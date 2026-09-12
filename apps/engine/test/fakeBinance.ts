/** In-memory Binance spot: market fills at `price`, OCO lists with two legs, triggers when `moveTo()` crosses a leg. */
import { ExchangeOrderStatus, RestError, RestErrorKind, type BinanceRest, type OcoResult, type RestFill, type RestOrder } from "../src/execution/binance/rest.js";

interface FakeOrder extends RestOrder {
  listSibling?: string;
  stopLimitPrice?: number;
}

export class FakeBinance implements BinanceRest {
  price_ = 100;
  feePct = 0.1;
  commissionAsset: "USDT" | "BASE" | "BNB" = "USDT";
  orders = new Map<string, FakeOrder>();
  lists = new Map<string, string[]>();
  trades = new Map<string, RestFill[]>();
  balances_: Record<string, { free: number; locked: number }> = { USDT: { free: 10_000, locked: 0 } };
  /** Failure injection: a queue of errors thrown by the next placeOco calls. */
  ocoFailures: RestError[] = [];
  listenKeys = 0;
  keepAlives = 0;
  calls: string[] = [];
  private nextId = 1;
  private nextTrade = 1;

  constructor(price = 100) {
    this.price_ = price;
  }

  private id() {
    return String(this.nextId++);
  }
  private base(symbol: string) {
    return symbol.replace(/USDT$/, "");
  }
  private fill(o: FakeOrder, price: number, qty: number) {
    const base = this.base(o.symbol);
    const asset = this.commissionAsset === "USDT" ? "USDT" : this.commissionAsset === "BASE" ? base : "BNB";
    const commission = asset === "USDT" ? (price * qty * this.feePct) / 100 : asset === base ? (qty * this.feePct) / 100 : 0.001;
    const f: RestFill = { price, qty, commission, commissionAsset: asset, tradeId: String(this.nextTrade++) };
    this.trades.set(o.orderId, [...(this.trades.get(o.orderId) ?? []), f]);
    o.executedQty += qty;
    o.cummulativeQuoteQty += price * qty;
    o.status = o.executedQty + 1e-12 >= o.origQty ? ExchangeOrderStatus.Filled : ExchangeOrderStatus.PartiallyFilled;
    const b = this.balances_[base] ?? { free: 0, locked: 0 };
    if (o.side === "BUY") b.free += qty - (asset === base ? commission : 0);
    else b.free -= qty;
    this.balances_[base] = b;
    return f;
  }

  /** Move the market: stop legs trigger at or below their stop price, limit legs fill at or above their price. */
  moveTo(price: number) {
    this.price_ = price;
    for (const o of this.orders.values()) {
      if (o.status !== ExchangeOrderStatus.New || o.side !== "SELL") continue;
      if (o.stopPrice !== null && price <= o.stopPrice) this.trigger(o, o.stopLimitPrice ?? o.price);
      else if (o.stopPrice === null && o.type !== "MARKET" && price >= o.price) this.trigger(o, o.price);
    }
  }
  private trigger(o: FakeOrder, fillPrice: number) {
    this.fill(o, fillPrice, o.origQty);
    if (o.listSibling) {
      const s = this.orders.get(o.listSibling)!;
      if (s.status === ExchangeOrderStatus.New) s.status = ExchangeOrderStatus.Expired;
    }
  }

  async marketOrder(p: { symbol: string; side: "BUY" | "SELL"; qty: string; clientOrderId: string }): Promise<RestOrder> {
    this.calls.push(`market:${p.side}:${p.qty}`);
    const dup = [...this.orders.values()].find((o) => o.clientOrderId === p.clientOrderId);
    if (dup) throw new RestError(RestErrorKind.InvalidOrder, "Duplicate order sent.", -2026);
    const o: FakeOrder = {
      orderId: this.id(), clientOrderId: p.clientOrderId, orderListId: null, symbol: p.symbol, side: p.side, type: "MARKET", status: ExchangeOrderStatus.New,
      price: 0, stopPrice: null, origQty: Number(p.qty), executedQty: 0, cummulativeQuoteQty: 0, updateTime: Date.now(),
    };
    this.orders.set(o.orderId, o);
    this.fill(o, this.price_, o.origQty);
    return { ...o, fills: this.trades.get(o.orderId) };
  }

