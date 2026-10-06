# Performance methodology

## Measurement rules

- Same machine, same build mode (release/production), same data, same session for base and head. Record the environment (the `run` output includes platform, CPU model, core count, runtime version).
- Warm up (JIT, caches, connection pools) and discard warmup runs. Run enough to estimate the percentile you gate on: at least 20 per side for p90, 40 for p95 (the default), 200 for p99.
- Interleave base and head runs when the environment drifts (laptops on battery, thermal throttling, shared CI runners).
- Gate on tail percentiles (p90 and p95 by default), not means: latency is skewed, users feel the tail, and a change can keep the median while hurting p95. Report p50 for context.
- A difference is real only when the bootstrap confidence interval of the change excludes zero. It matters only when the interval clears the threshold or a budget is broken. The Mann-Whitney result in the output is context (did the whole distribution shift), not the gate.
- CI runners are noisy: use them to catch large regressions (> 10–20%) or count-based metrics (query count, allocations, bundle bytes), which are deterministic and better gates than wall time.

## Deterministic metrics (prefer for gates)

| Metric | How |
|---|---|
| Query count per request | ORM query logging / test assertion on query count |
| Allocations / heap | `--expose-gc` + `process.memoryUsage()`, `tracemalloc`, `go test -benchmem`, `dhat` |
| Bundle size | build output size; `size-limit`, `source-map-explorer` |
| Payload size | response body bytes in an integration test |
| Big-O check | run at N and 10N; time ratio should match the expected complexity |

## Static review classes

| Class | Signal in code | Proof |
|---|---|---|
| N+1 queries | query or fetch inside a loop / `map` with `await` | count queries for N items |
| Unbounded read | `.all()`, `SELECT *` without `LIMIT`, reading whole files/streams | size grows with user data |
| Missing index | new `WHERE`/`ORDER BY`/`JOIN` on columns without an index | `EXPLAIN` shows a sequential scan on a large table |
| Locking migration | `CREATE INDEX` without `CONCURRENTLY`, `ALTER COLUMN TYPE`, `NOT NULL` without default on big tables | lock type and table size |
| Blocking call on hot path | sync file/network I/O, `sleep`, CPU-heavy work in a request handler or event loop | handler call graph |
| Quadratic work | nested loops or `includes`/`indexOf` inside loops over user-sized lists | N at realistic size |
| Cache problems | cache key too broad/narrow, invalidation on every write, stampede on expiry | hit ratio or code path |
| Payload / bundle growth | new large dependency on the client, over-fetching fields | bytes before vs after |
| Concurrency | unbounded `Promise.all` over user data, missing pool limits, lock held across I/O | resource limits |
| Memory retention | growing module-level maps, listeners never removed, closures holding large objects | heap snapshots over time |

## Profilers

| Stack | CPU | Memory | Other |
|---|---|---|---|
| Node / Bun | `node --cpu-prof`, `bun --inspect`, `0x`, `clinic flame` | `--heap-prof`, heap snapshots | `--trace-gc` |
| Python | `py-spy record`, `cProfile` + `snakeviz`, `pyinstrument` | `tracemalloc`, `memray` | `scalene` |
| Go | `go test -cpuprofile`, `pprof` | `-memprofile`, `pprof -alloc_space` | `go tool trace` |
| Rust | `cargo flamegraph`, `perf` | `dhat`, `heaptrack` | `criterion` for benches |
| JVM | async-profiler, JFR | JFR, heap dumps | |
| Browser | Performance panel, Lighthouse | Memory panel | Web Vitals |
| Database | `EXPLAIN (ANALYZE, BUFFERS)`, slow query log, `pg_stat_statements` | | |

Running a profiler may need installing a tool; ask before installing anything.
