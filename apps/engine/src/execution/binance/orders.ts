/** Persistence for exchange orders and fills (tables `orders`, `fills`): the adapter's memory across restarts. */
import type { Mode } from "../../config.js";
import type { Sql } from "../../db.js";

/** What an order is for. One OCO list = two rows (limit leg + stop leg) sharing an order_list_id. */
export enum OrderGroup {
  Entry = "entry",
  /** OCO covering the TP1 fraction: limit at tp1, stop at sl. */
  OcoA = "oco_a",
  /** OCO covering the remainder: limit at tp, stop at sl. */
  OcoB = "oco_b",
  /** Fallback when an OCO is impossible: stop-loss-limit alone. */
  StopOnly = "stop_only",
  MarketExit = "market_exit",
}

export enum OrderLeg {
  Limit = "limit",
  Stop = "stop",
  Market = "market",
}

export enum LocalOrderStatus {
  New = "new",
  PartiallyFilled = "partially_filled",
  Filled = "filled",
  Canceled = "canceled",
  Rejected = "rejected",
  Expired = "expired",
}

export const OPEN_LOCAL = new Set<LocalOrderStatus>([LocalOrderStatus.New, LocalOrderStatus.PartiallyFilled]);

export interface OrderRow {
  id: string; // ours: `${positionId}:${group}:${leg}:${seq}`
  positionId: string;
  symbol: string;
  group: OrderGroup;
  leg: OrderLeg;
  side: "BUY" | "SELL";
  type: string; // exchange order type
  exchangeOrderId: string | null;
  orderListId: string | null;
  clientOrderId: string;
  price: number | null;
  stopPrice: number | null;
  qty: number;
  executedQty: number;
  status: LocalOrderStatus;
  /** Quantity of this order's fills already handed to the position manager through closeLong. */
  consumedQty: number;
  createdAt: Date;
}

export interface FillRow {
  id: string; // exchange trade id (or `${orderId}:${n}` when unknown)
  orderId: string; // OrderRow.id
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  ts: Date;
}

export interface OrderStore {
  insert(o: OrderRow): Promise<void>;
  update(o: OrderRow): Promise<void>;
  byId(id: string): Promise<OrderRow | null>;
  byExchangeId(exchangeOrderId: string): Promise<OrderRow | null>;
  byClientId(clientOrderId: string): Promise<OrderRow | null>;
  forPosition(positionId: string): Promise<OrderRow[]>;
  /** Every order still open on our side, all positions. */
  allOpen(): Promise<OrderRow[]>;
  insertFill(f: FillRow): Promise<boolean>;
  fillsFor(orderId: string): Promise<FillRow[]>;
}

export function localStatus(exchangeStatus: string): LocalOrderStatus {
  switch (exchangeStatus) {
    case "NEW":
    case "PENDING_NEW":
    case "PENDING_CANCEL":
      return LocalOrderStatus.New;
    case "PARTIALLY_FILLED":
      return LocalOrderStatus.PartiallyFilled;
    case "FILLED":
      return LocalOrderStatus.Filled;
    case "CANCELED":
      return LocalOrderStatus.Canceled;
    case "REJECTED":
      return LocalOrderStatus.Rejected;
    default:
      return LocalOrderStatus.Expired; // EXPIRED, EXPIRED_IN_MATCH
  }
}

export class PgOrderStore implements OrderStore {
  constructor(private sql: Sql, private mode: Mode) {}

