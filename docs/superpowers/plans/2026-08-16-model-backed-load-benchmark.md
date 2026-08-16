# Model-Backed Load Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the invalidation-scaling microbenchmark under a precise command name and add a safe, model-backed load benchmark that exercises Prisma 7, PostgreSQL, Redis, caching, writes, and invalidation.

**Architecture:** Keep benchmark policy in pure profile/statistics modules, isolate disposable database and Redis resources behind a fixture lifecycle, and run concurrent workers through real extended Prisma clients. A thin CLI selects a fixed profile, reports informational performance metrics, fails on correctness errors, and cleans only its run namespace unless preservation is requested.

**Tech Stack:** TypeScript 5.6, tsx, Vitest 4, Prisma 7.9, PostgreSQL, node-redis 6, `@prisma/adapter-pg`

**Spec:** `docs/superpowers/specs/2026-08-16-model-backed-load-benchmark-design.md`

## Global Constraints

- Commands are exactly `test:benchmark:invalidation` and `test:benchmark:load`.
- `test:benchmark:load` defaults to `--profile quick` and accepts `--profile stress` and `--preserve`.
- The measured operation mix is 90% reads and 10% writes.
- Quick profile: 4 tenants, 100 widgets per tenant, 2 parts per widget, concurrency 8, 3-second warm-up, 10-second measurement.
- Stress profile: 20 tenants, 500 widgets per tenant, 2 parts per widget, concurrency 32, 15-second warm-up, 60-second measurement.
- Performance values are informational; workload errors and stale-read failures make the command fail.
- The model-backed benchmark never calls `FLUSHDB` and deletes only its unique Redis prefix and database tenant markers.
- No new runtime or development dependencies.
- Preserve unrelated changes already present in `tests/load/invalidation-scaling.ts`; do not reset or reformat that file.
- Use Conventional Commit subjects without Copilot trailers.

---

## File Structure

- `tests/load/profiles.ts` — fixed profile definitions, CLI parsing, and 90/10 operation selection.
- `tests/load/statistics.ts` — percentile and throughput calculations with no service dependencies.
- `tests/load/benchmark-metrics.ts` — operation, cache-event, query, freshness, and error aggregation plus report shape.
- `tests/load/benchmark-fixture.ts` — run identity, fixture seeding, Prisma/Redis client construction, and namespace-scoped cleanup.
- `tests/load/model-workload.ts` — warm-up and concurrent worker execution through real extended clients.
- `tests/load/load-benchmark.ts` — preflight, orchestration, terminal reporting, exit behavior, and resource cleanup.
- `tests/unit/load-profiles.test.ts` — deterministic profile/parser/operation-mix tests.
- `tests/unit/load-statistics.test.ts` — deterministic percentile/throughput tests.
- `tests/unit/benchmark-metrics.test.ts` — deterministic aggregation tests.
- `tests/integration/load-benchmark.test.ts` — reduced real-service correctness and cleanup smoke coverage.
- `package.json` — benchmark command names.
- `README.md`, `CONTRIBUTING.md` — benchmark intent, prerequisites, usage, metrics, and safety.

### Task 1: Rename the Invalidation Benchmark Command

**Files:**
- Modify: `package.json:79-91`

**Interfaces:**
- Consumes: existing `tests/load/invalidation-scaling.ts`
- Produces: package script `test:benchmark:invalidation`

- [ ] **Step 1: Add a failing package-script assertion**

Create a temporary one-command assertion without editing the dirty benchmark source:

```bash
node -e "const p=require('./package.json'); if(p.scripts['test:benchmark:invalidation']!=='tsx tests/load/invalidation-scaling.ts') process.exit(1)"
```

Expected: exit 1 because the renamed script is absent.

- [ ] **Step 2: Rename the script**

Replace:

```json
"test:load": "tsx tests/load/invalidation-scaling.ts"
```

with:

