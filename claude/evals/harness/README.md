# Delivery eval harness (iteration 2)

Measures the delivery workflow the way it is really used: fresh, headless Claude Code sessions (`claude -p`) started inside small fixture repos with planted problems, with the workflow installed or not. Nothing in the prompt mentions skills or checks, so the runs also measure how much hand input the workflow saves.

| Step | Command | What it does |
|---|---|---|
| Run | `bun run.ts --out DIR --arms vanilla,v1,v2 --reps 5 --v1-skills <dir>` | One session per eval × arm × repetition, interleaved; resumable |
| Score | `bun score.ts --out DIR` | Cost, turns and tool calls from the session's result event; hidden acceptance tests and repo checks on a copy of the final repo |
| Grade | `bun grade.ts --out DIR` | Blind grading of review answers by a separate session (workflow names masked; no repo, transcript or arm) |
| Report | `bun report.ts --out DIR --md FILE` | Per-arm and per-eval tables; differences vs vanilla with 95% bootstrap CIs stratified by eval |

**Arms.** `vanilla`: the user's normal setup. `v1`: the previous four skills as project skills, no hooks. `v2`: the `delivery` plugin (slim skills, preflight, Stop and Bash hooks) via `--plugin-dir`.

**Evals** (`evals-v2.json`). Four implementation tasks scored by hidden tests the agent never sees (`hidden/*.hidden-test.ts`, copied in only at scoring time): a typo, a discount-code feature with a no-N+1 check, a security-sensitive remember-me feature (cookie flags, unpredictable token), and a bug fix. Four review tasks graded on fixed assertions plus deterministic repo checks (untouched repo, no tags, no stray worktrees): merge readiness, a p90/p95 performance question, a CI audit and a release plan.

**Hard tier (iteration 3).** Five harder implementation tasks, each with a trap that the obvious fix falls into: `hard-rename` (two untested callers only the typecheck sees), `hard-format` (a parser in another module reads the old format; only the full suite's round-trip test shows it), `hard-search` (the easy fix walks the catalog and breaks a performance-budget test), `hard-migration` (a new reversible migration that keeps data, plus raw SQL elsewhere) and `hard-idempotent` (a race between concurrent calls; the control task, since no gate can catch it). Each hidden test was checked to fail on the untouched fixture, fail on the typical half-fix, and pass with a reference fix. TypeScript comes from bun's local cache (no network).

**Why this is more accurate than iteration 1.** Real sessions instead of subagents told to read a SKILL.md; the workflow triggers (or not) on its own; the agent works with the fixture as its working directory (iteration 1's `security-review` read the wrong folder); outcomes are hidden tests and repo state, not the coordinator's judgment; review answers are graded blind; five repetitions per cell with confidence intervals; costs come from the session's own accounting.

**Limits.** Small fixtures, so absolute costs are low and differences in long tasks may be larger; the grader is a model; hook commands' wall time is included in duration but costs no tokens; `security-review` runs inside the session and its tokens are counted.

`make_fixtures.sh` rebuilds the fixtures; fixtures and runs are not stored (G-33).
