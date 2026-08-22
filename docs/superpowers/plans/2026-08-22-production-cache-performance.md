# Production Cache Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct cross-instance and tenant invalidation defects, remove avoidable Node CPU work, reduce standalone/Sentinel Redis round trips, and add production-representative performance evidence.

**Architecture:** Four sequential stages preserve the generational invalidation model while replacing its surrounding implementation. Stage 1 establishes correctness and an unbiased baseline, Stage 2 introduces canonical v2 keys and a flat string wire format, Stage 3 adds optional atomic optimized adapter primitives with a command fallback, and Stage 4 expands measurement to contention, realistic payloads, command counts, and event-loop utilization.

**Tech Stack:** TypeScript 5.6, Prisma 7.9, node:crypto SHA-256, SuperJSON 2, node-redis 6, ioredis 6, Redis Lua, Vitest 4, PostgreSQL 17

**Spec:** `docs/superpowers/specs/2026-08-22-production-cache-performance-design.md`

## Global Constraints

- Preserve O(number of tags), scan-free generational invalidation.
- Preserve transaction-deferred invalidation and rollback behavior.
- Never sacrifice cross-instance consistency or tenant correctness for benchmark gains.
- Prefer over-invalidation to a reachable stale cache entry.
- Optimize standalone/Sentinel; Redis Cluster and adapters without optimized primitives use the correct command fallback.
- Cache key and wire format v2 intentionally abandon v1 entries; no migration or legacy adapter layer.
- Remove `hash-object`; add no replacement runtime dependency.
- Performance values are informational and never hard CI thresholds.
- Execution-model override: every task uses a fresh GPT-5.6 SOL agent at maximum reasoning effort, following the user's latest direction after the spec was approved.
- Every task follows TDD with assertion-level RED evidence, commits its work, and writes an ignored stage report.
- Run service-backed commands with `TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags` and `TEST_REDIS_URL=redis://localhost:6380`.
- Do not modify, stage, revert, or overwrite uncommitted changes in the original main checkout, especially `src/invalidation.ts` and `tests/load/invalidation-scaling.ts`.
- Conventional Commit subjects only; no Copilot attribution trailers or tags.

---

## Cross-Stage File Structure

- `src/canonical.ts` — canonical Prisma-value encoding and SHA-256 query identity.
- `src/serialization.ts` — flat v2 SuperJSON string wire format.
- `src/keys.ts` — prepared base keys, tag-version tokens, fallback generation keys, and direct lock keys.
- `src/optimized.ts` — optimized primitive types and extension-side orchestration.
- `src/adapters/scripts.ts` — reusable EVALSHA load/retry executor.
- `src/adapters/node-redis.ts` — raw string adapter plus standalone optimized primitives.
- `src/adapters/ioredis.ts` — raw string adapter plus standalone optimized primitives.
- `src/lua/*.ts` — immutable Lua source strings and result parsers.
- `tests/load/read-comparison.ts` — discarded warm-up and raw-A/cold/warm/raw-B comparison.
- `tests/load/contention-benchmark.ts` — synchronized cold-key contention measurement.
- `tests/load/query-kind-metrics.ts` — per-kind latency/throughput and event-loop metrics.
- `tests/load/realistic-workload.ts` — list-heavy, aggregate, and Zipfian workloads.
- `.superpowers/sdd/2026-08-22-production-cache-performance/stage-N-report.md` — ignored implementation and benchmark evidence.

## Stage Report Contract

Each ignored stage report must contain:

```markdown
# Stage N Report

## Commit range
- Start: exact full commit SHA
- End: exact full commit SHA

## Environment
- Date/time:
- Host CPU and memory:
- Node, pnpm, PostgreSQL, and Redis versions:
- Database and Redis topology:
- Benchmark profile and workload:

## RED/GREEN evidence
| Test | RED assertion/failure | GREEN result |

## Correctness
- Unit/integration/typecheck/lint/build/E2E results:
- Freshness or semantic-digest failures:
- Anomalies:

## Performance
- Raw A, cold, warm, raw B, mixed, and raw drift:
- Redis command counts, or "not instrumented until Stage 4":
- Event-loop utilization, or "not instrumented until Stage 4":
- Contention winner/loser percentiles:

## Comparison with prior stage
- Same-host deltas:
- Interpretation:
- Regressions or risks:
```

After each implementation commit, dispatch an independent specification reviewer and then an independent code-quality reviewer. Fix every Critical or Important finding, re-run affected checks, and have the rejecting reviewer re-review before starting the next task.

