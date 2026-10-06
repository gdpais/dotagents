# Iteration 2 results (2026-10-06)

160 headless Claude Code sessions (Opus 5.5, the user's normal setup): 8 tasks × 4 setups × 5 repetitions, interleaved. Implementation tasks scored by hidden acceptance tests; review tasks by a 3-vote blind grader majority plus deterministic repo checks. Session cost $41.12, grading $8.71 (API-equivalent).

| Setup | Implementation quality | Review quality | Cost per task (impl / review / all) | Review runs that changed the repo |
|---|---|---|---|---|
| vanilla (no workflow) | 100% | 85.8% | $0.190 / $0.282 / $0.236 | 5/20 |
| v1 (4 skills, no hooks) | 100% | 100% | $0.203 / $0.340 / $0.272 | 0/20 |
| v2 (plugin: slim skills + hooks) | 100% | 96.8% | $0.217 / $0.316 / $0.267 | 1/20 |
| **v2.1 (v2 + fixes below)** | **100%** | **98.8%** | **$0.204 / $0.304 / $0.254** | **0/20** |

Differences with 95% bootstrap confidence intervals (stratified by task):

| Comparison | Review quality | Cost, all tasks |
|---|---|---|
| v2.1 vs vanilla | **+13.0 pts [+9.5, +16.5]** | +$0.018 [+0.008, +0.029] (+8%) |
| v2.1 vs v1 | −1.3 pts [−3.8, 0.0] | **−$0.017 [−0.029, −0.006] (−6%)** |
| v2.1 vs v2 | +2.0 pts [−1.5, +5.8] | −$0.013 [−0.024, −0.002] |

## What the data says

1. **Small implementation tasks don't need the workflow.** All four setups passed every hidden test (typo, feature with an N+1 trap, security-sensitive feature, bug fix), and every setup ran the tests by itself in 15 of 20 runs. On this kind of task the model already does what the gates enforce. The cost of having the plugin installed is +$0.014 per task (+7%), mostly fixed context.
2. **The value is in the review-type work.** On CI audits, vanilla missed the absent secret and dependency scanning in 5 of 5 runs; the audit script's gate map caught it every time. On release preparation, vanilla never stopped for a go (5/5), wrote changelog and version bumps, and committed straight to `main` in 4 of 5 runs. The workflow setups stopped and asked every time (v2.1). Merge reviews and the p90/p95 performance question were close to equal across setups.
3. **Automatic gates beat instructions on cost.** v2.1 matches v1's quality with 6% lower cost and no reliance on the model remembering to run checks. Its hooks stayed silent (zero tokens) when nothing failed.
4. **Over-eager gates are expensive.** v2 asked for a security review whenever a file under `auth/` changed: +26% cost on that task, with no change in outcome (the code was already secure in 15 of 15 runs across setups). v2.1 asks only when a risky pattern appears (weak randomness, injection sinks, disabled TLS, string-built SQL…) or a path the project marked; the cost went back to vanilla's level.
5. **Single LLM grades are unreliable.** With one grader vote, 4 of 15 "don't claim unrun checks" verdicts were wrong (every one of those runs had run the tests). Majority voting and a deterministic transcript check fixed it and moved v2's review score by about 3 points. Deterministic checks first, voted LLM grading second.

## v2.1 changes (from findings 4 and the v2 release slip)

- Security review requested only on a risky code pattern or a configured `securityPaths` entry; a file merely under `auth/` or a dependency bump is a note. Setting `SameSite` no longer counts as a risky header change.
- Release preparation stays in the reply: no changelog commit, version bump or tag until the user says go.
- `delivery-lifecycle` description shortened (845 → 681 characters).

## Limits and what to test next

- The implementation tasks hit the ceiling, so these runs can't show whether the Stop hook catches regressions in bigger changes. Next: harder tasks (multi-file changes that break a distant test, a migration, a refactor under a performance budget), where vanilla is expected to fail sometimes.
- One model (Opus 5.5) and small repos; absolute costs are low and may grow differently on long tasks.
- The grader is still a model, even with voting; review assertions were written by the same author as the workflow.

# Iteration 3 results: hard implementation tasks (2026-10-06)

Five harder tasks, each built so the obvious fix falls into a trap that only a particular check reveals (details in README.md). Each hidden test was verified to fail on the untouched fixture, fail on the typical half-fix, and pass with a reference fix. 75 sessions for vanilla, v1 and v2.1, then 45 for v2.2 on all nine implementation tasks. Cost $20.88 + $11.70.

| Setup | Implementation tasks passed (9 tasks × 5) | Cost vs vanilla, original 4 | Cost vs vanilla, hard 5 | Stop-hook interruptions |
|---|---|---|---|---|
| vanilla | 45/45 | — | — | — |
| v1 | 45/45 | +7% [+3, +10] | +4% [−4, +12] | — |
| v2.1 | 45/45 | +7% [+4, +11] | +17% [+9, +25] | 10/45, all false alarms |
| **v2.2** | **45/45** | **+5% [+3, +8]** | **+7% [0, +14]** | **0/45** |

## What the data says

1. **Opus 5.5 avoided every trap on its own.** It found the untested callers, the parser in another module, the performance budget, the reversible migration and the race condition in 45 of 45 vanilla runs. With 0 failures in 45, the vanilla failure rate on tasks like these is below about 7% (95% upper bound). There was nothing for the stop gate to catch.
2. **v2.1's extra cost on hard tasks came entirely from two false alarms.** It read `regex.exec(...)` as command execution, which forced a security review in 5 of 5 format runs. It also treated a column rename as a blocking migration review, which forced the deploy checklist mid-implementation in 5 of 5 migration runs (+55% on that task).
3. **v2.2 fixes both.** It never interrupted in 45 runs. What it costs now is the fixed context of having the plugin installed: about $0.01–0.02 per task (+5–7%). The hooks themselves cost no tokens when nothing fails.
4. **The rename task split into two styles** (one batch `sed` vs one edit per file). v2.1 and v2.2 took the per-file style more often. At 5/5 vs 2/5 that's not significant (p ≈ 0.17), but it accounts for most of v2.2's remaining hard-task overhead.

## Conclusions across iterations 2 and 3

- **On implementation, the workflow is insurance.** It cost +5–7% and caught nothing real in 90 runs, because nothing went wrong. That premium comes from the plugin's skill descriptions sitting in context, not from the hooks, which cost nothing when silent. Turning the stop gate off saves no tokens; only uninstalling the plugin does.
- **On review-type work it pays for itself:** +13 points (CI audits, release preparation) for +8%.
- **Precision matters more than coverage.** Each false alarm costs a whole extra review. Gates should block only on things that are wrong now: failing checks, secrets, risky security patterns.
- **Next useful test:** the same tasks with a cheaper model (Sonnet or Haiku) with and without the plugin. If the gates bring a cheaper model up to Opus-alone quality, the workflow becomes a cost saving rather than a premium.

# On-demand use and time cost (2026-10-06)

"On-demand" = nothing installed; the prompt names the skill file (review tasks) or asks for the preflight script (two hard implementation tasks). 30 sessions, same scoring and 3-vote grading. Wall-clock time is what the user waits, including hooks.

| Review tasks (4) | Quality | Cost per task | Time per task |
|---|---|---|---|
| No workflow | 86% | $0.282 | 49 s |
| On-demand (skill named in the prompt) | 99% | $0.393 | 61 s |
| Plugin installed (v2.1) | 99% | $0.304 | 49 s |

- On-demand matches the installed plugin's quality (+13 pts over no workflow) but costs +$0.089 [+0.05, +0.13] and +11 s [+5, +18] per task more than having it installed. Reading the skill as a file means an extra tool round trip, more reference reads and ~3 more turns, each re-reading the context.
- Asking for the preflight by hand on implementation tasks cost +$0.043 and +9 s vs no workflow, with no quality change; the automatic hook (v2.2) cost nothing extra on the same tasks.
- Break-even: installed costs ~$0.014 extra on each task that doesn't use a skill; on-demand costs ~$0.089 extra on each task that does. Installing is cheaper once more than about 1 in 7 tasks needs one of these skills.
- Time: v2.2 adds +1–2 s per implementation task on these fixtures (n.s.), but the stop gate runs the project's real test suite after every editing turn, so in a repo with a slow suite the time cost is that suite's duration per turn.