```json
"test:benchmark:invalidation": "tsx tests/load/invalidation-scaling.ts"
```

- [ ] **Step 3: Verify the package script**

Run:

```bash
node -e "const p=require('./package.json'); if(p.scripts['test:benchmark:invalidation']!=='tsx tests/load/invalidation-scaling.ts'||p.scripts['test:load']) process.exit(1)"
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: rename invalidation benchmark command"
```

### Task 2: Add Profiles, Argument Parsing, and Statistics

**Files:**
- Create: `tests/load/profiles.ts`
- Create: `tests/load/statistics.ts`
- Create: `tests/unit/load-profiles.test.ts`
- Create: `tests/unit/load-statistics.test.ts`

**Interfaces:**
- Produces:

```ts
export type BenchmarkProfileName = 'quick' | 'stress';
export type BenchmarkOperation = 'read' | 'write';

export interface BenchmarkProfile {
    name: BenchmarkProfileName;
    tenants: number;
    widgetsPerTenant: number;
    partsPerWidget: number;
    concurrency: number;
    warmupMs: number;
    durationMs: number;
    readRatio: number;
}

export interface BenchmarkCliOptions {
    profile: BenchmarkProfile;
    preserve: boolean;
}

export const BENCHMARK_PROFILES: Record<BenchmarkProfileName, BenchmarkProfile>;
export function parseBenchmarkArgs(args: string[]): BenchmarkCliOptions;
export function selectOperation(sample: number, readRatio?: number): BenchmarkOperation;
export function percentile(samples: readonly number[], percentileValue: number): number;
export function operationsPerSecond(completed: number, durationMs: number): number;
```

- [ ] **Step 1: Write failing profile and parser tests**

Cover exact profile constants, default parsing, both `--profile stress` and `--profile=stress`, `--preserve`, missing profile values, unsupported profile names, unknown arguments, and sample bounds:

```ts
expect(parseBenchmarkArgs([])).toEqual({ profile: BENCHMARK_PROFILES.quick, preserve: false });
expect(parseBenchmarkArgs(['--profile', 'stress', '--preserve'])).toEqual({
    profile: BENCHMARK_PROFILES.stress,
    preserve: true,
});
expect(selectOperation(0.8999)).toBe('read');
expect(selectOperation(0.9)).toBe('write');
expect(() => selectOperation(-0.01)).toThrow('sample must be between 0 and 1');
expect(() => parseBenchmarkArgs(['--profile', 'large'])).toThrow('Unknown benchmark profile: large');
```

- [ ] **Step 2: Run profile tests and verify failure**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/load-profiles.test.ts
```

Expected: FAIL because `tests/load/profiles.ts` does not exist.

- [ ] **Step 3: Implement fixed profiles and strict argument parsing**

Use these exact profile values:

```ts
export const BENCHMARK_PROFILES = {
    quick: {
        name: 'quick',
        tenants: 4,
        widgetsPerTenant: 100,
        partsPerWidget: 2,
        concurrency: 8,
        warmupMs: 3_000,
        durationMs: 10_000,
        readRatio: 0.9,
    },
    stress: {
        name: 'stress',
        tenants: 20,
        widgetsPerTenant: 500,
        partsPerWidget: 2,
        concurrency: 32,
        warmupMs: 15_000,
        durationMs: 60_000,
        readRatio: 0.9,
    },
} as const satisfies Record<BenchmarkProfileName, BenchmarkProfile>;
```

Reject unknown arguments and malformed values with messages that include the offending argument. Validate `selectOperation` samples as finite values in `[0, 1]`.

- [ ] **Step 4: Run profile tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/load-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing statistics tests**

Define nearest-rank percentile behavior and invalid-input behavior:

```ts
expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
expect(percentile([], 0.5)).toBe(0);
expect(() => percentile([1], 1.1)).toThrow('percentile must be between 0 and 1');
expect(operationsPerSecond(250, 2_000)).toBe(125);
expect(() => operationsPerSecond(1, 0)).toThrow('durationMs must be greater than 0');
```

- [ ] **Step 6: Run statistics tests and verify failure**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/load-statistics.test.ts
```

