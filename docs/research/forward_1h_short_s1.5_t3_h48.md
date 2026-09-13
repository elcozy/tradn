# Forward test — 1h short, short_s1.5_t3_h48

Train: bars before 2024-01-01 (309,743 bars, base rate -0.119 R). Test: bars from 2024-01-01 (328,729 bars, base rate -0.133 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**7 selection(s) stay positive out of sample with ≥ 300 trades, 1 of them robust:**

- **ROBUST** up_from_low_30d in -inf..4.97 & dd_30d in -35.1..-27: +0.115 R over 758 trades, 24.6/month, positive in 79% of coins; by year: 2024 +0.21, 2025 +0.01, 2026 +0.26
- **pass** model: predicted R > 0.5: +0.124 R over 893 trades, 27.6/month, positive in 79% of coins; by year: 2024 +0.25, 2025 +0.13, 2026 -0.15
- **pass** model: predicted R > 0.3: +0.022 R over 3,111 trades, 96.1/month, positive in 64% of coins; by year: 2024 +0.09, 2025 -0.00, 2026 -0.05
- **pass** up_from_low_30d in 51.8..inf & dd_30d in -inf..-35.1: +0.020 R over 310 trades, 12.1/month, positive in 30% of coins; by year: 2024 -0.03, 2025 +0.03, 2026 +0.21
- **pass** up_from_low_30d in 51.8..inf & dist_high_20 in 4.53..6.97: +0.016 R over 1,087 trades, 33.6/month, positive in 64% of coins; by year: 2024 -0.04, 2025 +0.09, 2026 +0.16
- **pass** up_from_low_30d in 51.8..inf & ema200_rel in 3.04..6.55: +0.005 R over 589 trades, 18.3/month, positive in 57% of coins; by year: 2024 -0.15, 2025 +0.36, 2026 -0.26
- **pass** atr_pct in 1.81..2.42 & up_from_low_30d in 51.8..inf: +0.004 R over 1,043 trades, 32.3/month, positive in 57% of coins; by year: 2024 -0.04, 2025 +0.06, 2026 +0.06

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| up_from_low_30d in -inf..4.97 & dd_30d in -35.1..-27 **ROBUST** | +0.059 | 758 | +0.115 | +0.209 | 40.8 | 24.6 | -40.6 | 79% | 100% |
| up_from_low_30d in 51.8..inf & dd_30d in -inf..-35.1 **PASS** | +0.114 | 310 | +0.020 | +0.088 | 37.1 | 12.1 | -27.0 | 30% | 67% |
| up_from_low_30d in 51.8..inf & dist_high_20 in 4.53..6.97 **PASS** | +0.092 | 1,087 | +0.016 | +0.076 | 37.4 | 33.6 | -102.0 | 64% | 67% |
| up_from_low_30d in 51.8..inf & ema200_rel in 3.04..6.55 **PASS** | +0.026 | 589 | +0.005 | +0.079 | 37.2 | 18.3 | -97.1 | 57% | 33% |
| atr_pct in 1.81..2.42 & up_from_low_30d in 51.8..inf **PASS** | +0.058 | 1,043 | +0.004 | +0.067 | 36.7 | 32.3 | -105.0 | 57% | 67% |
| up_from_low_30d in 51.8..inf | +0.022 | 2,717 | -0.030 | +0.040 | 36.0 | 83.9 | -232.0 | 36% | 67% |
| atr_pct in 1.81..2.42 | -0.042 | 4,017 | -0.051 | +0.013 | 35.4 | 124.2 | -249.4 | 7% | 33% |
| dist_high_20 in 4.53..6.97 | -0.059 | 6,959 | -0.061 | +0.028 | 35.6 | 215.0 | -494.3 | 0% | 0% |
| ema200_rel in -6.86..-3.73 | -0.016 | 4,971 | -0.063 | +0.047 | 35.7 | 153.6 | -373.5 | 21% | 0% |
| ret_96 in -inf..-9.26 | -0.060 | 3,774 | -0.063 | +0.016 | 35.1 | 116.6 | -297.8 | 7% | 0% |
| up_from_low_30d in 51.8..inf & dd_30d in -8.75..-4.81 | +0.056 | 632 | -0.065 | -0.003 | 35.1 | 19.6 | -92.8 | 36% | 33% |
| btc_ret_24h in -inf..-2.9 & dow in 4 | +0.067 | 1,114 | -0.066 | +0.034 | 35.8 | 35.3 | -165.8 | 31% | 33% |
| dd_30d in -35.1..-27 | -0.043 | 3,548 | -0.068 | +0.024 | 35.2 | 109.8 | -289.2 | 21% | 0% |
| atr_pct in 1.81..2.42 & dist_high_20 in 3.21..4.53 | +0.037 | 1,671 | -0.072 | -0.007 | 34.6 | 51.8 | -170.6 | 14% | 0% |
| dd_30d in -27..-21.6 | -0.049 | 3,697 | -0.073 | +0.032 | 35.2 | 114.1 | -285.5 | 14% | 0% |
| ret_96 in -9.26..-4.86 | -0.038 | 5,950 | -0.077 | +0.034 | 35.5 | 183.6 | -496.3 | 0% | 0% |
| ema200_rel in 6.55..inf & btc_ret_24h in 1.44..3 | +0.079 | 1,532 | -0.078 | +0.004 | 35.1 | 48.4 | -160.3 | 15% | 33% |
| dist_high_20 in 6.97..inf & dow in 4 | +0.103 | 874 | -0.090 | -0.024 | 34.8 | 27.1 | -141.9 | 14% | 0% |
| atr_pct in 1.81..2.42 & ema200_rel in 6.55..inf | +0.025 | 1,087 | -0.096 | -0.032 | 33.8 | 34.1 | -125.7 | 29% | 33% |
| btc_ret_24h in -0.00312..0.547 | -0.056 | 10,199 | -0.127 | +0.024 | 35.1 | 314.8 | -1329.2 | 0% | 0% |
| btc_ret_24h in 1.44..3 | -0.024 | 8,358 | -0.137 | +0.003 | 34.5 | 258.5 | -1212.2 | 0% | 0% |
| ema200_rel in 6.55..inf | -0.048 | 4,007 | -0.138 | -0.054 | 32.6 | 124.3 | -610.6 | 0% | 0% |
| ret_96 in 9.81..inf | -0.058 | 4,020 | -0.144 | -0.059 | 32.5 | 124.8 | -623.9 | 0% | 0% |
| dist_low_20 in 7.2..inf & dow in 3 | +0.073 | 933 | -0.147 | -0.069 | 32.7 | 29.2 | -174.9 | 29% | 0% |
| ema200_rel in -inf..-6.86 & dow in 4 | +0.131 | 883 | -0.150 | -0.079 | 32.3 | 27.4 | -180.6 | 0% | 0% |
| bb_width_pctile in -inf..0.104 | -0.053 | 5,483 | -0.165 | +0.027 | 34.6 | 169.4 | -961.7 | 7% | 0% |
| dow in 6 | -0.053 | 6,166 | -0.166 | +0.015 | 34.1 | 192.6 | -1066.7 | 7% | 0% |
| atr_pct in 2.42..inf | -0.039 | 2,286 | -0.169 | -0.124 | 31.6 | 70.8 | -399.8 | 0% | 0% |
| atr_pct in 2.42..inf & dist_high_20 in 4.53..6.97 | +0.030 | 1,029 | -0.181 | -0.136 | 31.8 | 32.1 | -196.2 | 0% | 0% |
| btc_ret_24h in 0.547..1.44 & dow in 6 | +0.025 | 2,267 | -0.206 | -0.031 | 32.4 | 70.8 | -544.6 | 15% | 0% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 13,285 | -0.045 | +0.069 | 36.5 | 410.0 | -785.1 | 7% | 0% |
| model: predicted R > 0.1 | 9,012 | -0.020 | +0.091 | 37.4 | 278.1 | -343.8 | 29% | 33% |
| model: predicted R > 0.2 | 5,475 | -0.002 | +0.106 | 37.8 | 169.1 | -149.9 | 43% | 33% |
| model: predicted R > 0.3 **PASS** | 3,111 | +0.022 | +0.128 | 38.4 | 96.1 | -112.9 | 64% | 33% |
| model: predicted R > 0.5 **PASS** | 893 | +0.124 | +0.220 | 41.8 | 27.6 | -51.4 | 79% | 67% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| up_from_low_30d | 0.0087 |
| atr_pct | 0.0055 |
| dow | 0.0040 |
| ret_1d_5 | 0.0039 |
| btc_ret_24h | 0.0038 |
| btc_trend_1h | 0.0037 |
| dist_high_20 | 0.0015 |
| bb_width_pctile | 0.0014 |
| ema50_rel | 0.0012 |
| dist_low_20 | 0.0004 |
| vol_ratio | 0.0003 |
| wick_lower_pct | 0.0002 |
| ret_4 | 0.0000 |
| wick_upper_pct | 0.0000 |
| ema20_rel | 0.0000 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
