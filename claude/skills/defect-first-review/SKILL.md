---
name: defect-first-review
description: Read-only, defect-first review of a code change — a PR URL or number, pasted diff, commit, branch against a base branch, or uncommitted work — that reports only verified, actionable regressions introduced by the change, ranked P0–P3 with cited lines, or "No findings." Use whenever someone asks to review a PR, diff, or commit, pastes even a short diff or snippet and asks "is this safe to merge?", asks to check their uncommitted or local changes for bugs, says "review this before I merge", or wants a security, performance, or correctness pass on a change. Not for whole-codebase audits or refactor priorities (engineering:tech-debt), test planning (engineering:testing-strategy), design proposals (engineering:architecture), or diagnosing a live failure (engineering:debug or rca-investigation).
---

# Defect-First Review

Find every defect in a code change that its author would want to fix, prove each one from the code, and report nothing else. The value of this review is its signal: a short list of real, reproducible problems the author trusts, not a long list of possibilities they have to triage.

`No findings.` is a complete and correct result when nothing qualifies. Never invent a finding to fill the report.

## Contract

- **Read-only.** Do not modify files, stage, commit, check out, rebase, push, or post review comments. Scratch reproductions go in a temporary directory outside the repository. Posting is a separate, explicitly requested step (see *Publishing*).
- **Change-scoped.** Review what the change introduces. Pre-existing problems, intentional behavior changes, and style preferences are out of scope.
- **Whole diff.** Continue through the entire diff after the first issue. Report the coverage you actually achieved.
- **Evidence-led.** Every finding names a concrete scenario or call path demonstrated from the code, and the evidence used to confirm it.
- **One accountable reviewer.** The session running this skill owns the final list. Lens subagents propose candidates; they do not report, post, or spawn further agents.
- **Instructions files.** Honor `CLAUDE.md` and `AGENTS.md` (repository root and any directory containing a changed file; the nearer file wins on conflict). The user's explicit request overrides both.

## Step 1 — Resolve the review target

Identify exactly what would change, before reading any code. Record the resolved identity (SHAs, refs, PR number) — it goes in the coverage note. The helper lives in this skill's folder; run it by that path and point it at the repository with `-C <repo>`. It prints JSON (comparison ref, merge base, diff command, changed files, untracked files). If Python is unavailable, run the equivalent git commands by hand.

| Input | How to resolve | Notes |
|---|---|---|
| Base branch ("review my branch against main") | `bun scripts/resolve_review_target.ts --base <branch>` then `git diff <merge_base>` | Diff the changes that would actually merge, never the branch tip. See rule below. |
| Uncommitted work | `bun scripts/resolve_review_target.ts --uncommitted`, then `git diff HEAD` and read each untracked file | Staged + unstaged + untracked. |
| Commit | `bun scripts/resolve_review_target.ts --commit <rev>`, then the printed `diff_command` | Root commits handled. |
| PR URL or number | Source-control connector or `gh pr view <n> --json baseRefName,headRefOid,title,body,files` + `gh pr diff <n>` | Read head versions with `git show <headRefOid>:<path>` after fetching the PR ref; never check it out over the user's working tree. |
| Pasted diff / patch | Use as given | Call sites outside the diff may be unavailable; state that limit and lower confidence accordingly. |

**Base-branch rule.** Resolve the comparison ref to the branch's upstream when that upstream exists and is ahead of the local branch; otherwise use the local branch. Run `git merge-base HEAD <comparison-ref>` and inspect `git diff <merge-base-sha>`. If the local branch cannot be resolved, try its configured upstream, then `<remote>/<branch>`, before reporting the target unavailable. The helper script implements exactly this and never fetches or writes; if the base is stale and a fetch is needed, say so rather than fetching silently.

If the target is ambiguous (for example "review this" with no diff, no branch, and a clean tree), ask one short question. Otherwise proceed.

Details, `gh`/connector commands, and edge cases: [references/target-resolution.md](references/target-resolution.md).

## Step 2 — Load context

Read, in this order, only what is relevant:

