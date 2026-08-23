# prisma-extension-cache-tags

Opt-in Redis read-through caching for Prisma 7 with automatic, generational tag
invalidation that stays O(tags) and never scans the cache keyspace.

[![CI](https://github.com/nmb0032/prisma-extension-cache-tags/actions/workflows/ci.yml/badge.svg)](https://github.com/nmb0032/prisma-extension-cache-tags/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/nmb0032/prisma-extension-cache-tags)](LICENSE)

## Contents

- [prisma-extension-cache-tags](#prisma-extension-cache-tags)
  - [Contents](#contents)
  - [Why this package](#why-this-package)
  - [Requirements and installation](#requirements-and-installation)
  - [60-second quick start](#60-second-quick-start)
  - [Recipes](#recipes)
    - [ioredis](#ioredis)
    - [Per-query options and bypasses](#per-query-options-and-bypasses)
    - [Explicit tags](#explicit-tags)
    - [Dependency tags](#dependency-tags)
    - [Safe multi-tenant defaults](#safe-multi-tenant-defaults)
    - [Interactive transactions](#interactive-transactions)
    - [Optional `withCacheInvalidation` fallback](#optional-withcacheinvalidation-fallback)
    - [Structured logging and metrics](#structured-logging-and-metrics)
  - [How it works](#how-it-works)
  - [Compatibility and operational limits](#compatibility-and-operational-limits)
  - [Benchmarks](#benchmarks)
  - [Documentation](#documentation)
  - [Contributing](#contributing)
  - [License](#license)

## Why this package

- Opt-in read-through caching for Prisma 7 `findUnique`, `findFirst`, `findMany`,
  `count`, `aggregate`, and `groupBy` reads.
- Automatic generational tag invalidation after successful writes.
- O(tags) invalidation with no `SCAN` and no tag-to-key index.
- Exact canonical cache identity and sorted tenant-scope verification before
  every returned hit.
- Invalidation deferred until a transaction commits; a rollback leaves the
  previous cache generation valid.
- Distributed single-flight protection for concurrent cache misses.
- Built-in node-redis and ioredis adapters, plus a minimal custom
  `RedisAdapter` interface.
- Optimized Redis scripts for standalone and Sentinel deployments when
  available, with a safe command fallback for Redis Cluster.

## Requirements and installation

- Node.js `^20.19 || ^22.12 || >=24.0`
- Prisma 7 with `@prisma/client` `^7.2.0` and a Prisma driver adapter, such as
  `@prisma/adapter-pg`
- A Redis server and exactly one supported Redis client:
  `redis` `^5.0.0 || ^6.0.0` or `ioredis` `^5.0.0 || ^6.0.0`

Install the package with one Redis client. Choose one command; do not install
both clients for the same adapter:

```bash
pnpm add prisma-extension-cache-tags redis
# or
pnpm add prisma-extension-cache-tags ioredis
```

The package does not replace Prisma setup. Your application must already
generate a Prisma 7 client with a driver adapter.

## 60-second quick start

This example uses Prisma 7's `prisma-client` generator, PostgreSQL through
`@prisma/adapter-pg`, and node-redis. Set `DATABASE_URL` and `REDIS_URL` before
starting the application.

Generate a client from a schema like this:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model Widget {
  id       String @id @default(uuid())
  tenantId String
  name     String
}
```

Prisma 7 reads the datasource URL from `prisma.config.ts`:

```ts
// prisma.config.ts
import path from "node:path";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

Create the extended client:

```ts
// src/db.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "redis";
import { createCacheTagsExtension } from "prisma-extension-cache-tags";
import { createNodeRedisAdapter } from "prisma-extension-cache-tags/node-redis";
import { PrismaClient } from "./generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl || !redisUrl) {
  throw new Error("DATABASE_URL and REDIS_URL are required");
}

const redis = createClient({ url: redisUrl });
await redis.connect();

const prismaAdapter = new PrismaPg({ connectionString: databaseUrl });
export const prisma = new PrismaClient({ adapter: prismaAdapter }).$extends(
  createCacheTagsExtension(createNodeRedisAdapter(redis), {
    tenantKeys: ["tenantId"],
  }),
);

// Caching is opt-in per read. Tags are inferred from the Prisma arguments.
const widgets = await prisma.widget.findMany({
  where: { tenantId: "org_123" },
  cache: { ttlSeconds: 60 },
});

// Successful writes invalidate matching generations automatically.
await prisma.widget.update({
  where: { id: "widget_1" },
  data: { name: "renamed" },
});
```

Run `pnpm prisma generate` after changing the schema. Adapt the generated
client path to your application's output directory.

## Recipes

### ioredis

Use the ioredis subpath export instead of the node-redis adapter:

```ts
import Redis from "ioredis";
import { createCacheTagsExtension } from "prisma-extension-cache-tags";
import { createIoRedisAdapter } from "prisma-extension-cache-tags/ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const redisAdapter = createIoRedisAdapter(redis);

const prisma = new PrismaClient({ adapter: prismaAdapter }).$extends(
  createCacheTagsExtension(redisAdapter, {
    tenantKeys: ["tenantId"],
  }),
);
```

`ioredis` connects as needed. The `PrismaClient` and `prismaAdapter` in this
snippet are the same Prisma 7 setup shown above.

### Per-query options and bypasses

Caching is opt-in on supported reads. `ttlSeconds` is clamped to the configured
maximum; `key` adds a component to the complete canonical identity and cannot
make different queries alias each other.

```ts
const widgets = await prisma.widget.findMany({
  where: { tenantId: "org_123" },
  cache: {
    ttlSeconds: 60,
    key: "widget-dashboard",
    debug: true,
  },
});

const fresh = await prisma.widget.findMany({
  where: { tenantId: "org_123" },
  cache: { enabled: false },
});
```

Use `cache: { enabled: false }` for a one-off uncached read. Other per-read
options include `tags`, `inferTags`, `mergeTags`, and `stampede`.

### Explicit tags

Add the same application tag to reads and writes when a broader or custom
invalidation scope is useful:

```ts
const dashboardTags = ["dashboard:org_123"];

await prisma.widget.findMany({
  where: { tenantId: "org_123" },
  cache: { ttlSeconds: 60, tags: dashboardTags },
});

await prisma.widget.update({
  where: { id: "widget_1" },
  data: { name: "renamed" },
  cache: { tags: dashboardTags },
});
```

The public `createCacheTags` helper also provides tenant, model, and entity tag
formats when you want consistent names across application code.

### Dependency tags

Map a written model to related models whose cached reads should be invalidated:

```ts
import type { CacheTagsConfig } from "prisma-extension-cache-tags";

const cacheConfig: CacheTagsConfig = {
  tenantKeys: ["tenantId"],
  dependencyTags: {
    Widget: ["Part"],
  },
};
```

For application-specific scopes, a dependency resolver receives the model,
operation, tenant IDs, entity IDs, and original arguments and returns tag
strings.

### Safe multi-tenant defaults

Configure every argument name that can identify a tenant and keep
`tenantPrecision` at its default `false` unless the stronger invariant is
enforced:

```ts
const cacheConfig: CacheTagsConfig = {
  tenantKeys: ["tenantId", "organizationId"],
};
```

The default emits an unscoped model tag for inferred reads and writes. This is
the correctness-first behavior: a write in one tenant can evict another
tenant's cached entry, but it cannot leave that entry stale.

> **Warning:** Set `tenantPrecision: true` only when every cached read and every
> write is guaranteed to include one of the configured tenant keys. Tenant-
> resolved reads then omit the unscoped model tag. A write that cannot resolve a
> tenant falls back to model-wide invalidation and logs a warning; without the
> invariant, tenant-precise reads are not safe.

### Interactive transactions

Use Prisma's normal `$transaction`; no wrapper is required. Invalidation tags
from writes are buffered and flushed once after commit. A rollback does not
advance the previous generation.

```ts
await prisma.$transaction(async (tx) => {
  await tx.widget.update({
    where: { id: "widget_1" },
    data: { name: "renamed in transaction" },
  });
});
```

The callback and batch forms of `$transaction` are intercepted on the extended
client.

### Optional `withCacheInvalidation` fallback

Use `withCacheInvalidation` only for a code path that cannot use the extended
client's intercepted `$transaction` callback. It buffers tags emitted during
the callback and flushes them when the callback resolves; it does not replace
Prisma's database transaction semantics.

```ts
import { withCacheInvalidation } from "prisma-extension-cache-tags";

const redisAdapter = createNodeRedisAdapter(redis);
const cacheConfig = { tenantKeys: ["tenantId"] };

await withCacheInvalidation(
  () =>
    prisma.widget.update({
      where: { id: "widget_1" },
      data: { name: "renamed" },
    }),
  redisAdapter,
  cacheConfig,
);
```

Use the same cache configuration for the wrapper and the extended client.

### Structured logging and metrics

Logging is a no-op by default. Logger methods receive `(data, message)`;
metrics receive cache hits, misses, bypasses, and optional optimized-script
events.

```ts
import type { CacheTagsConfig } from "prisma-extension-cache-tags";

const cacheConfig: CacheTagsConfig = {
  logger: {
    debug(data, message) {
      console.debug(message, data);
    },
    info(data, message) {
      console.info(message, data);
    },
    warn(data, message) {
      console.warn(message, data);
    },
    error(data, message) {
      console.error(message, data);
    },
  },
  metrics: {
    onCacheEvent(event) {
      console.log("cache event", event);
    },
    onScriptEvent(event) {
      console.log("Redis script event", event);
    },
  },
};
```

`onCacheEvent` reports `{ model, operation, result, path, reason? }`, where
`result` is `hit`, `miss`, or `bypass`. The `path` identifies optimized,
fallback, or bypass handling. Replace the `console` calls with your logging
and metrics backend.

## How it works

Each cached read resolves inferred and explicit tags, then builds one canonical
identity from the model, operation, cleaned Prisma arguments, schema version,
normalized tags, tenant scope, and optional custom key. Its SHA-256 digest forms
the base cache key; current tag-generation counters are appended to select the
active generation. The stored envelope retains the identity and sorted tenant
scope, and every candidate hit is verified before its value is returned.

A successful write increments each affected tag counter instead of deleting
matching keys. Older generations become unreachable immediately and expire
through their own TTL, so invalidation stays independent of the number of
cached keys. See [How invalidation works](docs/how-invalidation-works.md) and
[Configuration](docs/configuration.md) for the full key, tag, and transaction
details.

## Compatibility and operational limits

| Area            | Support or limit                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Node.js 20.19+ in the 20.x line, 22.12+ in the 22.x line, or 24+                                                       |
| Prisma          | `@prisma/client` `^7.2.0` with a driver adapter                                                                        |
| Redis clients   | `redis` 5.x or 6.x, `ioredis` 5.x or 6.x, or a custom `RedisAdapter`                                                   |
| Topology        | Built-in adapters use optimized scripts on standalone/Sentinel when available; Redis Cluster uses the command fallback |
| External writes | Database writes outside the extended Prisma client are not observed and require an explicit invalidation integration   |
| Old generations | Unreachable keys remain until their configured TTL expires                                                             |
| Scope           | No stale-while-revalidate, hosted Redis service, or edge-runtime guarantee                                             |

## Benchmarks

One controlled local stress run reported the following; these are environment-
specific measurements, not universal package claims:

| Measurement                    |                       Result |
| ------------------------------ | ---------------------------: |
| Raw throughput                 |    approximately 21K ops/sec |
| Warm throughput                |               42,942 ops/sec |
| Warm speedup                   |                        2.03x |
| Warm database queries          |                            0 |
| Warm latency (p50 / p95 / p99) |        0.67 / 1.28 / 1.43 ms |
| Raw A/B drift                  |                        1.36% |
| 32-client cold-key contention  | one database query per round |

Reproduce the load and invalidation benchmarks with the setup in
[CONTRIBUTING.md](CONTRIBUTING.md):

```bash
pnpm test:benchmark:load -- --profile stress
pnpm test:benchmark:invalidation
```

The invalidation benchmark calls `FLUSHDB` on its selected Redis database.
Run it only against a disposable database with no concurrent users. See the
[benchmark harness notes](tests/load/README.md) for workload and isolation
details.

## Documentation

- [Configuration reference](docs/configuration.md)
- [How invalidation works](docs/how-invalidation-works.md)
- [Benchmark harness](tests/load/README.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local services, verification
commands, and commit conventions.

## License

[MIT](LICENSE)
