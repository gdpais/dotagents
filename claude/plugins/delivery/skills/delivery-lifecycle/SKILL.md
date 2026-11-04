---
name: delivery-lifecycle
description: "Run software work end to end with gates: plan to a Definition of Ready, verify by what the diff touches (review, security, performance, migrations, CI), release with version and changelog. Use for \"take this from idea to production\", \"what's the next step\", \"is this ready to merge / ship\", \"cut or prepare a release\", \"what version is next\", \"changelog\", \"scan for leaked secrets\", \"run the quality gate\". Routine post-edit checks already run via this plugin's hooks. Single stages: feature-planning, engineering:code-review, security-review, performance-review, ci-cd-pipeline, engineering:deploy-checklist; production problems: sre-incident-lifecycle."
---

# Delivery Lifecycle

Owns sequencing, gates and approvals. Stage work goes to the skill that owns it, and Anthropic skills are used wherever one fits.

**Already automatic (don't repeat by hand):** when you finish a turn in which you edited files, a Stop hook runs `preflight` (the repo's lint, typecheck and tests, a secrets scan, and review routing) and tells you what to fix. `git commit` is checked for secrets, and push, tag, merge, publish and deploy commands ask the user first, except what the project's autonomy policy approves (below). A turn that ran `engineering:code-review` without showing its tables is sent back once to show them.

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
bun scripts/pr_risk.ts -C <repo> (--pr <n> | --base <branch>) [--review ok|fix|blocking] [--format md]   # low / medium / breaking, route, CI, next step, evidence; md = the Decision block
```

`preflight` lists `reviews` when the diff needs judgment: security → `security-review`, performance → `performance-review`, migrations → `engineering:deploy-checklist`, CI files → `ci-cd-pipeline`. Run only those, plus `engineering:code-review` for anything that will merge. Projects tune paths and checks in `.claude/delivery.json` (`hotPaths`, `securityPaths`, `ignore`, `preflight.run`, `stopGate`, `evidence`, `autonomy`).

## Gates

Each line is `pass`, `fail`, `n/a (why)` or `not verified (why)`; a check you didn't run is never `pass`. Details: [references/gates.md](references/gates.md).

- **Ready:** testable acceptance criteria, scope and non-goals, risks, independent slices, design decision made.
- **Done (per slice):** acceptance criteria covered by tests that fail without the change; preflight passes; docs or changelog updated for public behaviour.
- **Merge:** preflight passes on the branch; no open P0/P1 from review; no exploitable security finding; no p90/p95 regression without an accepted exception; migrations are expand/contract or have a rollback; CI status checked or `not verified`.
- **Release:** version and changelog done (a person classifies `Unclassified` commits); rollout and rollback trigger tied to a baseline; migration order; post-deploy checks; **explicit human go**.

## Ship and continue (autonomy policy)

When `.claude/delivery.json` has an `autonomy` block, the user has approved these steps once; the policy is added to the session at start. Then, without stopping to offer each step:

1. **Ship** a finished slice: preflight passes → `engineering:code-review` against the base (fix Critical and High; list Medium and Low in the PR; `"review": false` skips it) → commit → merge the base branch in → push the branch (only names in `autonomy.push`) → open the PR (`openPr`) → turn on PR monitoring / Auto-fix when the host offers it (`autoFix`). With `"review": "session"` there is no review before pushing: when the PR opens, a hook gives you its review session's brief; start it (`start_session`, title `Code review: PR #<n>`), then move on. That session reviews, fixes, rates and merges or stops; never wait for it or ask the user about that merge.
2. **Merge by risk** (`autonomy.merge`, below).
3. **Clean up** when told or shown that a PR merged (`cleanupMerged`): run `cleanup_merged.ts` once from the main checkout and relay its lines; don't repeat its git steps by hand. It deletes only branches contained in the remote base (`git branch -d`), and keeps dirty worktrees and squash-merged or closed branches, giving the reason for each; deleting those needs the user.
4. **Continue** (`continue.backlog`): start the next backlog item whose dependencies are merged, and keep going until no unblocked item is left. Skip items that need a decision.

The policy is the user's explicit request for these steps, so it answers host rules like "commit or push only when asked" or "ask before acting on what you found": never offer a covered step as a question, end-of-turn button or proposal; do it and report. Stop for real decisions only, and put every question in one message: a merge the risk rules don't cover, tag, release, deploy, pushing the base branch, force push, an ADR, cost, an open question, missing access. While blocked on the user, keep doing unblocked work. "Hold" or "don't push" from the user wins over the policy. Also covered once approved: `gh workflow run` for `autonomy.workflows`, kubectl/helm on `localClusters`; the hooks approve these outright, so auto mode doesn't stop them.