  async placeOco(p: { symbol: string; qty: string; limitPrice: string; stopPrice: string; stopLimitPrice: string; listClientOrderId: string }): Promise<OcoResult> {
    this.calls.push(`oco:${p.qty}:${p.limitPrice}:${p.stopPrice}`);
    const fail = this.ocoFailures.shift();
    if (fail) throw fail;
    const limit = Number(p.limitPrice);
    const stop = Number(p.stopPrice);
    if (!(limit > this.price_ && this.price_ > stop))
      throw new RestError(RestErrorKind.InvalidOrder, "The relationship of the prices for the orders is not correct.", -1013);
    const base = this.base(p.symbol);
    const free = (this.balances_[base]?.free ?? 0) - this.lockedFor(p.symbol);
    if (Number(p.qty) > free + 1e-9) throw new RestError(RestErrorKind.InsufficientFunds, "Account has insufficient balance for requested action.", -2010);
    const listId = `L${this.id()}`;
    const mk = (type: string, price: number, stopPrice: number | null, stopLimit?: number): FakeOrder => ({
      orderId: this.id(), clientOrderId: `${p.listClientOrderId}-${type[0]}`, orderListId: listId, symbol: p.symbol, side: "SELL", type, status: ExchangeOrderStatus.New,
      price, stopPrice, origQty: Number(p.qty), executedQty: 0, cummulativeQuoteQty: 0, updateTime: Date.now(), stopLimitPrice: stopLimit,
    });
    const a = mk("LIMIT_MAKER", limit, null);
    const b = mk("STOP_LOSS_LIMIT", Number(p.stopLimitPrice), stop, Number(p.stopLimitPrice));
    a.listSibling = b.orderId;
    b.listSibling = a.orderId;
    this.orders.set(a.orderId, a);
    this.orders.set(b.orderId, b);
    this.lists.set(listId, [a.orderId, b.orderId]);
    return { orderListId: listId, listClientOrderId: p.listClientOrderId, orders: [a, b].map((o) => ({ orderId: o.orderId, clientOrderId: o.clientOrderId, type: o.type })) };
  }
  /** Quantity locked by resting sells; the two legs of an OCO list lock their quantity once. */
  private lockedFor(symbol: string) {
    let q = 0;
    const lists = new Set<string>();
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol || o.side !== "SELL" || o.status !== ExchangeOrderStatus.New || o.type === "MARKET") continue;
      if (o.orderListId) {
        if (lists.has(o.orderListId)) continue;
        lists.add(o.orderListId);
      }
      q += o.origQty - o.executedQty;
    }
    return q;
  }

  async stopLossLimit(p: { symbol: string; qty: string; stopPrice: string; limitPrice: string; clientOrderId: string }): Promise<RestOrder> {
    this.calls.push(`stop:${p.qty}:${p.stopPrice}`);
    const o: FakeOrder = {
      orderId: this.id(), clientOrderId: p.clientOrderId, orderListId: null, symbol: p.symbol, side: "SELL", type: "STOP_LOSS_LIMIT", status: ExchangeOrderStatus.New,
      price: Number(p.limitPrice), stopPrice: Number(p.stopPrice), origQty: Number(p.qty), executedQty: 0, cummulativeQuoteQty: 0, updateTime: Date.now(), stopLimitPrice: Number(p.limitPrice),
    };
    this.orders.set(o.orderId, o);
    return { ...o };
  }
  async cancelOrderList(_symbol: string, orderListId: string) {
    this.calls.push(`cancelList:${orderListId}`);
    const ids = this.lists.get(orderListId);
    if (!ids) throw new RestError(RestErrorKind.InvalidOrder, "Order list does not exist.", -2011);
    let any = false;
    for (const id of ids) {
      const o = this.orders.get(id)!;
      if (o.status === ExchangeOrderStatus.New) {
        o.status = ExchangeOrderStatus.Canceled;
        any = true;
      }
    }
    if (!any) throw new RestError(RestErrorKind.InvalidOrder, "Order list is already done.", -2011);
  }
  async cancelOrder(_symbol: string, orderId: string) {
    this.calls.push(`cancel:${orderId}`);
    const o = this.orders.get(orderId);
    if (!o || o.status !== ExchangeOrderStatus.New) throw new RestError(RestErrorKind.InvalidOrder, "Unknown order sent.", -2011);
    o.status = ExchangeOrderStatus.Canceled;
  }
  async getOrder(_symbol: string, orderId: string): Promise<RestOrder> {
    const o = this.orders.get(orderId);
    if (!o) throw new RestError(RestErrorKind.InvalidOrder, "Order does not exist.", -2013);
    return { ...o };
  }
  async openOrders(symbol?: string): Promise<RestOrder[]> {
    return [...this.orders.values()].filter((o) => o.status === ExchangeOrderStatus.New && (!symbol || o.symbol === symbol)).map((o) => ({ ...o }));
  }
  async tradesForOrder(_symbol: string, orderId: string) {
    return this.trades.get(orderId) ?? [];
  }
  async balances() {
    return this.balances_;
  }
  async price() {
    return this.price_;
  }
  async createListenKey() {
    this.listenKeys += 1;
    return `key${this.listenKeys}`;
  }
  async keepAliveListenKey() {
    this.keepAlives += 1;
  }
  async closeListenKey() {}

  /** Add an order we did not place (someone else trading the account). */
  foreignOrder(symbol: string): string {
    const o: FakeOrder = {
      orderId: this.id(), clientOrderId: "web_123", orderListId: null, symbol, side: "SELL", type: "LIMIT", status: ExchangeOrderStatus.New,
      price: this.price_ * 2, stopPrice: null, origQty: 1, executedQty: 0, cummulativeQuoteQty: 0, updateTime: Date.now(),
    };
    this.orders.set(o.orderId, o);
    return o.orderId;
  }
  openSells(symbol?: string) {
    return [...this.orders.values()].filter((o) => o.status === ExchangeOrderStatus.New && o.side === "SELL" && (!symbol || o.symbol === symbol));
  }
}