Expected: FAIL because `tests/load/statistics.ts` does not exist.

- [ ] **Step 7: Implement pure statistics functions**

`percentile` must copy and numerically sort samples, use `Math.ceil(percentileValue * length) - 1`, and clamp the index to zero for percentile 0. `operationsPerSecond` returns `completed / (durationMs / 1000)`.

- [ ] **Step 8: Run focused unit tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/load-profiles.test.ts tests/unit/load-statistics.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tests/load/profiles.ts tests/load/statistics.ts tests/unit/load-profiles.test.ts tests/unit/load-statistics.test.ts
git commit -m "test: define load benchmark profiles"
```

### Task 3: Add Benchmark Metrics and Reporting Data

**Files:**
- Create: `tests/load/benchmark-metrics.ts`
- Create: `tests/unit/benchmark-metrics.test.ts`

**Interfaces:**
- Consumes: `BenchmarkOperation`, `percentile`, `operationsPerSecond`
- Produces:

```ts
export interface BenchmarkSummary {
    elapsedMs: number;
    completed: number;
    reads: number;
    writes: number;
    errors: number;
    freshnessFailures: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    databaseQueries: number;
    operationsPerSecond: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
}

export class BenchmarkMetrics {
    readonly cacheMetrics: Metrics;
    recordOperation(operation: BenchmarkOperation, durationMs: number): void;
    recordError(): void;
    recordFreshnessFailure(): void;
    addDatabaseQueries(count: number): void;
    reset(): void;
    summarize(elapsedMs: number): BenchmarkSummary;
}
```

- [ ] **Step 1: Write failing aggregation tests**

Record two reads, one write, one hit, two misses, four database queries, one error, and one freshness failure. Assert exact counts, a `1 / 3` hit rate, `3` completed operations, and percentiles from the three latency samples. Also assert a zero hit rate when no cache events occurred and reject negative durations/query counts.

- [ ] **Step 2: Run the metrics test and verify failure**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/benchmark-metrics.test.ts
```

Expected: FAIL because `BenchmarkMetrics` is missing.

- [ ] **Step 3: Implement the collector**

Expose a stable `cacheMetrics` object:

```ts
this.cacheMetrics = {
    onCacheEvent: ({ result }) => {
        if (result === 'hit') this.cacheHits += 1;
        else this.cacheMisses += 1;
    },
};
```

Treat `completed` as successfully completed read and write operations. Keep errors and freshness failures separate. `reset` clears operation, latency, cache-event, query, error, and freshness state. `summarize` returns immutable calculated data and does not reset the collector.

- [ ] **Step 4: Run the metrics and dependent unit tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/benchmark-metrics.test.ts tests/unit/load-statistics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/load/benchmark-metrics.ts tests/unit/benchmark-metrics.test.ts
git commit -m "test: add load benchmark metrics"
```

### Task 4: Add an Isolated Real-Service Fixture

**Files:**
- Create: `tests/load/benchmark-fixture.ts`
- Create: `tests/integration/load-benchmark.test.ts`
- Modify: `tests/integration/global-setup.ts:11-88`

**Interfaces:**
- Consumes: `BenchmarkProfile`, `BenchmarkMetrics`, `createTestPrismaClient`, `createTestRedisClient`, `createCachedClient`
- Produces:

```ts
export interface BenchmarkWidget {
    id: string;
    tenantId: string;
    initialName: string;
    workerIndex: number;
}

export interface BenchmarkFixture {
    runId: string;
    keyPrefix: string;
    tenantIds: string[];
    widgetsByWorker: BenchmarkWidget[][];
    clients: ReturnType<typeof createCachedClient>[];
    queryCounters: QueryCounter[];
    redis: ReturnType<typeof createTestRedisClient>;
    cleanup(): Promise<void>;
    disconnect(): Promise<void>;
}

