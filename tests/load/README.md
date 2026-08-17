# Benchmark harnesses

The `tests/load` directory contains two benchmarks with different purposes:

- `test:benchmark:invalidation` is a synthetic Redis-only keyspace-scaling
  microbenchmark. It does not exercise Prisma or PostgreSQL.
- `test:benchmark:load` is a model-backed workload that runs real cached Prisma
  `Widget` and `Part` unique/list operations against PostgreSQL and Redis. Its
  shared read corpus also probes distributed cold-list stampede behavior and
  reads widget writes back through another client.

## Synthetic invalidation benchmark

This benchmark measures invalidation latency while the Redis keyspace grows
from 1,000 to 100,000 cached keys. It seeds each keyspace with cached query
values, performs 200 invalidations with the real node-redis adapter, and
records p50 and p99 latency. Redis command statistics also verify that each
invalidation produces exactly one `INCRBY`, regardless of keyspace size.

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
exceeded or when the observed Redis `INCRBY` count is not fixed.

## Model-backed load benchmark

The model-backed benchmark requires PostgreSQL and Redis plus the fixture schema
setup described in [CONTRIBUTING.md](../../CONTRIBUTING.md). It uses the
`quick` profile by default:

```bash
pnpm test:benchmark:load
pnpm test:benchmark:load -- --profile stress
pnpm test:benchmark:load -- --preserve
```

It first reports a finite raw/cold/warm read-only comparison. The deterministic
plan is built from the shared corpus and covers `Widget.findUnique`,
`Part.findUnique`, `Widget.findMany`, and `Part.findMany`. Raw reads set
`cache.enabled: false`; cold reads run once after clearing only the validated
current-run namespace; warm reads repeat the exact plan without cleanup. The
same client concurrency is used for every phase, results are checked by
deterministic digest, and each row reports completed reads, elapsed time,
throughput, p50/p95/p99 latency, cache hits/misses/hit rate, database queries,
and speedup versus raw (`1.00x` for raw).

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
