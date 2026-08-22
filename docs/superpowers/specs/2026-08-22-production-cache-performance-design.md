# Production Cache Performance Design

## Goal

Improve production throughput and latency without weakening generational invalidation, cross-instance consistency, transaction behavior, tenant isolation, or stampede protection.

The work addresses three verified correctness and measurement defects before optimizing CPU and Redis round trips:

1. Cache keys canonicalize object-property order while stored fingerprints preserve insertion order, allowing semantically identical calls from different instances to delete and replace each other's entries.
2. Write-side tag truncation can omit tenant invalidations under `tenantPrecision: true`, allowing stale reads.
3. The benchmark runs `raw -> cold -> warm` without discarded warm-up or a second raw sample, biasing comparisons through V8, Prisma, connection, and PostgreSQL warm-up.

## Constraints

- Preserve the O(number of tags) generational invalidation model and its scan-free production behavior.
- Preserve transaction-deferred invalidation and rollback behavior.
- Preserve tenant isolation and prefer over-invalidation to stale data.
- Optimize standalone Redis and Sentinel deployments.
- Redis Cluster and custom adapters use a correct command fallback when optimized multi-key primitives are unavailable.
- Introduce cache key and wire format v2. Existing v1 entries are not read or migrated and expire naturally.
- No legacy adapter compatibility layer is required.
- Remove `hash-object`; do not add a replacement runtime dependency.
- Performance values are informational, not CI thresholds.
- Each stage is implemented by a fresh GPT-5.6 Luna agent at maximum reasoning effort.

## Stage 1: Correctness and Trustworthy Measurement

### Canonical cache identity

Remove the stored full-argument fingerprint from cache entries. The cache key already identifies model, operation, canonical arguments, schema version, and tag versions. Retaining a second, differently canonicalized identity check creates cache thrash while adding negligible collision protection.

Until the v2 canonical serializer lands in Stage 2, Stage 1 must ensure every identity representation uses one canonical form. Alternating semantically identical arguments with different insertion order across independent clients must produce one database query and no cache deletion.

### Write-side invalidation completeness

`maxTagsPerQuery` limits read-key precision only. Writes must never drop resolved invalidation tags. A write may invalidate more broadly or increment more tags, but it must not leave a matching cached read reachable.

Tests must cover `tenantPrecision: true` with at least 20 tenants and a write resolving more tags than the configured read limit. Every tenant's next read must return fresh data.

### Benchmark ordering

The read comparison performs:

1. an unmeasured discarded warm-up that does not populate comparison cache entries;
2. measured raw sample A;
3. measured cold cache;
4. measured warm cache;
5. measured raw sample B.

The report displays both raw samples and their drift. It must not collapse them into a single baseline. Cold and warm speedups use the mean of raw A and raw B only when drift is within a clearly reported 10%; otherwise the report marks comparative speedup as unstable.

### Contended-key measurement

Add a phase where 32 independent clients request one cold key simultaneously. Report database-query count and winner/loser p50, p95, and p99 latency. The correctness invariant is one database query and equal results.

## Stage 2: CPU, Allocation, Hashing, and Wire Format

### Canonical Prisma argument encoding

Add a focused canonical encoder that:

- sorts object keys without cloning the full object;
- preserves array order;
- distinguishes absent properties from explicit `undefined`;
- deterministically represents `Date`, `BigInt`, decimal-like values, `Buffer`, typed arrays, `Map`, `Set`, `NaN`, positive and negative infinity, and negative zero;
- rejects cycles with an actionable error;
- produces identical output for semantically identical objects regardless of insertion order.

Hash the canonical bytes with Node's built-in SHA-256. The key uses a compact hexadecimal or base64url digest. The same canonical representation is the only query-identity source.

Deterministic corpus tests and generated Prisma-shaped test values must cover equivalence and non-equivalence properties. `BigInt` arguments must cache successfully.

### Flat cache envelope

Cache v2 stores one SuperJSON serialization of the query value in a flat envelope. It does not serialize a pre-serialized SuperJSON object or store full query arguments.

The adapter API exposes raw string reads and writes so the path does not perform `JSON.parse -> object traversal -> SuperJSON traversal`. Built-in node-redis and ioredis adapters implement the new interface directly.

The cache prefix changes to `prismaCacheTags:v2`, isolating all v1 entries. Serialization fidelity tests cover Prisma-relevant values and confirm v1 data is ignored.

### Single-pass operation preparation

For every read:

- strip cache options once;
- infer and normalize tags once;
- canonicalize and hash cleaned arguments once;
- pass those prepared values through key generation, lookup, and population.

Remove redundant tag normalization, argument cloning, and fingerprint recomputation.

## Stage 3: Optimized Standalone/Sentinel Redis Primitives

