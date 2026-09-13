# Crypto Day-Trading Automation Tool — Plan

## Context

You used to day-trade crypto manually (support/resistance, indicator confluence, range trading) but work keeps you off the charts. The goal is a locally-run tool that:

1. **Records** every decision: each signal with its projected entry / SL / TP / R and the "why", and later the real outcome (win/loss, realised R, duration, how far it went for and against you). This journal is how you judge what works.
2. **Automates** your style: buy at "low" (support / oversold / bottom of range), exit at a breakpoint with SL and TP, and **trail** both upward as price moves in your favour. The bot runs the trades; you supervise from a dashboard and Telegram.
3. Starts on **Binance spot**, designed so futures/perps can be added later.
4. Uses **both languages**: Python for research, backtesting and signal generation; TypeScript/Node for live execution, dashboard and alerts. They share Postgres and Redis with a versioned JSON contract.

Decisions made so far: Binance; spot first then futures; default 5m/15m entries with a 1h trend filter, all timeframes configurable per strategy; 1% risk per trade, 3% max daily loss; **the first running version places no orders at all** (shadow mode: it records buy points, projected sell points and what happened next, with a dashboard and Telegram notifications).

### Run modes

The engine has one `MODE` setting that gates everything else:

- **shadow** (first): no exchange keys, no orders. Every signal is written to the journal with its projected entry, stop, targets and reasons. The engine then follows live candles with the same exit policy it will use later and marks the hypothetical outcome (would have hit TP1, stopped out, trailed to X, took N hours). Telegram sends a message at each of those points. This is the "is the bot seeing what I would have seen?" phase.
- **paper**: same as shadow plus a simulated wallet, fees and slippage, so equity curves and sizing are exercised.
- **testnet**: real orders against Binance testnet.
- **live**: real money, small capital, hard limits.

Shadow and paper share the same code path; paper only adds the simulated wallet. Nothing above shadow is built until the shadow journal has been reviewed for at least two weeks.

Honest framing: no bot is guaranteed profitable. The pipeline (backtest with fees → walk-forward → shadow → paper → testnet → small live) plus hard risk limits is the real product. Strategies are plugins that must earn their place with data.

---

## Documents in the repo

- `docs/PLAN.md` — this document: goals, decisions, strategy rules, phases.
- `docs/ARCHITECTURE.md` — diagrams, repo tree, runtime flow, message payloads and formulas (all code-like detail lives there).
- `docs/PLAN_BUILD.md` — the full flow of work, milestone by milestone, with done criteria and no timelines.
- `docs/CHECKLIST.md` — the step-by-step checklist, ticked as we go. Every session starts by reading it.
- `docs/DECISIONS.md` — one line per decision with date and reason (e.g. "2026-09-12 spot first: no liquidation risk while learning the bot").

---

## Architecture

Three services and two shared stores. The diagram, repo tree and message shapes are in [ARCHITECTURE.md](ARCHITECTURE.md).

- **Python research service**: ingests Binance klines into Postgres, runs indicators, strategies and backtests, and in live mode evaluates each closed candle and publishes signals to Redis.
- **TypeScript engine**: streams live candles, consumes signals, applies risk limits, follows each signal with the exit policy and, depending on the run mode, either only records what would have happened (shadow) or places and trails orders through a paper, testnet or live adapter. It writes positions, orders and outcomes back to Postgres.
- **TypeScript dashboard and Telegram bot**: read-only views over the database plus manual overrides sent to the engine as commands.
- **Postgres (TimescaleDB)** holds candles, the signal journal, positions, orders, fills, equity and backtest results. **Redis Streams** carry signals, engine events and commands.

Python owns anything that needs pandas or vectorised backtesting. Node owns anything long-running with websockets and order state. They never call each other's code; they only agree on database tables and JSON messages.

### Repo layout

A pnpm workspace for the TypeScript apps and a uv project for Python: engine and dashboard under `apps/`, the research service under `services/`, shared contracts under `packages/`, Docker Compose and SQL migrations under `infra/`, and these documents under `docs/`. Full tree in [ARCHITECTURE.md](ARCHITECTURE.md).

### Tools, libraries, APIs