export async function createBenchmarkFixture(
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    options?: { preserve?: boolean; runId?: string },
): Promise<BenchmarkFixture>;
export async function deleteRedisNamespace(
    redis: ReturnType<typeof createTestRedisClient>,
    keyPrefix: string,
): Promise<void>;
```

- [ ] **Step 1: Extract reusable fixture preparation**

Export `TEST_DATABASE_URL`, `checkPostgresReachability`, and `ensureFixtureSchema` from `tests/integration/global-setup.ts` without changing setup behavior. Keep the existing actionable errors.

- [ ] **Step 2: Write a failing integration cleanup test**

Use a tiny inline profile with 2 tenants, 2 widgets each, 1 part each, and concurrency 2. Create one unrelated Redis key before fixture creation. Assert:

```ts
expect(fixture.widgetsByWorker.flat()).toHaveLength(4);
expect(await fixture.clients[0]!.part.count({
    where: { tenantId: { in: fixture.tenantIds } },
})).toBe(4);
```

After `fixture.cleanup()`, assert benchmark rows and keys are absent while the unrelated Redis key remains.

- [ ] **Step 3: Run the integration test and verify failure**

Run:

```bash
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts
```

Expected: FAIL because `createBenchmarkFixture` does not exist.

- [ ] **Step 4: Implement fixture creation**

Use `randomUUID()` unless `runId` is supplied. Set:

```ts
const keyPrefix = `prismaCacheTags:benchmark:${runId}`;
const tenantIds = Array.from({ length: profile.tenants }, (_, index) => `benchmark:${runId}:tenant:${index}`);
```

Seed widgets and nested parts in bounded batches, then distribute widgets by `index % profile.concurrency`. Create one independent cached Prisma client and query counter per worker with:

```ts
{
    keyPrefix,
    metrics: metrics.cacheMetrics,
    defaultTtlSeconds: 300,
    maxTtlSeconds: 300,
}
```

`deleteRedisNamespace` iterates `redis.scanIterator({ MATCH: `${keyPrefix}:*`, COUNT: 100 })` and unlinks batches of at most 100 keys. It must never accept an empty prefix or a prefix without `:benchmark:`.

- [ ] **Step 5: Implement idempotent cleanup and disconnect**

Default cleanup deletes parts through cascading widget deletion scoped by `tenantId: { in: tenantIds }`, then deletes only the Redis namespace. With `preserve: true`, cleanup performs no deletion. `disconnect` closes every Prisma client and the Redis client with `Promise.allSettled`, then throws an `AggregateError` if any close failed.

- [ ] **Step 6: Run the focused integration test**

Run:

```bash
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/load/benchmark-fixture.ts tests/integration/load-benchmark.test.ts tests/integration/global-setup.ts
git commit -m "test: add isolated benchmark fixture"
```

### Task 5: Add the Concurrent Model Workload

**Files:**
- Create: `tests/load/model-workload.ts`
- Modify: `tests/integration/load-benchmark.test.ts`

**Interfaces:**
- Consumes: `BenchmarkFixture`, `BenchmarkProfile`, `BenchmarkMetrics`, `selectOperation`
- Produces:

```ts
export async function warmBenchmarkCache(
    fixture: BenchmarkFixture,
    profile: BenchmarkProfile,
): Promise<void>;

