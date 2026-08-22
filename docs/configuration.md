# Configuration

`createCacheTagsExtension(redisAdapter, config?)` accepts a `CacheTagsConfig`.
The extension uses the defaults below when a field is omitted.

## `CacheTagsConfig`

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enables or disables the extension globally. When disabled, the extension strips `cache` from arguments and runs the Prisma operation normally. |
| `defaultTtlSeconds` | `number` | `30` | TTL used by a cached read when `cache.ttlSeconds` is omitted. |
| `maxTtlSeconds` | `number` | `300` | Upper bound applied to every requested read TTL; tag-version counters are retained for at least this long (normally 10x, with a 3600-second minimum). |
| `keyPrefix` | `string` | `'prismaCacheTags:v1'` | Prefix for query keys, tag-version keys, and stampede-lock keys. |
| `cacheNull` | `boolean` | `true` | Allows `null` read results to be cached. |
| `cacheEmpty` | `boolean` | `true` | Allows empty-array read results to be cached. |
| `schemaVersion` | `number` | `1` | Adds a schema generation to cache identity. Bump it after a breaking change to cached shapes to invalidate every cache entry at once. |
| `maxTagsPerQuery` | `number` | `30` | Maximum number of normalized tags retained in a cached read key. Writes always invalidate every resolved tag. |
| `stampede` | `CacheStampedeOptions` | `{ waitMs: 1500, pollMs: 50, lockTtlMs: 5000 }` | Default distributed single-flight settings for cache misses. |
| `dependencyTags` | `Record<string, string[] \| CacheDependencyResolver>` | `{}` | Adds model or custom tags to a write so related model reads are invalidated too. |
| `inferTags` | `boolean` | `true` | Enables automatic tenant, model, and entity tag inference. |
| `tenantKeys` | `string[]` | `[]` | Prisma argument property names that identify tenants. With no tenant keys, inferred tags use the `global:` namespace. |
| `tenantPrecision` | `boolean` | `false` | Opts into tenant-precise reads when every cached read and write is guaranteed to include one of `tenantKeys`; otherwise the safe model-level default is recommended. |
| `entityKeys` | `string[]` | `['id']` | Prisma argument property names that identify individual records. |
| `logger` | `Logger` | No-op logger | Receives structured debug, warning, and error events emitted by the extension. The `info` method is part of the interface but is not currently emitted by core operations. |
| `metrics` | `Metrics` | No-op metrics sink | Receives cache hit and miss events through `onCacheEvent`. |

### Tenant keys

List every argument property that can scope a query to a tenant. The names are
searched through Prisma `where` and write arguments, including nested relation
filters.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
    tenantKeys: ['organizationId', 'accountId'],
};
```

For writes, tenant values are inferred from the Prisma arguments and, when
available, the successful returned record. This means an update or delete such
as `where: { id: 'widget_1' }` can still invalidate the affected tenant when
the returned row includes `organizationId`.

With the default `tenantPrecision: false`, every inferred read and write emits
the unscoped `global:model:<Model>` tag. Tenant and entity tags are added when
their values are available, but invalidation granularity remains model-level so
ambiguous arguments cannot leave a cached read stale. The global model tag is
retained when `maxTagsPerQuery` truncates the read tag list.

Set `tenantPrecision: true` only when every cached read and every write includes
one of `tenantKeys` in its arguments. Tenant-resolved reads then use tenant tags
without the unscoped model tag. Tenant-resolved writes include both tenant tags
and the unscoped model tag so tenant-less reads are invalidated. If a write
cannot resolve a tenant, it uses the global fallback and logs a warning; this
mode is not a substitute for the required invariant. When `inferTags: false` or
`mergeTags: false` is used, the caller is responsible for supplying the
complete invalidation scope explicitly.

### Entity keys

The default `['id']` adds record-level tags when an `id` is present. Add other
unique identifiers when your application reads or writes records by them.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
    entityKeys: ['id', 'slug'],
};
```

### Dependency tags

An array maps a written model to related models whose model tags should also be
invalidated. A resolver can return application-specific tags when the
relationship needs more context.

```ts
import type { CacheDependencyResolver, CacheTagsConfig } from 'prisma-extension-cache-tags';

const billingDependencyTags: CacheDependencyResolver = ({ tenantIds }) =>
    tenantIds.map((tenantId) => `tenant:${tenantId}:billing`);

const config: CacheTagsConfig = {
    tenantKeys: ['organizationId'],
    dependencyTags: {
        Widget: ['Part'],
        Invoice: billingDependencyTags,
    },
};
```

