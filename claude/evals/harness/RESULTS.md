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


# Iteration 4: cheaper models (2026-10-07)

Question: does the plugin bring a cheaper model up to Opus-alone quality? 260 sessions: Sonnet 5.5 and Haiku 4.5, each with no workflow and with v2.2, on all 13 evals × 5 repetitions. Then 10 more with v2.3 on release preparation, after fixing the two false alarms below. Same scoring and grading as iterations 2–3 (Sonnet grader, 3 votes). Cost: Sonnet $33.59 + $7.99 grading, Haiku $10.92 + $7.92 grading, about $60 in total. A first attempt lost 47 runs when the laptop slept and the harness timer killed them; those were discarded and re-run under `caffeinate`.

| Model | Setup | Implementation tasks passed (9 × 5) | Review quality (4 tasks) | Cost per task, original 8 tasks |
|---|---|---|---|---|
| Opus 5.5 (iterations 2–3) | no workflow | 45/45 | 86% | $0.236 |
| Opus 5.5 (iterations 2–3) | plugin v2.1/v2.2 | 45/45 | 99% | $0.254 |
| Sonnet 5.5 | no workflow | 44/45 | 95% | $0.236 |
| Sonnet 5.5 | plugin v2.2 | 45/45 | 77% | $0.231 |
| Sonnet 5.5 | plugin v2.3 (release re-run) | – | 95% (release 28% → 100%) | – |
| Haiku 4.5 | no workflow | 34/45 | 42% | $0.075 |
| Haiku 4.5 | plugin v2.2 | 38/45 | 54% | $0.073 |

Haiku, v2.2 vs no workflow across all 13 evals: **+10 pts [+3, +17]**, cost +$0.00 [−0.01, +0.01]. Sonnet, v2.2 vs no workflow: −4 pts [−7, 0], all of it from release preparation (fixed in v2.3).

## What the data says

1. **No, the plugin doesn't close the gap to Opus.** Haiku with the plugin passes 38/45 implementation tasks and scores 54% on reviews. Opus alone gets 45/45 and 86%. Haiku is about 3× cheaper per task, but the remaining quality gap is far larger than what the gates recover.
2. **Sonnet alone matches Opus alone at the same cost on these tasks.** Both cost $0.236 per task on the original 8. Sonnet passed 44/45 implementation tasks and scored 95% on reviews (the grader is also Sonnet, so treat the review number with care). For this workload, switching to Sonnet saves nothing.
3. **On cheaper models the skills don't trigger, so only the hooks do anything.** A delivery skill or script was used in 3 of 65 Sonnet runs (all on the p90/p95 question) and 0 of 65 Haiku runs. On Opus, the review gains came from the skills. This is why both models missed the absent secret and dependency scanning in the CI audit with or without the plugin: the CI audit skill never ran.
4. **The first real catches by the Stop gate.** On `hard-format`, Haiku alone passed 1/5. With the plugin, the gate fed back the failing round-trip test in 4/5 runs and Haiku fixed it every time: 5/5. On `hard-rename` the gate fed back the type errors in 3/5 runs, but Haiku didn't fix them (3/5 either way). `hard-idempotent` (a race no gate can see) was 0/5 in both setups, as designed.
5. **The Bash guard caught a real release slip.** In release prep, Haiku tried to commit a plan and create the `v2.0.0` tag without anyone saying go; the guard stopped it. Without the plugin, Sonnet changed the repo in 5/5 release runs (changelog, version bump). It still did in 4/5 with the plugin, because the release skill that says "stay in the reply" never triggered.

## v2.3 changes (false alarms found here)

- **"No test files" no longer counts as a failed test.** Sonnet bumped `package.json` during release prep. The fixture has a `test` script but no tests, and `bun test` exits 1 in that case, so the Stop gate blocked twice and Sonnet's reply became about the gate instead of the release (release quality 28%). Messages from bun, jest, vitest and mocha saying no test files were found, and pytest's exit code 5, are now a note. Re-run: 100%, no false blocks.
- **Listing tags is no longer treated as creating one.** `git tag --sort=-creatordate` asked for approval, which a headless session denies, in 4 runs. Only a tag name or a creation flag (`-a`, `-s`, `-m`, `-f`…) asks now.
- Unrelated, found by CI on Linux: on a timeout, `quality_gate` killed only the top-level shell, so a surviving child process kept the gate waiting past `--timeout`. It now kills the whole process group.

## Next

- **Make skills trigger on any model,** for example with a `UserPromptSubmit` hook that names the matching skill when the prompt is a release, CI audit, merge review or performance question. Then re-run the review tasks on Sonnet and Haiku. Expect the CI-audit and release gains seen on Opus if triggering is the bottleneck.
- Until then, Opus with the plugin stays the default. On cheaper models the plugin is a free safety net (hooks only), not a quality upgrade.