### Task 1: Correctness and Trustworthy Baseline

**Files:**
- Modify: `src/keys.ts`
- Modify: `src/tags.ts`
- Modify: `src/types.ts`
- Modify: `src/serialization.ts`
- Modify: `src/extension.ts`
- Modify: `tests/load/read-comparison.ts`
- Modify: `tests/load/read-comparison-report.ts`
- Modify: `tests/load/load-benchmark.ts`
- Create: `tests/load/contention-benchmark.ts`
- Modify: `tests/unit/keys.test.ts`
- Modify: `tests/unit/serialization.test.ts`
- Modify: `tests/unit/tags.test.ts`
- Modify: `tests/unit/read-comparison.test.ts`
- Modify: `tests/unit/read-comparison-report.test.ts`
- Modify: `tests/integration/caching.test.ts`
- Modify: `tests/integration/load-benchmark.test.ts`
- Modify: `README.md`
- Modify: `tests/load/README.md`

**Interfaces:**
- Produces:

```ts
export interface ReadOnlyComparison {
    plan: ReadComparisonOperation[];
    warmupReads: number;
    rawDriftPercent: number;
    stableRawBaseline: boolean;
    phases: {
        rawA: ReadComparisonPhase;
        cold: ReadComparisonPhase;
        warm: ReadComparisonPhase;
        rawB: ReadComparisonPhase;
    };
}

export type ReadComparisonMode = 'rawA' | 'cold' | 'warm' | 'rawB';

export interface LatencySummary {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
}

export interface ContentionBenchmarkResult {
    rounds: number;
    contenders: number;
    databaseQueriesPerRound: number[];
    winner: LatencySummary;
    losers: LatencySummary;
}

export async function runColdKeyContention(
    fixture: BenchmarkFixture,
    contenders?: number,
): Promise<ContentionBenchmarkResult>;
```

- Consumes existing `RedisAdapter`, `BenchmarkFixture`, `BenchmarkMetrics`, `ReadComparisonPhase`, and generational key helpers.

- [ ] **Step 1: Write the cross-instance fingerprint regression test**

Add an integration test using two independent cached clients and semantically equal filters constructed in opposite property order:

```ts
const argsA = { where: { tenantId: 't1', name: 'widget' }, cache: { ttlSeconds: 60 } };
const argsB = { where: { name: 'widget', tenantId: 't1' }, cache: { ttlSeconds: 60 } };

await podA.widget.findMany(argsA);
for (let index = 0; index < 20; index += 1) {
    await (index % 2 === 0 ? podB : podA).widget.findMany(index % 2 === 0 ? argsB : argsA);
}

expect(counterA.total + counterB.total).toBe(1);
```

- [ ] **Step 2: Run the fingerprint test and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm exec vitest run --project integration tests/integration/caching.test.ts
```

Expected: FAIL because alternating argument order causes repeated fingerprint mismatch misses.

- [ ] **Step 3: Remove the stored fingerprint**

Keep the Stage 1 nested value representation, but remove the second query identity:

```ts
export interface CachedEnvelope {
    value: ReturnType<typeof superjson.serialize>;
}
```

Delete `computeFingerprint`, stop passing query identity into serialization, and deserialize any structurally valid Stage 1 envelope without comparing full arguments. The existing key hash remains the sole Stage 1 identity until Stage 2 replaces it.

- [ ] **Step 4: Re-run fingerprint and serialization tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/serialization.test.ts tests/unit/keys.test.ts
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm exec vitest run --project integration tests/integration/caching.test.ts
```

Expected: PASS with one total database query.

- [ ] **Step 5: Write the write-tag truncation regression**

Add a unit test proving a write resolves every tag beyond `maxTagsPerQuery`, and an integration test that warms 20 tenant-precise reads, performs one write resolving all tenants, then observes fresh results for all 20:

```ts
const resolved = resolveCacheTags(
    'Widget',
    'updateMany',
    { where: { tenantId: { in: tenantIds } }, data: { name: 'updated' } },
    undefined,
    normalizeConfig({ tenantKeys: ['tenantId'], tenantPrecision: true, maxTagsPerQuery: 5 }),
    true,
);

expect(resolved.tags).toContain('tenant:t19:model:Widget');
expect(resolved.tags.length).toBeGreaterThan(5);
```

