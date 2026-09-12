/**
 * Binance spot adapter (testnet and live, M6/M7).
 *
 * - entry: MARKET buy with an idempotent client id derived from the position id; the fill is read
 *   from the FULL response (quote spent / base received) and the sellable quantity excludes any
 *   commission charged in the base asset
 * - protection: two sell OCO lists — A covers the TP1 fraction (limit tp1 / stop sl), B the remainder
 *   (limit tp / stop sl). Stop-limit sits 0.2% under the stop. A stop that moved up by at least a tick
 *   and 0.05%, a ratcheted target or a changed quantity cancels the list, re-checks fills in the gap,
 *   and places a new one. The manager calls protect once per candle, so at most one replace per candle.
 *   If Binance rejects the OCO because the market is already through a price: sell that quantity at
 *   market and alert; otherwise fall back to a lone stop-loss-limit and alert.
 * - exits decided by the exit policy (closeLong) are first matched against fills the exchange already
 *   made (an OCO leg that triggered intrabar); whatever is left is sold at market after cancelling the
 *   remaining protection
 * - invariant: no open position without an exchange-side stop. Three failed placements -> the whole
 *   position is sold at market and the manager is told (forced close)
 * Every order and fill is persisted (orders/fills tables) so a restart re-adopts the exchange state.
 */
import { createHash } from "node:crypto";
import { EngineEventType, type EventSink } from "../../events.js";
import { log } from "../../log.js";
import { toCcxtSymbol } from "../../marketdata/gapFill.js";
import { EntryTiming, type CloseRequest, type ExchangeAdapter, type Fill, type ForcedClose, type OpenRequest, type ProtectRequest } from "../adapter.js";
import { formatToStep, roundPriceToTick, roundQtyDownToStep, type SymbolFilters } from "../precision.js";
import { LocalOrderStatus, OPEN_LOCAL, OrderGroup, OrderLeg, localStatus, type FillRow, type OrderRow, type OrderStore } from "./orders.js";
import { QUOTE } from "../wallet.js";
import { RestError, RestErrorKind, avgPrice, type BinanceRest, type RestFill, type RestOrder } from "./rest.js";

export interface ExecutionReport {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  orderListId: string | null;
  side: "BUY" | "SELL";
  execType: string; // NEW | TRADE | CANCELED | EXPIRED | REJECTED
  status: string;
  lastQty: number;
  lastPrice: number;
  cumQty: number;
  cumQuote: number;
  commission: number;
  commissionAsset: string;
  tradeId: string;
  time: number;
}