| Layer             | Choice                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binance access    | `ccxt` in both languages (REST); raw `ws` for kline stream and user data stream                                                                                                                                                                    |
| Python            | `pandas`, `numpy`, `pydantic`, `sqlalchemy` + `psycopg`, `redis`, `typer`; `vectorbt` for sweeps, own event-driven backtester for the exit policy; `optuna` for walk-forward optimisation; `uv`, `ruff`, `pytest`                                  |
| TypeScript        | `zod`, `postgres` (porsager) or `drizzle-orm`, `ioredis`, `decimal.js` (never floats for qty/price), `pino`, `grammy` (Telegram), `fastify` + `react` + `vite`, `lightweight-charts` (candles + overlays) and `recharts` (equity, histograms); `vitest`, `tsx`, `pnpm`                                               |
| Infra             | Docker Compose: `timescale/timescaledb`, `redis:7`; SQL migrations run by `research migrate` (small runner, no dbmate)                                                                                                                             |
| Binance endpoints | klines `GET /api/v3/klines`; kline WS `wss://stream.binance.com:9443/stream`; OCO `POST /api/v3/orderList/oco`; user data stream via listenKey; spot testnet `https://testnet.binance.vision`; futures testnet `https://testnet.binancefuture.com` |
| Keys              | withdrawals disabled, IP-restricted, separate testnet and live keys, never committed                                                                                                                                                               |

Environment notes (checked on this Mac): Python 3.10.2, Node 20.19.4 and 22.14.0 via nvm, Docker running, `uv` installed via brew. The `pnpm` on PATH is a corepack shim for pnpm 11 that crashes on Node 20; Phase 0 must `nvm use 22` or `npm i -g pnpm@9` first.

---

## Strategy rules in detail