### Stampede protection

On a miss, the first caller can acquire a Redis lock and populate the cache.
Other callers poll for the value until `waitMs`; `lockTtlMs` should exceed the
expected database query duration.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
    stampede: {
        waitMs: 2_000,
        pollMs: 100,
        lockTtlMs: 10_000,
    },
};
```

### Schema version

`schemaVersion` is part of both generated and custom cache keys. Bump it to
invalidate every cache entry at once after a breaking change to cached shapes.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
    schemaVersion: 2,
};
```

### Logger

The logger receives `(data, message)` for each event emitted by the extension.
Core operations currently emit debug, warning, and error events; `info` is
available on the interface for integrations but is not emitted by core
operations. The default is a no-op, so logging is opt-in.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
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
};
```

### Metrics

The metrics sink receives `{ model, operation, result }`, where `result` is
`'hit'` or `'miss'`. The default is a no-op.

```ts
import type { CacheTagsConfig } from 'prisma-extension-cache-tags';

const config: CacheTagsConfig = {
    metrics: {
        onCacheEvent(event) {
            console.log(`${event.model}.${event.operation}: ${event.result}`);
        },
    },
};
```

## `CacheStampedeOptions`

These fields can be set globally in `CacheTagsConfig.stampede` or overridden
for one read with `CacheReadOptions.stampede`.

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `waitMs` | `number` | `1500` | Maximum time a lock waiter polls for the owner to populate the cache. |
| `pollMs` | `number` | `50` | Delay between waiter polls. |
| `lockTtlMs` | `number` | `5000` | Redis lock lifetime; set it longer than the expected database query duration. |

## `CacheReadOptions`

Caching is opt-in: add a `cache` object to a supported read operation
(`findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, or `groupBy`).

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `ttlSeconds` | `number` | `config.defaultTtlSeconds` | Requested cache TTL, clamped to `config.maxTtlSeconds` and never below one second (including for zero or negative requests). |
| `key` | `string` | Generated key | Adds a caller-provided component to cache identity. Model, operation, cleaned arguments, schema, and tag generations still participate, so distinct queries cannot alias through a shared custom key. |
| `enabled` | `boolean` | `true` when `cache` is present | Set to `false` to bypass the cache for one read. |
| `debug` | `boolean` | `false` | Emits debug hit, miss, and population messages through `logger`. |
| `tags` | `string[]` | `[]` | Adds explicit invalidation tags. |
| `inferTags` | `boolean` | `config.inferTags` (`true`) | Enables or disables inferred tenant, model, and entity tags for this read. |
| `mergeTags` | `boolean` | `true` | When `true`, merges explicit tags with inferred tags; when `false`, explicit tags replace inferred tags. |
| `stampede` | `CacheStampedeOptions` | `config.stampede` | Overrides lock wait, poll, and lock-TTL settings for this read. |

```ts
import type { CacheReadOptions } from 'prisma-extension-cache-tags';

const readOptions: CacheReadOptions = {
    ttlSeconds: 60,
    key: 'widget-list',
    tags: ['dashboard:org_123'],
    debug: true,
    inferTags: true,
    mergeTags: true,
    stampede: {
        waitMs: 2_000,
    },
};
```

Use the options on a Prisma read:

```ts
const widgets = await prisma.widget.findMany({
    where: { organizationId: 'org_123' },
    cache: readOptions,
});
```

## `CacheWriteOptions`

Writes always run first. After a successful write, the extension invalidates
the inferred and explicit tags. The `cache` object controls invalidation; it
does not cache the write result.

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `tags` | `string[]` | `[]` | Adds explicit tags to the tags inferred from the write arguments. |
| `debug` | `boolean` | `false` | Emits a debug message after publishing invalidation tags. |
| `inferTags` | `boolean` | `config.inferTags` (`true`) | Enables or disables inferred tenant, model, and entity tags for this write. |
| `mergeTags` | `boolean` | `true` | When `true`, merges explicit tags with inferred tags; when `false`, explicit tags replace inferred tags. |

```ts
import type { CacheWriteOptions } from 'prisma-extension-cache-tags';

const writeOptions: CacheWriteOptions = {
    tags: ['dashboard:org_123'],
    debug: true,
    inferTags: true,
    mergeTags: true,
};
```

```ts
await prisma.widget.update({
    where: { id: 'widget_1' },
    data: { name: 'renamed' },
    cache: writeOptions,
});
```
