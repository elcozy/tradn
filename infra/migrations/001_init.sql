-- 001_init: core schema shared by Python (research) and TypeScript (engine/dashboard).
-- Every table the engine writes carries a `mode` column so shadow/paper/testnet/live never mix.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TYPE run_mode AS ENUM ('shadow', 'paper', 'testnet', 'live');
CREATE TYPE side AS ENUM ('long', 'short');
CREATE TYPE position_state AS ENUM ('pending', 'open', 'breakeven', 'trailing', 'closed', 'failed');
CREATE TYPE order_status AS ENUM ('new', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired');

-- Candles: Python ingest writes history, TS engine writes live closed candles.
CREATE TABLE candles (
  symbol      text        NOT NULL,
  timeframe   text        NOT NULL,
  open_time   timestamptz NOT NULL,
  open        numeric     NOT NULL,
  high        numeric     NOT NULL,
  low         numeric     NOT NULL,
  close       numeric     NOT NULL,
  volume      numeric     NOT NULL,
  closed      boolean     NOT NULL DEFAULT true,
  PRIMARY KEY (symbol, timeframe, open_time)
);
SELECT create_hypertable('candles', 'open_time', chunk_time_interval => INTERVAL '30 days');

-- Signals: THE JOURNAL. Projection written by Python at signal time, outcome written back by the engine.
CREATE TABLE signals (
  id            text        PRIMARY KEY,   -- deterministic: strategy_id:symbol:tf:candle_open_time
  ts            timestamptz NOT NULL,
  strategy_id   text        NOT NULL,      -- instance id from config, e.g. s1_btc_15m
  strategy_type text        NOT NULL,      -- sr_bounce | indicator_confluence | range
  symbol        text        NOT NULL,
  timeframe     text        NOT NULL,
  side          side        NOT NULL,
  entry_type    text        NOT NULL,      -- market | limit
  entry_price   numeric     NOT NULL,
  stop_price    numeric     NOT NULL,
  tp1_price     numeric,
  tp_price      numeric     NOT NULL,
  projected_r   numeric GENERATED ALWAYS AS (
                  CASE WHEN entry_price = stop_price THEN NULL
                       ELSE (tp_price - entry_price) / (entry_price - stop_price) END) STORED,
  confidence    real,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Outcome (NULL until the engine acts)
  mode          run_mode,
  outcome       text,                      -- win | loss | breakeven | rejected | expired
  reject_reason text,
  position_id   text,
  actual_entry  numeric,
  slippage_pct  numeric,
  exit_price    numeric,
  realized_r    numeric,
  realized_pnl  numeric,
  fees          numeric,
  mfe_r         numeric,
  mae_r         numeric,
  bars_held     integer,
  duration_s    integer,
  close_reason  text,                      -- stop | take_profit | trailing | time | regime | manual | kill
  closed_at     timestamptz
);
CREATE INDEX signals_ts_idx ON signals (ts DESC);
CREATE INDEX signals_strategy_outcome_idx ON signals (strategy_id, outcome);

CREATE TABLE positions (
  id             text           PRIMARY KEY,
  mode           run_mode       NOT NULL,
  signal_id      text           NOT NULL REFERENCES signals(id),
  strategy_id    text           NOT NULL,
  symbol         text           NOT NULL,
  timeframe      text           NOT NULL,
  side           side           NOT NULL,
  entry_price    numeric        NOT NULL,
  qty            numeric        NOT NULL,
  remaining_qty  numeric        NOT NULL,
  sl_price       numeric        NOT NULL,
  sl_initial     numeric        NOT NULL,
  tp_price       numeric        NOT NULL,
  tp1_price      numeric,
  tp1_done       boolean        NOT NULL DEFAULT false,
  highest_high   numeric        NOT NULL,
  lowest_low     numeric        NOT NULL,
  bars_held      integer        NOT NULL DEFAULT 0,
  state          position_state NOT NULL DEFAULT 'open',
  opened_at      timestamptz    NOT NULL,
  closed_at      timestamptz,
  close_reason   text,
  exit_price     numeric,
  pnl            numeric,
  r_multiple     numeric,
  exit_params    jsonb          NOT NULL DEFAULT '{}'::jsonb,
  meta           jsonb          NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX positions_open_idx ON positions (mode, symbol) WHERE state <> 'closed';

CREATE TABLE orders (
  id                 text         PRIMARY KEY,
  mode               run_mode     NOT NULL,
  exchange_order_id  text,
  order_list_id      text,
  position_id        text         REFERENCES positions(id),
  symbol             text         NOT NULL,
  type               text         NOT NULL,
  side               text         NOT NULL,
  price              numeric,
  stop_price         numeric,
  qty                numeric      NOT NULL,
  status             order_status NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  raw                jsonb
);
CREATE INDEX orders_position_idx ON orders (position_id);

CREATE TABLE fills (
  id         text        PRIMARY KEY,
  order_id   text        NOT NULL REFERENCES orders(id),
  price      numeric     NOT NULL,
  qty        numeric     NOT NULL,
  fee        numeric     NOT NULL DEFAULT 0,
  fee_asset  text,
  ts         timestamptz NOT NULL
);

CREATE TABLE equity_snapshots (
  ts             timestamptz NOT NULL,
  mode           run_mode    NOT NULL,
  balance_quote  numeric     NOT NULL,
  unrealised     numeric     NOT NULL DEFAULT 0,
  drawdown_pct   numeric     NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, ts)
);

CREATE TABLE backtest_runs (
  id           text        PRIMARY KEY,
  strategy_id  text        NOT NULL,
  symbol       text        NOT NULL,
  timeframe    text        NOT NULL,
  params       jsonb       NOT NULL,
  from_ts      timestamptz NOT NULL,
  to_ts        timestamptz NOT NULL,
  metrics      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Same columns as a closed signal so backtest and live trades are compared with the same queries.
CREATE TABLE backtest_trades (
  run_id        text        NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  signal_id     text        NOT NULL,
  ts            timestamptz NOT NULL,
  symbol        text        NOT NULL,
  timeframe     text        NOT NULL,
  entry_price   numeric     NOT NULL,
  stop_price    numeric     NOT NULL,
  tp1_price     numeric,
  tp_price      numeric     NOT NULL,
  actual_entry  numeric     NOT NULL,
  exit_price    numeric     NOT NULL,
  outcome       text        NOT NULL,
  realized_r    numeric     NOT NULL,
  realized_pnl  numeric     NOT NULL,
  fees          numeric     NOT NULL,
  mfe_r         numeric     NOT NULL,
  mae_r         numeric     NOT NULL,
  bars_held     integer     NOT NULL,
  close_reason  text        NOT NULL,
  closed_at     timestamptz NOT NULL,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, signal_id)
);

CREATE TABLE risk_events (
  id      bigserial   PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  mode    run_mode    NOT NULL,
  type    text        NOT NULL,
  detail  jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Engine runtime state (paused flag, news toggle, last heartbeat) — one row per mode.
CREATE TABLE engine_state (
  mode            run_mode    PRIMARY KEY,
  paused          boolean     NOT NULL DEFAULT false,
  news_block      boolean     NOT NULL DEFAULT false,
  last_heartbeat  timestamptz,
  last_candle_at  timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Views for the dashboard
CREATE VIEW v_strategy_scorecard AS
SELECT
  strategy_id, symbol, timeframe, mode,
  count(*)                                                    AS trades,
  count(*) FILTER (WHERE outcome = 'win')                     AS wins,
  count(*) FILTER (WHERE outcome = 'loss')                    AS losses,
  round(avg(realized_r)::numeric, 3)                          AS expectancy_r,
  round((count(*) FILTER (WHERE outcome = 'win'))::numeric
        / NULLIF(count(*) FILTER (WHERE outcome IN ('win','loss')), 0), 3) AS win_rate,
  round(sum(realized_pnl) FILTER (WHERE realized_pnl > 0)
        / NULLIF(abs(sum(realized_pnl) FILTER (WHERE realized_pnl < 0)), 0), 3) AS profit_factor,
  round(avg(mfe_r) FILTER (WHERE outcome = 'loss')::numeric, 3) AS avg_mfe_of_losers,
  round(avg(mae_r) FILTER (WHERE outcome = 'win')::numeric, 3)  AS avg_mae_of_winners,
  round(avg(bars_held)::numeric, 1)                           AS avg_bars_held,
  sum(realized_pnl)                                           AS total_pnl
FROM signals
WHERE outcome IN ('win', 'loss', 'breakeven')
GROUP BY strategy_id, symbol, timeframe, mode;

CREATE VIEW v_open_positions AS
SELECT p.*, s.meta AS signal_meta, s.projected_r
FROM positions p JOIN signals s ON s.id = p.signal_id
WHERE p.state <> 'closed';

CREATE VIEW v_daily_pnl AS
SELECT mode, date_trunc('day', closed_at) AS day,
       count(*) AS trades, sum(realized_pnl) AS pnl, sum(realized_r) AS r
FROM signals
WHERE closed_at IS NOT NULL AND outcome IN ('win', 'loss', 'breakeven')
GROUP BY mode, date_trunc('day', closed_at);