  async insert(o: OrderRow) {
    await this.sql`
      INSERT INTO orders (id, mode, exchange_order_id, order_list_id, client_order_id, position_id, symbol, type, side, price, stop_price, qty, status, created_at, raw)
      VALUES (${o.id}, ${this.mode}, ${o.exchangeOrderId}, ${o.orderListId}, ${o.clientOrderId}, ${o.positionId}, ${o.symbol}, ${o.type}, ${o.side},
        ${o.price}, ${o.stopPrice}, ${o.qty}, ${o.status}, ${o.createdAt}, ${this.sql.json({ group: o.group, leg: o.leg, executed_qty: o.executedQty, consumed_qty: o.consumedQty } as never)})`;
  }
  async update(o: OrderRow) {
    await this.sql`
      UPDATE orders SET exchange_order_id = ${o.exchangeOrderId}, order_list_id = ${o.orderListId}, status = ${o.status}, price = ${o.price},
        stop_price = ${o.stopPrice}, qty = ${o.qty}, updated_at = now(),
        raw = raw || ${this.sql.json({ executed_qty: o.executedQty, consumed_qty: o.consumedQty } as never)}
      WHERE id = ${o.id}`;
  }
  private rows(where: ReturnType<Sql>) {
    return this.sql<Record<string, any>[]>`SELECT * FROM orders WHERE mode = ${this.mode} AND ${where} ORDER BY created_at`.then((rs) => rs.map(toRow));
  }
  async byId(id: string) {
    return (await this.rows(this.sql`id = ${id}`))[0] ?? null;
  }
  async byExchangeId(exchangeOrderId: string) {
    return (await this.rows(this.sql`exchange_order_id = ${exchangeOrderId}`))[0] ?? null;
  }
  async byClientId(clientOrderId: string) {
    return (await this.rows(this.sql`client_order_id = ${clientOrderId}`))[0] ?? null;
  }
  forPosition(positionId: string) {
    return this.rows(this.sql`position_id = ${positionId}`);
  }
  allOpen() {
    return this.rows(this.sql`status IN ('new', 'partially_filled')`);
  }
  async insertFill(f: FillRow) {
    const r = await this.sql`INSERT INTO fills (id, order_id, price, qty, fee, fee_asset, ts) VALUES (${f.id}, ${f.orderId}, ${f.price}, ${f.qty}, ${f.fee}, ${f.feeAsset}, ${f.ts})
      ON CONFLICT (id) DO NOTHING`;
    return r.count === 1;
  }
  async fillsFor(orderId: string) {
    const rows = await this.sql<Record<string, any>[]>`SELECT * FROM fills WHERE order_id = ${orderId} ORDER BY ts`;
    return rows.map((r) => ({ id: r.id, orderId: r.order_id, price: Number(r.price), qty: Number(r.qty), fee: Number(r.fee), feeAsset: r.fee_asset ?? "", ts: r.ts }));
  }
}

function toRow(r: Record<string, any>): OrderRow {
  return {
    id: r.id,
    positionId: r.position_id,
    symbol: r.symbol,
    group: r.raw?.group,
    leg: r.raw?.leg,
    side: r.side,
    type: r.type,
    exchangeOrderId: r.exchange_order_id,
    orderListId: r.order_list_id,
    clientOrderId: r.client_order_id,
    price: r.price === null ? null : Number(r.price),
    stopPrice: r.stop_price === null ? null : Number(r.stop_price),
    qty: Number(r.qty),
    executedQty: Number(r.raw?.executed_qty ?? 0),
    status: r.status,
    consumedQty: Number(r.raw?.consumed_qty ?? 0),
    createdAt: r.created_at,
  };
}

export class MemoryOrderStore implements OrderStore {
  orders = new Map<string, OrderRow>();
  fills = new Map<string, FillRow>();
  async insert(o: OrderRow) {
    this.orders.set(o.id, { ...o });
  }
  async update(o: OrderRow) {
    this.orders.set(o.id, { ...o });
  }
  async byId(id: string) {
    return this.orders.get(id) ?? null;
  }
  async byExchangeId(exchangeOrderId: string) {
    return [...this.orders.values()].find((o) => o.exchangeOrderId === exchangeOrderId) ?? null;
  }
  async byClientId(clientOrderId: string) {
    return [...this.orders.values()].find((o) => o.clientOrderId === clientOrderId) ?? null;
  }
  async forPosition(positionId: string) {
    return [...this.orders.values()].filter((o) => o.positionId === positionId);
  }
  async allOpen() {
    return [...this.orders.values()].filter((o) => OPEN_LOCAL.has(o.status));
  }
  async insertFill(f: FillRow) {
    if (this.fills.has(f.id)) return false;
    this.fills.set(f.id, f);
    return true;
  }
  async fillsFor(orderId: string) {
    return [...this.fills.values()].filter((f) => f.orderId === orderId);
  }
}
