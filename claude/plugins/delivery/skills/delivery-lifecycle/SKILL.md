---
name: delivery-lifecycle
description: "Run software work end to end with gates: plan to a Definition of Ready, verify by what the diff touches (review, security, performance, migrations, CI), release with version and changelog. Use for \"take this from idea to production\", \"what's the next step\", \"is this ready to merge / ship\", \"cut or prepare a release\", \"what version is next\", \"changelog\", \"scan for leaked secrets\", \"run the quality gate\". Routine post-edit checks already run via this plugin's hooks. Single stages: feature-planning, defect-first-review, security-review, performance-review, ci-cd-pipeline, engineering:deploy-checklist; production problems: sre-incident-lifecycle."
---

# Delivery Lifecycle

Owns sequencing, gates and approvals. Stage work goes to the skill that owns it, and Anthropic skills are used wherever one fits.

**Already automatic (don't repeat by hand):** when you finish a turn in which you edited files, a Stop hook runs `preflight` (the repo's lint, typecheck and tests, a secrets scan, and review routing) and tells you what to fix. `git commit` is checked for secrets, and push, tag, merge, publish and deploy commands ask the user first, except what the project's autonomy policy approves (below).

## Route

| The work is… | Do |
|---|---|
| a small fix, docs, copy | Just do it. The hook checks it. Reply in a few lines. |
| a feature or change bigger than ~1 day, or unclear | `feature-planning` → Definition of Ready → build in slices |
| a new service or store, public API or schema contract, irreversible migration, new critical dependency | ADR via `engineering:architecture` before building; a person accepts it |
| "is it ready to merge?" | Run preflight on the branch, then the gates below; present the merge gate |
| a release | `release_plan.ts` + `engineering:deploy-checklist`; give the plan and draft notes in the reply, change nothing (no changelog commit, version bump or tag) until the user says go |
| production is impacted now | `sre-incident-lifecycle` first; the fix comes back here |

If the request is genuinely ambiguous, ask one short question; otherwise proceed.

## Tools (in this skill's folder; run by path)

```bash
bun scripts/preflight.ts -C <repo> [--base <branch>]   # classify + quality + secrets + CI audit, ~15 lines
bun scripts/release_plan.ts -C <repo> [--format md]    # next semver + changelog from Conventional Commits
bun scripts/cleanup_merged.ts -C <repo> [--dry-run] [BRANCH...]   # after merges: fetch --prune, fast-forward base, remove merged worktrees and branches
bun scripts/pr_risk.ts -C <repo> (--pr <n> | --base <branch>) [--review ok|fix|blocking]   # low / medium / breaking, merge route, CI, evidence to collect
```

`preflight` lists `reviews` when the diff needs judgment: security → `security-review`, performance → `performance-review`, migrations → `engineering:deploy-checklist`, CI files → `ci-cd-pipeline`. Run only those, plus `defect-first-review` for anything that will merge. Projects tune paths and checks in `.claude/delivery.json` (`hotPaths`, `securityPaths`, `ignore`, `preflight.run`, `stopGate`, `evidence`, `autonomy`).

## Gates

Each line is `pass`, `fail`, `n/a (why)` or `not verified (why)`; a check you didn't run is never `pass`. Details: [references/gates.md](references/gates.md).

- **Ready:** testable acceptance criteria, scope and non-goals, risks, independent slices, design decision made.
- **Done (per slice):** acceptance criteria covered by tests that fail without the change; preflight passes; docs or changelog updated for public behaviour.
- **Merge:** preflight passes on the branch; no open P0/P1 from review; no exploitable security finding; no p90/p95 regression without an accepted exception; migrations are expand/contract or have a rollback; CI status checked or `not verified`.
- **Release:** version and changelog done (a person classifies `Unclassified` commits); rollout and rollback trigger tied to a baseline; migration order; post-deploy checks; **explicit human go**.

## Ship and continue (autonomy policy)

