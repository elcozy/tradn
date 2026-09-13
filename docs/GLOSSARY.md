# Glossary

Every abbreviation and term used in the code, the config, the dashboard and the research reports, with a worked example where numbers help. The example bar is a real one from the BTC labels: 2026-07-22 22:30 UTC, 15-minute candle.

## Prices and sizing

**Candle / bar** — one time slot of price data: open, high, low, close, volume (OHLCV). A "15m bar" covers fifteen minutes. Everything in the bot works on *closed* bars; the bar still forming is never used.

**Timeframe (tf)** — the length of a bar: 1m, 5m, 15m, 1h, 4h, 1d. A strategy has an *entry timeframe* (where it looks for trades) and a *regime timeframe* (slower, where it checks the trend).

**ATR — Average True Range.** How far the price typically moves in one bar, averaged over the last 14 bars (the "true range" of a bar is its high−low, widened to include any gap from the previous close). It is a volatility ruler in price units, so a rule like "stop 1 ATR below entry" adapts to each coin: a quiet coin gets a tight stop, a jumpy one a wide stop.
Example: BTC's 15-minute ATR on the example bar was **128.95 USDT**, or 0.195% of the price.

**Entry** — the price the trade is bought at. In backtests and labels: the *next* bar's open, plus slippage. Example: **65,994.98**.

**Stop (SL, stop loss)** — the price at which the trade is closed for a loss. Example: entry − 1 ATR = **65,866.03**.

**Target (TP, take profit)** — the price at which the trade is closed for a profit. Example: entry + 2 ATR = **66,252.88**. TP1 is a partial target (half the position sold at +1 R); TP or TP2 is the final one.

**R — one unit of risk.** The distance from entry to stop, in price. Every result is expressed as a multiple of it so trades on different coins and prices can be compared.
Example: 65,994.98 − 65,866.03 = **128.95 USDT = 1 R** (with a 1-ATR stop, 1 R *is* the ATR). A target 2 ATR away is +2 R; being stopped out is −1 R; "+0.36 R" means the trade made 36% of what it risked.

**Risk amount** — how much money 1 R is worth for a real position: `equity × per_trade_pct` (1% of equity by default), which sets the quantity: `qty = risk amount / (entry − stop)`. On spot with no leverage the quantity is also capped by `notional_cap_pct` (25% of equity), so the *effective* risk can be less than 1%.

**Notional** — quantity × price, the money actually put into a position.

**Slippage** — the difference between the price you expected and the price you got. Modelled as 0.05% against you on the entry (`paper.slippage_pct`).

**Fee** — Binance spot charges 0.1% of the notional on every fill, buy and sell (`fee_pct: 0.1`). In R terms the round trip costs `0.1% × (entry + exit) / (entry − stop)`.
Example: 0.1% × (65,994.98 + 65,866.03) = 131.86 USDT = **1.02 R** — on a 1-ATR 15m stop the fees are larger than the stop itself. That is why tight stops on fast timeframes lose even when the pattern is right.

**Spread** — the gap between the best bid and best ask on the order book, as a % of price. A market order pays it. The universe filter requires < 0.05%.

**Tick size / step size / min notional** — Binance's precision rules per pair: prices must be multiples of the tick, quantities multiples of the step, and an order must be worth at least the minimum notional (about 5 USDT).

## Outcomes and metrics

**Gross R / net R (realized_r)** — the trade's result in R before / after fees. Example: stopped out, gross **−1.00 R**, net **−2.02 R**.

**Win rate** — the share of trades with net R > 0. Alone it says nothing: a 90% win rate with tiny targets and huge stops loses money.

**Expectancy** — the average net R per trade. The number that decides whether a rule makes money. −0.40 R means losing 40% of the risked amount per trade on average; anything durable above 0 is an edge.

**Profit factor (PF)** — gross profit of the winners divided by gross loss of the losers. Above 1 is profitable.

**Max drawdown (maxDD)** — the largest fall in cumulative R (or equity) from a peak before a new peak.

**MFE / MAE — Maximum Favourable / Adverse Excursion.** How far the price went in the trade's favour / against it while it was open, in R. A losing trade with MFE of 1.5 R got three quarters of the way to a 2 R target before turning; that tells you about target placement.