1. `CLAUDE.md` / `AGENTS.md` instructions that apply to the changed paths (conventions, forbidden patterns, test commands).
2. The change's stated intent: PR title and description, linked issue, or commit message. A change that fails its own stated intent is a correctness defect if it meets the reporting bar.
3. Any user focus ("focus on security", "this is a hot path", "this handles PII"). Focus narrows which lenses get depth; it does not lower the bar, and a P0 seen incidentally is still reported.
4. The full diff, then enough surrounding code for each changed path: callers, callees, types, schemas, config, and the tests that exercise it.

Classify files: hand-written source and tests get line review; generated, vendored, and lock files are checked only for consistency with their sources (for example, an unexpected dependency version change) and listed as such in the coverage note.

## Step 3 — Plan the passes

Choose single-pass or fan-out. This is a judgment call; the numbers are a rough guide, not a rule.

- **Single pass** (default): the diff plus its context fits comfortably in one reading — roughly under ~400 changed lines and ~10 files — and the user has not asked for extra depth. Apply all lenses yourself.
- **Lens fan-out**: larger diffs, security-sensitive surfaces (auth, crypto, payments, multi-tenant data, deserialization, shell/SQL construction), or an explicit request for a thorough review. Launch parallel subagents, one per lens: `security`, `correctness`, `performance` (add `data-and-migrations` when schema or persistent data changes). Each gets the whole diff.
- **Path partition**: when a single lens cannot hold the whole diff, split by cohesive path groups and give each group all lenses. Keep cross-cutting files (shared types, schemas, config) visible to every partition.

Each subagent receives: the resolved target (merge-base SHA and diff command, or the diff text), its lens checklist, the applicable instructions files, the stated intent, the reporting bar from Step 5, and the candidate schema below. It returns candidates only; it never edits, posts, or delegates. Full briefs: [references/subagent-briefs.md](references/subagent-briefs.md).

Candidate schema (every lens returns this, and so does a single pass internally):

```
- lens: security | correctness | performance | data-and-migrations | maintainability
  file: path/to/file.ext
  lines: 41-44            # smallest range that overlaps the diff
  title: imperative fix-oriented title
  scenario: concrete input/state/call path -> wrong behavior
  evidence: files/lines/tests read to support it
  would_refute: what observation would show this is not a defect
  suggested_priority: P0-P3
```

Plus a short list of areas examined with no candidates — it feeds the coverage note.

## Step 4 — Generate candidates with the coverage lenses

Walk the diff hunk by hunk through each lens. The lenses are for coverage — they make sure nothing is skipped. They are not a reporting quota. Full checklists with qualifying examples: [references/coverage-lenses.md](references/coverage-lenses.md).

- **Security**: injection (SQL, shell, template, LDAP, header), XSS, CSRF, SSRF, path traversal, insecure deserialization, authentication and authorization gaps (missing checks, tenant scoping, IDOR), secrets or credentials in code or logs, unsafe crypto or randomness, widened permissions or CORS.
- **Correctness**: edge cases (empty, null, zero, negative, overflow, unicode, time zones), off-by-one, wrong condition or operator, broken contracts with callers, type mismatches, race conditions and non-atomic check-then-act, idempotency and retries, failure to meet the stated intent.
- **Error handling**: swallowed or over-broad exceptions, lost error context, missing cleanup on failure paths, partial writes, retries without bounds, error paths that now return success.
- **Performance**: N+1 queries, unbounded queries or loops, missing pagination or limits, quadratic work on hot paths, missing index for a new query pattern, resource leaks (connections, files, goroutines, listeners), unnecessary large allocations or copies.
- **Data and migrations**: destructive or locking migrations, backfills without batching, schema/code deploy-order hazards, backward-incompatible serialization or API changes.
- **Maintainability**: only when it meaningfully raises defect risk — duplicated logic that has already diverged, a misleading name that inverts meaning, dead code that hides a live path. Not naming taste or formatting.

## Step 5 — Verify every candidate (the reporting bar)

This gate turns candidates into findings. Run it yourself for a single pass; for fan-out, verify each candidate independently of the lens that proposed it (a separate verifier subagent per batch is appropriate for large sets; always verify P0/P1 candidates yourself or with a fresh verifier). Agreement between two lenses reading the same code is not independent confirmation — the code path is.

Flag an issue only when **all** of these are true:

- It affects correctness, security, performance, or maintainability in a meaningful way.
- It is discrete and actionable.
- It was introduced by the reviewed change (check the merge-base version when unsure).
- The affected scenario or call path can be demonstrated from the code.
- The author would probably fix it if they knew about it.

Do not flag speculative concerns, pre-existing problems, intentional behavior changes, or style nits that do not obscure the code.

To verify, read the real call sites and the tests: does any caller actually reach the bad path? Does a guard elsewhere already prevent it? Does an existing test pin the new behavior as intended? Running existing, local, hermetic checks (unit tests, type checker, linter) is allowed when the repository documents how and they touch no external systems or shared state; otherwise name the check instead of running it. Never run migrations, deploys, or anything that writes outside a temporary directory.

Assign a confidence to each survivor:

- `confirmed` — the scenario is traced end to end in code, or reproduced by a test or check you ran.
- `plausible` — the defect is demonstrable in the changed code, but one named link could not be inspected (for example, an external caller, runtime config, or a pasted diff with no surrounding code). Report it only if the bar is otherwise met, and name the gap.
- `refuted` / `speculative` — drop it. If it still represents a real unknown, mention it once under residual risks, not as a finding.

## Step 6 — Deduplicate and rank

Merge candidates that describe the same root defect (keep the clearest scenario and the smallest citation; note secondary locations in the paragraph). Split a candidate that bundles two independent fixes. Order by priority, then by blast radius.

Priorities:

- `P0` — universal release blocker or critical failure (for example: data loss or corruption, auth bypass, remote code execution, a crash on the main path, secret exposure).
- `P1` — urgent defect that should be fixed next (for example: cross-tenant read, wrong results on a common path, unbounded query on a hot endpoint).
- `P2` — ordinary defect that should be fixed (for example: an edge case that produces a wrong result, an N+1 on a moderate path, a lost error on a secondary path).
- `P3` — low-impact issue still worth fixing (for example: a leak in a short-lived CLI, a misleading log on an error path).

The examples calibrate; context decides. Do not inflate a priority to make a finding look important, and do not assign business severity or impact you cannot see.

## Step 7 — Report

### When the host provides a findings-reporting tool

If the environment offers a structured findings tool (for example `ReportFindings`), and the active instructions say to use it, call it once with the verified findings ranked most-severe first (empty array when none survive) and do not also print them as text. Map fields: `file`, `line` (first line of the cited range), `summary` (`[P1] <title>` plus one-sentence defect), `failure_scenario` (the scenario), `category` (the lens), `short_summary` (the title), `verdict` (`CONFIRMED` or `PLAUSIBLE`). Put the overall assessment and coverage note in normal text.

### Otherwise: the P-format text report

Write the report in the language the user writes in, unless they explicitly ask for another; keep code, identifiers and the `[P1]` / `No findings.` markers as written.

Findings first, ordered by severity, one entry per issue:

`[P1] Imperative finding title — path/to/file.ext:line`

Follow each title with one short paragraph: the affected scenario and why the behavior is wrong. Keep the cited range as small as possible and make sure it overlaps the reviewed diff. Line numbers are file lines in the reviewed (head) version, not positions in the diff: before reporting, print each cited range from that version (for example `git show <head>:<path> | sed -n 'A,Bp'`, or `grep -n` on the working file) and confirm it contains the code you describe; when the defect lives in unchanged code but is triggered by the change, cite the changed line that triggers it. End the entry with one line: `Evidence: <what confirmed it>. Confidence: confirmed|plausible (<gap>).` Include a minimal fix snippet only when the fix is not obvious from the paragraph and fits in a few lines.

If there are no qualifying findings, write exactly `No findings.`

Then, briefly:

- **Assessment** — one or two sentences on overall correctness, with a verdict that follows from the findings: `Blocking` (any P0/P1), `Fix before merge` (P2 only), `OK to merge` (P3 only or none). The verdict is advisory; merge decisions stay with the humans who own them.
- **Test gaps** — material missing tests on business-critical paths, error handling, edge cases, security boundaries, or data integrity touched by this change. Name the test, not a coverage percentage.
- **Residual risks** — real unknowns that could not be verified and therefore are not findings, each with the check that would resolve it.
- **Coverage** — target identity (PR number / SHAs / merge base), files and lines reviewed, files checked for consistency only, lenses applied (and whether fan-out was used), checks actually run versus only recommended, and any limit (pasted diff, inaccessible callers, stale base).

