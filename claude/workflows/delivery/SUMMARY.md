# Delivery workflow — summary

**What it is:** the software-company lifecycle from idea to production and back: Intake → Plan → Design (when needed) → Build → Verify → Release → Operate → Learn, with four evidence-based gates (Definition of Ready, Definition of Done, Merge, Release) and human approval at every irreversible step. Anthropic skills are used wherever they cover a stage; custom skills exist only where nothing else does (DL-27).

**Packaging (v3.0):** the `delivery` plugin in `claude/plugins/delivery`: four skills plus two hooks. The Stop hook runs `preflight` after any turn that edited files and asks once for a review only when the diff has a risky pattern; the Bash hook scans commits for secrets and asks before push/tag/merge/publish/deploy. v3 adds an opt-in `autonomy` policy in `.claude/delivery.json`. Once the user approves it, Claude pushes feature branches, opens PRs, cleans up merged branches and continues the backlog without asking. Merges, tags, releases, deploys, base-branch and force pushes still ask. Install: `/plugin marketplace add /Users/gabiru/personal/dotagents` then `/plugin install delivery@dotagents`.

**Custom skills** (`plugins/delivery/skills/`):

| Skill | Company role | Scripts (bun, tested) |
|---|---|---|
| `delivery-lifecycle` | Engineering manager: routing, merge and release gates, approvals | `preflight.ts` (classify + quality + secrets + CI audit in one call), `release_plan.ts` (semver bump and changelog), `cleanup_merged.ts` (post-merge cleanup), `pr_risk.ts` (low / medium / breaking, merge route, evidence); libraries `classify_change.ts`, `quality_gate.ts`, `scan_secrets.ts` |
| `feature-planning` | Product + tech lead: spec, testable ACs, slices, Definition of Ready | — |
| `performance-review` | Performance engineering: budgets, base vs head on p90/p95, profiling | `bench_stats.ts` |
| `ci-cd-pipeline` | Platform / DevOps: pipeline design and audit | `audit_ci.ts` |

**Anthropic and existing skills used by stage:** Design → `engineering:architecture`, `engineering:system-design`. Build → `engineering:testing-strategy`, `engineering:debug`. Verify → `engineering:code-review` (always; `defect-first-review` was retired on 2026-11-02, DL-78), built-in `security-review`, `engineering:deploy-checklist` for migrations. Release → `engineering:deploy-checklist`. Operate and Learn → `sre-incident-lifecycle`, `rca-investigation`, `incident-postmortem`, `engineering:tech-debt`, `engineering:documentation`, `coo-portfolio-review` (on demand).

**Repository tooling:** `claude/tools/validate_skills.ts`, `claude/tools/permission_audit.ts` (who stopped each tool call for permission), root `package.json` (`bun run lint`, `bun run test`), `.github/workflows/ci.yml` (validation, all tests, secret scan, CI self-audit; SHA-pinned).

**Trigger examples:** "take this feature from idea to production" / "is this ready to merge?" → delivery-lifecycle · "write a spec for bulk invoice export" → feature-planning · "is my branch slower than main?" → performance-review · "harden our GitHub Actions" → ci-cd-pipeline.

**Decided 2026-10-06:** CI status handled as today (DL-32); `.delivery/` ignored (DL-33); security via the built-in `security-review` (DL-29); performance gates on p90/p95 (DL-31). Evals (G-43): custom vs Anthropic-only substance 26/28 vs 25/28, house rules 8/9 vs 5/9, skill selection 18/18, +8% to +40% tokens; details in `evals/evals-delivery.json`.

**Iteration 2 (2026-10-06, `evals/harness/RESULTS.md`):** 160 real headless sessions with hidden tests and voted blind grading. v2.1 vs no workflow: review work +13 pts [+9.5, +16.5] for +8% cost; v2.1 vs v1: same quality, −6% cost. Small implementation tasks: 100% in every setup (no measurable gain; harder tasks are the next test).

**Iteration 3 (2026-10-06):** five trap tasks; every setup passed all 45 implementation runs. v2.2 removes the two false alarms behind v2.1's +17% hard-task cost; its stop gate never fired, and installing the plugin costs +5–7% on implementation (insurance) while review work gains +13 pts.

