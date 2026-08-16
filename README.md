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

On a cached read, the extension infers tenant, model, and entity tags from the Prisma arguments. Configure argument names with `tenantKeys` and `entityKeys`, or add explicit `cache.tags` when a query needs a broader or custom scope. The default model-level fallback is retained whenever it is emitted, even when `maxTagsPerQuery` truncates the tag list.

Each tag has a Redis version counter, and the current counter values are folded into the cache key. A read therefore selects the current generation without maintaining a list of every key that carries the tag.

A successful write increments the affected counters, so old cache keys become unreachable immediately and expire on their own TTL. Interactive transactions defer those increments until commit; a rollback does not invalidate the previous generation.

Read the [detailed invalidation explanation](docs/how-invalidation-works.md) for the key, fingerprint, and transaction details.

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
cost changes as the Redis keyspace grows. `test:benchmark:load` runs real Prisma
`Widget` and `Part` reads and writes against PostgreSQL and Redis through the
cache extension. It uses the `quick` profile by default; `--profile stress` uses
a larger dataset, more concurrency, and a longer measurement window for deliberate
capacity investigations.

The invalidation benchmark reports p50 and p99 invalidation latency by keyspace
and verifies the expected Redis `INCRBY` count. The model-backed report includes
throughput, p50/p95/p99 latency, cache hit rate, database query count, errors, and
freshness failures. Performance numbers are informational only and are not CI
gates; correctness failures, workload errors, and freshness failures still make
the command fail.

The model-backed benchmark normally removes only the current run's database rows
and Redis namespace, and never flushes the Redis database. Pass `--preserve` to
skip that cleanup and inspect the run; the command prints the run ID, tenant IDs,
and Redis key prefix. The synthetic invalidation benchmark resets its disposable
Redis database with `FLUSHDB`, so run it only against a disposable database with
no concurrent users.

## License

MIT