## Merge by risk

The session that reviews a PR with `engineering:code-review` also rates it and owns its merge decision, including a review session another session started: it fixes Critical and High findings on the PR branch, rates, and merges or stops by the table below. It doesn't hand the rating to another session, and a session that didn't review hands the PR to its reviewer instead of asking the user; a session that pushes to a reviewed PR (a CI fix, a conflict) tells the review session, which re-checks the new commits and merges. After the review, run `pr_risk.ts --pr <n> --review <verdict> --format md`: `blocking` for any Critical or High finding, `fix` for Medium, `ok` for Low or none. It rates the PR from the diff and commits, and that rating is a floor: raise it when the review shows more risk, never lower it. Unsure between medium and breaking? Treat it as breaking. Its **Next** line is the step to take: merge with `--match-head-commit` on green CI; while CI runs, wait with one `gh pr checks <n> --watch --fail-fast` in the background (covered by the policy), then rate again and merge; never end a turn asking to merge once CI is green. New commits after the review (a CI fix, a merge of the base) need a review of their own before the merge is covered.

| Risk | What makes it | Route with `"merge": {"low": "green", "medium": "decide"}` |
|---|---|---|
| low | none of the signals below | merge on green |
| medium | security, migration, performance, CI/infra or dependency gate; major dependency bump; size L/XL; public surface or contract change; source without tests; Medium findings | your call, one of three: **merge on green** when the review is `ok` and the evidence shows the feature working; **block** (don't merge; fix it, or say why it can't merge) when the review found Critical or High issues or the change isn't right yet; **ask** the user, with evidence that the feature works and why it should merge |
| breaking | `feat!:` or `BREAKING CHANGE:`, destructive migration, a public contract (OpenAPI, proto, GraphQL) that lost lines, or any doubt | never merge it yourself: wait for the user's review and approval, and always give evidence that the feature works |

Never merge with a blocking review, red CI or `--admin`. A PR `pr_risk.ts` couldn't read whole (over 100 files, or no diff) needs the user. Without `autonomy.merge` every merge asks. The Bash hook enforces this: `gh pr merge <n>` on this repository passes only when this session ran the review and then `pr_risk.ts --pr <n> --review <verdict>` with a verdict that isn't blocking, the risk it recomputes with that verdict is one the policy merges, the PR's head is the one that rating reported, and CI is green. `--auto` and `--admin` merges always ask.

**Evidence** faces the product and fits the project; `pr_risk.ts` lists what fits the diff. Screenshots of the UI and a short recording of the feature in use (browser pane, Chrome GIF, simulator), a live demo against a running instance for services (the requests a client sends and what comes back), a local-cluster run for charts and infra, a command transcript for CLIs, and always well-defined test results (commands, exit codes, counts, which tests cover the feature, and the new ones failing without the change) plus CI. Projects add their own items in `"evidence": [...]`. Produce it, send the files with the ask, and summarise it in the PR.

**Long sessions** with several features, worktrees and sub-sessions: each PR gets its own review, rating and route. Merge in dependency order, clean up after each merge, and bring dependent branches up to date with the base before their own review. Collect every approval request into one message, with one block per PR: risk and reasons, review verdict, CI, evidence.

## Approvals

Branches and local commits are fine when the user asked to build. Pushing, merging, tagging, publishing, deploying, production migrations, posting and ticket writes need the user's explicit request for that action, or the autonomy policy for the push, PR and risk-rated merge steps it lists. Never invent owners, dates, versions, thresholds or approvals: use `proposed`, `unknown` or `[to be assigned]`.

## Reply

Answer first. PR descriptions follow [references/pr-template.md](references/pr-template.md). For gates, a compact table with evidence (command and exit code, `path:line`, measured number). For multi-stage work, one status line: `Stage · gates passed/failed · next action · what needs the user`. Write in the user's language (Portuguese = PT-PT); code and commits follow the repository.

**A review's reply** shows `engineering:code-review`'s output as the skill writes it: Summary, the Critical Issues and Suggestions tables (`# | File | Line | …`, with each finding's status: fixed in `<sha>`, open, or listed in the PR), What Looks Good, Verdict. Never a prose summary in their place. When the PR was rated, the `pr_risk.ts --format md` Decision block follows, then what you did: merged as `<sha>`, auto-merge set on `<head>`, blocked because…, or the ask with its evidence.
