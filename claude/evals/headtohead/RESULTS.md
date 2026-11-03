# Stage 2 head-to-head: results (2026-11-03)

215 headless Claude Code sessions (`claude -p`, Opus 5.5, Claude Code 2.1.310, the user's setup): 12 evals × each family's arms × 5 repetitions, interleaved. Every skill arm's skill was forced with its slash command and confirmed in the session's saved transcript (215/215, no reruns). Grading was blind: 3 Sonnet graders per run, majority vote, skill names masked. Cost: **$95.21 in sessions + $36.56 in grading** (final grades $21.99; the rest is regrading after the key fixes below and the sign-in failures). Total ≈ $132, under the $150 cap.

## Verdicts

**Incident: keep the custom skills.**
- Custom beats `engineering:incident-response` on substance by **+13.0 points [+8.4, +17.7]** (93% vs 80%), for **+$0.18 per run** (+25%) and about 36 s more.
- `engineering:incident-response` does not come close. It scores the same as no skill (+0.4 points [−4.6, +5.4]) and invents facts in 19 of 25 runs, mostly severity levels, owners and rollback targets. Custom invents in 9 of 25.
- Where custom adds nothing for its cost:
  - **Postmortem:** custom 82% vs 89% for both none and engineering. All three invent narrative causes ("not coordinated"); custom's only edge is format (house rules 80% vs 24–28%).
  - **Small RCA:** engineering 92% vs custom 98%, for +$0.17 per run.
- Where custom earns it:
  - **Two-turn RCA:** 100% vs 67% for both others.
  - **Live report plus PT email:** 95% vs 70–75%.
  - **Complex RCA:** 91% vs 84–87%.

**Code review: evidence on G-46, which (PR #7, merged 2026-11-02) made `engineering:code-review` the delivery reviewer and removed `defect-first-review`.** The data supports it on recall and cost and goes against it on precision.

For G-46:
- **No bugs lost:** `engineering:code-review` found 100% of the planted defects, the same as `defect-first-review`, including the two harder repos (`rv-ledger`, `rv-cache`).
- **Cheaper and faster:** **−$0.13 per run [−$0.14, −$0.12]** vs `defect-first-review` (−37%), 30 s vs 47 s. It is the cheapest skill arm.
- **More extra issues:** it reports more real issues beyond the planted ones, +1.1 per run [+0.9, +1.3].

Against G-46:
- **Noisier:** more false positives than `defect-first-review`, **+0.31 per run [+0.14, +0.49]** across all 7 repos.
  - On the harder repos the gap is **+0.90 [+0.50, +1.30]**, 1.5 vs 0.6 per run.
  - Excluding the two disputed decoys: 0.70 vs 0.20.
- **Not better than no skill:** same recall, same false positives (0.00 [−0.23, +0.20]), +$0.04 per run. What it adds over no skill is extra real issues (+0.7 per run) and some format.
- **Worse than the built-in `/code-review` on the harder repos:**
  - More false positives (+0.50 [+0.10, +0.90]).
  - Fewer extra real issues (−1.1 [−1.4, −0.8]).
  - The built-in costs $0.05 more per run.
  - Across all 7 repos the two are close on false positives (−0.11 [−0.40, +0.14]).

Net: removing `defect-first-review` loses no bug-finding and saves about a third of the review cost. The price is about one extra false positive per review on harder changes. If that noise matters, the built-in `/code-review` is the better Anthropic reviewer on the harder repos for +$0.05 per run. `defect-first-review` stays the quietest (0 false positives on the clean refactor, where the built-in reported 1.4 pre-existing issues per run).

## Incident (5 evals × 5 reps)

| Arm | Substance | House rules | Cost per run | Time per run |
|---|---|---|---|---|
| none | 80% | 45% | $0.743 | 149 s |
| `engineering:incident-response` | 80% | 45% | $0.714 | 144 s |
| custom sre stage skill | **93%** | 79% | $0.890 | 180 s |

| Comparison (95% CI, stratified by eval) | Substance | Cost per run |
|---|---|---|
| engineering vs none | +0.4 [−4.6, +5.4] | −$0.029 [−$0.088, +$0.037] |
| custom vs none | **+13.4 [+9.6, +17.4]** | +$0.148 [+$0.086, +$0.214] |
| custom vs engineering | **+13.0 [+8.4, +17.7]** | +$0.177 [+$0.131, +$0.224] |

| Eval (custom skill forced) | none | engineering | custom |
|---|---|---|---|
| Live report + PT email (`sre-incident-lifecycle`) | 75% ($0.25) | 70% ($0.24) | **95%** ($0.37) |
| Small RCA (`rca-investigation`) | 82% ($0.38) | 92% ($0.48) | 98% ($0.65) |
| Complex RCA, large logs, clock skew (`rca-investigation`) | 87% ($0.72) | 84% ($0.98) | 91% ($1.02) |
| Postmortem (`incident-postmortem`) | **89%** ($1.22) | **89%** ($0.73) | 82% ($0.77) |
| Two-turn RCA (`rca-investigation`) | 67% ($1.14) | 67% ($1.14) | **100%** ($1.64) |

| Runs with invented facts (of 5) | none | engineering | custom |
|---|---|---|---|
| Live report + email | 5 | 5 | 1 |
| Small RCA | 1 | 1 | 1 |
| Complex RCA | 5 | 4 | 2 |
| Postmortem | 2 | 5 | 5 |
| Two-turn RCA | 2 | 4 | 0 |

Substance per dollar is flat: none 1.08, engineering 1.13, custom 1.05 substance per $. Custom buys **about 13 substance points for $0.15–0.18 per run**.

## Code review (7 repos × 5 reps; built-in at its default level here, **high**)

| Arm | Recall | False positives per run | FP on the clean change | Other real issues | Style-only | House rules | Cost per run | Time per run |
|---|---|---|---|---|---|---|---|---|
| none | 100% | 0.54 | 0.20 | 1.0 | 1.5 | 11% | $0.190 | 23 s |
| `engineering:code-review` | 100% | 0.54 | 0.20 | 1.7 | 1.9 | 33% | $0.226 | 30 s |
| built-in `/code-review` | 100% | 0.66 | 1.40 | 1.9 | 1.1 | 36% | $0.273 | 35 s |
| `defect-first-review` | 100% | **0.23** | **0.00** | 0.5 | 0.9 | 96% | $0.356 | 47 s |

| Comparison (95% CI, stratified by repo) | False positives per run | Cost per run |
|---|---|---|
| builtin vs none | +0.11 [−0.17, +0.40] | +$0.083 [+$0.066, +$0.100] |
| custom vs none | −0.31 [−0.54, −0.11] | +$0.166 [+$0.151, +$0.181] |
| custom vs builtin | **−0.43 [−0.71, −0.17]** | +$0.083 [+$0.066, +$0.099] |
| custom vs engineering | −0.31 [−0.49, −0.14] | +$0.130 [+$0.118, +$0.142] |
| engineering vs builtin | −0.11 [−0.40, +0.14] | −$0.047 [−$0.06, −$0.03] |

**The two harder repos alone** (`rv-ledger`: 1-based page offset, mutable default, split transaction; `rv-cache`: per-user page cached by path, TTL in the wrong unit, error responses cached). 10 runs per arm:

| Arm | Recall | False positives per run | Without the 2 disputed decoys | Other real issues | Cost per run |
|---|---|---|---|---|---|
| none | 100% | 1.10 | 0.40 | 1.4 | $0.204 |
| `engineering:code-review` | 100% | 1.50 | 0.70 | 1.7 | $0.220 |
| built-in `/code-review` | 100% | 1.00 | **0.10** | **2.8** | $0.268 |
| `defect-first-review` | 100% | **0.60** | 0.20 | 0.5 | $0.329 |

On these repos, false positives:
- Custom vs built-in: −0.4 [−0.9, +0.2]; custom costs +$0.06 [+$0.03, +$0.09].
- `engineering:code-review` vs custom: +0.9 [+0.5, +1.3].
- `engineering:code-review` vs built-in: +0.5 [+0.1, +0.9].

## Limits

- **Recall ceiling.** Every arm, including no skill, found every planted defect, even in the harder repos. A harder set (multi-file, cross-module, behaviour only a test reveals) would be needed to compare bug-finding.
- **Answer keys were corrected twice after the first grading pass**, and every arm was regraded each time:
  - The INC-2219 keys had paraphrased the evidence, so graders took quoted details for invented ones. The short evidence files are now in the keys word for word.
  - Two review decoys are debatable, and the review FP numbers still count them. `rv-cache` `widgets()` de-duplication does change result alignment, and `rv-ledger` fee rounding to 0.00 posts a zero fee entry. Every arm reported them. The table above also shows FPs without them.
- **Blinding is partial.** Output format can reveal the arm: the built-in's findings list, `defect-first-review`'s P0–P3 lines, the custom incident headings. House rules are the custom skills' own format rules, so they favour custom; they are reported apart and don't drive the verdicts.
- **Scope.** One model (Opus 5.5), Sonnet graders, 5 repetitions per cell, small fixtures. Skills were forced by slash command; stage 1 measured natural routing. Review runs were read-only (repo unchanged in 140/140).

## Proposed decision row (not added to ORCHESTRATION-DECISIONS.md)

G-47 is the next free number on `origin/master`. It also replaces the stage-1 routing row, which had proposed G-46 before that number was taken.

| G-47 | Head-to-head of the overlapping skills (2026-11-03) | Incident: custom sre skills, `engineering:incident-response`, none. Review: check G-46 against the data | Incident: keep the sre skills; `engineering:incident-response` stays off (G-14). Review: G-46 stands (`engineering:code-review` is the delivery reviewer). Its cost is noise, not missed bugs. Revisit with the built-in `/code-review` if review noise becomes a problem. | 215 forced-skill `claude -p` sessions (Opus 5.5), 5 reps, 3 blind Sonnet graders; $95 sessions + $37 grading. Incident substance: custom 93% vs engineering 80% (+13.0 [+8.4, +17.7]) and none 80%, for +$0.18 per run; engineering invents facts in 19/25 runs; the postmortem skill adds format only (82% vs 89%). Review: every arm found 100% of planted defects, including two harder repos. `engineering:code-review` costs $0.13 less per run than `defect-first-review` but has +0.31 false positives per run (+0.90 on the harder repos) and equals no skill on recall and false positives. The built-in had fewer false positives than it on the harder repos (−0.50) for +$0.05 per run. Stage 1 routing: neither engineering skill won a natural request while the custom skills were installed. |

## Files

| File | What |
|---|---|
| `run.ts` | Arms, forcing, skill confirmation, two-turn evals; resumable |
| `score.ts` | Deterministic checks: deliverable, citations, key figures, repo unchanged, cost and time |
| `grade.ts` | 3 bare Sonnet graders, majority vote, names masked |
| `report.ts` | Tables and stratified bootstrap CIs |
| `make_incident_fixtures.py`, `make_review_fixtures.sh`, `make_review_key.py` | Rebuild the fixtures and keys deterministically |
| `keys/` | Answer keys; never copied into a session folder |
| `evals.json` | Prompts and assertions |
| `runs.jsonl` | meta, score and grade for every run |
| `tables.md`, `summary.json` | Report output |
| `headtohead.test.ts` | Unit tests |

The full transcripts and fixtures are not stored (G-33). This session's run directory was the scratchpad `h2h` folder.
