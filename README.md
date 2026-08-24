# prisma-extension-cache-tags

Opt-in Redis read-through caching for Prisma 7 with query-aware dependency
subscriptions and narrow, generational write invalidation.

## Requirements and installation

- Node.js `^20.19 || ^22.12 || >=24.0`
- Prisma 7 with `@prisma/client` `^7.2.0` and a driver adapter
- Redis plus exactly one supported client: `redis` 5/6 or `ioredis` 5/6

```bash
pnpm add prisma-extension-cache-tags redis
# or
pnpm add prisma-extension-cache-tags ioredis
```

## Quick start

The companion generator creates the schema descriptor used by the query
analyzer. Add both generators to `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

generator cacheTags {
  provider = "prisma-cache-tags-generator"
  output   = "../src/generated/cache-tags"
}

model WorkOrder {
  id             String      @id @default(uuid())
  organizationId String
  equipment      Equipment[]
}

model Equipment {
  id             String      @id @default(uuid())
  organizationId String
  workOrders     WorkOrder[]
}
```

Run `pnpm prisma generate` after adding or changing schema models. The generated
module exports `cacheSchema`; it contains relation, scalar, primary-key, and
unique-key metadata and no credentials or runtime client state.

Declare every cacheable model's scope. Related models that share a tenant
dimension use the same namespace; global models use `tenant: false`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from 'redis';
import { createCacheTagsExtension, invalidateScope } from 'prisma-extension-cache-tags';
import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
import { cacheSchema } from './generated/cache-tags';
import { PrismaClient } from './generated/prisma/client';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const redisAdapter = createNodeRedisAdapter(redis);
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
}).$extends(
    createCacheTagsExtension(redisAdapter, {
        schema: cacheSchema,
        models: {
            WorkOrder: {
                tenant: { field: 'organizationId', namespace: 'organization' },
            },
            Equipment: {
                tenant: { field: 'organizationId', namespace: 'organization' },
            },
        },
    }),
);

const workOrders = await prisma.workOrder.findMany({
    where: { organizationId: 'org_1' },
    include: { equipment: true },
    cache: { ttlSeconds: 60 },
});

await prisma.equipment.upsert({
    where: { id: 'equipment_123' },
    create: { id: 'equipment_123', organizationId: 'org_1' },
    update: {},
});

// Explicitly flush one complete tenant scope when required.
await invalidateScope({ namespace: 'organization', id: 'org_1' }, redisAdapter, {
    schema: cacheSchema,
    models: {
        WorkOrder: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
        Equipment: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
    },
});
```

The `WorkOrder` read automatically subscribes to WorkOrder and Equipment
because Equipment is selected. Relation filters, ordering, counts, and nested
relation arguments are inferred too. The successful Equipment write publishes
only the affected organization/model (and proven entity) tags, so unrelated
models and organizations remain cache hits.

## Explicit application dependencies

Prisma cannot infer a relation represented only by a scalar ID, computed field,
or external service. Add a typed `readDependencies` resolver to that model:

```ts
const models = {
    WorkOrder: {
        tenant: { field: 'organizationId', namespace: 'organization' },
        readDependencies: ({ schema }) => [{ model: 'Equipment', scope: { namespace: 'organization', id: 'org_1' } }],
    },
    Equipment: { tenant: { field: 'organizationId', namespace: 'organization' } },
} as const;
```

Resolvers receive `{ model, operation, args, scopes, schema }` and return
`{ model, scope }` dependencies or explicit `{ tag }` values. Inferred
dependencies are merged by default. Setting `mergeTags: false` replaces them;
the caller then owns complete invalidation correctness.

## Reads, writes, and transactions

Caching is opt-in on `findUnique`, `findFirst`, `findMany`, `count`, `aggregate`,
and `groupBy`. A read creates subscriptions to the primary/dependency models,
the resolved tenant root, and global model fallbacks. A successful write
publishes only models it can prove changed. Normal writes do not publish roots
or global fallbacks; ambiguous tenant evidence instead publishes the affected
global fallback and warns. Nested writes use the same evidence rule.

Writes inside either Prisma `$transaction` form defer publication until commit;
rollback publishes nothing. `withCacheInvalidation` is an optional wrapper for
code that cannot use the intercepted transaction callback.

## Safe bypasses and operations

Reads bypass caching rather than guessing when a model is unconfigured, a
relation is unsupported/unknown, tenant scope is missing, a relation crosses
namespaces without proof, or the complete tag set exceeds `maxTagsPerQuery`.
Writes are never skipped. The default key prefix is `prismaCacheTags:v3`;
older-version entries are ignored and expire naturally.

Generational invalidation is O(published tags), with no Redis key scan or
tag-to-key index. See [How invalidation works](docs/how-invalidation-works.md)
for the invariants and [Configuration](docs/configuration.md) for all options.

## Benchmarks

The dependency-aware benchmark reports generations made unreachable, cache hit
rate, database refills, Redis tag-version operations, and refill contention:

```bash
pnpm test:benchmark:dependencies
```

The deterministic synthetic workload (100 tenants, 20 models per tenant, 50
queries per model) measured 5,950 legacy affected entries versus 150
query-aware entries per write, a **39.67x fanout reduction**. Treat this as a
comparative harness result, not a universal throughput claim.

Other load benchmarks and disposable-service setup are documented in
[tests/load/README.md](tests/load/README.md).

## Documentation

- [Configuration reference](docs/configuration.md)
- [How invalidation works](docs/how-invalidation-works.md)
- [v3 migration guide](docs/migration-v3.md)
- [Benchmark harness](tests/load/README.md)

## License

[MIT](LICENSE)
