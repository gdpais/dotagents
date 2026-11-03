### Incident

| Arm | Runs | Substance | House rules | Cost per run | Time per run | Substance per $ |
|---|---|---|---|---|---|---|
| none | 25 | 80% | 45% | $0.743 | 149 s | 1.08 |
| engineering | 25 | 80% | 45% | $0.714 | 144 s | 1.13 |
| custom | 25 | 93% | 79% | $0.890 | 180 s | 1.05 |

| Comparison | Substance (points) | House (points) | Cost per run |
|---|---|---|---|
| engineering vs none | +0.4 [-4.6, +5.4] | -0.8 [-6.3, +4.7] | −$0.029 [−$0.088, +$0.037] |
| custom vs none | +13.4 [+9.6, +17.4] | +33.7 [+29.2, +38.7] | +$0.148 [+$0.086, +$0.214] |
| custom vs engineering | +13.0 [+8.4, +17.7] | +34.5 [+30.0, +39.5] | +$0.177 [+$0.131, +$0.224] |

Substance by eval (share of substance assertions passed, mean over runs):

| Eval | none | engineering | custom |
|---|---|---|---|
| inc-live | 75% ($0.25) | 70% ($0.24) | 95% ($0.37) |
| inc-small | 82% ($0.38) | 92% ($0.48) | 98% ($0.65) |
| inc-2219-pm | 89% ($1.22) | 89% ($0.73) | 82% ($0.77) |
| inc-2219-2t | 67% ($1.14) | 67% ($1.14) | 100% ($1.64) |
| inc-2219 | 87% ($0.72) | 84% ($0.98) | 91% ($1.02) |

### Code review

| Arm | Runs | Planted-defect recall | False positives per run | FP on the clean change | Other real issues | Style-only | Valid citations | House rules | Cost per run | Time per run |
|---|---|---|---|---|---|---|---|---|---|---|
| none | 35 | 100% | 0.54 | 0.20 | 1.0 | 1.5 | 98% | 11% | $0.190 | 23 s |
| engineering | 35 | 100% | 0.54 | 0.20 | 1.7 | 1.9 | 100% | 33% | $0.226 | 30 s |
| builtin (high) | 35 | 100% | 0.66 | 1.40 | 1.9 | 1.1 | 100% | 36% | $0.273 | 35 s |
| custom | 35 | 100% | 0.23 | 0.00 | 0.5 | 0.9 | 99% | 96% | $0.356 | 47 s |

| Comparison | Recall (points) | False positives per run | Cost per run |
|---|---|---|---|
| engineering vs none | +0.0 [+0.0, +0.0] | +0.00 [-0.23, +0.20] | +$0.036 [+$0.023, +$0.047] |
| builtin vs none | +0.0 [+0.0, +0.0] | +0.11 [-0.17, +0.40] | +$0.083 [+$0.066, +$0.100] |
| custom vs none | +0.0 [+0.0, +0.0] | -0.31 [-0.54, -0.11] | +$0.166 [+$0.151, +$0.181] |
| custom vs builtin | +0.0 [+0.0, +0.0] | -0.43 [-0.71, -0.17] | +$0.083 [+$0.066, +$0.099] |
| custom vs engineering | +0.0 [+0.0, +0.0] | -0.31 [-0.49, -0.14] | +$0.130 [+$0.118, +$0.142] |

Recall and false positives by repo (mean over runs):

| Repo | none | engineering | builtin | custom |
|---|---|---|---|---|
| rv-notifier | 100% / FP 0.2 | 100% / FP 0.0 | 100% / FP 0.6 | 100% / FP 0.0 |
| rv-billing | 100% / FP 0.0 | 100% / FP 0.2 | 100% / FP 0.0 | 100% / FP 0.2 |
| rv-ledger | 100% / FP 0.6 | 100% / FP 1.0 | 100% / FP 0.8 | 100% / FP 0.0 |
| rv-cache | 100% / FP 1.6 | 100% / FP 2.0 | 100% / FP 1.2 | 100% / FP 1.2 |
| rv-auth | 100% / FP 0.6 | 100% / FP 0.2 | 100% / FP 0.6 | 100% / FP 0.0 |
| rv-inventory | 100% / FP 0.6 | 100% / FP 0.2 | 100% / FP 0.0 | 100% / FP 0.2 |
| rv-clean | – / FP 0.2 | – / FP 0.2 | – / FP 1.4 | – / FP 0.0 |

