---
name: ci-cd-pipeline
description: "Design, harden, or audit a CI/CD pipeline so it enforces the delivery gates automatically: lint, typecheck, tests, build, secret and dependency scanning, SAST, and a protected deploy with environments, approvals, concurrency and rollback. Audits GitHub Actions workflows for unpinned actions, broad token permissions, pull_request_target misuse, script injection, printed secrets, missing timeouts, and unprotected deploy jobs, and maps which gates the pipeline actually enforces. Use when the user says \"set up CI\", \"add a pipeline / GitHub Actions\", \"audit / harden our workflows\", \"why isn't CI catching X\", \"add a deploy pipeline\", or when delivery-lifecycle's infra gate is required. Not for a one-off deploy checklist (engineering:deploy-checklist), release versioning and changelog (delivery-lifecycle release_plan.ts), or a production incident (sre-incident-lifecycle)."
---

# CI/CD Pipeline

The pipeline is where the workflow's gates stop depending on people remembering them. Every gate in `delivery-lifecycle` that can be automated should run in CI; every deploy should go through a protected, auditable path.

## Audit (existing pipeline)

1. Run the auditor in this skill's folder (read-only; run by path):

   ```bash
   bun scripts/audit_ci.ts -C <repo>
   ```

   It parses `.github/workflows/*.yml`, reports findings `CI01`–`CI12` with level, job and step, and a `gates` map showing whether lint, typecheck, test, build, secret scan, dependency scan, SAST and deploy appear anywhere. Exit 1 means at least one `high`.
2. Read each `high` and `medium` in the workflow file to confirm it (the auditor is pattern-based: e.g. a `pull_request_target` job that checks out the base branch is safe). Drop false positives with the reason.
3. Compare the `gates` map with the project's quality commands (`quality_gate.ts` from `delivery-lifecycle`, or `CLAUDE.md`). A gate the team relies on that CI does not run is a finding: "tests pass locally" is not enforced.
4. For other CI systems (GitLab CI, CircleCI, Jenkins, Azure Pipelines, Buildkite) apply the same checks by reading the config: pinned images and orbs, least-privilege tokens, untrusted input in scripts, secrets in logs, timeouts, protected deploy stages.

Report answer-first: the `high` findings with file, job, step and the fix; then `medium`/`low` grouped; then the gate map with what is missing. Proposed fixes are shown as diffs; applying them is a change like any other (built and reviewed through `delivery-lifecycle`).

## Design (new or rebuilt pipeline)

Start from [references/pipeline-blueprint.md](references/pipeline-blueprint.md), adapted to the detected stack. Principles:

- **Fast feedback first:** format/lint/typecheck in parallel, then tests, then build; cache dependencies; fail fast. Target under ~10 minutes for the PR path; split slow suites (e2e, load) into a separate job or schedule.
- **Same commands as local:** CI calls the repository's own scripts (`make test`, `pnpm run test`), not a parallel definition that drifts.
- **Security gates in the PR path:** secret scan on the diff, dependency review for manifest changes, SAST where the stack has a mature tool (CodeQL, Semgrep). Block on high-confidence findings only, to keep trust in the signal.
- **Least privilege:** top-level `permissions: contents: read`; widen per job only where needed; actions pinned to full SHAs (Dependabot or Renovate keeps them current); `persist-credentials: false` unless a step pushes; OIDC to the cloud instead of long-lived keys.
- **Untrusted input:** never interpolate `github.event.*` text fields into `run:`; pass through `env:` and quote. Never run fork code under `pull_request_target` with secrets.
- **Protected deploys:** deploy jobs run only from the default branch or tags, use a GitHub `environment` with required reviewers for production, a `concurrency` group without cancel-in-progress, a timeout, a post-deploy smoke check, and a documented rollback job.
- **Artifacts once:** build once, promote the same artifact (image digest, package) through environments; record provenance (SLSA/attestations) when the org requires it.
- **Branch protection:** required status checks on the default branch, required review, linear history if the team wants it. These are repository settings: recommend them; changing them needs the user (it is an account/security setting).

## Guardrails

- Writing workflow files is a code change; pushing them, enabling workflows, adding secrets, or changing branch protection needs explicit authorization. Never print or request secret values; refer to them by name.
- Do not invent cloud accounts, environments, registry names, or approvers; use placeholders the user fills.
- Do not trigger workflow runs (`gh workflow run`) or re-run deploys without explicit authorization.
- Language follows the user's language unless they name one; YAML, commands and identifiers stay as is.