export interface BinanceAdapterDeps {
  mode: "testnet" | "live";
  rest: BinanceRest;
  orders: OrderStore;
  filters: Map<string, SymbolFilters>;
  events: EventSink;
  onForcedClose?: (fc: ForcedClose) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const STOP_LIMIT_GAP_PCT = 0.2;
const REPLACE_MIN_PCT = 0.05;
const MAX_ATTEMPTS = 3;
const EPS = 1e-9;

/** Binance allows ^[.A-Z:/a-z0-9_-]{1,36}$; a sha1 prefix keeps ids short and deterministic. */
export function clientId(prefix: string, positionId: string, seq?: number): string {
  const h = createHash("sha1").update(positionId).digest("hex").slice(0, 20);
  return seq === undefined ? `${prefix}${h}` : `${prefix}${h}-${seq.toString(36)}`;
}

interface Desired {
  group: OrderGroup.OcoA | OrderGroup.OcoB;
  qty: number;
  limit: number;
  stop: number;
}

interface ActiveGroup {
  group: OrderGroup;
  legs: OrderRow[];
  qty: number;
  limit: number | null;
  stop: number | null;
}

export class BinanceSpotAdapter implements ExchangeAdapter {
  readonly mode: "testnet" | "live";
  readonly entryTiming = EntryTiming.Immediate;
  private seq = 0;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: BinanceAdapterDeps) {
    this.mode = d.mode;
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  quoteEntry(refPrice: number): number {
    return refPrice;
  }

  // ---- formatting -------------------------------------------------------------------------------
  private f(symbol: string): SymbolFilters | undefined {
    return this.d.filters.get(symbol);
  }
  private qtyStr(symbol: string, qty: number): string {
    const f = this.f(symbol);
    return f ? formatToStep(roundQtyDownToStep(qty, f.stepSize), f.stepSize) : String(qty);
  }
  private priceStr(symbol: string, price: number): string {
    const f = this.f(symbol);
    return f ? formatToStep(roundPriceToTick(price, f.tickSize), f.tickSize) : String(price);
  }
  private tick(symbol: string): number {
    return Number(this.f(symbol)?.tickSize ?? 0);
  }
  private step(symbol: string): number {
    return Number(this.f(symbol)?.stepSize ?? 0);
  }
  private base(symbol: string): string {
    return toCcxtSymbol(symbol).split("/")[0]!;
  }
  private nextSeq(): number {
    this.seq += 1;
    return Date.now() % 1_000_000 * 100 + (this.seq % 100);
  }

  // ---- bookkeeping ------------------------------------------------------------------------------
  private async recordOrder(row: OrderRow, o: RestOrder): Promise<void> {
    row.exchangeOrderId = o.orderId;
    row.orderListId = o.orderListId ?? row.orderListId;
    row.status = localStatus(String(o.status));
    row.executedQty = o.executedQty;
    await this.d.orders.update(row);
    if (o.fills?.length) {
      for (const [i, f] of o.fills.entries()) await this.d.orders.insertFill(this.toFillRow(row, f, i));
    } else if (o.executedQty > EPS) {
      const have = (await this.d.orders.fillsFor(row.id)).reduce((a, f) => a + f.qty, 0);
      if (have + EPS < o.executedQty) {
        for (const [i, f] of (await this.d.rest.tradesForOrder(row.symbol, o.orderId)).entries()) await this.d.orders.insertFill(this.toFillRow(row, f, i));
      }
    }
  }
  private toFillRow(row: OrderRow, f: RestFill, i: number): FillRow {
    return { id: f.tradeId || `${row.id}:${i}`, orderId: row.id, price: f.price, qty: f.qty, fee: f.commission, feeAsset: f.commissionAsset, ts: this.now() };
  }
  private async refresh(rows: OrderRow[]): Promise<void> {
    for (const row of rows) {
      if (!row.exchangeOrderId || !OPEN_LOCAL.has(row.status)) continue;
      try {
        await this.recordOrder(row, await this.d.rest.getOrder(row.symbol, row.exchangeOrderId));
      } catch (err) {
        log.warn({ err, order: row.id }, "order refresh failed");
      }
    }
  }
  /** REST poll fallback for the user data stream: refresh every order we still think is open. */
  async refreshOpenOrders(): Promise<void> {
    await this.refresh(await this.d.orders.allOpen());
  }

  /** User data stream: apply one executionReport. Returns false when the order is not ours. */
  async applyExecutionReport(r: ExecutionReport): Promise<boolean> {
    const row = (await this.d.orders.byExchangeId(r.orderId)) ?? (await this.d.orders.byClientId(r.clientOrderId));
    if (!row) return false;
    row.exchangeOrderId = r.orderId;
    row.status = localStatus(r.status);
    row.executedQty = Math.max(row.executedQty, r.cumQty);
    await this.d.orders.update(row);
    if (r.execType === "TRADE" && r.lastQty > 0)
      await this.d.orders.insertFill({ id: r.tradeId, orderId: row.id, price: r.lastPrice, qty: r.lastQty, fee: r.commission, feeAsset: r.commissionAsset, ts: new Date(r.time) });
    return true;
  }

  /** Fee of a set of fills expressed in quote where possible; base-asset commissions are converted at the fill price. */
  private feeInQuote(fills: { price: number; fee: number; feeAsset: string }[], base: string): { fee: number; feeAsset: string } {
    let quote = 0;
    let other = 0;
    let otherAsset = "";
    for (const f of fills) {
      if (f.feeAsset === QUOTE) quote += f.fee;
      else if (f.feeAsset === base) quote += f.fee * f.price;
      else {
        other += f.fee;
        otherAsset = f.feeAsset;
      }
    }
    return other > 0 && quote === 0 ? { fee: other, feeAsset: otherAsset } : { fee: quote, feeAsset: QUOTE };
  }

  // ---- entry ------------------------------------------------------------------------------------
  async openLong(req: OpenRequest): Promise<Fill> {
    const symbol = req.signal.symbol;
    const cid = clientId("e-", req.positionId);
    let row = await this.d.orders.byClientId(cid);
    if (row && row.status === LocalOrderStatus.Filled) return this.entryFill(row); // retry after a crash: already bought
    if (!row) {
      row = {
        id: `${req.positionId}:entry`, positionId: req.positionId, symbol, group: OrderGroup.Entry, leg: OrderLeg.Market, side: "BUY", type: "MARKET",
        exchangeOrderId: null, orderListId: null, clientOrderId: cid, price: null, stopPrice: null, qty: req.qty, executedQty: 0,
        status: LocalOrderStatus.New, consumedQty: 0, createdAt: this.now(),
      };
      await this.d.orders.insert(row);
    }
    const o = await this.d.rest.marketOrder({ symbol, side: "BUY", qty: this.qtyStr(symbol, req.qty), clientOrderId: cid });
    await this.recordOrder(row, o);
    if (o.executedQty <= EPS) throw new RestError(RestErrorKind.InvalidOrder, `market buy ${symbol} not filled (${o.status})`);
    return this.entryFill(row);
  }

  private async entryFill(row: OrderRow): Promise<Fill> {
    const fills = await this.d.orders.fillsFor(row.id);
    const base = this.base(row.symbol);
    const qty = fills.reduce((a, f) => a + f.qty, 0);
    const quote = fills.reduce((a, f) => a + f.price * f.qty, 0);
    const baseFee = fills.filter((f) => f.feeAsset === base).reduce((a, f) => a + f.fee, 0);
    const price = qty > 0 ? quote / qty : 0;
    const sellable = roundQtyDownToStep(qty - baseFee, this.f(row.symbol)?.stepSize ?? "0.00000001");
    return { price, qty: sellable, ...this.feeInQuote(fills, base), ts: this.now(), orderId: row.exchangeOrderId ?? undefined };
  }

  // ---- protection -------------------------------------------------------------------------------
  private async activeGroups(positionId: string): Promise<Map<OrderGroup, ActiveGroup>> {
    const rows = (await this.d.orders.forPosition(positionId)).filter((r) => r.side === "SELL" && OPEN_LOCAL.has(r.status));
    const out = new Map<OrderGroup, ActiveGroup>();
    for (const r of rows) {
      const g = out.get(r.group) ?? { group: r.group, legs: [], qty: r.qty, limit: null, stop: null };
      g.legs.push(r);
      if (r.leg === OrderLeg.Limit) g.limit = r.price;
      if (r.leg === OrderLeg.Stop) g.stop = r.stopPrice;
      out.set(r.group, g);
    }
    return out;
  }

  private desired(req: ProtectRequest): Desired[] {
    const step = this.step(req.symbol);
    const out: Desired[] = [];
    if (!req.tp1Done && req.tp1 !== null && req.tp1Qty !== null && req.tp1Qty > EPS) {
      const a = Math.min(req.tp1Qty, req.qty);
      const b = req.qty - a;
      out.push({ group: OrderGroup.OcoA, qty: a, limit: req.tp1, stop: req.stop });
      if (b > step + EPS) out.push({ group: OrderGroup.OcoB, qty: b, limit: req.tp, stop: req.stop });
    } else if (req.qty > EPS) {
      out.push({ group: OrderGroup.OcoB, qty: req.qty, limit: req.tp, stop: req.stop });
    }
    return out;
  }

  private needsReplace(symbol: string, cur: ActiveGroup, d: Desired): boolean {
    const tick = this.tick(symbol);
    const step = this.step(symbol);
    if (Math.abs(cur.qty - d.qty) > step / 2 + EPS) return true;
    if (cur.limit !== null && Math.abs(cur.limit - d.limit) >= Math.max(tick, EPS)) return true;
    if (cur.stop !== null && d.stop - cur.stop >= Math.max(tick, (cur.stop * REPLACE_MIN_PCT) / 100)) return true;
    return cur.stop === null || cur.limit === null; // stop-only fallback: try to upgrade to a real OCO
  }

  async protect(req: ProtectRequest): Promise<void> {
    const groups = await this.activeGroups(req.positionId);
    const wanted = this.desired(req);
    for (const d of wanted) {
      const cur = groups.get(d.group);
      let qty = d.qty;
      if (cur) {
        if (!this.needsReplace(req.symbol, cur, d)) continue;
        qty -= await this.cancelGroup(cur); // whatever filled while we were cancelling is already sold
      }
      // a stop-only fallback for this group counts as its current protection
      const so = groups.get(OrderGroup.StopOnly);
      if (so && !cur) qty -= await this.cancelGroup(so);
      if (qty > this.step(req.symbol) / 2 + EPS) await this.placeGroup(req, { ...d, qty });
    }
    const wantedGroups = new Set(wanted.map((w) => w.group));
    for (const [g, cur] of groups) {
      if (!wantedGroups.has(g as OrderGroup.OcoA) && g !== OrderGroup.StopOnly) await this.cancelGroup(cur);
    }
  }

  /** Cancel a list (or lone order), refresh its legs and return the quantity that filled before the cancel took. */
  private async cancelGroup(g: ActiveGroup): Promise<number> {
    const first = g.legs[0]!;
    try {
      if (first.orderListId) await this.d.rest.cancelOrderList(first.symbol, first.orderListId);
      else if (first.exchangeOrderId) await this.d.rest.cancelOrder(first.symbol, first.exchangeOrderId);
    } catch (err) {
      log.warn({ err, group: g.group }, "cancel failed (list may already be done); refreshing");
    }
    await this.refresh(g.legs);
    let filled = 0;
    for (const leg of g.legs) {
      const fresh = await this.d.orders.byId(leg.id);
      if (fresh) filled += fresh.executedQty;
    }
    return filled;
  }

  private async placeGroup(req: ProtectRequest, d: Desired): Promise<void> {
    const symbol = req.symbol;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const seq = this.nextSeq();
      const listId = clientId(d.group === OrderGroup.OcoA ? "a-" : "b-", req.positionId, seq);
      try {
        const oco = await this.d.rest.placeOco({
          symbol, qty: this.qtyStr(symbol, d.qty), limitPrice: this.priceStr(symbol, d.limit), stopPrice: this.priceStr(symbol, d.stop),
          stopLimitPrice: this.priceStr(symbol, d.stop * (1 - STOP_LIMIT_GAP_PCT / 100)), listClientOrderId: listId,
        });
        const limitLeg = oco.orders.find((o) => o.type.includes("LIMIT") && !o.type.includes("STOP")) ?? oco.orders[0]!;
        const stopLeg = oco.orders.find((o) => o.type.includes("STOP")) ?? oco.orders[1]!;
        const mk = (leg: OrderLeg, o: { orderId: string; clientOrderId: string; type: string }): OrderRow => ({
          id: `${req.positionId}:${d.group}:${leg}:${seq}`, positionId: req.positionId, symbol, group: d.group, leg, side: "SELL", type: o.type || (leg === OrderLeg.Limit ? "LIMIT_MAKER" : "STOP_LOSS_LIMIT"),
          exchangeOrderId: o.orderId, orderListId: oco.orderListId, clientOrderId: o.clientOrderId, price: leg === OrderLeg.Limit ? d.limit : d.stop * (1 - STOP_LIMIT_GAP_PCT / 100),
          stopPrice: leg === OrderLeg.Stop ? d.stop : null, qty: d.qty, executedQty: 0, status: LocalOrderStatus.New, consumedQty: 0, createdAt: this.now(),
        });
        await this.d.orders.insert(mk(OrderLeg.Limit, limitLeg));
        await this.d.orders.insert(mk(OrderLeg.Stop, stopLeg));
        log.info({ position: req.positionId, group: d.group, qty: d.qty, stop: d.stop, limit: d.limit }, "protection placed");
        return;
      } catch (err) {
        const e = err instanceof RestError ? err : new RestError(RestErrorKind.Other, String(err));
        log.warn({ err: e.message, kind: e.kind, attempt, group: d.group }, "OCO placement failed");
        if (e.kind === RestErrorKind.InvalidOrder) {
          if (await this.handlePriceConstraint(req, d)) return;
        }
        if (e.kind === RestErrorKind.InsufficientFunds && attempt === 1) {
          d = { ...d, qty: d.qty - this.step(symbol) }; // the base balance is one step short (rounding / dust)
          continue;
        }
        if (attempt < MAX_ATTEMPTS) await this.sleep(1000 * attempt);
      }
    }
    await this.emergencyExit(req, `protection for ${d.group} failed ${MAX_ATTEMPTS} times`);
  }

