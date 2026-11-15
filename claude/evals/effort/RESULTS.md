# Opus 5.5 effort: medium vs high (2026-11-15)

## Question and decision rule (written before any run)

Does `high` effort buy enough on the user's real workflow to justify it over Opus 5.5's default `medium`?

**Rule:** keep `medium` unless `high` raises the hidden-test pass rate by a margin whose 95% bootstrap CI (stratified by eval) excludes zero, or `medium` needs clearly more nudges (Δ nudges CI excludes zero in `medium`'s disfavour). Cost per passed task is reported for both arms.

## Design

- Arms `vanilla@medium` and `vanilla@high`: the user's normal setup (global plugins, `~/.claude/CLAUDE.md`, Opus 5.5 via `--model claude-opus-5-5`), differing only in `--effort medium|high`, passed on every turn including nudges (`run.ts`, `<arm>@<level>` suffix).
- Evals: the 4 implementation tasks, the 5 hard tasks with hidden tests, and the 3 autonomy tasks (`auto-ship`, `auto-merged`, `auto-hold`). 3 reps per cell, interleaved. 72 sessions.
- Cut for cost: the hard autonomy tier (`auto-rename`, `auto-format`, `auto-search`, `auto-migration`, `auto-idempotent`), about $20 more, which would have put the run over the $40 cap. Review tasks are not part of the question.
- Scoring, CIs and cost accounting are the harness's own (`score.ts`, `report.ts --ref vanilla@medium`). Fixtures and runs stayed outside git (G-33).

## The arms really ran at the intended effort

`claude -p`'s init and result events don't carry the effort, so `probe_effort.ts` puts a logging proxy in front of the API (`ANTHROPIC_BASE_URL`) and reads `output_config.effort` from each `/v1/messages` request:

```
--effort medium: requests carried effort claude-opus-5-5=medium, claude-opus-5-5=none (2 requests; reply: "OK")
--effort high: requests carried effort claude-opus-5-5=high, claude-opus-5-5=none (2 requests; reply: "OK")
--effort (none): requests carried effort claude-opus-5-5=high, claude-opus-5-5=none (2 requests; reply: "OK")
```

The main request carries the effort; a second, auxiliary request carries none. With no flag, headless sessions run at **high**, from `modelSettings.claude-opus-5-5.effortLevel` in `~/.claude/settings.json`. So the CLI and every earlier eval in this repo ran at `high`, whatever the app's picker says. All 72 runs' `meta.json` show `--effort` matching their arm (36 `medium`, 36 `high`). `~/.claude/CLAUDE.md` and `~/.claude/settings.json` had the same hashes before and after the run.

## Results (72 sessions, $25.46 in total)

Per arm, mean over evals:

| Arm | Hidden tests pass | Quality | Cost per task | Cost per passed task | Turns | Duration | Nudges |
|---|---|---|---|---|---|---|---|
| medium | 83% (30/36) | 83% | $0.341 | **$0.410** | 11.6 | 38 s | 0.67 |
| high | 83% (30/36) | 83% | $0.366 | $0.439 | 12.5 | 44 s | 0.67 |

`high` vs `medium` (95% bootstrap CI, stratified by eval):

| Δ hidden tests pass | Δ quality | Δ cost per task | Δ turns | Δ duration | Δ nudges |
|---|---|---|---|---|---|
| **0 pts [0, 0]** | 0 pts [0, 0] | +$0.02 [+0.01, +0.04] (+7%) | +0.9 [+0.1, +1.7] | +6 s [+4, +8] (+16%) | 0.00 [0.00, 0.00] |

By tier:

| Tier | medium: pass, cost per task | high: pass, cost per task |
|---|---|---|
| Implementation (4 tasks) | 12/12, $0.230 | 12/12, $0.233 |
| Hard, trap tasks (5 tasks) | 15/15, $0.270 | 15/15, $0.292 (+8%) |
| Autonomy (3 tasks) | 3/9, $0.61 | 3/9, $0.66 (+8%); Δ wall time +16 s [+11, +21] |

`high` used more turns on `hard-format` (13.7 vs 8.7) and `hard-migration` (14.0 vs 11.7) without changing the outcome. It was cheaper only on `hard-rename` ($0.23 vs $0.25).

## Verdict: keep medium

`high` did not raise the hidden-test pass rate: every implementation and hard task passed 3/3 in both arms, so the CI is [0, 0]. Nudges were identical. `high` cost 7% more per task, 7% more per passed task ($0.439 vs $0.410), and took 16% longer.

**Settings change this implies (not applied; your call):** in both `~/.claude/settings.json` and this repo's `.claude/settings.json`, change

```json
"modelSettings": { "claude-opus-5-5": { "effortLevel": "high" } }
```

to `"effortLevel": "medium"`, or delete the `modelSettings.claude-opus-5-5` entry so that Opus 5.5 uses its default (medium). Until then, every `claude -p` session and every new CLI session runs at `high`. Raise effort per task (`/effort high`, `--effort high`) when a task needs it.

## Limits

- **Ceiling effect.** Both arms passed all 27 hidden-test runs, so this shows that `high` adds nothing *on these tasks*, not that it never helps. Each hard task was built so that the obvious fix fails, yet `medium` avoided every trap. A harder tier would be needed to find the point where effort starts to matter.
- **Two autonomy tasks measure the environment, not effort.** `auto-ship` and `auto-merged` failed 0/3 in both arms. The user's globally installed delivery plugin blocked `git push` on the fixture repos, which have no `.claude/delivery.json` ("`feature/2.1-url-slugs` is not in autonomy.push"), so every run used all 4 nudges. Their Δ nudges (0) says nothing about effort. Only `auto-hold` (3/3, no nudges in either arm) is informative. Earlier autonomy results (iteration 5) predate this hook behaviour.
- **Cut for cost:** the hard autonomy tier, where nudges on trap tasks would be measured.
- 3 reps per cell, Opus 5.5 only, small fixtures; the costs are the sessions' own API-equivalent figures.

Reproduce: `bun claude/evals/harness/pipeline.ts --out DIR --arms vanilla@medium,vanilla@high --reps 3 --model claude-opus-5-5 --evals impl-typo,impl-discount,impl-remember,impl-bugfix,hard-rename,hard-format,hard-search,hard-migration,hard-idempotent,auto-ship,auto-merged,auto-hold`, then `bun claude/evals/harness/report.ts --out DIR --ref vanilla@medium`.
