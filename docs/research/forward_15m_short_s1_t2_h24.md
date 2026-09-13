# Forward test — 15m short, short_s1_t2_h24

Train: bars before 2024-01-01 (1,238,845 bars, base rate -0.496 R). Test: bars from 2024-01-01 (1,316,334 bars, base rate -0.573 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**1 selection(s) stay positive out of sample with ≥ 300 trades, 0 of them robust:**

- **pass** model: predicted R > 0.3: +0.027 R over 480 trades, 15.1/month, positive in 57% of coins; by year: 2024 +0.02, 2025 -0.03, 2026 +0.20

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| atr_pct in 1.2..inf & up_from_low_30d in -inf..4.97 | -0.017 | 1,832 | -0.111 | +0.024 | 34.6 | 61.6 | -211.0 | 14% | 0% |
| atr_pct in 1.2..inf & dist_high_20 in 1.07..1.49 | -0.077 | 3,146 | -0.153 | -0.016 | 33.7 | 98.2 | -498.7 | 14% | 0% |
| atr_pct in 1.2..inf & ema50_rel in -0.722..-0.303 | -0.112 | 2,176 | -0.155 | -0.020 | 34.0 | 67.4 | -362.2 | 7% | 0% |
| atr_pct in 1.2..inf & ret_96 in 4.7..inf | -0.110 | 6,346 | -0.156 | -0.031 | 33.5 | 196.9 | -1005.5 | 0% | 0% |
| atr_pct in 1.2..inf & dist_high_20 in 2.12..3.37 | -0.115 | 5,552 | -0.158 | -0.024 | 33.4 | 172.0 | -884.9 | 7% | 0% |
| atr_pct in 1.2..inf & ema200_rel in 3.12..inf | -0.117 | 6,457 | -0.158 | -0.034 | 33.3 | 200.3 | -1039.3 | 7% | 0% |
| dist_low_20 in 3.42..inf & up_from_low_30d in 51.8..inf | -0.106 | 8,322 | -0.159 | +0.001 | 34.0 | 257.1 | -1342.3 | 7% | 0% |
| atr_pct in 1.2..inf & up_from_low_30d in 51.8..inf | -0.103 | 7,479 | -0.166 | -0.042 | 32.8 | 231.3 | -1252.8 | 14% | 0% |
| atr_pct in 1.2..inf & dist_high_20 in 1.49..2.12 | -0.089 | 4,181 | -0.166 | -0.031 | 33.0 | 129.6 | -702.7 | 0% | 0% |
| atr_pct in 1.2..inf & dist_low_20 in 3.42..inf | -0.100 | 10,411 | -0.167 | -0.043 | 33.1 | 322.3 | -1763.6 | 0% | 0% |
| atr_pct in 1.2..inf & ret_1d_5 in 11..inf | -0.111 | 5,928 | -0.178 | -0.053 | 32.4 | 186.4 | -1066.8 | 7% | 0% |
| atr_pct in 1.2..inf & ema50_rel in -1.53..-0.722 | -0.112 | 2,982 | -0.188 | -0.052 | 32.8 | 92.3 | -576.6 | 0% | 0% |
| atr_pct in 1.2..inf | -0.132 | 17,298 | -0.189 | -0.058 | 32.4 | 535.0 | -3287.2 | 0% | 0% |
| dist_low_20 in 3.42..inf & ema50_rel in -inf..-1.53 | -0.082 | 2,418 | -0.206 | -0.086 | 31.6 | 74.8 | -504.4 | 0% | 0% |
| ema200_rel in -inf..-3.23 & ret_1d_5 in 11..inf | -0.108 | 1,690 | -0.226 | -0.046 | 32.4 | 53.7 | -397.1 | 0% | 0% |
| atr_pct in 0.882..1.2 | -0.238 | 28,806 | -0.229 | -0.032 | 32.9 | 889.0 | -6627.7 | 0% | 0% |
| up_from_low_30d in 51.8..inf | -0.187 | 22,570 | -0.240 | -0.008 | 33.5 | 695.9 | -5425.9 | 0% | 0% |
| dist_low_20 in 3.42..inf | -0.196 | 31,054 | -0.244 | -0.035 | 32.9 | 958.4 | -7622.2 | 0% | 0% |
| atr_pct in 1.2..inf & ema200_rel in -3.23..-1.62 | -0.114 | 2,025 | -0.246 | -0.107 | 30.6 | 62.7 | -517.5 | 0% | 0% |
| dist_high_20 in 3.37..inf | -0.221 | 27,854 | -0.261 | -0.060 | 31.9 | 859.7 | -7304.3 | 0% | 0% |
| ema200_rel in -inf..-3.23 | -0.248 | 29,551 | -0.293 | -0.051 | 31.9 | 912.0 | -8672.1 | 0% | 0% |
| ret_1d_5 in 11..inf | -0.246 | 24,334 | -0.309 | -0.050 | 32.1 | 762.6 | -7547.1 | 0% | 0% |
| ret_96 in 4.7..inf | -0.259 | 29,786 | -0.318 | -0.054 | 32.0 | 919.3 | -9487.3 | 0% | 0% |
| ret_16 in 1.75..inf | -0.266 | 43,980 | -0.322 | -0.049 | 32.2 | 1357.4 | -14195.6 | 0% | 0% |
| ema200_rel in 3.12..inf | -0.245 | 30,088 | -0.323 | -0.062 | 31.7 | 928.6 | -9736.9 | 0% | 0% |
| dd_30d in -inf..-35.1 | -0.266 | 21,790 | -0.326 | -0.056 | 31.8 | 716.9 | -7111.9 | 0% | 0% |
| ret_4 in 0.859..inf | -0.265 | 71,144 | -0.327 | -0.037 | 32.6 | 2193.5 | -23254.4 | 0% | 0% |
| ema50_rel in -inf..-1.53 | -0.273 | 36,086 | -0.331 | -0.073 | 31.2 | 1114.9 | -11941.7 | 0% | 0% |
| ema20_rel in 0.878..inf | -0.272 | 52,371 | -0.341 | -0.048 | 32.2 | 1616.3 | -17856.5 | 0% | 0% |
| ema50_rel in 1.48..inf | -0.272 | 39,662 | -0.341 | -0.063 | 31.7 | 1224.1 | -13544.0 | 0% | 0% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 9,291 | -0.143 | +0.029 | 35.0 | 287.0 | -1337.1 | 0% | 0% |
| model: predicted R > 0.1 | 3,502 | -0.086 | +0.067 | 36.6 | 108.2 | -355.8 | 21% | 0% |
| model: predicted R > 0.2 | 1,264 | -0.026 | +0.107 | 37.9 | 39.4 | -104.6 | 50% | 33% |
| model: predicted R > 0.3 **PASS** | 480 | +0.027 | +0.145 | 39.4 | 15.1 | -25.2 | 57% | 67% |
| model: predicted R > 0.5 | 85 | +0.127 | +0.233 | 43.5 | 2.9 | -9.1 | 55% | 100% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| atr_pct | 0.1605 |
| btc_trend_1h | 0.0014 |
| bb_width_pctile | 0.0007 |
| ema200_rel | 0.0007 |
| up_from_low_30d | 0.0007 |
| btc_ret_24h | 0.0007 |
| dd_30d | 0.0007 |
| ret_96 | 0.0005 |
| vol_ratio | 0.0002 |
| dow | 0.0001 |
| trend_4h | 0.0001 |
| ema50_rel | 0.0001 |
| consec_up | 0.0001 |
| rsi_1h | 0.0000 |
| trend_1h | 0.0000 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