  /**
   * Binance requires limit > market > stop for a sell OCO. If the market is already through one of
   * them, that quantity is sold at market now (the exit policy will account for it on the candle
   * close); otherwise the rejection had another cause and a lone stop-loss-limit keeps the downside covered.
   */
  private async handlePriceConstraint(req: ProtectRequest, d: Desired): Promise<boolean> {
    const symbol = req.symbol;
    const px = await this.d.rest.price(symbol);
    if (px <= d.stop || px >= d.limit) {
      const why = px <= d.stop ? "stop already breached" : "target already reached";
      const fill = await this.marketSell(req.positionId, symbol, d.qty, OrderGroup.MarketExit);
      await this.d.events.emit({ type: EngineEventType.Alert, position_id: req.positionId, symbol, price: fill.price, qty: fill.qty, reason: `OCO impossible (${why} at ${px}); sold ${fill.qty} at market` });
      return true;
    }
    const seq = this.nextSeq();
    const cid = clientId("s-", req.positionId, seq);
    const o = await this.d.rest.stopLossLimit({ symbol, qty: this.qtyStr(symbol, d.qty), stopPrice: this.priceStr(symbol, d.stop), limitPrice: this.priceStr(symbol, d.stop * (1 - STOP_LIMIT_GAP_PCT / 100)), clientOrderId: cid });
    await this.d.orders.insert({
      id: `${req.positionId}:${OrderGroup.StopOnly}:${OrderLeg.Stop}:${seq}`, positionId: req.positionId, symbol, group: OrderGroup.StopOnly, leg: OrderLeg.Stop, side: "SELL", type: "STOP_LOSS_LIMIT",
      exchangeOrderId: o.orderId, orderListId: null, clientOrderId: cid, price: d.stop * (1 - STOP_LIMIT_GAP_PCT / 100), stopPrice: d.stop, qty: d.qty, executedQty: 0,
      status: localStatus(String(o.status)), consumedQty: 0, createdAt: this.now(),
    });
    await this.d.events.emit({ type: EngineEventType.Alert, position_id: req.positionId, symbol, reason: `OCO rejected; stop-loss-limit at ${d.stop} placed alone, target managed by the bot` });
    return true;
  }

