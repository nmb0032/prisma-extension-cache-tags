# Model-backed load benchmark final fix report

## Status

Complete. The final-review fixes are implemented in commit `11826c5`
(`fix: harden model-backed load benchmark`).

## RED/GREEN evidence

### RED

The first focused test run was intentionally executed after adding the
regression tests and before completing the implementation:

```text
pnpm exec vitest run --project unit \
  tests/unit/benchmark-report.test.ts \
  tests/unit/fixture-client.test.ts \
  tests/unit/model-workload.test.ts \
  tests/unit/benchmark-fixture-seeding.test.ts
```

Result: 4 test files failed and 5 tests failed. The failures showed the
expected missing reporting module, absent preserve metadata, missing
benchmark pool limit, and the old widget-only/same-client workload behavior.
The Prisma constructor test also exposed a test-double setup issue, which was
corrected before the implementation was evaluated again.

### GREEN

Focused unit coverage:

```text
pnpm exec vitest run --project unit \
  tests/unit/benchmark-report.test.ts \
  tests/unit/fixture-client.test.ts \
  tests/unit/model-workload.test.ts \
  tests/unit/benchmark-fixture-seeding.test.ts
```

Result: 4 files passed, 10 tests passed.

Full unit suite:

```text
pnpm run test:unit
```

Result: 16 files passed, 126 tests passed.

Focused real-service benchmark integration:

```text
TEST_DATABASE_URL=<local fixture Postgres URL> \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts
```

Result: 1 file passed, 3 tests passed.

Full integration suite:

```text
TEST_DATABASE_URL=<local fixture Postgres URL> \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm run test:integration
```

Result: 6 files passed, 43 tests passed.

Type, lint, build, and package E2E:

```text
pnpm run typecheck       # passed
pnpm run lint            # passed
pnpm run build           # passed
pnpm run test:e2e       # passed
```

Quick model benchmark:

```text
TEST_DATABASE_URL=<local fixture Postgres URL> \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm test:benchmark:load
```

Result: exited 0 and reported `37,065` completed operations
(`33,306` reads, `3,759` writes), `3,687.7` ops/sec, `43.1%` cache hit rate,
`24,468` database queries, `0` errors, and `0` freshness failures.

Existing invalidation benchmark smoke:

```text
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:invalidation
```

Result: exited 0; p50 growth across the 100x keyspace was `1.06x`, with 200
`INCRBY` calls at each keyspace size.

Argument validation:

```text
pnpm test:benchmark:load -- --profile unknown
```

Result: exited 1 before service setup with
`Unknown benchmark profile: unknown`.

## Review of each finding

1. **Model breadth/list coverage — fixed.** Fixture seeding now retains
   `Part` metadata in a shared read corpus. Warm-up samples cached
   `Widget.findUnique`, `Part.findUnique`, `Widget.findMany`, and
   `Part.findMany` operations. Measured reads select among widget/part unique
   and widget/part list reads, while writes remain widget-only. The fixed
   profile read ratio remains `0.9`, preserving the 90% read / 10% write
   workload contract.

2. **Distributed stampede and cross-client freshness — fixed.** The shared
   corpus is available to every worker instead of being restricted to writer
   shards. `runColdSharedListQuery` sends one identical, initially cold list
   query through two independent Prisma clients, asserts equal results, and
   requires exactly one observed database query. Widget ownership remains
   sharded one-writer-per-widget, while every post-write cached freshness read
   uses `(workerIndex + 1) % clients.length`, guaranteeing a different client.

3. **Connection budget and warm-up load — fixed.** Benchmark fixture Prisma
   clients are constructed with `BENCHMARK_MAX_CONNECTIONS_PER_CLIENT = 1`,
   which becomes `pg.Pool`'s `max: 1`. The seed client uses the same limit.
   Existing integration callers retain the default pool behavior because the
   new options are optional. Warm-up samples at most 64 widgets, 64 parts, two
   tenant lists, and four passes, with the per-client request bound exposed as
   `MAX_WARMUP_REQUESTS_PER_CLIENT`. Unit coverage constructs the stress
   client count deterministically and asserts total configured connections do
   not exceed profile concurrency; real integration coverage exercises the
   construction path.

