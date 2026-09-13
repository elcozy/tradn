# Forward test — 15m short, short_s2_t4_h96

Train: bars before 2024-01-01 (1,238,845 bars, base rate -0.227 R). Test: bars from 2024-01-01 (1,315,918 bars, base rate -0.259 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**2 selection(s) stay positive out of sample with ≥ 300 trades, 0 of them robust:**

- **pass** atr_pct in 1.2..inf & up_from_low_30d in -inf..4.97: +0.028 R over 787 trades, 26.5/month, positive in 57% of coins; by year: 2024 -0.03, 2025 +0.02, 2026 +0.13
- **pass** up_from_low_30d in 51.8..inf & btc_ret_24h in 1.44..3: +0.018 R over 1,770 trades, 54.7/month, positive in 77% of coins; by year: 2024 -0.05, 2025 +0.11, 2026 +0.29

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| atr_pct in 1.2..inf & up_from_low_30d in -inf..4.97 **PASS** | +0.028 | 787 | +0.028 | +0.097 | 37.5 | 26.5 | -48.6 | 57% | 67% |
| up_from_low_30d in 51.8..inf & btc_ret_24h in 1.44..3 **PASS** | +0.155 | 1,770 | +0.018 | +0.130 | 38.8 | 54.7 | -88.1 | 77% | 67% |
| up_from_low_30d in 51.8..inf & ema50_rel in -0.303..-0.0092 | +0.026 | 2,100 | -0.027 | +0.097 | 37.3 | 64.9 | -142.2 | 50% | 33% |
| btc_ret_24h in 1.44..3 & ret_1d_5 in 11..inf | +0.074 | 1,898 | -0.031 | +0.092 | 37.8 | 61.3 | -153.1 | 46% | 33% |
| up_from_low_30d in 51.8..inf & ema50_rel in -0.722..-0.303 | +0.015 | 2,166 | -0.034 | +0.086 | 37.2 | 66.8 | -157.7 | 29% | 33% |
| up_from_low_30d in 51.8..inf & btc_ret_24h in 0.547..1.44 | +0.033 | 2,080 | -0.063 | +0.058 | 36.2 | 64.3 | -169.8 | 31% | 33% |
| up_from_low_30d in 51.8..inf & ema200_rel in -1.62..-0.732 | +0.032 | 1,313 | -0.068 | +0.054 | 35.7 | 40.6 | -106.8 | 36% | 33% |
| dist_high_20 in 3.37..inf & btc_ret_24h in 1.44..3 | +0.060 | 1,752 | -0.077 | +0.021 | 36.2 | 54.3 | -178.5 | 23% | 33% |
| atr_pct in 1.2..inf & btc_ret_24h in 1.44..3 | +0.081 | 1,179 | -0.080 | -0.013 | 35.7 | 36.6 | -151.4 | 23% | 33% |
| up_from_low_30d in 51.8..inf | -0.051 | 5,992 | -0.086 | +0.023 | 34.8 | 184.9 | -558.8 | 7% | 0% |
| atr_pct in 0.882..1.2 | -0.133 | 11,280 | -0.090 | +0.009 | 34.6 | 348.1 | -1041.8 | 0% | 0% |
| dist_low_20 in 3.42..inf | -0.129 | 15,327 | -0.115 | -0.003 | 34.3 | 473.0 | -1801.1 | 0% | 0% |
| dist_high_20 in 3.37..inf | -0.113 | 12,606 | -0.123 | -0.016 | 34.0 | 389.1 | -1580.3 | 7% | 0% |
| up_from_low_30d in 34.2..51.8 | -0.137 | 6,677 | -0.130 | +0.016 | 34.6 | 205.9 | -881.9 | 0% | 0% |
| atr_pct in 1.2..inf | -0.077 | 6,164 | -0.131 | -0.064 | 33.0 | 190.8 | -839.4 | 0% | 0% |
| dist_high_20 in 2.12..3.37 | -0.130 | 21,038 | -0.136 | +0.005 | 34.2 | 649.3 | -2895.5 | 0% | 0% |
| ret_16 in -inf..-1.77 | -0.132 | 18,012 | -0.144 | -0.006 | 33.9 | 555.9 | -2610.8 | 0% | 0% |
| ret_1d_5 in 11..inf | -0.116 | 6,626 | -0.147 | -0.022 | 33.4 | 207.7 | -1030.3 | 0% | 0% |
| ema200_rel in -inf..-3.23 | -0.132 | 9,488 | -0.147 | -0.026 | 33.2 | 293.1 | -1398.7 | 0% | 0% |
| up_from_low_30d in 51.8..inf & ret_1d_5 in -inf..-10.3 | +0.067 | 864 | -0.150 | -0.042 | 32.8 | 26.7 | -138.0 | 15% | 0% |
| atr_pct in 1.2..inf & btc_ret_24h in 0.547..1.44 | +0.102 | 1,269 | -0.151 | -0.084 | 33.3 | 39.4 | -232.7 | 0% | 33% |
| ret_1d_5 in -inf..-10.3 | -0.136 | 7,108 | -0.165 | -0.037 | 32.8 | 219.4 | -1181.4 | 0% | 0% |
| dist_high_20 in 3.37..inf & btc_ret_24h in 0.547..1.44 | +0.058 | 2,203 | -0.166 | -0.061 | 33.5 | 68.1 | -433.4 | 15% | 0% |
| dd_30d in -inf..-35.1 | -0.134 | 5,805 | -0.177 | -0.049 | 32.4 | 191.0 | -1029.2 | 0% | 0% |
| ret_96 in 4.7..inf | -0.122 | 10,671 | -0.179 | -0.047 | 32.8 | 329.3 | -1988.4 | 0% | 0% |
| ema200_rel in 3.12..inf | -0.123 | 10,986 | -0.185 | -0.052 | 32.5 | 339.1 | -2099.6 | 0% | 0% |
| ema50_rel in -inf..-1.53 & btc_ret_24h in 0.547..1.44 | +0.015 | 2,039 | -0.186 | -0.050 | 32.7 | 63.0 | -490.1 | 0% | 0% |
| ema50_rel in -inf..-1.53 & btc_ret_24h in 1.44..3 | +0.056 | 1,332 | -0.196 | -0.073 | 31.8 | 41.3 | -282.6 | 0% | 0% |
| btc_ret_24h in 1.44..3 & ema200_rel in -3.23..-1.62 | +0.036 | 1,308 | -0.200 | -0.054 | 32.1 | 40.5 | -279.3 | 8% | 0% |
| btc_ret_24h in 1.44..3 | -0.110 | 14,415 | -0.223 | -0.007 | 33.8 | 445.8 | -3253.9 | 0% | 0% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 18,352 | -0.111 | +0.037 | 35.1 | 566.4 | -2125.2 | 0% | 0% |
| model: predicted R > 0.1 | 9,994 | -0.085 | +0.052 | 35.8 | 308.4 | -908.5 | 7% | 0% |
| model: predicted R > 0.2 | 4,825 | -0.051 | +0.075 | 36.6 | 149.1 | -360.1 | 21% | 33% |
| model: predicted R > 0.3 | 2,176 | -0.120 | -0.004 | 34.2 | 67.2 | -293.1 | 0% | 0% |
| model: predicted R > 0.5 | 425 | -0.276 | -0.177 | 28.7 | 13.1 | -119.8 | 14% | 0% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| atr_pct | 0.0308 |
| btc_trend_1h | 0.0041 |
| up_from_low_30d | 0.0040 |
| btc_ret_24h | 0.0027 |
| dd_30d | 0.0022 |
| ema200_rel | 0.0019 |
| dow | 0.0019 |
| ret_96 | 0.0009 |
| bb_width_pctile | 0.0008 |
| ret_1d_5 | 0.0006 |
| dist_high_20 | 0.0003 |
| bb_pos | 0.0002 |
| rsi | 0.0002 |
| dist_low_20 | 0.0002 |
| ema50_rel | 0.0001 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