  private async marketSell(positionId: string, symbol: string, qty: number, group: OrderGroup): Promise<Fill> {
    const seq = this.nextSeq();
    const cid = clientId("x-", positionId, seq);
    const row: OrderRow = {
      id: `${positionId}:${group}:${OrderLeg.Market}:${seq}`, positionId, symbol, group, leg: OrderLeg.Market, side: "SELL", type: "MARKET", exchangeOrderId: null, orderListId: null,
      clientOrderId: cid, price: null, stopPrice: null, qty, executedQty: 0, status: LocalOrderStatus.New, consumedQty: 0, createdAt: this.now(),
    };
    await this.d.orders.insert(row);
    const o = await this.d.rest.marketOrder({ symbol, side: "SELL", qty: this.qtyStr(symbol, qty), clientOrderId: cid });
    await this.recordOrder(row, o);
    const fills = await this.d.orders.fillsFor(row.id);
    const filled = fills.reduce((a, f) => a + f.qty, 0);
    const quote = fills.reduce((a, f) => a + f.price * f.qty, 0);
    return { price: filled > 0 ? quote / filled : avgPrice(o), qty: filled, ...this.feeInQuote(fills, this.base(symbol)), ts: this.now(), orderId: o.orderId };
  }

  /** Last resort: sell everything the position still holds and tell the manager. */
  private async emergencyExit(req: ProtectRequest, reason: string): Promise<void> {
    for (const g of (await this.activeGroups(req.positionId)).values()) await this.cancelGroup(g);
    const fill = await this.marketSell(req.positionId, req.symbol, req.qty, OrderGroup.MarketExit);
    await this.d.events.emit({ type: EngineEventType.OrderRejected, position_id: req.positionId, symbol: req.symbol, price: fill.price, qty: fill.qty, reason: `${reason}; position sold at market` });
    for (const r of await this.d.orders.forPosition(req.positionId)) {
      if (r.id === `${req.positionId}:${OrderGroup.MarketExit}:${OrderLeg.Market}:${this.seqOf(r.id)}` || r.group === OrderGroup.MarketExit) {
        r.consumedQty = r.executedQty;
        await this.d.orders.update(r);
      }
    }
    if (this.d.onForcedClose) await this.d.onForcedClose({ positionId: req.positionId, fill, reason: "kill" });
  }
  private seqOf(id: string): string {
    return id.split(":").pop() ?? "";
  }

