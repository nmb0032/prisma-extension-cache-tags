# Task 5 Report: Concurrent Model Workload

## Status

Implemented the concurrent model-backed workload and its integration coverage.

## RED evidence

The integration assertion was added before the workload module. With the
already-running disposable services configured, the required focused command
failed because the implementation module did not exist:

```text
TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
TEST_REDIS_URL='redis://localhost:6380' \
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts

Error: Cannot find module '../load/model-workload'
```

## GREEN evidence

- `TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' TEST_REDIS_URL='redis://localhost:6380' pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts` — **PASS** (1 file, 3 tests).
- `pnpm exec vitest run --project unit tests/unit/load-profiles.test.ts tests/unit/load-statistics.test.ts tests/unit/benchmark-metrics.test.ts` — **PASS** (3 files, 23 tests).
- `pnpm exec tsc --noEmit` — **PASS**.
- `pnpm run lint` — **PASS**.
- `git diff --check` — **PASS**.

The integration test verifies that a second warm-up pass increases cache hits
without adding database queries, then runs deterministic reads and writes and
asserts zero errors, zero freshness failures, cache hits, and database
queries.

## Changed files

- `tests/load/model-workload.ts`
  - Added concurrent per-shard cache warm-up with at least two complete passes.
  - Added shared-deadline workers with optional operation limits, deterministic
    clock/random injection, cached reads, invalidating writes, and freshness
    checks.
  - Records operation errors and freshness failures, and adds the aggregate
    database-query total exactly once.
- `tests/integration/load-benchmark.test.ts`
  - Added real Postgres/Redis warm-up and mixed read/write workload coverage.

## Self-review

- Warm-up uses each client's worker-owned widget shard and the required
  300-second cached `findUnique` call.
- Workers never select outside their assigned shard, so concurrent writes do
  not target the same widget.
- Write names include the worker index and a monotonic worker-local counter.
- A stale post-write read records a freshness failure and throws an error that
  identifies the widget, expected name, and observed name.
- Worker failures are recorded and rethrown; all workers settle before the
  query total is added once.
- No production exports, unrelated fixture behavior, or Redis isolation
  behavior were changed.

## Concerns

No code concerns remain. Prisma 7 setup requires `TEST_DATABASE_URL`; focused
integration validation used the already-running disposable Postgres and Redis
services on ports 5433 and 6380. The deferred direct
preserve/disconnect failure-injection coverage was not part of this task.
