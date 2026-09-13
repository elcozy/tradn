# Forward test — 1h long, long_s1.5_t3_h48

Train: bars before 2024-01-01 (309,743 bars, base rate -0.195 R). Test: bars from 2024-01-01 (328,720 bars, base rate -0.213 R). Rules were chosen on the training years only; every number below is measured on the test years, as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins.

## Verdict

**5 selection(s) stay positive out of sample with ≥ 300 trades, 3 of them robust:**

- **ROBUST** dd_30d in -inf..-35.1 & dist_low_20 in 7.2..inf: +0.135 R over 574 trades, 18.9/month, positive in 92% of coins; by year: 2024 +0.09, 2025 +0.10, 2026 +0.37
- **ROBUST** atr_pct in 2.42..inf & btc_ret_24h in -inf..-2.9: +0.124 R over 976 trades, 30.7/month, positive in 100% of coins; by year: 2024 +0.19, 2025 +0.04, 2026 +0.11
- **ROBUST** dd_30d in -inf..-35.1 & btc_ret_24h in -inf..-2.9: +0.078 R over 1,077 trades, 36.0/month, positive in 77% of coins; by year: 2024 +0.13, 2025 +0.02, 2026 +0.11
- **pass** atr_pct in 2.42..inf & dist_low_20 in 4.65..7.2: +0.039 R over 995 trades, 30.8/month, positive in 71% of coins; by year: 2024 +0.15, 2025 -0.04, 2026 -0.23
- **pass** atr_pct in 2.42..inf: +0.021 R over 2,290 trades, 70.9/month, positive in 64% of coins; by year: 2024 +0.08, 2025 -0.04, 2026 -0.04

_30 rules and 5 model thresholds were tried; by chance alone about 1.8 of them would look positive. Weight the ROBUST ones._

## Rules mined on the training years, scored on the test years

| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|---|
| dd_30d in -inf..-35.1 & dist_low_20 in 7.2..inf **ROBUST** | -0.021 | 574 | +0.135 | +0.191 | 43.0 | 18.9 | -26.9 | 92% | 100% |
| atr_pct in 2.42..inf & btc_ret_24h in -inf..-2.9 **ROBUST** | +0.008 | 976 | +0.124 | +0.167 | 41.8 | 30.7 | -68.2 | 100% | 100% |
| dd_30d in -inf..-35.1 & btc_ret_24h in -inf..-2.9 **ROBUST** | -0.042 | 1,077 | +0.078 | +0.144 | 39.9 | 36.0 | -57.1 | 77% | 100% |
| atr_pct in 2.42..inf & dist_low_20 in 4.65..7.2 **PASS** | -0.043 | 995 | +0.039 | +0.083 | 39.2 | 30.8 | -65.6 | 71% | 33% |
| atr_pct in 2.42..inf **PASS** | -0.079 | 2,290 | +0.021 | +0.065 | 37.8 | 70.9 | -115.3 | 64% | 33% |
| dd_30d in -inf..-35.1 & ret_4 in 1.75..inf | -0.024 | 1,183 | -0.027 | +0.047 | 36.8 | 38.9 | -62.8 | 54% | 0% |
| btc_ret_24h in -inf..-2.9 & dist_high_20 in 6.97..inf | -0.038 | 2,568 | -0.064 | +0.004 | 35.4 | 79.6 | -231.8 | 31% | 0% |
| dist_low_20 in 4.65..7.2 & dow in 2 | -0.029 | 1,361 | -0.065 | +0.026 | 35.3 | 42.2 | -167.2 | 36% | 33% |
| dd_30d in -inf..-35.1 | -0.060 | 2,738 | -0.065 | +0.014 | 35.3 | 90.1 | -255.5 | 43% | 0% |
| atr_pct in 1.47..1.81 & dow in 4 | -0.030 | 1,197 | -0.073 | +0.008 | 35.5 | 37.1 | -122.9 | 36% | 33% |
| dow in 4 | -0.101 | 5,892 | -0.090 | +0.044 | 36.8 | 182.8 | -585.9 | 29% | 0% |
| atr_pct in 2.42..inf & dow in 3 | -0.035 | 396 | -0.093 | -0.048 | 33.8 | 12.4 | -61.5 | 36% | 33% |
| dist_high_20 in 6.97..inf | -0.099 | 5,148 | -0.106 | -0.037 | 33.9 | 159.0 | -617.4 | 7% | 0% |
| ret_1d_5 in -inf..-10.3 | -0.101 | 3,235 | -0.114 | -0.036 | 34.0 | 99.8 | -411.7 | 7% | 0% |
| ema200_rel in -inf..-6.86 | -0.096 | 4,169 | -0.123 | -0.045 | 33.4 | 128.7 | -580.2 | 7% | 0% |
| ret_4 in 1.75..inf | -0.088 | 10,564 | -0.126 | -0.029 | 33.4 | 326.0 | -1380.7 | 7% | 0% |
| ret_96 in -inf..-9.26 | -0.118 | 4,133 | -0.135 | -0.056 | 33.3 | 127.6 | -655.6 | 7% | 0% |
| btc_ret_24h in 3..inf | -0.118 | 4,404 | -0.138 | -0.012 | 33.8 | 137.2 | -690.3 | 0% | 0% |
| btc_ret_24h in -inf..-2.9 & ret_4 in -inf..-1.78 | -0.017 | 3,277 | -0.143 | -0.061 | 33.0 | 101.6 | -537.4 | 0% | 0% |
| btc_ret_24h in -2.9..-1.39 & ret_4 in -inf..-1.78 | -0.048 | 3,864 | -0.155 | -0.063 | 32.6 | 120.0 | -676.1 | 0% | 0% |
| btc_ret_24h in -inf..-2.9 | -0.102 | 5,032 | -0.158 | -0.053 | 33.1 | 155.9 | -873.0 | 0% | 0% |
| ret_16 in -inf..-3.71 | -0.113 | 7,297 | -0.164 | -0.077 | 32.1 | 225.7 | -1221.8 | 0% | 0% |
| ema20_rel in -inf..-1.91 | -0.109 | 8,797 | -0.173 | -0.081 | 31.9 | 271.8 | -1580.5 | 0% | 0% |
| ret_4 in -inf..-1.78 | -0.115 | 12,002 | -0.178 | -0.083 | 31.7 | 370.8 | -2160.3 | 0% | 0% |
| dist_high_20 in 6.97..inf & dow in 3 | -0.014 | 1,050 | -0.180 | -0.109 | 30.8 | 32.6 | -216.2 | 7% | 0% |
| atr_pct in 1.47..1.81 | -0.108 | 5,612 | -0.184 | -0.103 | 30.8 | 173.4 | -1047.3 | 14% | 0% |
| atr_pct in 1.81..2.42 & btc_ret_24h in 3..inf | -0.019 | 796 | -0.204 | -0.141 | 29.9 | 24.8 | -182.8 | 8% | 0% |
| btc_ret_24h in -2.9..-1.39 | -0.120 | 8,850 | -0.206 | -0.080 | 31.8 | 274.5 | -1834.7 | 0% | 0% |
| btc_ret_24h in 3..inf & dow in 0 | +0.023 | 1,040 | -0.217 | -0.087 | 30.6 | 32.8 | -279.7 | 0% | 33% |
| btc_ret_24h in -inf..-2.9 & dow in 3 | -0.007 | 1,107 | -0.358 | -0.252 | 26.3 | 34.3 | -407.1 | 0% | 33% |

## Gradient-boosting model (ceiling), by selectivity

| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |
|---|---|---|---|---|---|---|---|---|
| model: predicted R > 0 | 9,785 | -0.106 | -0.002 | 34.6 | 302.6 | -1079.4 | 0% | 0% |
| model: predicted R > 0.1 | 6,398 | -0.084 | +0.013 | 35.1 | 197.9 | -597.4 | 7% | 0% |
| model: predicted R > 0.2 | 3,921 | -0.041 | +0.051 | 36.4 | 121.3 | -341.8 | 29% | 33% |
| model: predicted R > 0.3 | 2,241 | -0.008 | +0.080 | 37.3 | 69.3 | -181.8 | 50% | 33% |
| model: predicted R > 0.5 | 649 | -0.036 | +0.040 | 36.5 | 20.3 | -97.2 | 43% | 33% |

## What the model relied on (permutation importance on the test years)

| feature | importance |
|---|---|
| up_from_low_30d | 0.0089 |
| atr_pct | 0.0071 |
| dd_30d | 0.0038 |
| btc_trend_1h | 0.0037 |
| dow | 0.0031 |
| ret_1d_5 | 0.0020 |
| bb_width_pctile | 0.0011 |
| ema50_rel | 0.0006 |
| wick_lower_pct | 0.0004 |
| above_ema20_1d | 0.0001 |
| consec_down | 0.0000 |
| ema20_rel | 0.0000 |
| trend_1h | 0.0000 |
| rsi_1h | 0.0000 |
| bullish | 0.0000 |

_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._