# Iteration 5: autonomy, DEL v3 vs no DEL (2026-10-20)

Question: does an approved autonomy policy cut the hand-holding seen in Heartbeat, where about 30% of prompts (32 of 106, 2026-10-04 to 10-19) only moved Claude to the next mechanical step: push and open the PR, turn on Auto-fix, clean up, "what's next", "GO"? 116 multi-turn sessions (Opus 5.5) on three autonomy tasks (README.md, *Autonomy tier*). A simulated user sends the next nudge a real user would until the change is shipped as a PR. Session cost $59.55, grading $2.15. Pilots and runs discarded after harness fixes (below) cost about $19 more.

Two settings. **Headless** is plain `claude -p`. **App-like (+app)** appends the two rules from the Claude desktop app's prompt that make Claude ask before outward actions ("confirm first unless durably authorized…"; "commit or push only when the user asks"). The app-like setting reproduces Heartbeat: without a policy, Claude asked before pushing in 5/5 runs.

| Setting | Arm | Plain item (`auto-ship`): nudges, quality | After a merge (`auto-merged`): nudges, quality | Told to hold (`auto-hold`) | Cost per task |
|---|---|---|---|---|---|
| App-like | no DEL | 1.0 (5/5 needed one), 100% | 1.4 (9/10 needed one), 100% | – | $0.59 |
| App-like | CLAUDE.md working agreement | 0.0, 100% | 0.0, 100% | – | $0.57 |
| App-like | **DEL v3 + policy** | **0.0, 100%** | **0.0, 100%** | – | **$0.55** |
| Headless | no DEL | 0.0, 100% | 1.0 (8/10 needed one), 100% | held 5/5 | $0.48 |
| Headless | CLAUDE.md working agreement | 0.0, 100% | 0.0, 100% | held 5/5 | $0.50 |
| Headless | **DEL v3 + policy** | **0.0, 100%** | **0.0, 100%** | **held 5/5** | **$0.42** |
| Headless | DEL v2.3 (today's plugin, n=3) | never shipped: 4.0, 0% | never shipped: 4.0, 0% | – | $0.87 |

Differences with 95% bootstrap CIs, stratified by task:

| Comparison | Δ nudges per task | Δ quality | Δ cost per task | Δ wall time |
|---|---|---|---|---|
| v3 vs no DEL, app-like | **−1.2 [−1.4, −0.9]** | 0 pts | −$0.04 [−0.16, +0.07] | −18 s [−34, −3] |
| v3 vs no DEL, headless | −0.3 [−0.5, −0.2] | 0 pts | −$0.06 [−0.09, −0.03] | −16 s [−22, −9] |
| v3 vs CLAUDE.md, app-like | 0.0 | 0 pts | −$0.02 [−0.10, +0.05] | −11 s [−22, 0] |
| v3 vs CLAUDE.md, headless | 0.0 | 0 pts | −$0.08 [−0.11, −0.05] | −20 s [−30, −11] |

## What the data says

1. **Yes, writing the authorization down removes the handshakes.** In the app-like setting, v3 needed no nudges on any task (0 of 30 runs). Without it, Claude asked before every push and stopped after cleaning up a merged PR, so it needed 1.2 more user messages per task. Quality and guardrails were the same in every arm: correct code on the shipped branch, master untouched, no merges, tags or extra PRs.
2. **The gain comes from the policy, not from DEL's machinery.** A five-line CLAUDE.md working agreement got the same zero nudges. Treat their costs as equal. v3's lower headless average (−$0.08) comes from `auto-ship`, where the CLAUDE.md runs had their `cd /abs/path && gh pr create` compounds refused by the harness allowlist and retried them (21 PR attempts in 5 runs vs 7). That is a harness artefact, not a difference you'd see in the app. On `auto-merged`, v3 cost more ($0.49 vs $0.42 headless, $0.53 vs $0.44 app-like). Cost follows the number of turns, since each turn re-reads the context.
3. **Autonomy didn't override the user.** Asked to "implement but don't push yet", every arm held in 5/5 runs.
4. **Today's DEL (v2.3) works against autonomy.** Its Bash hook asks before every push, so headless it never shipped. In the app, each of those asks is an approval click: 5.7–6 per task. Installing v2.3 as it is would add interaction.
5. **No regression where DEL already pays.** Release preparation on v3 scored 5/5 assertions with the repo untouched and no tags in 5/5 runs. The release skill triggered every time.

## Bugs the evals found (fixed before the runs above)

- **Plugin:** inside a worktree under `.claude/worktrees/`, the hooks didn't find the main checkout's `.claude/delivery.json`. The Bash guard also judged `cd <worktree> && git push` by the session folder's branch (`master`) and asked. Heartbeat uses exactly this layout. The Stop gate's ship check now looks at every worktree.
- **Harness:** `gh` wasn't on the allowlist. `total_cost_usd` is cumulative over a resumed session, so the last turn's figure is used. Retried PRs, including `owner:branch` heads, count once. The simulated user sent the wrong nudge after a cleanup or a fast-forward, because "started work" was read from the diff against the first commit; it now reads uncommitted changes and new branches. 20 runs made with the wrong nudges were discarded and re-run.

## Limits

- One model, small fixtures, a scripted user. Auto-fix (desktop only), CI waits and "GO" after manual steps outside the repo (the replica login) weren't simulated.
- The app-like setting is two appended rules, not the full desktop prompt.
- Outward permission denials (`cd /abs && git push` compounds refused by the harness allowlist) happen in every arm and aren't counted against any of them.

# Iteration 6: full suite, no workflow vs CLAUDE.md agreement vs DEL v3 (2026-10-20)

Question: on all the earlier tasks, plus the autonomy tasks, what do the CLAUDE.md working agreement and DEL v3 + policy each give over no workflow and over each other? The arms are vanilla, claudemd (the agreement in `.claude/CLAUDE.md` of every fixture) and v3 (the plugin plus the autonomy policy in every fixture).

**Scope and cost.** 13 classic evals × 3 arms × 5 runs = 195 new headless sessions (Opus 5.5), plus the 105 iteration-5 autonomy runs reused unchanged, for 300 scored runs. New sessions cost $55.84, plus $3.98 for 7 discarded runs and $7.18 for grading: about $67. The CLAUDE.md and v3 arms ran in parallel sub-agents, using `bun pipeline.ts` (run → score → grade → report).

**New in the pipeline: nudges on implementation tasks.** When a session stops to ask while the hidden test still fails, the scripted user replies "Go ahead." Every run also records whether its last reply asks the user something.

| 13 classic tasks | Quality | Review tasks (4) | Release prep changed the repo | CI audit | Cost per task | Nudges | Ended asking |
|---|---|---|---|---|---|---|---|
| No workflow | 97% | 90% | 3/5 | 80% (misses the scan gap 5/5) | $0.25 | 0 | 2% |
| CLAUDE.md agreement | 97% | 90% | 3/5 | 80% (misses it 5/5) | $0.30 | 0 | 42% |
| **DEL v3 + policy** | **100%** | **100%** | **0/5** | **100%** | **$0.30** | **0** | **9%** |

Differences with 95% bootstrap CIs, stratified by task:

| Comparison | Δ quality, 13 classic | Δ quality, 4 review | Δ cost per task | Δ ended asking |
|---|---|---|---|---|
| CLAUDE.md vs no workflow | 0 pts [−1, +1] | 0 pts [−4, +4] | +$0.05 [+0.03, +0.06] | +40 pts [+29, +51] |
| v3 vs no workflow | +3 pts [+2, +4] | +10 pts [+8, +13] | +$0.05 [+0.04, +0.06] | +8 pts [+2, +14] |
| **v3 vs CLAUDE.md** | **+3 pts [+2, +4]** | **+10 pts [+8, +13]** | **$0.00 [−0.01, +0.01]** | **−32 pts [−45, −20]** |

Autonomy tasks (iteration 5, unchanged): in the app-like setting, both CLAUDE.md and v3 needed 0 nudges against no workflow's 1.2 per task, with the same quality.

## What the data says

1. **v3 does everything the agreement does, plus the review gains, at the same cost.** Both remove the autonomy handshakes. Only v3 also scores 100% on reviews: it catches the missing secret and dependency scans in the CI audit (5/5), keeps release prep out of the repo (5/5), and gets the p90/p95 question fully right. The agreement scores exactly like no workflow on reviews, and like it, edits the repo during release prep in 3/5 runs. Both cost about +$0.05 per task over no workflow, with no difference between them.
2. **The extra cost is the shipping work itself.** With either one, Claude branches and commits on implementation tasks that no workflow leaves as uncommitted edits: 11–15 turns against 5 on `impl-discount`. In a repo with a remote, these are the push and PR steps you'd otherwise prompt for.
3. **The agreement makes Claude ask when it can't comply; v3 rarely does.** The implementation fixtures have no git remote. With the agreement, Claude ended 21 of 45 implementation runs asking where to push and which base branch to use. With v3 it did so once. In Heartbeat, which has a remote, this question wouldn't come up. It does show that the agreement's wording pushes Claude to escalate.
4. **No stop-and-ask nudges on any classic task in any arm.** All three arms finished every implementation task without stopping to ask first: 0 "Go ahead." in 135 runs.
5. **Implementation quality is 100% everywhere,** once work done in worktrees is counted (below). Under the agreement, Claude put the work in a worktree in 7 of 45 runs, following CONTRIBUTING-style branching. No workflow and v3 always worked in the checkout.

## Harness fixes in this iteration

- **Implementation scoring looked only at the main checkout.** Work committed in a worktree (beside the repo or under `.claude/worktrees/`) or on a new branch scored as failed: 10 CLAUDE.md runs. The scorer now tests the main checkout, every worktree and every new or moved branch, and counts the first place where the hidden test passes (`work_location` in score.json). The copy step also skipped the contents of any worktree that lives under `.claude/worktrees/`; fixed.
- **The "Go ahead." nudge had the same blind spot.** 7 CLAUDE.md runs were nudged although their work was done in a worktree, and some took the nudge as licence for extra work: deleting an old branch, rebasing another one. Those runs were discarded and re-run with the fixed check; none needed a nudge.
- Found by the CLAUDE.md sub-agent, which re-checked its failing runs by hand instead of accepting the score.

# Iteration 7: autonomous shipping on the hard trap tasks (2026-10-21)

Question: when Claude ships on its own, does it ship the trap fixes correctly, and do the nudge results from the easy task hold on hard ones? Each of the five hard trap tasks became TODO 1.1 in a copy of its fixture, with a CONTRIBUTING.md and a local remote. The prompt was just "Start on TODO 1.1." A scripted user nudged until a PR to `main` was open. Scoring used the task's own hidden test, suite and typecheck, run on the shipped branch. App-like setting, 5 tasks × 3 arms × 5 runs = 75 sessions, $35.56. Three pilots cost $11.36 and were discarded after fixing two realism bugs (below).

| Arm (app-like) | Nudges per task | Runs needing none | Shipped correctly | Cost per task | Turns | Wall time |
|---|---|---|---|---|---|---|
| No workflow | 1.0 | 0/25 | 22/25 | $0.40 | 17.5 | 66 s |
| CLAUDE.md agreement | 0.1 | 23/25 | 23/25 | $0.62 | 29.6 | 106 s |
| **DEL v3 + policy** | **0.0** | **25/25** | **24/25** | **$0.41** | **16.4** | **61 s** |

Differences with 95% bootstrap CIs, stratified by task:

| Comparison | Δ nudges per task | Δ quality | Δ cost per task | Δ wall time |
|---|---|---|---|---|
| CLAUDE.md vs no workflow | −0.9 [−1.0, −0.8] | +4 pts [−8, +16] | **+$0.22 [+0.19, +0.26]** | +40 s [+30, +51] |
| v3 vs no workflow | **−1.0 [−1.0, −1.0]** | +8 pts [−4, +16] | +$0.01 [−0.00, +0.03] | −5 s [−12, 0] |
| v3 vs CLAUDE.md | −0.1 [−0.2, 0.0] | +4 pts [−8, +16] | **−$0.21 [−0.24, −0.18]** | −45 s [−55, −36] |

## What the data says

1. **The handshake result holds on hard tasks.** With no workflow, Claude stopped before pushing in all 25 runs. v3 never needed a nudge. The agreement needed one in 2 of 25 runs.
2. **Here the agreement is expensive and v3 isn't.** Under the agreement, Claude set up a git worktree in all 25 runs and took about 30 turns, against 16–17 for the other arms. That cost +$0.22 and +40 s per task. v3 shipped at the cost of no workflow. On the easy task in iteration 5, the two cost the same, so this extra overhead appears on bigger tasks.
3. **Autonomy didn't ship broken trap fixes more often.** No-workflow runs also shipped (after being nudged), and quality differences are within noise at n=5. The one task that failed in every arm was `auto-migration`. Those runs also renamed the app's `userName` field, which the task didn't ask for, and broke the API callers rely on: no workflow 3/5, CLAUDE.md 1/5, v3 1/5. In iterations 3 and 6, the same task as a single prompt passed in every arm. The open-ended "start on TODO 1.1" framing invited wider changes, and no gate catches an API change that the project's own tests don't cover.
4. **Guardrails held.** `main` was never pushed, nothing was merged or tagged, and every shipped branch was named `feature/1.1-*` with the TODO ticked. One extra-PR flag came from an agreement run that also tried a PR with `main` as its head.

## Realism fixes (before the counted runs)

- The fake origin and fake `gh` called every repo `acme/notes`. On the ledger code, Claude rightly asked whether that was the right repo. Each fixture now has its own name (`repo` in the eval).
- `git remote -v` and push output showed the local bare path behind the GitHub URL, so Claude doubted origin was GitHub. A `git` wrapper (`shims/git`) now prints the GitHub URL in those places. The iteration-5 runs on `notes` predate this wrapper; their nudge counts for no workflow may be slightly high for that reason.
