-- 002: paper wallet (M5), exchange order bookkeeping (M6), would-have-won job (M8).

-- Paper/testnet/live quote balance survives restarts; NULL means "not started yet" (use paper.starting_balance).
ALTER TABLE engine_state ADD COLUMN balance_quote numeric;
-- Live safety gate (M7): entries are only placed when true. Paper/testnet default to true; live must be flipped on purpose.
ALTER TABLE engine_state ADD COLUMN entries_enabled boolean NOT NULL DEFAULT true;

-- Orders: the idempotent client id sent to the exchange (signal-derived), so a retry never double-buys.
ALTER TABLE orders ADD COLUMN client_order_id text;
CREATE INDEX orders_client_idx ON orders (client_order_id);
CREATE INDEX orders_open_idx ON orders (mode, symbol) WHERE status IN ('new', 'partially_filled');

-- Nightly job (research would-have-won): for every rejected signal, replay the exit policy on the candles
-- that followed and record whether the trade would have won.
CREATE TABLE would_have_won (
  signal_id     text        PRIMARY KEY REFERENCES signals(id),
  outcome       text        NOT NULL,   -- win | loss | breakeven | open (not resolved yet)
  realized_r    numeric,
  exit_price    numeric,
  close_reason  text,
  bars_held     integer,
  closed_at     timestamptz,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW v_rejected_would_have_won AS
SELECT s.id, s.ts, s.strategy_id, s.symbol, s.timeframe, s.mode, s.reject_reason, s.entry_price, s.stop_price, s.tp_price,
       s.projected_r, w.outcome AS would_have, w.realized_r AS would_have_r, w.close_reason AS would_have_close_reason,
       w.bars_held AS would_have_bars, w.closed_at AS would_have_closed_at, w.computed_at
FROM signals s JOIN would_have_won w ON w.signal_id = s.id
WHERE s.outcome = 'rejected';

-- Equity curve for the dashboard: latest snapshot per hour per mode.
CREATE VIEW v_equity_curve AS
SELECT DISTINCT ON (mode, date_trunc('hour', ts)) mode, ts, balance_quote, unrealised, drawdown_pct
FROM equity_snapshots
ORDER BY mode, date_trunc('hour', ts), ts DESC;
