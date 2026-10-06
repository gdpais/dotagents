---
name: performance-review
description: "Check whether a change makes software slower or heavier, and find why, with measurements instead of opinions: define the budget, measure base vs head with repeated runs, compare p90 and p95 (or the percentiles the project uses) with bootstrap confidence intervals, profile when there is a regression, and report a verdict (regression / improvement / within threshold / no significant change / inconclusive). Also reviews code for performance defects (N+1 queries, unbounded reads, missing indexes, blocking calls on hot paths, payload growth). Use when the user asks \"is this slower\", \"benchmark this\", \"performance review\", \"why is this endpoint slow\", \"set a performance budget\", or when delivery-lifecycle's performance gate is required. Not for live production latency incidents (sre-incident-lifecycle) or capacity planning of a new system (engineering:system-design)."
---

# Performance Review

Answer one question with evidence: does this change move the metric that matters, by how much, and how sure are we? Then, if it got worse, where the time goes.

## 1. Frame

- **What is measured:** the user-facing operation (endpoint latency, job duration, page load, CLI command, memory peak, bundle size, query count). Pick one primary metric and at most two secondary ones.
- **Budget:** from the user, `CLAUDE.md`, an SLO, or the project's `.claude/delivery.json`. If none exists, the comparison gates on **p90 and p95** with a default threshold of 5% (head may not be more than 5% slower than base at either percentile), labelled `default threshold`, and any absolute budget stays `[to be defined]`. Never invent an SLO.
- **Base and head:** the merge-base SHA and the change SHA. Measure both in the same environment, the same session, interleaved if possible.

## 2. Static pass (always, cheap)

Read the diff and the call paths it touches for the classes in [references/methodology.md](references/methodology.md#static-review-classes): queries in loops (N+1), unbounded reads, missing or unused indexes for new query shapes, synchronous I/O or sleeps on request paths, quadratic algorithms over user-sized data, cache invalidation storms, payload or bundle growth, lock contention, and memory retention. Each candidate needs the cited `path:line` in the reviewed version and a size argument ("for an account with N orders this runs N queries"). Confirmed defects go in the report with the same P-scale as `defect-first-review`; unproven ones are risks to measure.

## 3. Measure (when the gate is required or a static candidate needs proof)

Use the helper in this skill's folder (run by path):

```bash
W=$(mktemp -d)   # scratch space outside the repository
# head (current checkout)
bun scripts/bench_stats.ts run --cmd "<benchmark command>" --runs 40 --warmup 3 --out $W/head.json
# base: in a separate worktree so the user's tree is untouched
git -C <repo> worktree add $W/base <merge-base-sha>
bun scripts/bench_stats.ts run --cmd "<benchmark command>" --cwd $W/base --runs 40 --warmup 3 --out $W/base.json
bun scripts/bench_stats.ts compare $W/base.json $W/head.json [--stats p90,p95] [--threshold 5] [--budget p95=300,p90=250]
git -C <repo> worktree remove $W/base
```

- The benchmark command is the project's own benchmark (`pnpm bench`, `go test -bench`, `pytest-benchmark`, `hyperfine`-style script) or a minimal reproducible one you write in the temp directory. Microbenchmarks only for code that is genuinely hot; otherwise measure the operation end to end.
- The worktree is a temporary checkout outside the repository; it writes only to `.git/worktrees`. Say so before creating one, and remove it afterwards.
- `compare` reports each gated percentile with its change and a 95% bootstrap confidence interval, an overall verdict (the worst across percentiles), and exits 1 on `regression` or a budget breach. Tail percentiles need runs: p90 is fragile under 20 samples per side, p95 under 40, p99 under 200, and the output warns. A coefficient of variation above 10% means the environment is too noisy to trust a small change; fix the environment (close other work, more runs, longer warmup) before concluding.
- Never benchmark against production or shared environments without explicit authorization.

## 4. Diagnose (only on regression or when asked "why is it slow")

Profile the head build with the ecosystem's profiler ([references/methodology.md](references/methodology.md#profilers)): CPU profile or flame graph, query log with counts and timings, allocation profile. Name the hot frames or queries with their share of time, and connect them to lines in the diff. A hypothesis is confirmed only when changing that code moves the measurement.

## Report

Answer-first:

```
Verdict: regression — p95 +18.4% (95% CI +15.1% to +21.9%), p90 +16.2% (CI +13.0% to +19.5%); threshold 5% (default threshold)
Metric: POST /api/checkout latency, 40 runs + 3 warmup each, base 3f2a1c0 vs head 9b7e4d2, same machine
Base: p50 142.1 · p90 148.0 · p95 151.3 ms · Head: p50 168.3 · p90 172.0 · p95 179.0 ms · CV 2.1% / 2.4%
Cause: N+1 — src/cart/pricing.ts:58 loads each line item's promo separately (40 queries for a 40-line cart; profile: 71% of time in db.query)
Fix: batch load promos by id (pattern at src/cart/totals.ts:22); expected to restore baseline — re-measure after the fix.
```

Then: static findings (P-scale), measurements table, environment (from the sample file's `env`), what was not measured and why. If nothing was measured, the verdict is `not measured` with the static findings only — never a guessed number.

## Guardrails

- Numbers come from runs in this session or from data the user supplies; quote them as reported. No extrapolation to production load without a stated model.
- Do not change code to make a benchmark faster unless asked; a fix is a separate slice in the Build stage of `delivery-lifecycle`.
- Language follows the user's language unless they name one.
