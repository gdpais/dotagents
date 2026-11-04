# Gates, skip rules and approvals

Each gate is a checklist judged on evidence. Mark every line `pass`, `fail`, `n/a (<reason>)`, or `not verified (<reason>)`. A gate passes when no line is `fail`; `not verified` lines are shown to the user, who decides whether to accept them.

## Definition of Ready (end of Stage 1)

- Problem stated in one or two sentences, with who is affected.
- Acceptance criteria are testable (Given/When/Then or an equivalent observable check).
- Scope and non-goals written; anything ambiguous has an open question.
- Risks listed with a mitigation or an owner-to-be (`[to be assigned]` is fine).
- Work sliced into independently mergeable steps, each with its own acceptance check.
- Dependencies (teams, services, data, access) named.
- Design need decided: ADR required, or `not needed` with the reason.
- Rough size per slice (S/M/L) labelled `estimate`.

## Definition of Done (each slice, end of Stage 3)

- Acceptance criteria of the slice are covered by tests that fail without the change (or a stated reason they cannot be).
- Quality gate passes: format, lint, typecheck, tests, build as detected by `quality_gate.ts` or defined in `CLAUDE.md`.
- No secrets in the diff (`scan_secrets.ts --staged` before each commit, or `--diff <base>...HEAD`).
- Public behaviour change reflected in docs, changelog entry, or API schema.
- Feature flag or kill switch in place when the plan called for one.
- Commits follow the repository convention (Conventional Commits by default).

## Merge gate (end of Stage 4)

| Line | Source |
|---|---|
| Quality gate green on the final diff | `quality_gate.ts --run all` exit code |
| No open Critical or High finding | `engineering:code-review` |
| No open exploitable security finding; secrets scan clean | `security-review` + `scan_secrets.ts` (when the security gate is required) |
| No `regression` verdict, or a recorded budget exception | `performance-review` (when the performance gate is required) |
| Migration is backward compatible (expand → migrate → contract) or has a tested rollback | `engineering:code-review`, `engineering:deploy-checklist` |
| No `high` on changed CI/CD files | `ci-cd-pipeline` audit (when the infra gate is required) |
| CI status on the branch | user, `gh pr checks`, or source-control connector |
| Risk rated in the reviewing session, route followed | `pr_risk.ts --pr <n> --review <verdict> --format md`: low, medium or breaking, raised (never lowered) by the review; its Decision block goes under the review's tables |

**Merge by risk** (opt-in `autonomy.merge` in `.claude/delivery.json`; with `"review": "session"` each PR's own review session decides): low merges on green (merged now when CI is green, or GitHub auto-merge pinned to the reviewed head while the base's required checks run); medium is Claude's call between merging on green (review `ok`, evidence shows it working), blocking it (Critical or High findings, or not right yet) and asking with evidence; breaking, or any doubt between medium and breaking, waits for the user's review and approval. An ask carries the product-facing evidence `pr_risk.ts` lists for the project: screenshots and a recording for UI, a live demo for services, a local-cluster run for charts and infra, a transcript for CLIs, and well-defined test results plus CI for everything.

## Release gate (Stage 5)

- Merge gate passed for everything in the release.
- Version and changelog generated (`release_plan.ts`); `Unclassified` commits reviewed by a human.
- Rollout strategy chosen (all-at-once, canary, blue/green, flag ramp) with reason, via `engineering:deploy-checklist`.
- Rollback trigger stated as a measurable condition from a baseline (never invented), and the rollback method rehearsed or documented.
- Post-deploy checks named: which signals, which baseline, which watch window.
- Migrations ordered relative to the deploy.
- Explicit human go for tag, publish and deploy.

## Skip rules

| Stage | May be skipped when | Record |
|---|---|---|
| 1 Plan | fast path, or the user supplies an accepted spec/ticket meeting the DoR | `plan: provided` or `fast path` |
| 2 Design | none of the design triggers apply | `design: not needed (<reason>)` |
| 4 gates other than review | `classify_change.ts` reports `skip` and reading the diff agrees | gate `skip (no signal)` |
| 5 Release | library or repo with no release process, or continuous deploy on merge handled by CI | `release: by CI on merge` |
| 6 Operate | nothing was deployed | `operate: n/a` |

Review (Stage 4 `engineering:code-review`) is never skipped for code that will merge.

## Approval matrix

| Action | Who approves | Default |
|---|---|---|
| DoR accepted with gaps | user / product owner | ask |
| ADR accepted | user / architect | stays `proposed` |
| Create branch, local commits | implied by "build it" | allowed |
| Push to a feature branch, open a draft PR | user | ask once per work item |
| Merge a low or medium PR on green | user, once, via `autonomy.merge` | ask without it |
| Merge a breaking PR, push to the default branch | user | never without explicit request; breaking merges come with evidence |
| Tag, publish package, create GitHub release | user | never without explicit request |
| Deploy, run production migration, flip production flag | user (and the org's change process) | never without explicit request |
| Post comments, update tickets, send messages | user | ask; standing authorization per destination allowed |
