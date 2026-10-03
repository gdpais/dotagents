# Coverage lenses

The lenses make sure each part of the diff is examined from every relevant angle. They are **coverage**, not a quota: a lens that produces no candidates is a normal outcome and is recorded as "examined, nothing found". Every candidate still has to pass the reporting bar in SKILL.md Step 5.

Origin: the lens categories come from Anthropic's `engineering:code-review` review dimensions (security, performance, correctness, maintainability). The "qualifies / does not qualify" lines apply the review-agent reporting bar to each lens.

## Contents

- Security
- Correctness
- Error handling
- Performance
- Data and migrations
- Maintainability
- Tests (read as evidence, reported as gaps)

---

## Security

Look for, in changed code and the paths it newly exposes:

- Injection: SQL/NoSQL built by string concatenation or format; shell commands with interpolated input; template, LDAP, XPath, header, or log injection.
- XSS: unescaped output, `dangerouslySetInnerHTML` / `v-html` / `|safe` with user data, URL schemes not validated.
- CSRF: new state-changing endpoints without the project's CSRF protection.
- SSRF: server-side fetch of user-supplied URLs without allowlist.
- Path traversal: user input joined into filesystem paths without normalization and containment check.
- Insecure deserialization: `pickle`, `yaml.load`, Java/PHP native deserialization, or polymorphic JSON on untrusted input.
- Authentication and authorization: removed or bypassed checks, missing tenant/owner scoping (IDOR), privilege checks on the wrong object, trust in client-supplied role or ID.
- Secrets: credentials, tokens, or keys committed; secrets or PII newly written to logs, errors, or analytics.
- Crypto and randomness: non-cryptographic RNG for tokens, weak or homemade crypto, disabled TLS verification, timing-unsafe comparison of secrets.
- Exposure widening: permissive CORS, public buckets, broader IAM, debug endpoints enabled.

Qualifies: an attacker-controlled input demonstrably reaches the sink, or a check that previously applied no longer does.
Does not qualify: "this could be vulnerable if someone later passes user input here" with no such caller; hardening suggestions for code the change did not touch.

## Correctness

- Edge inputs: empty collections, null/None/undefined, zero, negative, max values and overflow, NaN, unicode and normalization, locale, time zones and DST, leap days.
- Off-by-one and boundary conditions; inclusive vs exclusive ranges; pagination cursors.
- Logic errors: inverted conditions, wrong operator, short-circuit mistakes, shadowed variables, mutated shared defaults.
- Contracts: signature or return-shape changes that break existing callers; changed units; changed ordering guarantees; API responses that clients depend on.
- Concurrency: check-then-act without atomicity, shared mutable state without locking, async functions not awaited, event ordering assumptions, non-idempotent handlers behind at-least-once delivery.
- Stated intent: the PR says it does X; the code does not do X on some path.

Qualifies: a specific input or sequence produces a wrong result, and a real caller can produce it.
Does not qualify: a theoretical input no caller can produce (check types, validation upstream, and call sites first).

## Error handling

- Exceptions swallowed (`except: pass`, empty `catch`), or caught too broadly so real failures become success.
- Error context lost (re-raise without cause, error mapped to a generic message that hides the failure from callers who branch on it).
- Missing cleanup on failure: locks, transactions, temp files, partially written records.
- Retries without bounds, backoff, or idempotency.
- Error paths that now return success codes or default values that downstream code treats as valid data.

Qualifies: a failure that previously surfaced is now hidden or leaves inconsistent state.
Does not qualify: "consider adding more logging" where no behavior is lost.

## Performance

- N+1 queries: per-item queries in loops, lazy relations touched inside serializers or templates, removed eager loading.
- Unbounded work: queries without limits, loading whole tables, loops over user-controlled sizes, missing pagination.
- Complexity: quadratic or worse work on a hot path (nested scans, repeated `list.index`, string concatenation in loops in languages where it copies).
- Indexes: a new query pattern (filter/sort/join column) with no supporting index on a large table.
- Resource leaks: connections, file handles, goroutines/threads, subscriptions, event listeners, timers not released.
- Allocation: large copies or materializations where streaming was used before.

Qualifies: the path is reachable at realistic scale (hot endpoint, large fixture, documented volume) and the cost grows with input.
Does not qualify: micro-optimizations; cold paths with bounded, small inputs.

## Data and migrations

Use when schema, persistent formats, or stored data change.

- Destructive operations (drop column/table, type narrowing) without a safe sequence.
- Locking operations on large tables (adding NOT NULL with default on some engines, index builds without concurrent option).
- Backfills in one transaction or without batching.
- Deploy-order hazards: new code reading a column not yet migrated, or old code breaking after migration.
- Backward-incompatible serialization: renamed fields in events, caches, or queues that old consumers read.

Qualifies: a concrete deploy sequence or data state leads to failure or loss.
Does not qualify: preference for a different migration tool or style. If table size or engine is unknown, list it under residual risks with the check to run.

## Maintainability

Only when it meaningfully raises the risk of defects:

- Duplicated logic that has already diverged from its original in this change.
- A name that now states the opposite of what the code does.
- Dead or unreachable code that hides the path actually taken.
- A new abstraction that silently changes behavior for existing users.

Does not qualify: naming taste, formatting, comment style, "could be split into smaller functions", single-responsibility preferences. The review-agent bar excludes style nits that do not obscure the code, and that bar wins over the broader Anthropic "style" dimension.

## Tests (read as evidence, reported as gaps)

Tests serve two roles:

1. **Evidence.** Read the tests for each changed path. An existing test that pins the new behavior is evidence the change is intentional; a test that would fail on the new code is strong evidence of a defect (run it if running is permitted).
2. **Gaps.** After findings, name material missing tests on the paths this change touches: business-critical paths, error handling, edge cases, security boundaries, data integrity (the focus areas from `engineering:testing-strategy`). Name the specific test that is missing.

A missing test is not itself a finding. A broken or now-meaningless test (asserting nothing, or asserting the bug) is a finding if it meets the bar.