  // ---- exits ------------------------------------------------------------------------------------
  async closeLong(req: CloseRequest): Promise<Fill> {
    const rows = (await this.d.orders.forPosition(req.positionId)).filter((r) => r.side === "SELL");
    await this.refresh(rows);
    let need = req.qty;
    const taken: { price: number; qty: number; fee: number; feeAsset: string }[] = [];
    const consume = async () => {
      for (const r of await this.d.orders.forPosition(req.positionId)) {
        if (r.side !== "SELL") continue;
        const avail = r.executedQty - r.consumedQty;
        if (avail <= EPS || need <= EPS) continue;
        const take = Math.min(avail, need);
        const fills = await this.d.orders.fillsFor(r.id);
        const fq = fills.reduce((a, f) => a + f.qty, 0);
        const px = fq > 0 ? fills.reduce((a, f) => a + f.price * f.qty, 0) / fq : (r.price ?? req.refPrice);
        const share = fq > 0 ? take / fq : 1;
        for (const f of fills) taken.push({ price: px, qty: 0, fee: f.fee * share, feeAsset: f.feeAsset });
        taken.push({ price: px, qty: take, fee: 0, feeAsset: QUOTE });
        r.consumedQty += take;
        need -= take;
        await this.d.orders.update(r);
      }
    };
    await consume();
    if (need > this.step(req.symbol) / 2 + EPS) {
      // nothing (or not enough) filled on the exchange: cancel what is resting and sell the rest at market
      for (const g of (await this.activeGroups(req.positionId)).values()) await this.cancelGroup(g);
      await consume();
      if (need > this.step(req.symbol) / 2 + EPS) {
        const fill = await this.marketSell(req.positionId, req.symbol, need, OrderGroup.MarketExit);
        const row = await this.d.orders.byExchangeId(fill.orderId!);
        if (row) {
          row.consumedQty = row.executedQty;
          await this.d.orders.update(row);
        }
        taken.push({ price: fill.price, qty: fill.qty, fee: fill.fee, feeAsset: fill.feeAsset });
        need -= fill.qty;
      }
    }
    const qty = taken.reduce((a, t) => a + t.qty, 0);
    const price = qty > 0 ? taken.reduce((a, t) => a + t.price * t.qty, 0) / qty : req.refPrice;
    return { price, qty, ...this.feeInQuote(taken, this.base(req.symbol)), ts: this.now() };
  }

  async release(positionId: string): Promise<void> {
    for (const g of (await this.activeGroups(positionId)).values()) await this.cancelGroup(g);
  }

  /** Reconciliation: is there an open stop covering (at least) `qty` for this position? */
  async stopCoverage(positionId: string): Promise<number> {
    let covered = 0;
    for (const g of (await this.activeGroups(positionId)).values()) if (g.stop !== null) covered += g.qty;
    return covered;
  }
}
