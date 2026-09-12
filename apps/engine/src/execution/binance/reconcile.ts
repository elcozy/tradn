/**
 * Reconciliation (on start and every 5 minutes): the exchange is the truth, the database must agree.
 * - open orders on the exchange we do not know -> reconcile_mismatch event + risk_events row, and
 *   new entries are paused (someone or something else is trading the account)
 * - our orders that the exchange no longer has open -> statuses and fills refreshed
 * - an open position whose remaining quantity has no exchange-side stop -> re-protected immediately
 * - base balances smaller than what our positions hold -> reconcile_mismatch alert
 */
import { EngineEventType, type EventSink } from "../../events.js";
import { log } from "../../log.js";
import { toCcxtSymbol } from "../../marketdata/gapFill.js";
import type { PositionManager } from "../../positions/manager.js";
import { RiskEventType, type PositionStore } from "../../positions/store.js";
import type { StateStore } from "../../state.js";
import type { BinanceSpotAdapter } from "./adapter.js";
import type { OrderStore } from "./orders.js";
import type { BinanceRest } from "./rest.js";

export interface ReconcileDeps {
  rest: BinanceRest;
  orders: OrderStore;
  adapter: BinanceSpotAdapter;
  manager: PositionManager;
  events: EventSink;
  risk: Pick<PositionStore, "insertRiskEvent">;
  state: Pick<StateStore, "setPaused">;
  /** Tolerance for balance checks (dust from base-asset commissions). */
  balanceTolerancePct?: number;
}

export interface ReconcileReport {
  unknownOrders: string[];
  reprotected: string[];
  balanceMismatches: string[];
}

export class Reconciler {
  constructor(private d: ReconcileDeps) {}

  async run(): Promise<ReconcileReport> {
    const report: ReconcileReport = { unknownOrders: [], reprotected: [], balanceMismatches: [] };

    // 1) unknown exchange orders
    const exchangeOpen = await this.d.rest.openOrders();
    const known = new Set((await this.d.orders.allOpen()).map((o) => o.exchangeOrderId));
    for (const o of exchangeOpen) if (!known.has(o.orderId)) report.unknownOrders.push(`${o.symbol}#${o.orderId}`);
    if (report.unknownOrders.length) {
      await this.d.risk.insertRiskEvent(RiskEventType.ReconcileMismatch, { unknown_orders: report.unknownOrders });
      await this.d.state.setPaused(true);
      await this.d.events.emit({ type: EngineEventType.ReconcileMismatch, reason: `${report.unknownOrders.length} open order(s) on the exchange are not ours; new entries paused`, detail: { orders: report.unknownOrders } });
    }

    // 2) our side: refresh anything we still think is open
    await this.d.adapter.refreshOpenOrders();

    // 3) every open position must have an exchange stop for its remaining quantity
    for (const p of this.d.manager.activePositions) {
      const covered = await this.d.adapter.stopCoverage(p.id);
      if (covered + 1e-9 >= p.state.remaining_qty * 0.999) continue;
      log.warn({ position: p.id, covered, remaining: p.state.remaining_qty }, "position without full exchange stop; re-protecting");
      await this.d.manager.reprotect(p.id);
      report.reprotected.push(p.id);
      await this.d.risk.insertRiskEvent(RiskEventType.Unprotected, { position_id: p.id, covered, remaining: p.state.remaining_qty });
      await this.d.events.emit({ type: EngineEventType.Alert, position_id: p.id, symbol: p.symbol, reason: `no exchange stop for ${p.state.remaining_qty - covered} — re-protected` });
    }

    // 4) balances vs positions
    const held = new Map<string, number>();
    for (const p of this.d.manager.activePositions) held.set(p.symbol, (held.get(p.symbol) ?? 0) + p.state.remaining_qty);
    if (held.size) {
      const balances = await this.d.rest.balances();
      const tol = 1 - (this.d.balanceTolerancePct ?? 0.2) / 100;
      for (const [symbol, qty] of held) {
        const base = toCcxtSymbol(symbol).split("/")[0]!;
        const b = balances[base];
        const have = b ? b.free + b.locked : 0;
        if (have < qty * tol) {
          report.balanceMismatches.push(symbol);
          await this.d.risk.insertRiskEvent(RiskEventType.ReconcileMismatch, { symbol, have, expected: qty });
          await this.d.events.emit({ type: EngineEventType.ReconcileMismatch, symbol, reason: `${base} balance ${have} < positions hold ${qty}`, detail: { have, expected: qty } });
        }
      }
    }
    return report;
  }
}