4. **Fatal failure reporting — fixed.** `benchmark-report.ts` is a pure
   report-row helper covered with partial error and freshness metrics.
   `load-benchmark.ts` records the measurement start before running workers and
   prints a partial summary in `finally` whenever the workload throws, before
   cleanup/disconnect failures are propagated. The existing entry-point catch
   still logs the final error and sets `process.exitCode = 1`. No intentional
   full benchmark failure was needed; focused reporting coverage verifies that
   nonzero fatal counters remain visible in the rendered row.

5. **Preserve-mode partial fixture initialization — fixed.** Fixture creation
   now skips both row and Redis cleanup when `preserve` is enabled, including
   when seeding fails partway through. Creation failures surface the original
   message together with the run ID, all tenant markers, Redis key prefix, and
   an explicit retention/cleanup message. Preserve-mode unit coverage asserts
   that cleanup is not attempted and the metadata is present.

6. **Disconnect aggregation failure injection — fixed.** A direct fixture
   `disconnect()` test injects independent Prisma and Redis close failures and
   asserts that the returned `AggregateError` contains both causes. The
   existing Redis connection teardown coverage remains intact.

7. **Prettier tooling — unchanged concern.** `pnpm run format` still fails
   with `prettier: command not found`. Prettier is not declared/available in
   this repository. No dependency was added, as required; this remains a
   pre-existing tooling concern rather than a feature change.

## Changed files

- `tests/load/model-workload.ts` — shared corpus, Part/list operations, cold
  cross-client probe, bounded warm-up, and different-client freshness reads.
- `tests/load/benchmark-fixture.ts` — seeded Part metadata, one-connection
  benchmark clients, preserve-aware failure cleanup, and contextual errors.
- `tests/load/benchmark-report.ts` — pure terminal report-row builder.
- `tests/load/load-benchmark.ts` — partial report emission before fatal
  propagation.
- `tests/fixture/client.ts` — optional pool limit for benchmark callers.
- `tests/integration/helpers.ts` — optional Prisma construction options,
  preserving existing defaults.
- `tests/integration/load-benchmark.test.ts` — cold list, Part coverage, and
  deterministic read/write workload assertions.
- `tests/unit/model-workload.test.ts` — Part/list shared-corpus and
  cross-client freshness coverage.
- `tests/unit/benchmark-fixture-seeding.test.ts` — preserve, disconnect
  aggregation, and stress connection-budget coverage.
- `tests/unit/benchmark-report.test.ts` — partial report-row coverage.
- `tests/unit/fixture-client.test.ts` — default versus bounded pool
  construction coverage.
- `README.md`, `CONTRIBUTING.md`, `tests/load/README.md` — documentation of
  cached list coverage, cross-client checks, bounded warm-up, and connection
  budget.

No package dependency or benchmark script/flag/profile constant was changed.
The model benchmark contains no `FLUSHDB`; safe key-prefix validation is
unchanged.

## Self-review

- `git diff --check` passed.
- Final diff contains only the files listed above; no unrelated source or
  generated Prisma files changed.
- The existing invalidation benchmark remains a separate command and retains
  its documented disposable-Redis behavior.
- Default integration helper pool behavior is unchanged unless the benchmark
  explicitly supplies `maxConnections: 1`.
- Correctness errors remain fatal; performance values remain informational.
- The final code commit is `11826c5`. This report is committed separately as a
  documentation artifact.

## Concerns

- Prettier remains unavailable (`pnpm run format` fails); no new dependency was
  introduced.
- `pnpm db:up` could not create a second local stack because port 5433 was
  already allocated. Verification used the already-running healthy local
  PostgreSQL/Redis fixture services at the documented ports.
- The 60-second stress measurement was not run. Its 32-client, one-connection
  construction and total connection budget were validated deterministically by
  unit coverage, as permitted by the review request.