- [ ] **Step 6: Run the tag tests and verify RED**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/tags.test.ts
```

Expected: FAIL because `resolveCacheTags` truncates writes to the read limit.

- [ ] **Step 7: Limit only read-side tags**

Pass an explicit read/write policy into normalization:

```ts
const maxTags = isReadOperation ? config.maxTagsPerQuery : Number.POSITIVE_INFINITY;
const tags = normalizeTags(candidateTags, maxTags, modelTagWasEmitted ? modelTag : undefined);
```

Update the `maxTagsPerQuery` type documentation to state that it limits cached read keys, never write invalidation.

- [ ] **Step 8: Run unit and integration truncation tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/tags.test.ts
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 \
pnpm exec vitest run --project integration tests/integration/caching.test.ts
```

Expected: PASS, with all 20 tenant reads fresh.

- [ ] **Step 9: Write failing A/B/A benchmark tests**

Change the expected comparison API to `rawA`, `cold`, `warm`, and `rawB`. Add tests for drift:

```ts
expect(calculateRawDriftPercent(10_000, 11_000)).toBeCloseTo(9.5238, 3);
expect(isStableRawBaseline(10_000, 11_000)).toBe(true);
expect(isStableRawBaseline(10_000, 12_000)).toBe(false);
```

Assert the execution call order is `warmup`, `rawA`, namespace clear, `cold`, `warm`, `rawB`.

- [ ] **Step 10: Run comparison tests and verify RED**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/read-comparison.test.ts tests/unit/read-comparison-report.test.ts
```

Expected: FAIL because the second raw sample and drift API do not exist.

- [ ] **Step 11: Implement discarded warm-up and raw drift reporting**

Execute the deterministic plan once with caching disabled before timers. Record both raw samples. Define drift symmetrically:

```ts
export function calculateRawDriftPercent(rawAOps: number, rawBOps: number): number {
    const midpoint = (rawAOps + rawBOps) / 2;
    return midpoint === 0 ? 0 : (Math.abs(rawAOps - rawBOps) / midpoint) * 100;
}

export function isStableRawBaseline(rawAOps: number, rawBOps: number): boolean {
    return calculateRawDriftPercent(rawAOps, rawBOps) <= 10;
}
```

Use the arithmetic mean of raw A/raw B operations per second as the speedup denominator only when drift is stable. Change `speedupVsRaw` to `number | null`; `null` renders as `unstable`.

- [ ] **Step 12: Write and implement the contended-key benchmark through TDD**

First add a real-service test expecting 32 simultaneous identical cold reads to return equal results and increment the database query counter once. Then implement `runColdKeyContention` using a start barrier:

```ts
let release!: () => void;
const start = new Promise<void>((resolve) => {
    release = resolve;
});
const calls = fixture.clients.slice(0, contenders).map(async (client) => {
    await start;
    const startedAt = performance.now();
    const result = await client.widget.findMany({
        where: { tenantId },
        cache: { ttlSeconds: 300 },
    });
    return { result, latencyMs: performance.now() - startedAt };
});
release();
```

Run 10 rounds for quick and 30 for stress. Clear only the run namespace before each round. Sort each round's latencies, append the fastest to winner samples and the remaining 31 to loser samples, and assert every `databaseQueriesPerRound` value is exactly one.

- [ ] **Step 13: Run Stage 1 validation**

Run:

```bash
pnpm run test:unit
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:integration
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:e2e
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load -- --profile stress
```

Expected: all correctness checks pass; benchmark output includes raw A/raw B drift and contention. Record exact quick and stress tables in `stage-1-report.md`.

- [ ] **Step 14: Commit Stage 1**

```bash
git add src tests README.md
git commit -m "fix: preserve cache identity and invalidation correctness"
```

### Task 2: Canonical v2 Keys and Flat String Wire Format

**Files:**
- Create: `src/canonical.ts`
- Modify: `src/serialization.ts`
- Modify: `src/keys.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/extension.ts`
- Modify: `src/adapters/node-redis.ts`
- Modify: `src/adapters/ioredis.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/canonical.test.ts`
- Modify: `tests/unit/serialization.test.ts`
- Modify: `tests/unit/keys.test.ts`
- Modify: `tests/unit/extension.test.ts`
- Create: `tests/unit/node-redis-adapter.test.ts`
- Create: `tests/unit/ioredis-adapter.test.ts`
- Modify: `tests/integration/caching.test.ts`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/how-invalidation-works.md`

**Interfaces:**
- Produces:

```ts
export function canonicalizePrismaValue(value: unknown): string;
export function hashCanonicalValue(value: unknown): string;

export interface PreparedCacheKey {
    baseKey: string;
    tagVersionKeys: string[];
}

export function prepareCacheKey(
    model: string,
    operation: string,
    cleanedArgs: unknown,
    normalizedTags: string[],
    config: NormalizedCacheConfig,
    customKey?: string,
): PreparedCacheKey;

export function createVersionToken(values: readonly (string | null)[]): string;
export function buildVersionedCacheKey(baseKey: string, versionToken: string): string;
export function serializeCachedValue(value: unknown): string;
export function deserializeCachedValue(payload: string): unknown;
```

The v2 `RedisAdapter` required interface becomes:

```ts
export interface RedisAdapter {
    getString(key: string): Promise<string | null>;
    setString(key: string, value: string, ttlSeconds?: number): Promise<void>;
    delete(key: string): Promise<void>;
    increment(key: string, amount?: number): Promise<number>;
    expire(key: string, ttlSeconds: number): Promise<void>;
    mgetString(keys: string[]): Promise<Array<string | null>>;
    setIfNotExists?(key: string, value: string, ttlMs: number): Promise<boolean>;
    deleteIfValue?(key: string, value: string): Promise<boolean>;
}

export interface CacheEvent {
    model: string;
    operation: string;
    result: 'hit' | 'miss' | 'bypass';
    path: 'fallback' | 'bypass';
    reason?: string;
}
```

- [ ] **Step 1: Write canonicalization RED tests**

Cover swapped keys, nested values, arrays, absent versus undefined, `Date`, `BigInt`, decimal-like `{ toJSON() }`, `Buffer`, `Uint8Array`, `Map`, `Set`, special numbers, negative zero, and cycles:

```ts
expect(canonicalizePrismaValue({ b: 2, a: 1 })).toBe(canonicalizePrismaValue({ a: 1, b: 2 }));
expect(canonicalizePrismaValue({ a: undefined })).not.toBe(canonicalizePrismaValue({}));
expect(hashCanonicalValue({ id: 42n })).toMatch(/^[a-f0-9]{64}$/);
expect(() => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    canonicalizePrismaValue(cyclic);
}).toThrow(/cycle.*self/i);
```

Add a deterministic 500-case generated corpus that reconstructs objects with reversed insertion order and expects equal canonical output.

- [ ] **Step 2: Run canonical tests and verify RED**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/canonical.test.ts
```

Expected: FAIL because `src/canonical.ts` does not exist.

- [ ] **Step 3: Implement the single-pass canonical encoder**

Use a recursive writer that appends type-prefixed tokens into a string array and tracks object paths in a `WeakMap<object, string>`. Sort object keys and canonicalized Map/Set entries. Use `createHash('sha256').update(canonical).digest('hex')`.

Do not call `JSON.stringify` on an entire object, deep-clone values, or import `hash-object`.

Export `CanonicalizationError` with readonly `path` and `reason` fields. Unsupported functions, symbols, weak collections, and cycles throw messages such as `Cannot canonicalize value at $.where.value: function is unsupported`.

- [ ] **Step 4: Write flat serialization RED tests**

Assert one string round trip and Prisma-value fidelity:

```ts
const value = {
    date: new Date('2026-08-22T00:00:00.000Z'),
    bigint: 42n,
    nested: [undefined, Number.NaN, new Set(['a'])],
};
const payload = serializeCachedValue(value);
expect(typeof payload).toBe('string');
expect(deserializeCachedValue(payload)).toEqual(value);
expect(payload).not.toContain('fingerprint');
```

- [ ] **Step 5: Run serialization tests and verify RED**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/serialization.test.ts
```

Expected: FAIL because the v2 functions do not exist.

- [ ] **Step 6: Implement flat string serialization**

Use exactly one SuperJSON stringify/parse pair:

```ts
export function serializeCachedValue(value: unknown): string {
    return superjson.stringify(value);
}

export function deserializeCachedValue(payload: string): unknown {
    return superjson.parse(payload);
}
```

Delete `CachedEnvelope`, fingerprint serialization, and nested SuperJSON helpers.

- [ ] **Step 7: Write prepared-key RED tests**

Assert `prepareCacheKey` is insertion-order-insensitive, emits `prismaCacheTags:v2`, and builds stable version tokens:

