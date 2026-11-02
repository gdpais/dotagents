# Stage 2 head-to-head: status (2026-11-02, incomplete)

**Not finished: grading stopped at the account's usage limit.** All 215 sessions ran (12 evals × family arms × 5 reps, Opus 5.5, every forced skill confirmed in the saved transcript, 0 retries). Deterministic scores exist for all 215. Blind grading covers the pilot (35) plus 71 of the other 180 runs; 109 grader calls returned `api_error` (usage limit) and need rerunning.

To finish: `bun grade.ts --out <run dir>` (resumes, regrades only the runs without a valid grade.json; delete the error grade.json files first or pass `--force --evals …`), then `bun report.ts --out <run dir> --md tables.md --json summary.json`, then write the verdict here. The run dir from this session is in the scratchpad (path in the hand-over note); `runs.jsonl` here holds meta + score + grade for every run.

## Pilot (1 rep per cell, all graded): indicative only

| Incident arm | Substance | House | Cost/run |
|---|---|---|---|
| none | 67% | 48% | $0.71 |
| engineering:incident-response | 81% | 42% | $0.76 |
| custom (sre stage skill) | 94% | 77% | $0.98 |

| Review arm | Recall (5 easy repos) | FP/run | House | Cost/run |
|---|---|---|---|---|
| none | 100% | 0.2 | 10% | $0.18 |
| engineering:code-review | 100% | 0.0 | 25% | $0.23 |
| built-in /code-review (high) | 100% | 0.2 | 40% | $0.29 |
| defect-first-review | 100% | 0.0 | 100% | $0.34 |

Every arm found every planted defect in the pilot, so two harder repos (`rv-ledger`, `rv-cache`, subtler defects plus decoys) were added before the full run. Built-in `/code-review` ran at its default level in `claude -p`, **high**.

## Files

`run.ts` (arms, forcing, resumable), `score.ts` (deterministic), `grade.ts` (3 bare Sonnet graders, majority, names masked), `report.ts` (stratified bootstrap CIs), `make_incident_fixtures.py`, `make_review_fixtures.sh`, `make_review_key.py`, `keys/` (answer keys; never copied into a session folder), `evals.json`, `runs.jsonl`, `headtohead.test.ts`.
