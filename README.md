# prisma-extension-cache-tags

Redis caching for Prisma with automatic, generational tag invalidation — a write is a single `INCR`, never a `SCAN`.

## Install

```bash
npm install prisma-extension-cache-tags
# plus whichever Redis client you already use
npm install redis    # or: npm install ioredis
```

## Quickstart

This example assumes a Prisma 7 `prisma-client` generator output at
`./generated/prisma`.

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from 'redis';
import { createCacheTagsExtension } from 'prisma-extension-cache-tags';
import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
import { PrismaClient } from './generated/prisma/client';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter }).$extends(
    createCacheTagsExtension(createNodeRedisAdapter(redis), {
        tenantKeys: ['organizationId'],
    }),
);

// Opt in per query. Tags are inferred automatically.
const widgets = await prisma.widget.findMany({
    where: { organizationId: 'org_123' },
    cache: { ttlSeconds: 60 },
});

// A write invalidates every cached read that shares a tag. No extra code.
await prisma.widget.update({
    where: { id: 'widget_1' },
    data: { name: 'renamed' },
});
```

When `tenantKeys` is configured, an ID-only update or delete uses the returned
record to identify its tenant when possible. By default, every inferred read and
write also carries the unscoped `global:model:<Model>` tag. This is deliberately
model-level invalidation: it keeps ambiguous read/write arguments correct, but a
write in one tenant can evict cached reads for every tenant.

Set `tenantPrecision: true` only when the application guarantees that every
cached read and every write includes one of the configured `tenantKeys` (for
example, a Prisma client already scoped per tenant):

```ts
createCacheTagsExtension(createNodeRedisAdapter(redis), {
    tenantKeys: ['organizationId'],
    tenantPrecision: true,
});
```

Precision mode omits the global model tag from tenant-resolved reads. Writes
with a resolved tenant still include it so tenant-less reads are invalidated; a
write that cannot resolve a tenant falls back to global model tags and logs a
warning. If the invariant is not guaranteed, keep the safe default.

## How invalidation works

On a cached read, the extension infers tenant, model, and entity tags from the Prisma arguments. Configure argument names with `tenantKeys` and `entityKeys`, or add explicit `cache.tags` when a query needs a broader or custom scope. The default model-level fallback is retained whenever it is emitted, even when `maxTagsPerQuery` truncates a read's tag list. The limit never truncates write invalidation tags.

Each tag has a Redis version counter, and the current counter values are folded into the cache key. A read therefore selects the current generation without maintaining a list of every key that carries the tag.

A successful write increments the affected counters, so old cache keys become unreachable immediately and expire on their own TTL. Interactive transactions defer those increments until commit; a rollback does not invalidate the previous generation.

Read the [detailed invalidation explanation](docs/how-invalidation-works.md) for key generation and transaction details.

## v2 keys and wire format

The default namespace is `prismaCacheTags:v2`. A read first prepares one
canonical identity from its model, operation, cleaned Prisma arguments, schema
version, normalized tags, tenant scope, and optional custom key. The SHA-256
digest of that exact identity is used in the base query key and the identity is
retained in the cached envelope. Current tag versions are appended as a stable
dot-separated generation token.

Values are stored as one flat SuperJSON string:

```ts
{ identity, tenantScope, value }
```

Every cache hit, including the optimized path, deserializes and verifies both
identity and sorted tenant scope before returning `value`. A mismatch is
deleted when possible, reported as a cache bypass, and never returned. v1 keys
are not read or migrated.

The built-in node-redis and ioredis adapters use standalone/Sentinel-safe Lua
primitives by default when their script commands are available. A versioned
lookup, owner population/release, and multi-tag invalidation each execute
atomically. Pass `{ optimized: false }` to either adapter factory, or omit the
optional primitives on a custom adapter, to use the equivalent command
fallback. Cluster clients must use the fallback because a multi-key script
cannot span Redis hash slots.

Lua results are treated as untrusted wire data. The extension deserializes and
verifies every returned envelope against the prepared canonical identity and
sorted tenant scope before reporting or serving a hit. Script loads use
`EVALSHA`, with one `NOSCRIPT` reload/retry; failures are logged and surfaced
through the optional `metrics.onScriptEvent` hook before the safe fallback runs.

## Requirements

- Prisma `^7.2.0` with a driver adapter
- Node `^20.19 || ^22.12 || >=24.0`
- Any Redis server and a compatible client adapter (`redis`, `ioredis`, or your own `RedisAdapter`)

## Features

- Generational O(1) invalidation
- Automatic tag inference
- Cross-model `dependencyTags`
- Transaction-deferred flush
- Distributed single-flight lock
- Atomic standalone Redis fast path (with command fallback)
- Superjson serialization (Date/Decimal/BigInt safe)

## Comparison and limits

The design deliberately focuses on predictable Prisma read-through caching and constant-time invalidation. These are the important boundaries:

| Area | This package provides | Deliberate limit |
| --- | --- | --- |
| Invalidation | Generational tag counters; a write performs one `INCR` per affected tag and never scans cache keys | Orphaned generations remain in Redis until their TTL expires |
| Revalidation | Read-through cache with distributed single-flight locking | No stale-while-revalidate |
| Value storage | Superjson envelopes through a normal Redis client | No RedisJSON integration |
| Runtime | Prisma 7 driver-adapter setup for supported Node releases | Edge-runtime testing is not provided |
| Operations | Bring your own Redis deployment and client adapter | No hosted option |

## Benchmarks

Run the benchmarks after completing the local setup in [CONTRIBUTING.md](CONTRIBUTING.md):
install dependencies, start PostgreSQL and Redis with `pnpm db:up`, set
`TEST_DATABASE_URL` and `TEST_REDIS_URL` as needed, and prepare the Prisma fixture
schema. The invalidation benchmark only needs Redis; the model-backed benchmark
needs both PostgreSQL and Redis.

```bash
pnpm test:benchmark:invalidation
pnpm test:benchmark:load
pnpm test:benchmark:load -- --profile stress
pnpm test:benchmark:load -- --preserve
```

`test:benchmark:invalidation` is a synthetic keyspace-scaling microbenchmark. It
seeds synthetic cached-query keys and measures whether generational invalidation
cost changes as the Redis keyspace grows. `test:benchmark:load` first discards an
untimed raw warm-up, then runs raw A, cold, warm, and raw B samples over one
finite deterministic plan from the fixture's shared corpus. Cold starts after
clearing the run namespace; warm repeats without cleanup. Every measured phase
uses the same clients and concurrency, verifies result-digest equivalence, and
reports throughput, latency percentiles, cache hits/misses, and database queries.
The report shows symmetric raw A/B drift. When drift is at most 10%, speedups use
the arithmetic mean of both raw samples; otherwise they render as `unstable`.

The load benchmark also synchronizes 32 independent clients on one cold key.
Quick runs use 10 rounds and stress runs use 30, reporting one database-query
count per round plus winner and loser p50/p95/p99 latency. It then prints the
existing blended 90% read / 10% write report for invalidation, distributed
stampede, and post-write freshness validation. The comparison namespace is
cleared before that mixed-workload warm-up so its cache state and report remain
isolated from the comparison.

The `quick` profile is the default; `--profile stress` uses a larger dataset,
more concurrency, and a longer measurement window for deliberate capacity
investigations. Warm-up requests are sampled and bounded, and each benchmark
Prisma client is capped at one PostgreSQL connection. Performance numbers are
informational only, not statistical claims or CI thresholds; correctness
failures remain fatal.

The invalidation benchmark reports p50 and p99 invalidation latency by keyspace
and verifies one Redis `EVALSHA` per optimized invalidation (or `INCRBY` in
forced fallback mode). The blended model-backed report
continues to include throughput, p50/p95/p99 latency, cache hit rate, database
query count, errors, and freshness failures. The preceding comparison has its
own rows and counters, so its read-only measurements do not alter the mixed
workload report. A focused Redis `INFO commandstats` probe can isolate warm
lookup, cold-owner, and multi-tag invalidation command deltas; `INFO` counters
are process-wide, so reset and run each probe without concurrent traffic.
Node event-loop utilization is not instrumented.

The model-backed benchmark normally removes only the current run's database rows
and Redis namespace, and never flushes the Redis database. Pass `--preserve` to
skip that cleanup and inspect the run; the command prints the run ID, tenant IDs,
and Redis key prefix. The synthetic invalidation benchmark resets its disposable
Redis database with `FLUSHDB`, so run it only against a disposable database with
no concurrent users.

## License

MIT
