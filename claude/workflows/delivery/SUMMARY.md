# Delivery workflow — summary

**What it is:** the software-company lifecycle from idea to production and back: Intake → Plan → Design (when needed) → Build → Verify → Release → Operate → Learn, with four evidence-based gates (Definition of Ready, Definition of Done, Merge, Release) and human approval at every irreversible step. Anthropic skills are used wherever they cover a stage; custom skills exist only where nothing else does (DL-27).

**Packaging (v3.0):** the `delivery` plugin in `claude/plugins/delivery`: four skills plus two hooks. The Stop hook runs `preflight` after any turn that edited files and asks once for a review only when the diff has a risky pattern; the Bash hook scans commits for secrets and asks before push/tag/merge/publish/deploy. v3 adds an opt-in `autonomy` policy in `.claude/delivery.json`. Once the user approves it, Claude pushes feature branches, opens PRs, cleans up merged branches and continues the backlog without asking. Merges, tags, releases, deploys, base-branch and force pushes still ask. Install: `/plugin marketplace add /Users/gabiru/personal/dotagents` then `/plugin install delivery@dotagents`.

**Custom skills** (`plugins/delivery/skills/`):

| Skill | Company role | Scripts (bun, tested) |
|---|---|---|
| `delivery-lifecycle` | Engineering manager: routing, merge and release gates, approvals | `preflight.ts` (classify + quality + secrets + CI audit in one call), `release_plan.ts` (semver bump and changelog), `cleanup_merged.ts` (post-merge cleanup); libraries `classify_change.ts`, `quality_gate.ts`, `scan_secrets.ts` |
| `feature-planning` | Product + tech lead: spec, testable ACs, slices, Definition of Ready | — |
| `performance-review` | Performance engineering: budgets, base vs head on p90/p95, profiling | `bench_stats.ts` |
| `ci-cd-pipeline` | Platform / DevOps: pipeline design and audit | `audit_ci.ts` |

**Anthropic and existing skills used by stage:** Design → `engineering:architecture`, `engineering:system-design`. Build → `engineering:testing-strategy`, `engineering:debug`. Verify → `defect-first-review` (always), built-in `security-review`, `engineering:deploy-checklist` for migrations. Release → `engineering:deploy-checklist`. Operate and Learn → `sre-incident-lifecycle`, `rca-investigation`, `incident-postmortem`, `engineering:tech-debt`, `engineering:documentation`, `coo-portfolio-review` (on demand).

**Repository tooling:** `claude/tools/validate_skills.ts`, root `package.json` (`bun run lint`, `bun run test`), `.github/workflows/ci.yml` (validation, all tests, secret scan, CI self-audit; SHA-pinned).

**Trigger examples:** "take this feature from idea to production" / "is this ready to merge?" → delivery-lifecycle · "write a spec for bulk invoice export" → feature-planning · "is my branch slower than main?" → performance-review · "harden our GitHub Actions" → ci-cd-pipeline.

**Decided 2026-10-06:** CI status handled as today (DL-32); `.delivery/` ignored (DL-33); security via the built-in `security-review` (DL-29); performance gates on p90/p95 (DL-31). Evals (G-43): custom vs Anthropic-only substance 26/28 vs 25/28, house rules 8/9 vs 5/9, skill selection 18/18, +8% to +40% tokens; details in `evals/evals-delivery.json`.

**Iteration 2 (2026-10-06, `evals/harness/RESULTS.md`):** 160 real headless sessions with hidden tests and voted blind grading. v2.1 vs no workflow: review work +13 pts [+9.5, +16.5] for +8% cost; v2.1 vs v1: same quality, −6% cost. Small implementation tasks: 100% in every setup (no measurable gain; harder tasks are the next test).

**Iteration 3 (2026-10-06):** five trap tasks; every setup passed all 45 implementation runs. v2.2 removes the two false alarms behind v2.1's +17% hard-task cost; its stop gate never fired, and installing the plugin costs +5–7% on implementation (insurance) while review work gains +13 pts.

**Iteration 5 (2026-10-20, autonomy):** 116 multi-turn sessions with a simulated user. In an app-like setting, no DEL needed 1.2 more nudges per task than v3 [0.9, 1.4], and v3 needed none in 30/30 runs, with the same quality and guardrails and no significant cost difference. A CLAUDE.md working agreement matched v3 on nudges at the same cost (v3's lower headless average came from harness-refused retries in the CLAUDE.md runs). v2.3 never shipped headless (it asks before every push). Installing in Heartbeat is the user's call (DL-62).

**Iteration 6 (2026-10-20, full suite):** 300 runs: no workflow, the CLAUDE.md agreement and v3 + policy, on all 13 classic tasks plus the autonomy tasks. v3 matched the agreement on nudges (both 0 in the app-like setting, against 1.2 per task with no workflow) and on cost (+$0.05 per task over no workflow for both), and beat it by +10 pts on reviews (CI audit, release prep kept out of the repo, p90/p95). The agreement scored like no workflow on reviews. One command, `bun pipeline.ts`, now runs the whole suite with nudges measured.

**Iteration 7 (2026-10-21, hard tasks shipped end to end):** 75 runs, app-like. v3 needed no nudges (25/25), against 1.0 per task with no workflow, at the same cost. The CLAUDE.md agreement needed almost none but cost +$0.22 per task (worktree set-up in every run). Trap-fix quality didn't change with autonomy; one task tempted every arm into an unasked API rename.

