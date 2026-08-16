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

## How invalidation works

On a cached read, the extension infers tenant, model, and entity tags from the Prisma arguments. Configure argument names with `tenantKeys` and `entityKeys`, or add explicit `cache.tags` when a query needs a broader or custom scope.

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
| Measurements | The load harness measures this package's invalidation scaling | No latency comparisons against other packages are published |

## License

MIT