### Capability model

The extension uses optional high-level optimized adapter primitives. Their absence selects the normal command fallback. This makes topology support explicit:

- built-in standalone/Sentinel adapters expose optimized primitives;
- Redis Cluster adapters and custom adapters may omit them;
- both paths share the same key, value, lock, and invalidation semantics.

The extension does not cache tag versions in process.

### Versioned cache lookup

The optimized read primitive atomically:

1. reads all required tag-version keys;
2. assembles the ordered version token;
3. derives the generation value key from the prepared base key and token;
4. returns the current cached string value.

It uses `EVALSHA` with script-load and one retry on `NOSCRIPT`. This reduces a warm hit from two sequential Redis round trips to one.

### Cold lookup and lock

The optimized cold primitive atomically checks the current generation value and, when absent, attempts ownership-safe lock acquisition. It retains the post-lock value recheck that prevents redundant database work.

Population and lock release form another ownership-safe atomic primitive. A failed cache population never suppresses the database result.

Waiters check for a populated value before sleeping, then use bounded exponential backoff starting near 2 ms and capped by configured `pollMs`. Timeouts still fall back to a correct database query.

The lock key derives directly from the already-hashed value-key identity and is not hashed again.

### Atomic invalidation

The optimized invalidation primitive increments and expires every tag-version key in one Lua script. It preserves the invariant that tag-version TTL exceeds the maximum lifetime of any cache entry.

If an optimized invalidation fails after script reload/retry, the extension executes the command fallback. A possible extra generation increment is acceptable because it over-invalidates without serving stale data.

### Cluster and custom fallback

The fallback retains separate Redis commands and does not execute multi-key Lua. Test suites run identical behavioral scenarios against optimized and fallback adapters.

## Stage 4: Production-Oriented Benchmarks

### Query-kind reporting

Report raw, cold, and warm results separately for:

- unique Widget reads;
- unique Part reads;
- Widget lists;
- Part lists;
- aggregates or grouped reads supported by the fixture.

The aggregate summary remains, but it cannot hide a regressing query kind.

### Realistic workloads

Add:

- a list-heavy workload with larger result payloads;
- a Zipfian hot-key workload with repeated popular keys;
- the 32-reader cold-key contention phase;
- Redis command counts for read, miss, write, and invalidation paths;
- Node event-loop utilization for every measured phase.

Network-separated Redis is an external benchmark configuration, not an automated dependency. Documentation explains how `TEST_REDIS_URL` can target a remote or latency-injected Redis.

### Benchmark evidence

Every implementation stage records:

- commit range;
- environment and selected profile;
- raw A/raw B drift;
- raw, cold, warm, and mixed results;
- Redis command counts;
- event-loop utilization where available;
- correctness failures or anomalies.

Quick benchmarks run after every stage. The stress benchmark establishes the initial baseline and final result. Same-host before/after results are required before accepting an optimization stage, but no fixed speed threshold gates CI.

## Error Handling and Observability

- Canonicalization errors identify the unsupported value path and bypass caching without changing the Prisma result.
- Permanent argument incompatibilities are logged as errors rather than silent warnings.
- Script errors include primitive name and retry state.
- Read optimization failures safely bypass or use the command fallback.
- Invalidation optimization failures use the command fallback and remain observable.
- Metrics distinguish optimized-path hits, fallback-path hits, misses, script reloads, script failures, and cache bypasses.
- No error path returns a success-shaped cached result after failed validation.

## Testing

Each stage follows test-driven development and captures assertion-level RED and GREEN evidence.

Required coverage includes:

- swapped property order across independent clients;
- tenant-precision writes exceeding the read tag limit;
- A/B/A benchmark drift;
- canonical encoding equivalence and non-equivalence;
- BigInt and Prisma-value serialization;
- v1/v2 isolation;
- optimized and fallback adapter parity;
- script load, `NOSCRIPT` reload, and fallback;
- lock ownership and waiter timing;
- multi-tag invalidation atomicity;
- transactions and rollback;
- node-redis and ioredis integration;
- cluster/custom fallback simulation;
- contended cold-key database-query count;
- query-kind and workload report calculations.

Every stage runs unit tests, integration tests, typecheck, lint, build, package E2E, and focused quick benchmarks. The final stage also runs the stress profile.

## Execution and Review

Execution uses four sequential fresh GPT-5.6 Luna agents at maximum reasoning effort, one per stage. Each agent receives this spec, its exact implementation-plan task, preceding stage interfaces, baseline metrics, and a report-file contract.

Each stage is independently reviewed for specification compliance and code quality. Important findings are fixed and re-reviewed before the next stage begins. A final whole-branch review evaluates cross-stage correctness, fallback parity, public API quality, documentation, and benchmark claims.