```ts
expect(createVersionToken([null, '2', '10'])).toBe('0.2.10');
expect(buildVersionedCacheKey('prismaCacheTags:v2:qry:Widget:findMany:abc', '0.2.10')).toBe(
    'prismaCacheTags:v2:qry:Widget:findMany:abc:0.2.10',
);
```

- [ ] **Step 8: Implement v2 key preparation and fallback generation**

`prepareCacheKey` hashes `{ model, operation, args: cleanedArgs, schemaVersion }` once for normal reads. For custom keys it hashes `{ key: customKey, schemaVersion }` and uses the `custom` namespace. Tags are already normalized and map directly to ordered tag-version keys. The fallback performs `mgetString`, creates the version token, and appends it to `baseKey`.

Set `DEFAULT_CONFIG.keyPrefix` to `prismaCacheTags:v2`.

- [ ] **Step 9: Replace adapter object conversion with raw strings**

Update node-redis and ioredis adapters to return raw `GET` strings and accept pre-serialized strings. Update adapter tests before implementation so they fail on the old parse/stringify behavior.

Remove all generic `get<T>` and `set(value: unknown)` use from the extension and examples.

- [ ] **Step 10: Prepare reads once**

Refactor `readThroughCache` to receive:

```ts
interface PreparedRead {
    cleanedArgs: unknown;
    normalizedTags: string[];
    preparedKey: PreparedCacheKey;
}
```

Resolve/normalize tags once, strip cache arguments once, hash once, and pass the prepared object through lookup and population. Do not call `normalizeTags` or `removeCacheFromArgs` inside lower key helpers.

- [ ] **Step 11: Add explicit canonicalization bypass behavior**

Write a failing extension test with a cyclic or unsupported argument. Assert Prisma executes once, cache reads/writes do not run, `metrics.onCacheEvent` receives `{ result: 'bypass', path: 'bypass', reason: 'canonicalization' }`, and `logger.error` contains the exact argument path.

Catch only `CanonicalizationError` around cache preparation. Log permanent argument incompatibilities at error level and invoke Prisma without caching. Propagate unrelated programming errors.

- [ ] **Step 12: Remove `hash-object`**

Run:

```bash
pnpm remove hash-object
```

Confirm `package.json`, `pnpm-lock.yaml`, source, tests, and built declarations contain no `hash-object` import.

- [ ] **Step 13: Add v2 integration coverage**

Test:

- BigInt filter arguments cache rather than bypass;
- v1 keys manually inserted into Redis are ignored;
- swapped argument order still produces one database query;
- Date/BigInt result values retain their types;
- write invalidation reaches v2 generations.

- [ ] **Step 14: Record CPU microbenchmarks**

Add an ignored Stage 2 benchmark script or report section that compares 100,000 iterations of old representative behavior captured in the report against:

- canonical hash time;
- v2 flat encode/decode time for 1, 25, and 100 rows;
- complete zero-latency adapter warm-hit CPU.

Do not keep legacy implementation code solely for benchmarking.

- [ ] **Step 15: Run Stage 2 validation**

Run unit, integration, typecheck, lint, build, E2E, quick benchmark, and the Stage 2 microbenchmarks. Record raw A/B drift, cache tables, CPU time, and package dependency diff in `stage-2-report.md`.

- [ ] **Step 16: Commit Stage 2**

```bash
git add src tests package.json pnpm-lock.yaml README.md docs
git commit -m "perf: add canonical v2 cache wire format"
```

### Task 3: Atomic Standalone Redis Fast Path

**Files:**
- Create: `src/optimized.ts`
- Create: `src/adapters/scripts.ts`
- Create: `src/lua/versioned-lookup.ts`
- Create: `src/lua/populate-release.ts`
- Create: `src/lua/bump-versions.ts`
- Modify: `src/types.ts`
- Modify: `src/extension.ts`
- Modify: `src/keys.ts`
- Modify: `src/locks.ts`
- Modify: `src/invalidation.ts`
- Modify: `src/adapters/node-redis.ts`
- Modify: `src/adapters/ioredis.ts`
- Create: `tests/unit/optimized.test.ts`
- Create: `tests/unit/scripts.test.ts`
- Modify: `tests/unit/locks.test.ts`
- Modify: `tests/unit/invalidation.test.ts`
- Modify: `tests/unit/node-redis-adapter.test.ts`
- Modify: `tests/unit/ioredis-adapter.test.ts`
- Modify: `tests/integration/caching.test.ts`
- Modify: `tests/integration/stampede.test.ts`
- Modify: `tests/integration/transactions.test.ts`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/how-invalidation-works.md`

**Interfaces:**
- Consumes Stage 2 `PreparedCacheKey`, raw string adapter, flat payload, and v2 generation-key helpers.
- Produces:

```ts
export interface OptimizedLookupInput {
    baseKey: string;
    tagVersionKeys: string[];
    lockToken?: string;
    lockTtlMs?: number;
}

