# Forward test — 15m long, long_s1_t2_h24

Train: bars before 2024-01-01 (1,238,845 bars, base rate -0.542 R). Test: bars from 2024-01-01 (1,316,296 bars, base rate -0.631 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**1 selection(s) stay positive out of sample with ≥ 300 trades, 0 of them robust:**

- **pass** model: predicted R > 0.3: +0.081 R over 706 trades, 22.1/month, positive in 57% of coins; by year: 2024 +0.37, 2025 +0.10, 2026 -0.43

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| atr_pct in 1.2..inf & ret_96 in -inf..-4.61 | -0.129 | 6,608 | -0.089 | +0.040 | 36.1 | 206.0 | -705.5 | 21% | 0% |
| atr_pct in 1.2..inf & dd_30d in -inf..-35.1 | -0.140 | 4,265 | -0.097 | +0.034 | 35.6 | 140.3 | -438.4 | 50% | 0% |
| atr_pct in 1.2..inf & ema50_rel in -inf..-1.53 | -0.161 | 7,512 | -0.104 | +0.026 | 35.7 | 232.3 | -900.0 | 14% | 0% |
| atr_pct in 1.2..inf & dist_low_20 in 1.17..1.59 | -0.133 | 3,290 | -0.110 | +0.026 | 35.5 | 101.7 | -371.6 | 14% | 0% |
| atr_pct in 1.2..inf & dist_low_20 in 1.59..2.21 | -0.147 | 4,258 | -0.111 | +0.025 | 35.5 | 132.2 | -515.7 | 21% | 0% |
| atr_pct in 1.2..inf & ema20_rel in -inf..-0.912 | -0.143 | 8,447 | -0.125 | +0.005 | 34.8 | 261.2 | -1143.4 | 14% | 0% |
| atr_pct in 1.2..inf & dist_high_20 in 3.37..inf | -0.147 | 10,729 | -0.128 | -0.002 | 34.6 | 331.8 | -1425.2 | 7% | 0% |
| atr_pct in 1.2..inf & ret_16 in -inf..-1.77 | -0.142 | 8,255 | -0.132 | -0.003 | 34.7 | 255.3 | -1200.7 | 14% | 0% |
| atr_pct in 1.2..inf | -0.183 | 17,225 | -0.138 | -0.008 | 34.2 | 532.7 | -2437.9 | 14% | 0% |
| dist_low_20 in 3.42..inf & ema20_rel in -inf..-0.912 | -0.162 | 1,728 | -0.142 | -0.036 | 34.8 | 53.5 | -324.3 | 7% | 0% |
| dist_high_20 in 3.37..inf & dist_low_20 in 3.42..inf | -0.156 | 4,227 | -0.146 | -0.035 | 34.0 | 130.6 | -639.4 | 7% | 0% |
| dist_high_20 in 3.37..inf & ema50_rel in 1.48..inf | -0.142 | 2,089 | -0.154 | -0.044 | 33.2 | 65.1 | -322.1 | 14% | 0% |
| atr_pct in 1.2..inf & dist_low_20 in 0.855..1.17 | -0.160 | 2,691 | -0.173 | -0.036 | 33.1 | 83.2 | -490.8 | 7% | 0% |
| dist_high_20 in 3.37..inf & ret_16 in 1.75..inf | -0.156 | 2,337 | -0.183 | -0.069 | 32.3 | 72.3 | -427.9 | 14% | 0% |
| dist_high_20 in 3.37..inf & dd_30d in -inf..-35.1 | -0.162 | 6,828 | -0.200 | -0.015 | 33.5 | 224.6 | -1412.0 | 14% | 0% |
| dist_high_20 in 3.37..inf & ret_96 in -inf..-4.61 | -0.153 | 13,872 | -0.201 | -0.008 | 33.9 | 428.6 | -2839.3 | 0% | 0% |
| dist_high_20 in 3.37..inf | -0.201 | 31,620 | -0.254 | -0.050 | 32.5 | 975.9 | -8038.0 | 0% | 0% |
| atr_pct in 0.882..1.2 | -0.256 | 29,308 | -0.267 | -0.070 | 31.7 | 904.5 | -7826.9 | 0% | 0% |
| dist_low_20 in 3.42..inf | -0.254 | 27,870 | -0.284 | -0.077 | 31.5 | 860.2 | -7905.5 | 0% | 0% |
| ret_96 in -inf..-4.61 | -0.255 | 30,232 | -0.305 | -0.055 | 32.2 | 933.0 | -9240.1 | 0% | 0% |
| ema200_rel in -inf..-3.23 | -0.265 | 31,534 | -0.309 | -0.063 | 31.9 | 973.2 | -9763.7 | 0% | 0% |
| ema50_rel in -inf..-1.53 | -0.252 | 40,896 | -0.332 | -0.070 | 31.6 | 1263.5 | -13604.1 | 0% | 0% |
| dd_30d in -inf..-35.1 | -0.261 | 22,723 | -0.337 | -0.065 | 31.6 | 747.6 | -7661.3 | 7% | 0% |
| up_from_low_30d in 51.8..inf | -0.310 | 22,924 | -0.337 | -0.105 | 30.3 | 706.8 | -7749.5 | 0% | 0% |
| ret_16 in -inf..-1.77 | -0.253 | 43,795 | -0.339 | -0.078 | 31.4 | 1351.6 | -14876.2 | 0% | 0% |
| ret_1d_5 in -inf..-10.3 | -0.286 | 26,306 | -0.342 | -0.074 | 31.4 | 811.1 | -9012.9 | 0% | 0% |
| btc_ret_24h in -inf..-2.9 | -0.281 | 21,657 | -0.343 | -0.034 | 32.8 | 671.1 | -7438.2 | 0% | 0% |
| bb_width_pctile in 0.879..inf | -0.277 | 39,347 | -0.360 | -0.063 | 32.0 | 1214.4 | -14159.7 | 0% | 0% |
| ema20_rel in -inf..-0.912 | -0.258 | 53,790 | -0.364 | -0.083 | 31.1 | 1660.1 | -19606.2 | 0% | 0% |
| ret_4 in -inf..-0.872 | -0.272 | 72,352 | -0.369 | -0.084 | 31.1 | 2233.0 | -26717.5 | 0% | 0% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 7,762 | -0.145 | +0.038 | 35.9 | 240.5 | -1188.9 | 0% | 0% |
| model: predicted R > 0.1 | 3,450 | -0.110 | +0.063 | 36.9 | 107.7 | -433.5 | 7% | 0% |
| model: predicted R > 0.2 | 1,540 | -0.042 | +0.123 | 38.6 | 48.1 | -198.0 | 36% | 67% |
| model: predicted R > 0.3 **PASS** | 706 | +0.081 | +0.241 | 43.1 | 22.1 | -96.4 | 57% | 67% |
| model: predicted R > 0.5 | 143 | +0.105 | +0.272 | 44.1 | 4.8 | -38.8 | 46% | 33% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| atr_pct | 0.1535 |
| btc_trend_1h | 0.0039 |
| btc_ret_24h | 0.0021 |
| hour | 0.0014 |
| ret_96 | 0.0007 |
| dd_30d | 0.0005 |
| ret_1d_5 | 0.0004 |
| vol_ratio | 0.0003 |
| bb_pos | 0.0003 |
| consec_up | 0.0002 |
| bb_width_pctile | 0.0001 |
| ret_4 | 0.0001 |
| trend_1h | 0.0000 |
| trend_4h | 0.0000 |
| wick_upper_pct | 0.0000 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
