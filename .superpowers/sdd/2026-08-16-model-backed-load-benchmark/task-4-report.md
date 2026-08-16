# Task 4 Report: Isolated Real-Service Fixture

## Status

Implemented and committed as `ef41c28` (`test: add isolated benchmark fixture`).

## RED evidence

The required integration test was written before the fixture implementation.

The first test invocation needed the repository's required `TEST_DATABASE_URL`
environment variable because `prisma.config.ts` resolves it eagerly. With the
disposable database URL supplied, the focused test failed for the intended
missing-implementation reason:

```text
TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts

FAIL ... tests/integration/load-benchmark.test.ts
Error: Cannot find module '../load/benchmark-fixture'
```

## Service commands and results

`pnpm db:up` was attempted as requested, but Docker could not bind port 5433
because the repository's disposable Postgres service was already running:

```text
Bind for 0.0.0.0:5433 failed: port is already allocated
```

The existing Postgres container on `localhost:5433` and Redis container on
`localhost:6380` were healthy. The stopped containers created by the failed
startup attempt were removed. Integration setup successfully generated the
fixture Prisma client and confirmed the database schema was already in sync.

## GREEN evidence

- Focused fixture integration test: **1 file, 1 test passed**.
- Full integration suite: **6 files, 41 tests passed**.
- Full unit suite: **11 files, 104 tests passed**.
- TypeScript check: `pnpm exec tsc --noEmit` passed.
- Lint: `pnpm run lint` passed.
- `git diff --check` passed.

## Changed files

- `tests/integration/global-setup.ts`
  - Exported `TEST_DATABASE_URL`, `checkPostgresReachability`, and
    `ensureFixtureSchema` without changing setup behavior or actionable errors.
- `tests/load/benchmark-fixture.ts`
  - Added unique run/tenant identity, bounded nested widget/part seeding,
    per-worker cached clients and query counters, safe namespace deletion,
    idempotent cleanup, preservation mode, and aggregate disconnect handling.
- `tests/integration/load-benchmark.test.ts`
  - Added real Postgres/Redis isolation coverage for row counts, cascading
    cleanup, namespace cleanup, idempotent cleanup, and preservation of an
    unrelated Redis key.

## Self-review

- No `FLUSHDB` is used by the new fixture or integration test.
- Redis cleanup rejects empty/non-benchmark prefixes, scans only the run
  namespace, and unlinks no more than 100 keys per batch.
- Database cleanup deletes widgets only for the generated tenant IDs; parts
  are removed by the schema's cascade.
- Fixture creation uses `randomUUID()` unless a run ID is supplied and uses
  the required cache configuration (`keyPrefix`, shared metrics, and 300
  second TTL bounds).
- Each worker receives its own extended Prisma client and query counter.
- `preserve: true` skips cleanup deletion, while normal cleanup is safe to
  call repeatedly.
- Disconnect attempts every client and Redis close through `Promise.allSettled`
  and reports failures as an `AggregateError`.
- Commit contains exactly the requested Conventional Commit subject and no
  attribution trailer.

## Concerns

No code concerns remain. Running `pnpm db:up` independently still requires
free host ports 5433 and 6380; validation used the already-running healthy
disposable services on those ports.

## Round 1/5 Fix Report

### Changes

- Added exact `prismaCacheTags:benchmark:<safe run id>` validation, including empty-suffix and Redis glob-metacharacter rejection before `SCAN`.
- Added unit coverage for accepted/rejected prefixes and the no-scan-on-invalid-prefix guarantee.
- Strengthened integration coverage for overlapping benchmark namespaces and partial seeding failures.
- Made fixture creation delete partial run-owned rows and Redis keys before closing resources, preserving cleanup order so cache invalidation keys are also removed.
- Aggregated primary, cleanup, and disconnect failures during fixture creation.
- Kept fixture disconnect Redis close failures visible by using the strict close path instead of the swallowing service-preflight helper.

### Test files

- `tests/unit/benchmark-fixture.test.ts`
- `tests/integration/load-benchmark.test.ts`

### Validation commands and outcomes

- `pnpm exec vitest run --project unit tests/unit/benchmark-fixture.test.ts tests/unit/benchmark-metrics.test.ts tests/unit/load-profiles.test.ts` — **PASS** (3 files, 28 tests).
- `TEST_DATABASE_URL=<disposable local Postgres URL> pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts` — **PASS** (1 file, 2 tests).
- `TEST_DATABASE_URL=<disposable local Postgres URL> pnpm exec vitest run --project integration` — **PASS** (6 files, 42 tests).
- `pnpm exec vitest run --project unit` — **PASS** (12 files, 116 tests).
- `pnpm exec tsc --noEmit` — **PASS**.
- `pnpm run lint` — **PASS**.
- `git diff --check` — **PASS**.

### Concerns

No code concerns remain. A standalone `pnpm exec prettier --check ...` invocation was unavailable because Prettier is not installed in this package; repository lint passed.

## Round 2/5 Fix Report

### Changes

- Replaced fail-fast seed batching with tracked `Promise.allSettled` operations, including synchronous batch-preparation failures, so cleanup starts only after every started widget write settles.
- Added strict benchmark Redis teardown that always attempts `destroy()` when `quit()` is unavailable or fails, and aggregates teardown failures in both fixture creation failure and normal disconnect paths.
- Kept `tests/support/service-preflight.ts` unchanged so its shared `destroy()` fallback remains intact.

### Covering test files

- `tests/unit/benchmark-fixture-seeding.test.ts`
  - Holds the first widget write in flight while the next seed operation fails synchronously and verifies cleanup follows write settlement.
  - Verifies failed Redis connections still attempt `destroy()` and surface teardown failures in the aggregate error.

### Validation commands and outcomes

- `pnpm exec vitest run --project unit tests/unit/benchmark-fixture-seeding.test.ts` — **PASS** (1 file, 2 tests).
- `pnpm exec vitest run --project unit tests/unit/benchmark-fixture.test.ts tests/unit/benchmark-fixture-seeding.test.ts` — **PASS** (2 files, 14 tests).
- `TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts` — **PASS** (1 file, 2 tests).
- `TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags pnpm exec vitest run --project integration` — **PASS** (6 files, 42 tests).
- `pnpm run typecheck` — **PASS**.
- `pnpm run lint` — **PASS**.
- `git diff --check` — **PASS**.

### Concerns

- `pnpm db:up` could not bind port 5433 because the repository's healthy disposable Postgres and Redis containers were already running; validation used those existing services.