export interface OptimizedLookupResult {
    cacheKey: string;
    value: string | null;
    lockAcquired: boolean;
}

export interface OptimizedRedisPrimitives {
    lookupVersioned(input: OptimizedLookupInput): Promise<OptimizedLookupResult>;
    populateAndRelease(input: {
        cacheKey: string;
        lockToken: string;
        value: string;
        ttlSeconds: number;
    }): Promise<boolean>;
    bumpTagVersions(keys: string[], ttlSeconds: number): Promise<number[]>;
}

export interface CacheScriptEvent {
    primitive: 'lookupVersioned' | 'populateAndRelease' | 'bumpTagVersions';
    result: 'reload' | 'failure';
    retry: boolean;
}
```

- [ ] **Step 1: Write script-executor RED tests**

Specify an executor that loads once, calls EVALSHA, reloads once on `NOSCRIPT`, and propagates other errors:

```ts
await executor.execute(['k1'], ['a1']);
await executor.execute(['k2'], ['a2']);
expect(client.scriptLoad).toHaveBeenCalledTimes(1);
expect(client.evalSha).toHaveBeenCalledTimes(2);
```

Add a `NOSCRIPT` test expecting two loads and successful retry.

- [ ] **Step 2: Implement `createScriptExecutor`**

Define structural client callbacks rather than importing Redis clients:

```ts
export function createScriptExecutor(
    source: string,
    operations: {
        load(script: string): Promise<string>;
        evalSha(sha: string, keys: string[], args: string[]): Promise<unknown>;
    },
): { execute(keys: string[], args: string[]): Promise<unknown> };
```

Serialize concurrent first loads through one shared promise.

- [ ] **Step 3: Write optimized lookup RED tests**

Against real Redis, assert:

- warm lookup returns payload in one optimized adapter call;
- cold lookup returns a cache key and ownership lock;
- a second contender does not acquire the lock;
- a value appearing between initial miss and lock ownership is returned and the lock is released;
- missing tag versions become zero in deterministic order.

- [ ] **Step 4: Implement versioned lookup Lua**

The script receives the base key, lock token/TTL arguments, and ordered tag-version keys. It concatenates the numeric versions with the same dot separator as Stage 2, derives `cacheKey`, checks value, optionally acquires `${cacheKey}:lock`, rechecks value, and returns:

```txt
[cacheKey, value-or-empty, value-present-flag, lock-acquired-flag]
```

Do not use this multi-key script for adapters that omit optimized primitives.

- [ ] **Step 5: Write and implement population/release**

RED tests require:

- only the matching owner can populate;
- expired/replaced owners cannot overwrite;
- successful population sets TTL and deletes the owned lock atomically;
- database result remains usable when population returns false.

The Lua script checks lock token before `SET EX` and `DEL`.

- [ ] **Step 6: Write and implement atomic invalidation**

RED tests require one primitive call, unique keys, returned versions, and TTLs:

```ts
const versions = await optimized.bumpTagVersions(['tag:a', 'tag:b'], 3600);
expect(versions).toEqual([1, 1]);
expect(await redis.ttl('tag:a')).toBeGreaterThan(3500);
```

Lua loops through keys and performs `INCR` then `EXPIRE` atomically.

- [ ] **Step 7: Add built-in adapter capabilities**

Extend structural node-redis clients with `scriptLoad`/`evalSha`, and ioredis clients with `script('LOAD')`/`evalsha`. `createNodeRedisAdapter` and `createIoRedisAdapter` expose `optimized` by default.

Add `{ optimized: false }` adapter factory options to model Cluster/custom fallback explicitly:

```ts
createNodeRedisAdapter(client, { optimized: false });
createIoRedisAdapter(client, { optimized: false });
```

- [ ] **Step 8: Add optimized-path observability**

Extend `CacheEvent.path` to `'optimized' | 'fallback' | 'bypass'` and add optional `Metrics.onScriptEvent(event: CacheScriptEvent)`. Write tests asserting optimized hits, fallback hits, misses, bypasses, script reloads, and terminal script failures are distinguishable.

Every script failure log includes `primitive`, `retry`, and the original error. Do not emit a hit after failed parsing or script validation.

- [ ] **Step 9: Integrate optimized reads with fallback parity**

When `adapter.optimized` exists, use `lookupVersioned`. When absent, use Stage 2 fallback generation, `getString`, and existing lock operations.

Read-side optimized failure logs the primitive and uses the command fallback. Cache population failure returns the database result.

- [ ] **Step 10: Integrate invalidation fallback**

`bumpTagVersions` uses the atomic primitive when available. On failure it logs once and executes the command fallback. Add a test where the optimized primitive increments one tag then rejects; fallback may produce version 2, but every key must be incremented and expiring.

Document why version TTL is `Math.max(maxTtlSeconds * 10, 3600)`.

- [ ] **Step 11: Remove redundant lock hashing and improve waiter polling**

Derive lock keys directly:

```ts
export function getCacheLockKey(cacheKey: string): string {
    return `${cacheKey}:lock`;
}
```

Change waiters to check immediately, then sleep with delays `2, 4, 8, ...` capped at `pollMs` and bounded by `waitMs`.

Write fake-timer tests proving a value available immediately causes no timer and a value available after 5 ms does not wait the default 50 ms.

- [ ] **Step 12: Run fallback and optimized parity suites**

Execute identical caching, invalidation, transaction, and stampede scenarios with:

- node-redis optimized;
- node-redis `{ optimized: false }`;
- ioredis optimized;
- ioredis `{ optimized: false }`;
- a minimal custom adapter with no optimized property.

All modes must return identical results and database-query counts.

- [ ] **Step 13: Measure command and contention gains**

Use Redis commandstats deltas to prove:

- optimized warm hit: one script command;
- optimized cold owner path: at most three script commands around the database query;
- five-tag invalidation: one script command;
- fallback command counts remain documented.

Run the 32-contender phase and record loser percentiles before/after immediate backoff.

- [ ] **Step 14: Run Stage 3 validation**

Run unit, integration, typecheck, lint, build, E2E, quick benchmark, focused command-count benchmark, and contention benchmark. Record same-host comparison against Stage 2 in `stage-3-report.md`.

- [ ] **Step 15: Commit Stage 3**

```bash
git add src tests README.md docs
git commit -m "perf: add atomic Redis cache fast path"
```

### Task 4: Production-Oriented Benchmarking and Final Evidence

**Files:**
- Modify: `tests/fixture/schema.prisma`
- Modify: `tests/load/benchmark-fixture.ts`
- Modify: `tests/load/read-comparison.ts`
- Modify: `tests/load/read-comparison-report.ts`
- Create: `tests/load/query-kind-metrics.ts`
- Create: `tests/load/realistic-workload.ts`
- Modify: `tests/load/load-benchmark.ts`
- Modify: `tests/load/profiles.ts`
- Modify: `tests/unit/read-comparison.test.ts`
- Create: `tests/unit/query-kind-metrics.test.ts`
- Create: `tests/unit/realistic-workload.test.ts`
- Modify: `tests/integration/load-benchmark.test.ts`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `tests/load/README.md`

**Interfaces:**
- Consumes all Stage 1-3 cache behavior and benchmark evidence.
- Produces:

```ts
export type QueryKind =
    | 'widgetUnique'
    | 'partUnique'
    | 'widgetList'
    | 'partList'
    | 'widgetAggregate';