**Iteration 5 (2026-10-20, autonomy):** 116 multi-turn sessions with a simulated user. In an app-like setting, no DEL needed 1.2 more nudges per task than v3 [0.9, 1.4], and v3 needed none in 30/30 runs, with the same quality and guardrails and no significant cost difference. A CLAUDE.md working agreement matched v3 on nudges at the same cost (v3's lower headless average came from harness-refused retries in the CLAUDE.md runs). v2.3 never shipped headless (it asks before every push). Installing in Heartbeat is the user's call (DL-62).

**Iteration 6 (2026-10-20, full suite):** 300 runs: no workflow, the CLAUDE.md agreement and v3 + policy, on all 13 classic tasks plus the autonomy tasks. v3 matched the agreement on nudges (both 0 in the app-like setting, against 1.2 per task with no workflow) and on cost (+$0.05 per task over no workflow for both), and beat it by +10 pts on reviews (CI audit, release prep kept out of the repo, p90/p95). The agreement scored like no workflow on reviews. One command, `bun pipeline.ts`, now runs the whole suite with nudges measured.

**Iteration 7 (2026-10-21, hard tasks shipped end to end):** 75 runs, app-like. v3 needed no nudges (25/25), against 1.0 per task with no workflow, at the same cost. The CLAUDE.md agreement needed almost none but cost +$0.22 per task (worktree set-up in every run). Trap-fix quality didn't change with autonomy; one task tempted every arm into an unasked API rename.


**v3.2 (2026-11-02, fewer asks, review and merge by risk):** a transcript audit of 45 Heartbeat sessions found the extra asks came from auto mode's classifier (it blocked Auto-fix 7 of 14 times), three guard parsing bugs, and merges asked again after the user said "merge". The hooks now approve the policy's routine steps outright, shipping includes `engineering:code-review` (the reviewer since DL-78; `defect-first-review` is retired), and an opt-in `autonomy.merge` merges low-risk PRs on green, lets Claude merge, block or ask on medium ones, and leaves breaking ones to the user, always with product-facing evidence (DL-70 to DL-79).

**v3.2.2 (2026-11-04, handshake asks):** on 3.2, about 45 of 70 end-of-turn questions in Heartbeat were steps the policy covers. The desktop app's own rules ("commit or push only when asked", "ask before acting on what you found") beat the policy text, the merge guard never saw a `pr_risk.ts` run with `| tail` or `; echo` after it, and review sessions didn't own their PR's merge. The policy now names itself as that explicit authorization and forbids offering covered steps, the guard reads each command of the line, and the review session owns the merge (DL-81).

**v3.3 (2026-11-04, review sessions and fewer asks):** with `"review": "session"`, each new PR gets its own review session (a plugin hook replaces the per-user Heartbeat hook whose brief said "Do not merge"): it shows `engineering:code-review`'s tables, fixes what it confirms, rates the PR and merges it on green, sets GitHub auto-merge on the reviewed head while required checks run, or stops for breaking changes; the opening session moves on. Any turn that ran the review must show its tables. The merge guard no longer loses the review to replayed transcript entries (every 3.2.2 merge asked), and pushes with GitHub CLI as the credential helper, `timeout`, variables, `if`/subshell bodies and `--repo` naming this repository are read. Replayed on the 58 calls the guard asked about since 1 Nov: 32 no longer ask, 4 more fixed but not replayable, 19 were merges by sessions that hadn't reviewed (the review session merges now), 3 are right to ask (DL-82 to DL-87).

**v3.3.1 (2026-11-07, no redundant review):** a session that reviewed its change with `engineering:code-review` after its last commit and before opening the PR owns that PR: the hook tells it to rate and merge or stop instead of starting a second review session (DL-88).

**v3.3.2 (2026-11-07, review before commit):** the review that makes the opening session the PR's owner may come before the commit and push, as the ship order has it; only a file change or an earlier PR after the review sends the PR to a review session (DL-89).

**v3.3.3 (2026-11-07, medium asks only in doubt):** a medium PR merges on green when the review is clean and the product evidence shows it working; Claude asks only when it doubts it works, as the end-of-turn card, with the review tables and product evidence sent as files (DL-91). dotagents gets its own merge policy, with plugin hooks, the marketplace and CI as security paths (DL-90).
