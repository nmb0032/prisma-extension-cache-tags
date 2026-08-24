# Migrating to v3

v3 replaces broad symmetric inference with query-aware read subscriptions and
narrow write publications. It is a breaking release. Configure the generated
descriptor and explicit scope for every cacheable model before enabling caching.

## Configuration changes

| v2                   | v3                                               |
| -------------------- | ------------------------------------------------ |
| `tenantKeys`         | per-model `{ tenant: { field, namespace } }`     |
| `tenantPrecision`    | removed; narrow publication is the default       |
| `entityKeys`         | generated primary/unique metadata                |
| `dependencyTags`     | inferred read dependencies or `readDependencies` |
| `inferTags: false`   | `mergeTags: false` with caller-owned correctness |
| `prismaCacheTags:v2` | `prismaCacheTags:v3`                             |

Add the companion generator and regenerate after schema changes:

```prisma
generator cacheTags {
  provider = "prisma-cache-tags-generator"
  output   = "./generated/cache-tags"
}
```

```bash
pnpm prisma generate
```

Import the generated `cacheSchema` and declare model scopes:

```ts
import { cacheSchema } from './generated/cache-tags';

const config = {
    schema: cacheSchema,
    models: {
        WorkOrder: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
        Equipment: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
    },
};
```

`namespace` is the logical tenant dimension shared by related models. A model
with `tenant: false` uses global tags. Relations that cross namespaces need
independent scope evidence or they bypass caching safely.

## Dependency migration

Relations selected or filtered by a read are inferred automatically. Remove
write-oriented dependency maps and rely on the relation metadata generated from
Prisma. For scalar/application-level relations, use a typed resolver:

```ts
const models = {
    WorkOrder: {
        tenant: { field: 'organizationId', namespace: 'organization' },
        readDependencies: () => [{ tag: 'external-equipment' }],
    },
};
```

Resolvers return model dependencies with an optional scope or explicit tags.
They merge with inferred dependencies by default. `mergeTags: false` replaces
the inferred set; the caller owns correctness and must provide every required
dependency, tenant root/fallback, and application tag.
For an external or application dependency represented by an explicit tag,
publish that same tag on the corresponding writes or application events.

## Behavioral changes

Reads subscribe to their primary model, inferred relation models, the resolved
tenant root, and global model fallbacks. Writes publish only models and proven
entities changed by the successful operation. Normal writes do not publish roots
or global fallbacks. Ambiguous primary or nested writes publish the global model
fallback and warn instead of risking stale tenant reads.

`invalidateScope({ namespace, id }, redisAdapter, config)` is now the explicit
tenant-wide operation. Cross-namespace reads, unsupported query shapes, missing
tenant evidence, and reads over `maxTagsPerQuery` bypass caching instead of
receiving incomplete tags. Writes remain uncapped and are never skipped.

Publications inside Prisma callback or batch transactions flush once after
commit; rollback publishes nothing. `withCacheInvalidation` remains an
optional wrapper only for code that cannot use the intercepted transaction
callback.

## Cache contents and rollout

The default key prefix is `prismaCacheTags:v3`. Existing v2 keys are ignored;
they expire naturally according to their TTL and are not migrated or looked up
alongside v3 entries. Expect a cold-cache period after deployment.