export async function runModelWorkload(
    fixture: BenchmarkFixture,
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    options?: { now?: () => number; random?: () => number; maxOperationsPerWorker?: number },
): Promise<void>;
```

- [ ] **Step 1: Extend the integration test with cache and freshness assertions**

Warm the tiny fixture twice and assert the second pass increases cache hits without increasing the database query count for the same reads. Run a short workload with a deterministic operation sequence containing both reads and writes. Assert zero errors, zero freshness failures, at least one cache hit, and at least one database query.

- [ ] **Step 2: Run the focused integration test and verify failure**

Run:

```bash
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts
```

Expected: FAIL because workload functions are missing.

- [ ] **Step 3: Implement warm-up**

For each worker shard, query each widget with:

```ts
client.widget.findUnique({
    where: { id: widget.id },
    cache: { ttlSeconds: 300 },
});
```

Repeat passes concurrently until `profile.warmupMs` elapses, while guaranteeing at least two complete passes. Warm-up cache events are collected, but warm-up operation latencies are not recorded.

- [ ] **Step 4: Implement concurrent workers**

Run one loop per client until a shared `deadline = now() + profile.durationMs`. When `maxOperationsPerWorker` is supplied for tests, each worker also stops after that many operations. Each worker selects only from its assigned widget shard, preventing concurrent writers for the same widget.

For reads, call cached `findUnique`. For writes, create a unique name containing the worker index and monotonic worker-local write counter, update through the extended client, then immediately call cached `findUnique`. If the returned name differs from the written name, call `recordFreshnessFailure()` and throw an error that includes widget ID, expected name, and observed name.

Measure each top-level read or write cycle with `now()`. On any error, call `recordError()` and rethrow so the benchmark fails instead of producing success-shaped output.

- [ ] **Step 5: Add database-query totals**

After all workers finish, sum `fixture.queryCounters.map(counter => counter.total)` and pass the total to `metrics.addDatabaseQueries`. Ensure it is added exactly once.

- [ ] **Step 6: Run focused integration and unit tests**

Run:

```bash
pnpm exec vitest run --project integration tests/integration/load-benchmark.test.ts
pnpm exec vitest run --project unit tests/unit/load-profiles.test.ts tests/unit/load-statistics.test.ts tests/unit/benchmark-metrics.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/load/model-workload.ts tests/integration/load-benchmark.test.ts
git commit -m "test: add concurrent Prisma load workload"
```

### Task 6: Add the Load Benchmark CLI

**Files:**
- Create: `tests/load/load-benchmark.ts`
- Modify: `package.json:79-92`

**Interfaces:**
- Consumes: all benchmark modules from Tasks 2-5 and shared service preflight
- Produces: package script `test:benchmark:load`

- [ ] **Step 1: Add the package script**

Add:

```json
"test:benchmark:load": "tsx tests/load/load-benchmark.ts"
```

- [ ] **Step 2: Implement preflight and fixture preparation**

Parse `process.argv.slice(2)`, run Redis and Postgres reachability checks with the existing `formatServiceUnavailable`/`formatError` diagnostics, call `ensureFixtureSchema()`, then create `BenchmarkMetrics` and `BenchmarkFixture`.

- [ ] **Step 3: Implement orchestration**

Print the selected profile and run namespace, call `warmBenchmarkCache`, call `metrics.reset()` and `reset()` on every fixture query counter, then call `runModelWorkload`. Summarize using actual elapsed measurement time.

- [ ] **Step 4: Implement terminal reporting**

Use `console.table` with these labels:

```ts
{
    profile: profile.name,
    completed: summary.completed,
    reads: summary.reads,
    writes: summary.writes,
    'ops/sec': summary.operationsPerSecond.toFixed(1),
    'p50 (ms)': summary.p50Ms.toFixed(2),
    'p95 (ms)': summary.p95Ms.toFixed(2),
    'p99 (ms)': summary.p99Ms.toFixed(2),
    'cache hit rate': `${(summary.cacheHitRate * 100).toFixed(1)}%`,
    'database queries': summary.databaseQueries,
    errors: summary.errors,
    'freshness failures': summary.freshnessFailures,
}
```

If errors or freshness failures are nonzero, throw an error. With `--preserve`, print the run ID, tenant IDs, Redis key prefix, and an explicit statement that cleanup was skipped.

- [ ] **Step 5: Guarantee cleanup**

In `finally`, call `fixture.cleanup()` and `fixture.disconnect()` independently so disconnect still occurs when cleanup fails. Combine primary, cleanup, and disconnect failures with `AggregateError`; do not swallow cleanup errors.

At the entry point:

```ts
void main().catch((error: unknown) => {
    logError(error);
    process.exitCode = 1;
});
```

- [ ] **Step 6: Verify argument validation without services**

Run:

```bash
pnpm test:benchmark:load -- --profile unknown
```

Expected: exit 1 with `Unknown benchmark profile: unknown` before service connection attempts.

- [ ] **Step 7: Run the quick benchmark**

Run:

```bash
pnpm db:up
pnpm test:benchmark:load
```

Expected: a table containing nonzero reads, writes, operations per second, cache hits, and database queries; zero errors and freshness failures; exit 0.

- [ ] **Step 8: Verify cleanup isolation**

Before a second run, set an unrelated Redis key. Run the quick benchmark and confirm the unrelated key remains while no keys matching the printed benchmark prefix remain.

- [ ] **Step 9: Commit**

```bash
git add package.json tests/load/load-benchmark.ts
git commit -m "test: add model-backed load benchmark"
```

### Task 7: Document Both Benchmarks

**Files:**
- Modify: `README.md:96-108`
- Modify: `CONTRIBUTING.md:19-37`

**Interfaces:**
- Consumes: final command and option behavior
- Produces: contributor-facing benchmark guidance

- [ ] **Step 1: Update README measurements**

Replace the single load-harness comparison row with a concise benchmark section that identifies:

```bash
pnpm test:benchmark:invalidation
pnpm test:benchmark:load
pnpm test:benchmark:load -- --profile stress
pnpm test:benchmark:load -- --preserve
```

State that the first command is a synthetic keyspace-scaling microbenchmark and the second runs real Prisma `Widget`/`Part` operations against PostgreSQL and Redis. List throughput, p50/p95/p99, cache hit rate, database query count, errors, and freshness failures. State that performance numbers are informational and not CI gates.

- [ ] **Step 2: Update contributor verification**

Replace `pnpm test:load` with both benchmark commands. Document that `--preserve` leaves the run-specific rows and Redis namespace for inspection and prints their identifiers. State that normal cleanup never flushes the Redis database.

- [ ] **Step 3: Check documentation references**

Run:

```bash
rg "test:load|test:benchmark" README.md CONTRIBUTING.md package.json
```

Expected: no `test:load` references; all documented commands exist in `package.json`.

- [ ] **Step 4: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: explain cache benchmarks"
```