export interface QueryKindSummary {
    kind: QueryKind;
    completed: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    operationsPerSecond: number;
}

export interface EventLoopSummary {
    utilization: number;
    activeMs: number;
    idleMs: number;
}

export interface RealisticWorkloadProfile {
    name: 'list-heavy' | 'zipfian';
    operations: number;
    concurrency: number;
    listTake: number;
    hotKeyProbability: number;
}
```

- [ ] **Step 1: Add aggregate fixture and operation RED tests**

Extend the deterministic plan with `widgetAggregate` per tenant:

```ts
{
    kind: 'widgetAggregate',
    tenantId,
}
```

Execute:

```ts
client.widget.aggregate({
    where: { tenantId },
    _count: { _all: true },
    cache,
});
```

Assert raw/cold/warm equivalence and phase invariants include the new operations.

- [ ] **Step 2: Add per-query-kind metrics through TDD**

Write failing tests that record samples independently and assert separate percentiles. Implement a collector keyed by `QueryKind`; do not infer kinds from operation names after execution.

Update comparison reports to print one aggregate table and one per-kind table for each phase.

- [ ] **Step 3: Add event-loop utilization measurement**

Use `performance.eventLoopUtilization()` snapshots around each phase:

```ts
const start = performance.eventLoopUtilization();
await runPhase();
const delta = performance.eventLoopUtilization(start);
```

Report utilization percentage, active milliseconds, and idle milliseconds. Unit-test conversion math with explicit snapshots.

- [ ] **Step 4: Add Redis command-count collection**

Capture `INFO commandstats` before and after phases. Parse only required commands and scripts into:

```ts
Record<'get' | 'mget' | 'set' | 'eval' | 'evalsha' | 'incrby' | 'expire', number>
```

Report deltas per phase. Missing commandstat entries equal zero. Parser tests use fixed INFO text.

- [ ] **Step 5: Add list-heavy workload**

Create a deterministic workload where at least 70% of reads are tenant list or aggregate operations, `take` is 100 where applicable, and the same finite plan runs raw/cold/warm.

Add `description String @default("")` to `Widget` and `Part`. Seed a deterministic 512-character Widget description and 256-character Part description so list results exercise meaningful serialization. Regenerate the fixture client through `pnpm exec prisma generate`.

- [ ] **Step 6: Add Zipfian workload**

Implement deterministic rank selection with a seeded PRNG and exponent 1.1. The hottest 20% of keys must receive approximately 80% of generated reads within a documented tolerance.

The phase includes cold contention and warm repeated-key behavior. Assert all clients return equivalent digests and stampede protection limits database queries.

- [ ] **Step 7: Add CLI profile selection**

Extend arguments without changing existing quick/stress behavior:

```bash
pnpm test:benchmark:load -- --workload standard
pnpm test:benchmark:load -- --workload list-heavy
pnpm test:benchmark:load -- --workload zipfian
pnpm test:benchmark:load -- --profile stress --workload list-heavy
```

Default workload remains `standard`. Reject unknown values before service connections.

- [ ] **Step 8: Add benchmark output**

For every workload print:

- environment/profile/workload;
- raw A and raw B with drift;
- cold and warm speedups or `unstable`;
- aggregate and per-kind latency/throughput;
- cache hit/miss and database-query counts;
- Redis command deltas;
- event-loop utilization;
- contention winner/loser percentiles;
- mixed correctness workload result.

Measure command deltas around isolated warm-read, cold-read, write, and multi-tag invalidation probes. Run no other benchmark workers during these probes, and label INFO commandstats as process-wide Redis counters rather than namespace-local counters.

- [ ] **Step 9: Update documentation**

Explain what each workload proves, why standard is intentionally unfavorable to caching, how to target a network-separated Redis with `TEST_REDIS_URL`, and why local results must not be published as universal performance claims.

Include exact quick, stress, list-heavy, and Zipfian commands.

- [ ] **Step 10: Run the final verification matrix**

Run:

```bash
pnpm run test:unit
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:integration
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:e2e
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:invalidation
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load -- --workload list-heavy
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load -- --workload zipfian
TEST_DATABASE_URL=postgresql://cachetags:cachetags@localhost:5433/cachetags \
TEST_REDIS_URL=redis://localhost:6380 pnpm run test:benchmark:load -- --profile stress
```

Expected: all correctness checks pass; every benchmark completes with zero errors/freshness failures and records its complete tables in `stage-4-report.md`.

- [ ] **Step 11: Compare final results with Stage 1**

Create a final report table for:

- warm throughput and p50/p95/p99;
- cold penalty versus mean raw baseline;
- raw drift;
- event-loop utilization;
- warm/cold/write Redis command counts;
- contention loser p50/p95/p99;
- standard/list-heavy/Zipfian hit rates and database-query reduction.

State observed gains without converting them into guaranteed package claims.

- [ ] **Step 12: Commit Stage 4**

```bash
git add tests README.md CONTRIBUTING.md
git commit -m "test: add production cache performance workloads"
```

## Final Review and Handoff

After all four tasks:

1. Run a broad whole-branch review against the committed spec.
2. Fix all Critical and Important findings in one reviewed fix wave.
3. Confirm the original main checkout's dirty files remain untouched.
4. Present the user with exact before/after benchmark tables, correctness fixes, public adapter changes, remaining risks, and branch integration options.