**Bars held / duration** — how long the trade was open.

**Close reason** — why it ended: `stop`, `take_profit`, `trailing` (a stop that had been moved up), `time` (time limit), `regime` (the trend filter turned against it), `manual`, `kill`.

**Outcome** — in the journal: `win`, `loss`, `breakeven` (|R| ≤ 0.05), `rejected` (the risk manager refused the signal), `expired`.

**Base rate** — in the research reports, the expectancy of entering at *every* bar, i.e. at random. Negative by construction (fees). A condition's **lift** is its expectancy minus the base rate.

**t (t-statistic)** — mean ÷ standard error; how far a bucket's expectancy is from zero in units of its own noise. Roughly, |t| ≥ 3 means the number is unlikely to be luck.

**cov % (coverage)** — what share of all bars fall in a bucket. High expectancy on 0.1% coverage is a handful of trades.

**coins + / years +** — the fraction of coins / calendar years in which the bucket's expectancy was positive. A real edge shows up in most of them; a fluke shows up in one.

**OOS — out of sample.** Results on data the rule was *not* designed or tuned on. Only OOS numbers count.

**PASS / ROBUST (forward-test reports)** — PASS: positive OOS expectancy on at least 300 trades. ROBUST: PASS and positive in every test year and in at least 60% of coins. With 35 rules tried per report, about two would PASS by luck alone; ROBUST is the bar that matters.

**Non-overlapping trades** — how forward tests count trades: a coin cannot enter again while its previous trade is still open, so the trade count is what could actually have been taken, not one per bar.

**Walk-forward** — optimise parameters on a training window, test on the following window, slide forward, report only the test windows stitched together.

**Look-ahead (bias)** — using information that was not available at the time of the decision. The most common way a backtest lies. Features are computed only from bars up to and including the current one; labels use the future on purpose and are never features.

## Indicators

**EMA (Exponential Moving Average)** — a smoothed price that weights recent bars more. EMA50 > EMA200 with price above EMA50 is the bot's definition of an uptrend (the *regime filter*).

**RSI (Relative Strength Index)** — momentum oscillator from 0 to 100; below 30 is "oversold", above 70 "overbought". S1 requires RSI < 45 at entry.

**Bollinger Bands (BB)** — a 20-bar moving average ± 2 standard deviations. `bb_pos` (%B) is where price sits between the bands (0 = lower band, 1 = upper); `bb_width` measures how squeezed the bands are.

**MACD** — difference between a 12- and a 26-bar EMA, with a 9-bar signal line; the histogram is their gap. Used by S2.

**ADX** — trend strength from 0 to 100; below 20 means no trend (ranging). Used by S3's regime.

**Swing high / low, level** — a bar whose high/low is the extreme of N bars either side. Clusters of swing lows form *support* levels, swing highs *resistance*. S1 buys bounces off support.

**Wick** — the part of a candle outside its body (open→close). A long lower wick means price fell and was bought back up within the bar: a rejection.

## Strategies and modes

**S1 `sr_bounce`** — support/resistance bounce (15m entries, 1h regime). **S2 `indicator_confluence`** — RSI + Bollinger + MACD agreeing. **S3 `range`** — buying the bottom of a 15m range with 5m entries in a non-trending 1h regime.

**Instance** — one strategy on one coin and timeframe with its own parameters, e.g. `s1_btc_15m`. Each has its own journal rows and scorecard.

**Regime** — the market state the slower timeframe is in: trending up (trade allowed), or not.

**Signal** — a strategy's decision to buy, with entry, stop, targets, projected R and its reasons. Written to the journal whether or not it is taken.

**Shadow / paper / testnet / live** — the run modes: record only; simulated wallet; real orders on Binance's test exchange; real money.

**OCO — One-Cancels-the-Other.** A Binance order pair (take-profit limit + stop) where filling one cancels the other. The bot's exchange-side protection.

**Universe** — the list of coins the bot watches: the pinned ones plus every pair liquid enough (30-day volume > $10M, spread < 0.05%), refreshed weekly.

**Triple barrier (labels)** — the research labelling rule: a hypothetical trade at every bar with a stop, a target and a time limit; the first one hit is the outcome.

**Journal** — the `signals` table: every decision and what happened next. The dataset everything is judged on.