All prices/indicators computed on **closed** candles only. Timeframes are **configuration, not code**: each strategy has an `entry_tf` and a `regime_tf` (plus S3's `range_tf`) in a strategy config file, and the same strategy can run several instances with different timeframes side by side (each instance gets its own journal rows and scorecard). Defaults below are 15m entries with a 1h regime filter (S3: 5m entries, 15m range, 1h regime). Changing a timeframe must require no code change, only a config edit and restart; supported values are 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d. Indicator periods (RSI length, ATR length, EMA lengths, swing width) are config too, with the defaults stated in each strategy.

### Shared regime filter (1h)

- **Trend OK**: 1h EMA(50) > EMA(200) and 1h close > EMA(50). (Long-only on spot.)
- **Volatility OK**: 1h ATR(14) / close between 0.3% and 3%. Too quiet = fees eat you; too wild = stops get hunted.
- **No-trade windows** (config): first 15 min after 00:00 UTC daily open, and a manual "news" toggle from Telegram.

### S1 — Support/resistance bounce (15m) — the MVP strategy

1. **Levels** from 1h swing points: a swing low is a bar whose low is the lowest of 5 bars either side (confirmed 5 bars later, so no look-ahead). Cluster swings within 0.25% into one level. Keep levels touched ≥ 2 times in the last 30 days, drop levels broken by a 1h close 0.5% below.
2. **Entry** when a 15m candle: (a) low comes within 0.3% of a support level, (b) closes bullish above the level, (c) lower wick ≥ 50% of the candle range (rejection), (d) 15m RSI(14) < 45.
3. **Stop**: the lower of 0.25% below the level and a tenth of an ATR below the candle low. If the resulting risk is more than 1.5% of price, skip (level too far).
4. **Target**: next resistance level above. Require projected R ≥ 1.5 else skip. TP1 at +1R (sell 50%).
5. **Invalidation**: a 1h close below the level closes the remainder at market (regime exit).

Worked example (BTC 15m): support 60,850; candle low 60,900, close 61,234, wick 62% of range, RSI 38 → entry ≈ 61,234 (market). SL = min(60,698, 60,900 − 21) = 60,698 → risk 536 (0.88%). Next resistance 62,500 → R = 2.36 ✓. TP1 = 61,770. Size = (equity × 1%) / 536.

### S2 — Indicator confluence (15m)

1. Regime filter passes.
2. **Entry** when all in the same or the previous 3 bars: RSI(14) crosses back **up** through 30; close touched or went below lower Bollinger(20, 2); MACD histogram rising (hist[i] > hist[i−1]).
3. **Stop**: entry − 1.5 × ATR(14). **Target**: entry + 2 × risk (R = 2). TP1 at +1R.
4. **Time stop**: 24 bars (6h) if breakeven not reached.

### S3 — Range / grid (5m entries, 15m range)

1. **Ranging regime**: 1h ADX(14) < 20 and 1h Bollinger width in the bottom 40% of its 30-day distribution. Trend filter is _not_ required (ranges happen in chop).
2. **Range**: highest high / lowest low of the last 48 × 15m bars (12h). Require range height ≥ 3 × ATR15m so there is room after fees.
3. **Entry**: 5m close in the bottom 20% of the range and bullish (close > open). One entry per range touch; optional ladder of up to 3 entries 0.5 × ATR apart (config).
4. **Stop**: range low − 0.5 × ATR. **TP1**: range midpoint (sell 50%). **TP2**: top 20% of range. Trailing off by default (mean reversion), configurable `trail_atr_k`.
5. **Exit** remainder at market if 1h ADX rises above 25 (range breaking).

### S4 — Dump bounce (15m, from the pattern research)

The only rule from the [pattern research](#pattern-research-findings) that held up out of sample on intraday bars, written as a strategy (`dump_bounce`, instances `s4_btc_15m` and `s4b_btc_15m`, disabled until the walk-forward confirms it). No trend filter: the dump is the regime.

1. **Trigger, mode `dump`**: the coin's own return over the last 96 × 15m bars (24h) is ≤ −5% and ATR(14) is ≥ 2% of price. **Mode `crash_bounce`**: the close is ≥ 35% below its 30-day high and ≥ 5% above its 20-bar low.
2. **Entry**: close of the qualifying bar, filled at the next open. One position per instance; the next entry waits for the exit.
3. **Stop**: entry − 2 × ATR. **Target**: entry + 2 × risk (4 ATR). **Time exit**: 96 bars, so every trade closes within 24h (the average one in about 8h).
4. **Exit policy**: pure barriers as in the research: no partial TP1, no breakeven move, no trailing (config `tp1_fraction: 0`, `breakeven_r: 99`, `trail_atr_k: null`). Whether trailing helps is a walk-forward question, not an assumption.
5. **Sizing caveat**: a 2 ATR stop on a coin with ATR > 2% is a 4–8% stop; `max_risk_pct` is 12 for this strategy, and at 1% risk the position is 12–25% of equity, inside the 25% notional cap.

### Shared exit policy (the SL/TP + trailing)

State machine per position, evaluated on each closed candle; hard SL checked against the bar's low, worst-case ordering (stop before TP in the same bar).

| State     | Rule                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| open      | initial SL/TP from the strategy; TP1 at +1R                                                                                           |
| breakeven | when close ≥ entry + 1R → SL = entry + round-trip fees                                                                                |
| trailing  | after TP1 fills → SL = max(SL, highest_high − k × ATR), k = 2 default; TP ratchets to highest_high + 1 × ATR so runners aren't capped |
| closed    | via stop, TP, time stop, regime invalidation, manual, or kill                                                                         |

Reference implementation in Python; identical port in TypeScript; both run the same JSON fixtures in CI (this is the key cross-language test).

### Position sizing & portfolio limits

- Quantity = 1% of equity divided by the distance from entry to stop, capped at 25% of equity notional, rounded **down** to the symbol's step size; skip if below the exchange's minimum quantity or notional. Formula in [ARCHITECTURE.md](ARCHITECTURE.md).
- Max 3 open positions, max 1 per symbol, daily loss ≥ 3% → pause until next UTC day, 3 consecutive losses → 2h cooldown. Every rejection is journaled with its reason.

---

## Order handling on Binance spot

1. **Entry**: market buy (S1/S2) or limit at signal price with a 2-candle TTL (S3). Idempotent `newClientOrderId = signal_id` so a retry never double-buys.
2. **Fill accounting** from the user data stream `executionReport`: `actual_entry` = quote spent / base received. If the fee asset is the base coin (no BNB discount) the **sellable qty = filled − fee**; if fees are in BNB the full qty is sellable. Get this wrong and every OCO is rejected for insufficient balance.
3. **Protection** placed immediately after fill, as **two OCO sell orders** (Binance OCO cannot do partial TPs, but two OCOs on half the qty each are allowed):
    - OCO-A: 50% qty, limit (TP1), stop = SL, stopLimit = SL × (1 − 0.2%)
    - OCO-B: 50% qty, limit (TP2), stop = SL, stopLimit = SL × (1 − 0.2%)
      Binance rule for a sell OCO: limit price > current price > stop price; if the market has already moved past that, fall back to a plain stop-loss-limit + separate TP limit and alert.
4. **Trailing / breakeven updates** once per candle close: if new SL > old SL by at least 1 tick and 0.05%: cancel OCO-B (`orderListId`), confirm cancelled, **re-check fills** (price may have hit during the gap), then place the new OCO-B with the new SL and ratcheted TP. Never more than one replace per candle per position.
5. **Invariant**: no open position without an exchange-side stop. If OCO placement fails 3 times → market-sell the remainder and alert. Reconciliation on start and every 5 min: `fetchOpenOrders` + `fetchBalance` vs DB; a DB position with no exchange stop is re-protected immediately; unknown open orders raise an alert and pause new entries.
6. **Precision**: from `exchangeInfo` filters `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize/minQty`, `NOTIONAL.minNotional`, `PERCENT_PRICE_BY_SIDE`. Prices rounded to tick, quantities rounded down to step, all with `decimal.js`.
7. **Streams**: kline WS (public), user data stream (listenKey, keep-alive every 30 min, reconnect before the 24h cut). Poll `fetchOrder` every 60s as a fallback for missed fills.
8. **Rate limits**: 6000 request weight per minute per IP (klines cost 2, most order calls 1), 50 orders per 10 seconds, 160k orders per day. WebSocket: 1024 streams per connection, 300 connections per 5 minutes, forced disconnect every 24h with a ping every 20s. Our load is a handful of calls per hour; log the `X-MBX-USED-WEIGHT` header anyway, back off on HTTP 429, and treat 418 as a ban.
9. **Reconnect gap fill**: after every WebSocket reconnect, fetch the missed candles over REST before evaluating strategies, so a dropped connection never produces a missing or partial candle in the journal.
10. **Paper adapter**: fills a market order at the next candle open + 0.05% slippage, fee 0.1%; simulates OCOs against candle high/low with the same worst-case ordering as the backtester. Paper and backtest must agree on the same candles.
11. **Testnet** (`testnet.binance.vision`): supports OCO and user data stream; liquidity is thin so expect odd fills. Used to validate the mechanics, not the strategy.
12. **Futures later**: same adapter interface; `STOP_MARKET` + `TAKE_PROFIT_MARKET` with `reduceOnly`, optional exchange-native `TRAILING_STOP_MARKET`, leverage cap, liquidation-distance check.

---

## Data & dashboard schema

### Historical candle data

Binance **spot** klines, public endpoint (no keys), stored in `candles` and backfilled by `research ingest`. Status as of 2026-09-13; full counts and commands in [DATA.md](DATA.md).

**Universe.** The bot does not watch every Binance pair: of ~400 crypto USDT pairs the median trades $0.4M a day with a 0.15% spread, which is a guaranteed ~−0.3R per trade before the strategy gets a vote. `research universe` keeps the fourteen pinned coins below plus every pair whose 30-day average volume is above $10M with a spread under 0.05% (about 30 coins in total, refreshed weekly by a pm2 cron job; details in [DATA.md](DATA.md)). More liquid coins means more signals for the journal without paying the spread tax.

**Pinned coins** (14, always watched, each with a hand-written S1 instance in `config/strategies.yaml`):

| coin | history from | why that date |
|---|---|---|
| BTCUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, TRXUSDT, LINKUSDT, AVAXUSDT, XLMUSDT, ALICEUSDT | 2021-04-01 | requested start |
| SHIBUSDT | 2021-05-10 | Binance spot listing (the futures ticker `1000SHIBUSDT` has no spot market) |
| C98USDT | 2021-07-23 | Binance spot listing |
| ENAUSDT | 2024-04-02 | Binance spot listing |

**Timeframes and depth:**

| timeframe | depth | purpose |
|---|---|---|
| 15m, 30m, 1h, 2h, 4h, 1d | every coin, from the date above to now | backtesting and walk-forward across five years of bull, bear and range markets; 1h is also the S1/S2 regime filter |
| 1m | original ten coins since 2023-01-01; the four new coins ~500 bars | dashboard chart |
| 5m | BTCUSDT since 2025-01-01; other coins ~500 bars | S3 entries |

Rules for this data:

- History is written by Python (`research ingest`); the TypeScript engine only appends live closed candles and gap-fills after a disconnect. Same upsert rule on both sides.
- The engine streams only the timeframes strategies or the chart use (currently 1m, 5m, 15m, 1h, 4h), so 30m, 2h and 1d stop growing after the backfill unless re-ingested or put to use.
- S1/S2 backtests can start at each coin's history date: the 1h regime data reaches back as far as the 15m entries. The first usable signal comes about 40 days later, once the 200-bar EMA and the 30-day level lookback have warmed up.
- Re-running ingest is safe and idempotent; it fills backwards to `--since` and forwards to the last closed candle.
- The only missing candles are Binance exchange-wide downtime: 12 hours between 2021-04-20 and 2023-03-24, the same for every coin listed at the time. Exact hours are in [DATA.md](DATA.md).

### Pattern research findings

Run on 2026-09-13 over the 14 pinned coins since 2021 (pipeline and commands in [DATA.md](DATA.md#pattern-research-what-preceded-good-trades); reports in `docs/research/`). The question was "when was it good to buy or sell, and does that knowledge hold in years it was not learned from?". The goal is not 90% accuracy, which no liquid market offers, but a positive expectancy per trade after fees on enough trades out of sample.

**1. Fees decide the timeframe.** A trade at every bar loses money in every setting, and the loss is mostly the exchange's cut, measured against the stop distance:

| setting | fees + slippage per trade | expectancy of a random entry, net | gross |
|---|---|---|---|
| 15m, stop 1 ATR, target 2 ATR, 24 bars | 0.76 R | −0.54 R (long) / −0.50 R (short) | +0.22 / +0.26 |
| 15m, stop 2 ATR, target 4 ATR, 96 bars | 0.23 R | −0.29 R / −0.23 R | −0.06 / −0.00 |
| 1h, stop 1.5 ATR, target 3 ATR, 48 bars | 0.14 R | −0.20 R / −0.12 R | −0.06 / +0.02 |

Gross of fees the market is a coin flip; the 15m tight setting pays three quarters of a stop to the exchange on every trade, so no condition can rescue it. This is the same conclusion as the S1 v1 backtest (stops too tight for a 0.2% round trip), now measured across 2.5 million bars.

**2. No single condition is robust.** In the descriptive reports (`explain_*.md`) nothing clears t ≥ 3 with positive expectancy in ≥ 70% of coins and years, in any setting. RSI, EMA distance, hour of day, weekday, volume ratio, wick size: each shifts expectancy by a few hundredths of an R at most. Whatever edge exists is in combinations.

**3. Four combinations hold out of sample, all on 1h bars.** Rules mined on 2021–2023, scored on 2024–2026 as non-overlapping trades per coin, net of fees. ROBUST = positive in every test year and in ≥ 60% of coins.

| side | rule | test exp R | trades | per month | coins + | 2024 / 2025 / 2026 |
|---|---|---|---|---|---|---|
| long | 30-day drawdown < −35% and price ≥ 7.2% above its 20-bar low | +0.135 | 574 | 19 | 92% | +0.09 / +0.10 / +0.37 |
| long | ATR > 2.42% of price and BTC down > 2.9% in 24h | +0.124 | 976 | 31 | 100% | +0.19 / +0.04 / +0.11 |
| long | 30-day drawdown < −35% and BTC down > 2.9% in 24h | +0.078 | 1,077 | 36 | 77% | +0.13 / +0.02 / +0.11 |
| short | price < 5% above its 30-day low and 30-day drawdown between −35% and −27% | +0.115 | 758 | 25 | 79% | +0.21 / +0.01 / +0.26 |

They tell one story: **sell the breakdown, buy the first bounce after a crash.** A coin making a fresh 30-day low after a 27–35% fall keeps falling (short); a coin that has fallen more than 35% and already bounced 7% off its low, or any high-volatility coin on a day BTC dropped hard, recovers (long). The gradient-boosting ceiling agrees: the features it leans on are rise from the 30-day low, ATR %, 30-day drawdown and BTC's trend, in both directions, and its most selective threshold on 1h shorts made +0.124 R over 893 trades (though it lost in 2026).

**Is 35% too deep?** The threshold is the bottom-eighth bucket of 30-day drawdowns on 2021–2023, so one bar in eight across these coins was that deep; altcoins fall a lot. Sweeping the threshold on the same test years (long: drawdown < X and price ≥ Y above its 20-bar low; short: within 5% of the 30-day low and drawdown in a band) shows the edge *is* the depth of the crash, not an artefact of the bucket edge:

| long rule | test exp R | trades | robust? |
|---|---|---|---|
| drawdown < −20%, bounce ≥ 7.2% | −0.018 | 1,726 | no |
| drawdown < −25%, bounce ≥ 7.2% | +0.007 | 1,300 | no |
| drawdown < −30%, bounce ≥ 7.2% | +0.042 | 925 | yes |
| drawdown < −35%, bounce ≥ 5% | +0.099 | 969 | yes (86% of coins) |
| drawdown < −35%, bounce ≥ 7.2% | +0.134 | 585 | yes |
| drawdown < −40%, bounce ≥ 5% | +0.142 | 517 | yes (92% of coins) |

The short side mirrors it: drawdown −10..−20% loses −0.26 R per trade, −20..−27% loses −0.06, −27..−35% makes +0.125, and anything deeper than −27% makes +0.08 on 1,338 trades. A coin down 15–25% is ordinary crypto noise and buying or shorting it has no edge; the edge starts around −30% and grows with depth, at the price of fewer trades. The relaxation that costs nothing is the bounce, not the drawdown: −35% with a 5% bounce keeps the robustness and gives 65% more trades than the mined rule.

**Day-trading version (same ideas, trades closed within 24h).** The 1h rules hold for up to 48 bars, a two-day swing. Re-tested on the 15m labels with a 2 ATR stop, 4 ATR target and 24h limit (2024–2026, non-overlapping trades, net of fees):

| 15m rule, max 24h | test exp R | trades | per month | avg hold | coins + | 2024 / 2025 / 2026 |
|---|---|---|---|---|---|---|
| BTC down > 2.9% in 24h and coin ATR > 2.0% of price | +0.267 | 502 | 16 | 8h | 100% | +0.37 / +0.09 / +0.31 |
| BTC down > 2.9% in 24h and coin ATR > 1.5% | +0.155 | 1,123 | 35 | 7.6h | 92% | +0.19 / +0.11 / +0.15 |
| drawdown < −40%, price ≥ 5% above its 5h low | +0.147 | 542 | 19 | 8h | 75% | +0.22 / +0.10 / +0.16 |
| drawdown < −35%, price ≥ 5% above its 5h low | +0.062 | 973 | 32 | 8h | 93% | +0.10 / +0.01 / +0.12 |
| short: near 30-day low, drawdown −27..−35% | −0.013 | 1,424 | 46 | 4.8h | 36% | not robust |

The 1h rules themselves do not survive a shorter time limit: relabelled with a 12h or 24h cap, the crash-bounce longs and the short go to about zero and only the BTC-dump long stays robust at +0.07 R. Yet with the 48h cap their average trade already closes in 10–16 hours; the two-day room is there for the minority of trades that need it, and cutting it both truncates those and lets the coin re-enter sooner at worse odds (trade counts triple, expectancy collapses). So on 1h the 48-bar limit stays; the same-day form of these ideas is the 15m table above. With a 1 ATR stop and 6h limit every one of these loses (fees 0.76 R per trade); the BTC-dump rule with ATR > 2% is the only one still positive (+0.117 R) and it is not robust. So the intraday form needs the wider stop and a full day of room; the average trade still closes in about eight hours. The short side does not work intraday at all. Two cautions: the ATR thresholds here were chosen with the test years in view (the mined rule on 1h used ATR > 2.42%), so the walk-forward must confirm them; and the BTC-dump rule fires on every coin on the same few days, so the portfolio cap on concurrent positions, not the signal count, decides how many of those trades are taken.

**As a strategy (S4, `dump_bounce`), backtested on all 32 coins from 2024-01-01** with next-open fills, 0.05% slippage, 0.1% fees per side and one position per coin at a time (`research backtest s4_btc_15m --symbol all --since 2024-01-01`):

| mode | trades | win rate | expectancy | total | max drawdown | profit factor | coins positive |
|---|---|---|---|---|---|---|---|
| `dump` (24h return ≤ −5%, ATR ≥ 2%) | 1,338 | 44% | **+0.159 R** | +212.8 R | −39.6 R | 1.28 | 25 of 31 that traded |
| `crash_bounce` (down 35% in 30d, 5% off the low) | 3,078 | 36% | −0.030 R | −92.1 R | −188.2 R | 0.96 | 15 of 31 |

The dump mode carries over from the research (+0.267 R on the 14 original coins) to the 17 coins the rules never saw, losing money only on the newest and wildest listings (TUT, PENGU, ONDO, XPL, PUMP, DASH). The crash-bounce mode does not: it is roughly break-even on the original 14 and loses heavily on the new ones (PUMP −48 R, WLD −34 R, LTC −34 R), because a coin that stays 35% down for weeks keeps re-qualifying and the strategy keeps re-entering. It is kept in the code as a documented failure, not a candidate. Exit mix for the dump mode: 53% stopped, 33% target, 14% closed by the 24h clock. After the one-year listing-age rule trimmed the universe to 28 coins the same backtest gives +0.203 R over 1,107 trades (+225 R).

**Walk-forward (the real test), dump mode, 28 coins, 2022-01 → 2026-09**, 180-day training windows choosing among six parameter combinations (24h drop ≤ −3/−5/−8%, ATR ≥ 1.5/2%), each followed by a 90-day test window; only test-window trades count (`research walkforward s4_btc_15m --symbol all --since 2022-01-01 --train-days 180 --test-days 90`):

| | pooled out of sample |
|---|---|
| trades | 2,637 |
| win rate | 43% |
| expectancy | **+0.114 R** |
| total | +300.9 R |
| max drawdown | −28.3 R |
| profit factor | 1.20 |
| coins positive | 22 of 28 (losers: ONDO, PENGU, TAO, NEAR, ENA, BCH) |

Lower than the fixed-parameter backtest because the training windows sometimes pick a looser setting that the next quarter punishes, which is exactly the honesty a walk-forward buys. **Verdict: positive out of sample across four years and most coins. S4 dump mode is enabled in shadow for the 14 pinned coins as of 2026-09-13**; the crash-bounce instance stays disabled. Next gates: shadow signals match the backtester on the same bars, then paper.

**4. What this is worth, honestly.** 30 rules and 5 model thresholds were tried per report, so about two would look positive by luck; the three long rules share their conditions and are one edge, not three; 2025 was thin for all four (+0.01 to +0.10 R); and +0.12 R per trade at 1% risk is roughly 0.1% of equity per trade with 40–70 R drawdowns along the way. That is an edge to build a strategy on, not an income. Fifteen-minute bars produced nothing robust in either direction.

**Next:** implement the two 1h ideas as a strategy class (entry on the rule, 1.5 ATR stop, 3 ATR target, 48-bar time exit, no regime filter of its own since the rule is the regime), run it through `research backtest` and `walkforward` on the 31-coin universe, and only then give it instances in `strategies.yaml`. The 1h data for the 17 auto-added coins goes back to 2021, so it is a genuine second test set the rules have never seen.

### Tables (Postgres / TimescaleDB, one `mode` column = shadow | paper | testnet | live on every row the engine writes)

- `candles(symbol, timeframe, open_time, open, high, low, close, volume, closed)` — hypertable. Python writes history, TS writes live.
- `signals` — **the journal**, one row per strategy decision:
    - projection (Python): `id` (deterministic: strategy:symbol:tf:candle_time), `ts, strategy, symbol, timeframe, side, entry_type, entry_price, stop_price, tp_price, tp1_price, projected_r, confidence, meta` (indicator snapshot / level / reasons)
    - outcome (TS, written on reject or close): `outcome` (win | loss | breakeven | rejected | expired), `reject_reason, position_id, actual_entry, slippage_pct, exit_price, realized_r, realized_pnl, fees, mfe_r, mae_r, bars_held, duration_s, close_reason, closed_at`
- `positions(id, mode, signal_id, symbol, strategy, side, entry_price, qty, remaining_qty, sl_price, tp_price, tp1_price, tp1_done, highest_high, lowest_low, bars_held, state, opened_at, closed_at, close_reason, pnl, r_multiple, meta)`
- `orders(id, mode, exchange_order_id, order_list_id, position_id, symbol, type, side, price, stop_price, qty, status, created_at, updated_at, raw)`
- `fills(id, order_id, price, qty, fee, fee_asset, ts)`
- `equity_snapshots(ts, mode, balance_quote, unrealised, drawdown_pct)` — hourly + on every close
- `backtest_runs(id, strategy, symbol, timeframe, params, from_ts, to_ts, metrics, created_at)` + `backtest_trades(run_id, …same columns as a closed signal…)` so backtest and live trades are compared with the same queries
- `risk_events(id, ts, env, type, detail)` — pauses, kill switches, reconciliation mismatches
- `schema_migrations(name, applied_at)`

### SQL views for the dashboard

- `v_strategy_scorecard`: per strategy × symbol × mode: trades, win rate, expectancy (avg R), profit factor, avg MFE of losers, avg MAE of winners, median time to TP1, max drawdown.
- `v_open_positions`: with live unrealised R and distance to SL/TP.
- `v_daily_pnl`: per mode per UTC day.
- `v_rejected_would_have_won`: rejected signals whose TP would have been hit before SL on subsequent candles (computed by a nightly Python job).

### Dashboard pages

1. **Chart** — a candlestick chart drawn from our own candles table (TradingView Lightweight Charts, open source), updating live over the dashboard WebSocket. Overlays: a marker on every candle where a signal fired (hover shows the reason), entry / stop / TP1 / TP2 lines for signals in flight, the trailing-stop path as it moved, and the support and resistance levels the strategy detected. Symbol and timeframe selectable from the configured set. A link opens the same symbol on TradingView for manual analysis; Binance itself cannot be embedded because it blocks iframes.
2. **Overview** — equity curve, today's PnL vs the 3% limit, open positions with SL/TP lines, engine status (mode, paused?, last candle, last heartbeat).
3. **Journal** — every signal, filterable by strategy/symbol/outcome, expandable "why" panel with indicator snapshot and a mini-chart of the trade (same chart component, zoomed to the trade).
4. **Scorecard** — the view above as a table plus R-distribution histogram per strategy.
5. **Backtests** — runs list, metrics, equity curves, side-by-side with live results for the same window; backtest trades can be replayed on the Chart page.
6. **Controls** — pause / resume / close position / close all / kill; also available as Telegram commands `/status /pause /resume /close SYMBOL /kill`.

### Message contracts

Three Redis streams, each with a versioned JSON Schema in `packages/contracts` from which zod and pydantic models are generated: **signals** (Python to engine), **engine events** (engine to dashboard and Telegram) and **engine commands** (dashboard and Telegram to engine). The producer validates on write, the consumer validates on read, and an unknown version is rejected and logged. Example payloads and the full list of event and command types are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## MVP scope and phase order

**MVP = shadow mode: one strategy (S1) on one symbol (BTCUSDT), no orders, every buy point and projected sell point marked in the database and followed to its outcome, viewed on a dashboard and pushed to Telegram.** Execution (paper wallet, testnet, live) comes only after the shadow journal has been reviewed for at least two weeks.

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| M0 Scaffold | repo layout, docker compose, migrations, contracts codegen, strategy config file, CI lint/test | tests green on an empty project |
| M1 Data | historical ingest for the configured symbol and timeframes; engine streams live candles into the same table | Python and TS read the same row for the same candle time |
| M2 Backtest | exit policy (Python + TS, shared fixtures), S1 strategy, event-driven backtester with fees and slippage, metrics, walk-forward split, results stored | S1 beats buy-and-hold and random-entry baselines out-of-sample after fees, or we iterate on S1 first |
| M3 Shadow live | signal runner writes signals and publishes them; engine in shadow mode follows each signal on live candles with the exit policy and marks the hypothetical outcome; Telegram notification at signal, TP1, stop, trailing moves and close | two weeks of shadow signals; shadow outcomes match a backtest over the same window |
| M4 Dashboard v1 | Overview, Journal, Scorecard pages over the shadow journal; pause/resume via Telegram | you can review a week of signals without opening a terminal |
| M5 Paper wallet | simulated balance, fees, slippage, sizing, equity snapshots, daily-loss pause | paper equity curve reproduces the shadow journal's R values |
| M6 Testnet | Binance spot adapter, two-OCO protection, cancel/replace, user data stream, reconciliation | kill the engine mid-position, confirm exchange stop survives, restart re-adopts it |
| M7 Live small | live keys, small capital, 1%/3% limits enforced | one month live with journal reviewed weekly |
| M8 More strategies | S2, S3, extra timeframe instances, parameter optimisation, rejected-would-have-won job, Backtests and Controls pages | each strategy instance has its own scorecard |
| M9 Futures | futures adapter, shorts, leverage cap, liquidation check | strategy and exit code unchanged |

---

## Verification

- **Unit**: exit policy fixtures produce identical event streams in Python and TS; position sizing; precision rounding; contract validation both sides.
- **Backtest sanity**: baselines (buy-and-hold, random entry with same exit policy) reproducible; strategy must beat both out-of-sample after fees.
- **Integration (shadow)**: start infra → ingest → backtest → run the signal runner and engine in shadow mode → a signal appears in the journal, is followed on live candles, closes with an outcome; Telegram messages received at each step.
- **Integration (paper and up)**: same flow with a position opening, trailing and closing against the wallet or exchange.
- **Testnet**: place / cancel / replace OCO; engine killed mid-position keeps exchange stop; restart reconciles.
- **Ops**: engine under `pm2` or launchd; hourly heartbeat; alert if no candle for 3 minutes or no heartbeat for 10.

## Risks / open decisions

- Overfitting: walk-forward + paper period; never tune on the validation window.
- Laptop uptime (sleep, wifi): exchange-side OCO protects open positions; a small VPS is an option after M6.
- Spot is long-only until M8.
- Two-OCO protection doubles order count; if Binance rejects for balance rounding, fall back to one OCO at TP2 and a bot-managed TP1.

---

## Decisions and checklist

- Decisions log: [DECISIONS.md](DECISIONS.md)
- Step-by-step checklist: [CHECKLIST.md](CHECKLIST.md)
