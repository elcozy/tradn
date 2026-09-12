/**
 * The slice of the Binance spot REST API the adapter needs, behind an interface so tests use a fake.
 * The production implementation goes through ccxt's implicit endpoint methods (signing, rate limiting,
 * sandbox switch to testnet.binance.vision) — not ccxt's unified createOrder, because spot OCO lists
 * and the FULL market-order response are Binance-specific.
 */
import { log } from "../../log.js";

export enum ExchangeOrderStatus {
  New = "NEW",
  PartiallyFilled = "PARTIALLY_FILLED",
  Filled = "FILLED",
  Canceled = "CANCELED",
  PendingCancel = "PENDING_CANCEL",
  Rejected = "REJECTED",
  Expired = "EXPIRED",
  ExpiredInMatch = "EXPIRED_IN_MATCH",
}

export const OPEN_STATUSES = new Set<string>([ExchangeOrderStatus.New, ExchangeOrderStatus.PartiallyFilled, ExchangeOrderStatus.PendingCancel]);

export interface RestFill {
  price: number;
  qty: number;
  commission: number;
  commissionAsset: string;
  tradeId: string;
}

export interface RestOrder {
  orderId: string;
  clientOrderId: string;
  orderListId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  status: ExchangeOrderStatus | string;
  price: number;
  stopPrice: number | null;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  updateTime: number;
  /** Only on a FULL market-order response. */
  fills?: RestFill[];
}

export interface OcoResult {
  orderListId: string;
  listClientOrderId: string;
  /** Two legs: the limit (take-profit) and the stop. */
  orders: { orderId: string; clientOrderId: string; type: string }[];
}

export enum RestErrorKind {
  InvalidOrder = "invalid_order",
  InsufficientFunds = "insufficient_funds",
  RateLimit = "rate_limit",
  Banned = "banned",
  Network = "network",
  Other = "other",
}

export class RestError extends Error {
  constructor(public kind: RestErrorKind, message: string, public code?: number) {
    super(message);
  }
}

export interface BinanceRest {
  marketOrder(p: { symbol: string; side: "BUY" | "SELL"; qty: string; clientOrderId: string }): Promise<RestOrder>;
  /** Sell OCO: limit (take-profit) above the market, stop-loss-limit below it. */
  placeOco(p: { symbol: string; qty: string; limitPrice: string; stopPrice: string; stopLimitPrice: string; listClientOrderId: string }): Promise<OcoResult>;
  stopLossLimit(p: { symbol: string; qty: string; stopPrice: string; limitPrice: string; clientOrderId: string }): Promise<RestOrder>;
  cancelOrderList(symbol: string, orderListId: string): Promise<void>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOrder(symbol: string, orderId: string): Promise<RestOrder>;
  openOrders(symbol?: string): Promise<RestOrder[]>;
  /** Fills of one order (commission per trade). */
  tradesForOrder(symbol: string, orderId: string): Promise<RestFill[]>;
  balances(): Promise<Record<string, { free: number; locked: number }>>;
  price(symbol: string): Promise<number>;
  createListenKey(): Promise<string>;
  keepAliveListenKey(key: string): Promise<void>;
  closeListenKey(key: string): Promise<void>;
}

/** Average fill price of an order from the exchange's cumulative fields. */
export function avgPrice(o: Pick<RestOrder, "executedQty" | "cummulativeQuoteQty" | "price">): number {
  return o.executedQty > 0 ? o.cummulativeQuoteQty / o.executedQty : o.price;
}

type Raw = Record<string, any>;

const num = (v: unknown, d = 0) => (v === undefined || v === null || v === "" ? d : Number(v));

export function parseOrder(r: Raw): RestOrder {
  return {
    orderId: String(r.orderId),
    clientOrderId: String(r.clientOrderId ?? ""),
    orderListId: r.orderListId === undefined || Number(r.orderListId) < 0 ? null : String(r.orderListId),
    symbol: String(r.symbol),
    side: r.side,
    type: String(r.type),
    status: String(r.status),
    price: num(r.price),
    stopPrice: r.stopPrice === undefined ? null : num(r.stopPrice),
    origQty: num(r.origQty),
    executedQty: num(r.executedQty),
    cummulativeQuoteQty: num(r.cummulativeQuoteQty),
    updateTime: num(r.updateTime ?? r.transactTime),
    fills: Array.isArray(r.fills) ? r.fills.map(parseFill) : undefined,
  };
}

export function parseFill(f: Raw): RestFill {
  return { price: num(f.price), qty: num(f.qty), commission: num(f.commission), commissionAsset: String(f.commissionAsset ?? ""), tradeId: String(f.tradeId ?? "") };
}