## Worked example (illustrative, not real code)

```
[P1] Scope the invoice lookup to the caller's tenant — billing/api/invoices.py:42-43
The change replaces `Invoice.objects.get(id=invoice_id, tenant=request.tenant)` with
`Invoice.objects.get(id=invoice_id)`. `GET /invoices/<id>` (billing/api/urls.py:18) only
requires an authenticated user, and invoice IDs are sequential integers, so any user can read
another tenant's invoice by incrementing the ID.
Evidence: route -> `InvoiceView.get` -> `get_invoice` traced; tests/test_invoices.py has no
cross-tenant case. Confidence: confirmed.

[P2] Restore `select_related("product")` on the line-item queryset — billing/api/invoices.py:51
The serializer reads `line.product.tax_rate` for every line (billing/serializers.py:88). With
the prefetch removed, rendering an invoice issues one query per line item; the largest fixture
(tests/fixtures/invoice_500.json) produces 501 queries for one request.
Evidence: ran `pytest billing/tests/test_serializers.py -q` with query logging in a temp copy.
Confidence: confirmed.

[P3] Close the export file when serialization fails — scripts/export_invoices.py:27
`open(path, "w")` is no longer inside the `with` block, so an exception from `json.dump` leaves
the handle open until process exit. Impact is limited to this one-shot CLI.
Evidence: read the full script; single caller in Makefile:12. Confidence: confirmed.

Assessment: Blocking — one P1 cross-tenant read; the rest of the pricing refactor looks correct.
Test gaps: no negative cross-tenant test for invoice endpoints; no query-count assertion on the
invoice serializer.
Residual risks: migration 0042 adds a NOT NULL column with a default on `invoice_lines`; lock
duration depends on table size, which is not visible here — check row count before deploy.
Coverage: PR #1234, head 9f3c2e1, merge base a17b0d4; 9 files, +312/-88 reviewed; schema.json
(generated) checked for consistency only; lenses security, correctness, performance in a single
pass; ran billing unit tests (48 passed); recommended but not run: integration suite.
```

A clean result looks like:

```
No findings.

Assessment: OK to merge — the retry change is bounded and the new error path is covered by
test_retry_gives_up_after_budget.
Coverage: uncommitted changes against HEAD 5d2e9aa; 3 files, +41/-12; single pass; ran
`go test ./internal/retry/...` (pass).
```

## Publishing (only when explicitly asked)

Do not post comments, request changes, approve, push, or open issues unless the user explicitly asks. When they do:

- A clear instruction ("post these as review comments on PR 1234") is authorization for that scope; do not re-ask for each comment.
- An ambiguous one ("can you leave this on the PR?") gets a draft shown first.
- Post only verified findings, each anchored to its cited line in the PR head, plus one summary comment. Use the source-control connector when attached, otherwise `gh`; with neither, return ready-to-paste comments.
- Never approve or request changes on the user's behalf unless they name that action.

Commands and anchoring rules: [references/github-posting.md](references/github-posting.md).

## Hand-offs

- Pre-existing problems or broad code-health concerns the user wants pursued → `engineering:tech-debt`.
- "What tests should we add?" beyond the named gaps → `engineering:testing-strategy`.
- A finding that needs runtime investigation of a live failure → `engineering:debug`, or `rca-investigation` for a production incident.
- Design-level disagreement with the approach (not a defect) → `engineering:architecture`; mention it in the assessment, not as a finding.

## Completion check

Before returning, confirm:

- The resolved target and merge base are stated, and the whole diff was read.
- Every finding passed all five bar criteria, cites a range that exists in the reviewed file and overlaps the diff, and carries evidence and confidence.
- Nothing speculative, pre-existing, or stylistic is listed as a finding.
- Findings are ordered P0 → P3, deduplicated, and `No findings.` is used when the list is empty.
- No file, branch, or remote state was changed, and nothing was posted without an explicit request.