When `.claude/delivery.json` has an `autonomy` block, the user has approved these steps once; the policy is added to the session at start. Then, without stopping to offer each step:

1. **Ship** a finished slice: preflight passes → `defect-first-review` against the base (fix P0/P1; list P2/P3 in the PR; `"review": false` skips it) → commit → merge the base branch in → push the branch (only names in `autonomy.push`) → open the PR (`openPr`) → turn on PR monitoring / Auto-fix when the host offers it (`autoFix`).
2. **Merge by risk** (`autonomy.merge`, below).
3. **Clean up** when told or shown that a PR merged (`cleanupMerged`): run `cleanup_merged.ts` once from the main checkout and relay its lines; don't repeat its git steps by hand. It deletes only branches contained in the remote base (`git branch -d`), and keeps dirty worktrees and squash-merged or closed branches, giving the reason for each; deleting those needs the user.
4. **Continue** (`continue.backlog`, `maxItems`): start the next backlog item whose dependencies are merged. Skip items that need a decision.

Stop for real decisions only, and put every question in one message: a merge the risk rules don't cover, tag, release, deploy, pushing the base branch, force push, an ADR, cost, an open question, missing access. While blocked on the user, keep doing unblocked work. "Hold" or "don't push" from the user wins over the policy. Also covered once approved: `gh workflow run` for `autonomy.workflows`, kubectl/helm on `localClusters`; the hooks approve these outright, so auto mode doesn't stop them.

## Merge by risk

The session that reviews a PR also rates it and owns its merge decision; it doesn't hand the rating to another session. After `defect-first-review`, run `pr_risk.ts --pr <n> --review <verdict>`. It rates the PR from the diff and commits, and that rating is a floor: raise it when the review shows more risk, never lower it.

| Risk | What makes it | Route with `"merge": {"low": "green", "medium": "decide"}` |
|---|---|---|
| low | none of the signals below | merge on green |
| medium | security, migration, performance, CI/infra or dependency gate; major version bump; size L/XL; public surface or contract change; source without tests; P2 findings | your call: merge on green when the review found nothing above P3 and the evidence shows the feature working; otherwise ask, with evidence |
| breaking | `feat!:` or `BREAKING CHANGE:`, destructive migration, a public contract (OpenAPI, proto, GraphQL) that lost lines | always ask, with evidence |

Never merge with an open P0/P1 or red CI. Without `autonomy.merge` every merge asks. The Bash hook enforces this: `gh pr merge <n>` passes only when this session ran the review and `pr_risk.ts --pr <n>`, the risk it recomputes is one the policy merges, and CI is green.

**Evidence** for an approval adapts to the project. `pr_risk.ts` lists what fits the diff: screenshots and a short recording for UI changes (browser pane, Chrome GIF, simulator), a live demo against a running instance for services, a local-cluster run for charts and infra, a command transcript for CLIs, and always the test results (commands, exit codes, counts, and the new tests that fail without the change) plus CI. Projects add their own items in `"evidence": [...]`. Produce it, send the files with the ask, and summarise it in the PR.

**Long sessions** with several features, worktrees and sub-sessions: each PR gets its own review, rating and route. Merge in dependency order, clean up after each merge, and bring dependent branches up to date with the base before their own review. Collect every approval request into one message, with one block per PR: risk and reasons, review verdict, CI, evidence.

## Approvals

Branches and local commits are fine when the user asked to build. Pushing, merging, tagging, publishing, deploying, production migrations, posting and ticket writes need the user's explicit request for that action, or the autonomy policy for the push, PR and risk-rated merge steps it lists. Never invent owners, dates, versions, thresholds or approvals: use `proposed`, `unknown` or `[to be assigned]`.

## Reply

Answer first. PR descriptions follow [references/pr-template.md](references/pr-template.md). For gates, a compact table with evidence (command and exit code, `path:line`, measured number). For multi-stage work, one status line: `Stage · gates passed/failed · next action · what needs the user`. Write in the user's language (Portuguese = PT-PT); code and commits follow the repository.
