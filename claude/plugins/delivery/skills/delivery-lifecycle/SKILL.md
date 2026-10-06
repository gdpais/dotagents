---
name: delivery-lifecycle
description: "Run software work end to end with gates: plan to a Definition of Ready, verify by what the diff touches (review, security, performance, migrations, CI), release with version and changelog. Use for \"take this from idea to production\", \"what's the next step\", \"is this ready to merge / ship\", \"cut or prepare a release\", \"what version is next\", \"changelog\", \"scan for leaked secrets\", \"run the quality gate\". Routine post-edit checks already run via this plugin's hooks. Single stages: feature-planning, defect-first-review, security-review, performance-review, ci-cd-pipeline, engineering:deploy-checklist; production problems: sre-incident-lifecycle."
---

# Delivery Lifecycle

Owns sequencing, gates and approvals. Stage work goes to the skill that owns it, and Anthropic skills are used wherever one fits.

**Already automatic (don't repeat by hand):** when you finish a turn in which you edited files, a Stop hook runs `preflight` (the repo's lint, typecheck and tests, a secrets scan, and review routing) and tells you what to fix. `git commit` is checked for secrets, and push, tag, merge, publish and deploy commands always ask the user first.

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
```

`preflight` lists `reviews` when the diff needs judgment: security → `security-review`, performance → `performance-review`, migrations → `engineering:deploy-checklist`, CI files → `ci-cd-pipeline`. Run only those, plus `defect-first-review` for anything that will merge. Projects tune paths and checks in `.claude/delivery.json` (`hotPaths`, `securityPaths`, `ignore`, `preflight.run`, `stopGate`).

## Gates

Each line is `pass`, `fail`, `n/a (why)` or `not verified (why)`; a check you didn't run is never `pass`. Details: [references/gates.md](references/gates.md).

- **Ready:** testable acceptance criteria, scope and non-goals, risks, independent slices, design decision made.
- **Done (per slice):** acceptance criteria covered by tests that fail without the change; preflight passes; docs or changelog updated for public behaviour.
- **Merge:** preflight passes on the branch; no open P0/P1 from review; no exploitable security finding; no p90/p95 regression without an accepted exception; migrations are expand/contract or have a rollback; CI status checked or `not verified`.
- **Release:** version and changelog done (a person classifies `Unclassified` commits); rollout and rollback trigger tied to a baseline; migration order; post-deploy checks; **explicit human go**.

## Approvals

Branches and local commits are fine when the user asked to build. Pushing, merging, tagging, publishing, deploying, production migrations, posting and ticket writes need the user's explicit request for that action. Never invent owners, dates, versions, thresholds or approvals: use `proposed`, `unknown` or `[to be assigned]`.

## Reply

Answer first. PR descriptions follow [references/pr-template.md](references/pr-template.md). For gates, a compact table with evidence (command and exit code, `path:line`, measured number). For multi-stage work, one status line: `Stage · gates passed/failed · next action · what needs the user`. Write in the user's language (Portuguese = PT-PT); code and commits follow the repository.
