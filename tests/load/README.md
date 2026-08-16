# Benchmark harnesses

The `tests/load` directory contains two benchmarks with different purposes:

- `test:benchmark:invalidation` is a synthetic Redis-only keyspace-scaling
  microbenchmark. It does not exercise Prisma or PostgreSQL.
- `test:benchmark:load` is a model-backed workload that runs real Prisma
  `Widget` and `Part` operations against PostgreSQL and Redis.

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

It reports throughput, p50/p95/p99 latency, cache hit rate, database query
count, errors, and freshness failures. Performance measurements are
informational and are not CI gates; workload errors and freshness failures
still fail the command. Normal cleanup removes only the run-specific database
rows and Redis namespace. `--preserve` skips cleanup and prints the run ID,
tenant IDs, and Redis key prefix for inspection.