### Task 8: Whole-Package Verification

**Files:**
- Modify only files required to fix defects caused by Tasks 1-7.

**Interfaces:**
- Consumes: completed implementation
- Produces: verified benchmark suite

- [ ] **Step 1: Run formatting and lint**

```bash
pnpm run format
pnpm run lint
```

Expected: PASS. Review formatting changes and retain only files in this feature scope.

- [ ] **Step 2: Run typecheck and build**

```bash
pnpm run typecheck
pnpm run build
```

Expected: PASS.

- [ ] **Step 3: Run unit, integration, and package E2E tests**

```bash
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Run both quick benchmarks**

```bash
pnpm run test:benchmark:invalidation
pnpm run test:benchmark:load
```

Expected: both exit 0. The invalidation benchmark reports flat keyspace scaling; the model-backed benchmark reports nonzero reads, writes, cache hits, and database queries with zero errors and freshness failures.

- [ ] **Step 5: Inspect repository state**

```bash
git status --short
git --no-pager diff
git --no-pager log --oneline -10
```

Expected: only the pre-existing user modification to `tests/load/invalidation-scaling.ts` remains uncommitted. Do not include or revert it.

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification required an in-scope fix, stage the specific changed benchmark files by their real paths, then commit:

```bash
git commit -m "fix: harden model load benchmark"
```

If no fix was needed, do not create an empty commit.
