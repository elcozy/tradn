# Forward test — 15m long, long_s2_t4_h96

Train: bars before 2024-01-01 (1,238,845 bars, base rate -0.285 R). Test: bars from 2024-01-01 (1,315,898 bars, base rate -0.323 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**3 selection(s) stay positive out of sample with ≥ 300 trades, 0 of them robust:**

- **pass** atr_pct in 1.2..inf & ret_96 in -inf..-4.61: +0.052 R over 2,624 trades, 81.8/month, positive in 79% of coins; by year: 2024 +0.12, 2025 -0.00, 2026 -0.01
- **pass** atr_pct in 1.2..inf & ema200_rel in -inf..-3.23: +0.031 R over 2,680 trades, 83.0/month, positive in 79% of coins; by year: 2024 +0.07, 2025 -0.01, 2026 -0.01
- **pass** bb_width_pctile in 0.879..inf & dd_30d in -inf..-35.1: +0.022 R over 1,840 trades, 60.5/month, positive in 71% of coins; by year: 2024 -0.05, 2025 +0.02, 2026 +0.13

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| atr_pct in 1.2..inf & ret_96 in -inf..-4.61 **PASS** | +0.015 | 2,624 | +0.052 | +0.118 | 39.6 | 81.8 | -118.8 | 79% | 33% |
| atr_pct in 1.2..inf & ema200_rel in -inf..-3.23 **PASS** | -0.027 | 2,680 | +0.031 | +0.097 | 38.8 | 83.0 | -105.4 | 79% | 33% |
| bb_width_pctile in 0.879..inf & dd_30d in -inf..-35.1 **PASS** | +0.060 | 1,840 | +0.022 | +0.106 | 38.3 | 60.5 | -96.3 | 71% | 67% |
| atr_pct in 1.2..inf | -0.081 | 6,093 | -0.021 | +0.046 | 36.7 | 188.4 | -323.9 | 57% | 33% |
| ret_96 in -inf..-4.61 & dist_low_20 in 3.42..inf | -0.024 | 2,164 | -0.024 | +0.052 | 37.6 | 67.1 | -163.0 | 36% | 33% |
| dd_30d in -inf..-35.1 & ret_1d_5 in -inf..-10.3 | -0.026 | 2,483 | -0.036 | +0.069 | 36.3 | 82.5 | -108.6 | 57% | 0% |
| ret_96 in -inf..-4.61 & bb_width_pctile in 0.879..inf | +0.024 | 4,623 | -0.040 | +0.061 | 37.2 | 143.3 | -372.2 | 14% | 33% |
| ret_96 in -inf..-4.61 & ret_1d_5 in -inf..-10.3 | +0.039 | 2,721 | -0.042 | +0.058 | 36.2 | 84.0 | -177.3 | 36% | 33% |
| dist_high_20 in 3.37..inf & ret_1d_5 in -inf..-10.3 | -0.018 | 3,204 | -0.051 | +0.044 | 36.0 | 99.0 | -214.7 | 29% | 33% |
| ema200_rel in -inf..-3.23 & ret_1d_5 in -inf..-10.3 | +0.020 | 3,349 | -0.065 | +0.039 | 35.5 | 103.5 | -266.8 | 21% | 33% |
| bb_width_pctile in 0.879..inf & ret_1d_5 in -inf..-10.3 | +0.005 | 2,676 | -0.083 | +0.011 | 35.4 | 82.7 | -256.1 | 7% | 33% |
| ret_96 in -inf..-4.61 & dist_high_20 in 3.37..inf | -0.011 | 6,917 | -0.094 | +0.007 | 34.9 | 213.7 | -815.0 | 7% | 0% |
| atr_pct in 1.2..inf & ret_1d_5 in -10.3..-5.47 | +0.012 | 782 | -0.098 | -0.029 | 34.3 | 24.3 | -100.4 | 36% | 33% |
| dist_low_20 in 3.42..inf | -0.109 | 12,807 | -0.132 | -0.023 | 33.6 | 395.3 | -1716.8 | 7% | 0% |
| dd_30d in -inf..-35.1 | -0.120 | 6,174 | -0.132 | -0.005 | 33.8 | 203.1 | -877.1 | 36% | 0% |
| ret_96 in -inf..-4.61 | -0.094 | 10,581 | -0.135 | -0.012 | 34.0 | 326.6 | -1469.5 | 0% | 0% |
| ret_96 in -inf..-4.61 & bb_width_pctile in 0.751..0.879 | -0.020 | 5,077 | -0.138 | -0.023 | 33.7 | 156.9 | -709.4 | 0% | 0% |
| ret_1d_5 in -inf..-10.3 | -0.124 | 7,046 | -0.143 | -0.016 | 33.7 | 217.5 | -1040.4 | 0% | 0% |
| btc_ret_24h in -inf..-2.9 | -0.133 | 7,637 | -0.147 | +0.002 | 34.5 | 236.7 | -1191.5 | 0% | 0% |
| dist_high_20 in 3.37..inf | -0.099 | 15,404 | -0.152 | -0.044 | 33.2 | 475.4 | -2380.3 | 0% | 0% |
| atr_pct in 0.882..1.2 | -0.138 | 11,607 | -0.156 | -0.057 | 32.6 | 358.2 | -1822.2 | 7% | 0% |
| ema200_rel in -inf..-3.23 | -0.122 | 11,187 | -0.160 | -0.037 | 33.2 | 345.6 | -1819.3 | 0% | 0% |
| ret_96 in -4.61..-2.33 & ret_1d_5 in -inf..-10.3 | -0.034 | 2,645 | -0.161 | -0.035 | 33.0 | 81.6 | -452.8 | 7% | 0% |
| bb_width_pctile in 0.879..inf | -0.116 | 18,386 | -0.172 | -0.017 | 34.0 | 567.4 | -3235.5 | 0% | 0% |
| ret_16 in 1.75..inf | -0.139 | 18,993 | -0.179 | -0.036 | 32.8 | 586.2 | -3407.6 | 0% | 0% |
| ema50_rel in -inf..-1.53 | -0.131 | 18,597 | -0.205 | -0.067 | 32.1 | 574.5 | -3832.6 | 0% | 0% |
| ret_16 in -inf..-1.77 | -0.140 | 22,099 | -0.210 | -0.072 | 31.8 | 682.0 | -4657.7 | 0% | 0% |
| ret_4 in -inf..-0.872 | -0.126 | 33,423 | -0.217 | -0.066 | 32.0 | 1031.5 | -7275.8 | 0% | 0% |
| ema20_rel in -inf..-0.912 | -0.134 | 25,995 | -0.220 | -0.072 | 31.8 | 803.1 | -5753.6 | 0% | 0% |
| dd_30d in -35.1..-26.9 & ret_1d_5 in 11..inf | -0.029 | 471 | -0.291 | -0.168 | 28.7 | 15.1 | -152.0 | 0% | 33% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 14,275 | -0.117 | +0.008 | 34.6 | 441.0 | -1794.2 | 0% | 0% |
| model: predicted R > 0.1 | 8,423 | -0.067 | +0.051 | 36.3 | 260.8 | -787.7 | 0% | 33% |
| model: predicted R > 0.2 | 4,750 | -0.051 | +0.060 | 36.4 | 148.1 | -508.1 | 7% | 33% |
| model: predicted R > 0.3 | 2,594 | -0.059 | +0.046 | 36.1 | 80.9 | -283.4 | 29% | 33% |
| model: predicted R > 0.5 | 707 | -0.078 | +0.016 | 35.2 | 22.3 | -98.1 | 38% | 33% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| atr_pct | 0.0308 |
| btc_trend_1h | 0.0044 |
| up_from_low_30d | 0.0029 |
| dd_30d | 0.0027 |
| ema200_rel | 0.0024 |
| hour | 0.0018 |
| ret_1d_5 | 0.0017 |
| btc_ret_24h | 0.0015 |
| dow | 0.0012 |
| rsi_1h | 0.0007 |
| bb_width_pctile | 0.0006 |
| trend_4h | 0.0002 |
| ret_96 | 0.0001 |
| consec_up | 0.0000 |
| bb_pos | 0.0000 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