/** ccxt-backed implementation. `sandbox` switches every endpoint to testnet.binance.vision. */
export async function ccxtBinanceRest(apiKey: string, secret: string, sandbox: boolean): Promise<BinanceRest> {
  const ccxt = await import("ccxt");
  const ex = new ccxt.binance({ apiKey, secret, enableRateLimit: true, options: { defaultType: "spot", adjustForTimeDifference: true } });
  if (sandbox) ex.setSandboxMode(true);
  const api = ex as unknown as Record<string, (p?: Raw) => Promise<any>>;

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      const used = (ex as unknown as { last_response_headers?: Record<string, string> }).last_response_headers?.["x-mbx-used-weight-1m"];
      if (used && Number(used) > 4000) log.warn({ used }, "binance request weight high");
      return out;
    } catch (err) {
      const e = err as Error & { constructor: { name: string } };
      const name = e.constructor?.name ?? "";
      const msg = e.message ?? String(err);
      const code = Number(/"code":\s*(-?\d+)/.exec(msg)?.[1]);
      if (name === "InsufficientFunds") throw new RestError(RestErrorKind.InsufficientFunds, msg, code);
      if (name === "InvalidOrder" || name === "OrderNotFound" || name === "BadRequest") throw new RestError(RestErrorKind.InvalidOrder, msg, code);
      if (name === "DDoSProtection" || msg.includes("418")) throw new RestError(RestErrorKind.Banned, msg, code);
      if (name === "RateLimitExceeded" || msg.includes("429")) throw new RestError(RestErrorKind.RateLimit, msg, code);
      if (name === "NetworkError" || name === "RequestTimeout" || name === "ExchangeNotAvailable") throw new RestError(RestErrorKind.Network, msg, code);
      throw new RestError(RestErrorKind.Other, msg, code);
    }
  };

  return {
    marketOrder: (p) =>
      wrap(async () => parseOrder(await api["privatePostOrder"]!({ symbol: p.symbol, side: p.side, type: "MARKET", quantity: p.qty, newClientOrderId: p.clientOrderId, newOrderRespType: "FULL" }))),
    placeOco: (p) =>
      wrap(async () => {
        const r = await api["privatePostOrderListOco"]!({
          symbol: p.symbol, side: "SELL", quantity: p.qty, listClientOrderId: p.listClientOrderId,
          aboveType: "LIMIT_MAKER", abovePrice: p.limitPrice,
          belowType: "STOP_LOSS_LIMIT", belowStopPrice: p.stopPrice, belowPrice: p.stopLimitPrice, belowTimeInForce: "GTC",
        });
        return {
          orderListId: String(r.orderListId),
          listClientOrderId: String(r.listClientOrderId),
          orders: (r.orderReports ?? r.orders ?? []).map((o: Raw) => ({ orderId: String(o.orderId), clientOrderId: String(o.clientOrderId), type: String(o.type ?? "") })),
        };
      }),
    stopLossLimit: (p) =>
      wrap(async () => parseOrder(await api["privatePostOrder"]!({ symbol: p.symbol, side: "SELL", type: "STOP_LOSS_LIMIT", quantity: p.qty, stopPrice: p.stopPrice, price: p.limitPrice, timeInForce: "GTC", newClientOrderId: p.clientOrderId }))),
    cancelOrderList: (symbol, orderListId) => wrap(async () => void (await api["privateDeleteOrderList"]!({ symbol, orderListId }))),
    cancelOrder: (symbol, orderId) => wrap(async () => void (await api["privateDeleteOrder"]!({ symbol, orderId }))),
    getOrder: (symbol, orderId) => wrap(async () => parseOrder(await api["privateGetOrder"]!({ symbol, orderId }))),
    openOrders: (symbol) => wrap(async () => ((await api["privateGetOpenOrders"]!(symbol ? { symbol } : {})) as Raw[]).map(parseOrder)),
    tradesForOrder: (symbol, orderId) => wrap(async () => ((await api["privateGetMyTrades"]!({ symbol, orderId })) as Raw[]).map((t) => ({ price: num(t.price), qty: num(t.qty), commission: num(t.commission), commissionAsset: String(t.commissionAsset), tradeId: String(t.id) }))),
    balances: () =>
      wrap(async () => {
        const acc = await api["privateGetAccount"]!({});
        const out: Record<string, { free: number; locked: number }> = {};
        for (const b of acc.balances as Raw[]) out[b.asset] = { free: num(b.free), locked: num(b.locked) };
        return out;
      }),
    price: (symbol) => wrap(async () => num((await api["publicGetTickerPrice"]!({ symbol })).price)),
    createListenKey: () => wrap(async () => String((await api["publicPostUserDataStream"]!({})).listenKey)),
    keepAliveListenKey: (key) => wrap(async () => void (await api["publicPutUserDataStream"]!({ listenKey: key }))),
    closeListenKey: (key) => wrap(async () => void (await api["publicDeleteUserDataStream"]!({ listenKey: key }))),
  };
}
