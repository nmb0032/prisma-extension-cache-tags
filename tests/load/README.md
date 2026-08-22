# Benchmark harnesses

The `tests/load` directory contains two benchmarks with different purposes:

- `test:benchmark:invalidation` is a synthetic Redis-only keyspace-scaling
  microbenchmark. It does not exercise Prisma or PostgreSQL.
- `test:benchmark:load` is a model-backed workload that runs real cached Prisma
  `Widget` and `Part` unique/list/aggregate operations against PostgreSQL and
  Redis. Its shared read corpus also probes distributed cold-list stampede
  behavior and reads widget writes back through another client.

## Synthetic invalidation benchmark

This benchmark measures invalidation latency while the Redis keyspace grows
from 1,000 to 100,000 cached keys. It seeds each keyspace with cached query
values, performs 200 invalidations with the real node-redis adapter, and
records p50 and p99 latency. Redis command statistics verify one logical
increment per invalidation: optimized `EVALSHA` calls contain a nested `INCR`,
while the command fallback reports `INCRBY`.

Run it against a disposable Redis instance:

```bash
pnpm test:benchmark:invalidation
```

Set `TEST_REDIS_URL` to use another Redis endpoint:

```bash
TEST_REDIS_URL=redis://localhost:6380 pnpm test:benchmark:invalidation
```

**Warning:** Run the benchmark only against a disposable Redis
instance/database with no concurrent users. It unconditionally uses `FLUSHDB`,
which deletes all keys in the selected database, and reads instance-wide Redis
`commandstats`; concurrent clients can therefore lose data and corrupt the
command-count measurements.

The benchmark passes when p50 invalidation latency grows by no more than 2x
across the 100x keyspace increase. It exits non-zero when that threshold is
exceeded or when the observed logical `INCR` plus `INCRBY` count is not fixed.

## Model-backed load benchmark

The model-backed benchmark requires PostgreSQL and Redis plus the fixture schema
setup described in [CONTRIBUTING.md](../../CONTRIBUTING.md). It uses the
`quick` profile by default:

```bash
pnpm test:benchmark:load
pnpm test:benchmark:load -- --profile quick
pnpm test:benchmark:load -- --profile stress
pnpm test:benchmark:load -- --workload list-heavy
pnpm test:benchmark:load -- --workload zipfian
pnpm test:benchmark:load -- --profile stress --workload list-heavy
pnpm test:benchmark:load -- --preserve
```

It first discards one untimed raw warm-up and then reports finite raw A, cold,
warm, and raw B phases. The deterministic plan is built from the shared corpus
and covers `Widget.findUnique`, `Part.findUnique`, `Widget.findMany`,
`Part.findMany`, and `Widget.aggregate`. Raw reads set `cache.enabled: false`;
cold reads run once after clearing only the validated current-run namespace;
warm reads repeat the exact plan without cleanup. The same client concurrency is
used for every measured phase, results are checked by deterministic digest, and
each row reports completed reads, elapsed time, throughput, p50/p95/p99
latency, cache hits/misses, cache-event hit rate (including waiter hits and
bypasses), database queries, and event-loop
utilization. The report calculates symmetric raw A/B drift. At no more than 10%
drift, speedups use the mean raw throughput; otherwise comparative speedups
render as `unstable`.

Each phase also prints a separate per-query-kind table for
`widgetUnique`, `partUnique`, `widgetList`, `partList`, and
`widgetAggregate`, so an aggregate row cannot hide a regressing kind.

Next, 32 independent Prisma clients sharing one Redis connection start the same
cold-key read behind a shared barrier. Quick runs execute 10 rounds and stress
runs execute 30. Each round must issue exactly one database query and return
equal results. The report
separates the fastest request in each round as the winner sample and reports
p50/p95/p99 for winners and the remaining loser samples.

The command then runs the existing blended 90% read / 10% write report, which
continues to validate invalidation, distributed stampede behavior, and
post-write freshness. Comparison counters are reset before that mixed report.
The run namespace is also cleared before the existing mixed-workload warm-up,
keeping its cache state independent of the comparison.
Performance measurements are informational and are not CI gates or statistical
claims; workload errors, digest mismatches, and freshness failures still fail
the command. Normal cleanup removes only the run-specific database rows and
Redis namespace. `--preserve` skips cleanup and prints the run ID, tenant IDs,
and Redis key prefix for inspection. Warm-up requests are sampled and bounded,
and each benchmark Prisma client is capped at one PostgreSQL connection so the
stress profile stays within its concurrency budget.

Before workers start, isolated warm-read, cold-read, write, and multi-tag
invalidation probes assert their expected cache events and database-query counts
before reporting Redis `INFO commandstats` deltas. These are process-wide
counters rather than namespace-local counts. The command columns are `get`,
`mget`, `set`, `eval`, `evalsha`, nested `incr`, fallback `incrby`, and `expire`;
multi-tag invalidation reports the nested logical increment count. A failed
prime or populate aborts the benchmark before a probe can look successful.
Every measured phase, including command probes, contention, and mixed
correctness, reports event-loop active/idle milliseconds and utilization.

`standard` is intentionally unfavorable to caching because it contains mostly
unique reads and writes. `list-heavy` uses `take: 100`, deterministic
512-character Widget and 256-character Part descriptions, and at least 70% list
or aggregate reads. `zipfian` uses a seeded PRNG with exponent 1.1, repeated identities across the
complete five-kind query set, and an approximately 80% hottest-20% traffic
target (reported with a documented ±10% tolerance). Both workloads use the same
finite raw-A/cold/warm/raw-B plan and the contention phase checks equal results
with bounded database work.

To target a network-separated or latency-injected Redis, set `TEST_REDIS_URL`:

```bash
TEST_REDIS_URL=redis://benchmark-redis.example:6379 pnpm test:benchmark:load -- --workload zipfian
```

This external endpoint is not an automated test dependency. Host hardware,
service versions, topology, network distance, and background load affect
measurements; local output must not be published as universal package
performance claims. Service diagnostics redact credentials from valid endpoint
URLs and replace malformed URLs with `[redacted service URL]`.
