# How invalidation works

This package uses generations instead of a reverse index from tags to Redis
keys. A cache read selects the current generation, while a write advances the
generation. No cache-key scan is needed.

## Generational cache keys

For a read without `cache.key`, the generated cache key is conceptually the
hash of:

```text
{ model, operation, args, schemaVersion, tags, tagVersions }
```

The extension normalizes the tags and reads their current versions before
hashing the query identity. `tagVersions` come from an `MGET` of
`<prefix>:tagver:<tag>` counters on every read. With no tags, the version list
is empty and there are no counter keys to request.

When `cache.key` is supplied, the extension uses the custom-key form
`<prefix>:custom:<hash({ key, model, operation, args, schemaVersion,
tagVersions })>` instead. `args` are the cleaned Prisma arguments with the
extension-only `cache` property removed. The caller-provided key participates
in identity without replacing the query identity, so reusing a custom key for
different models, operations, or arguments cannot make those queries share an
entry.

For a read of `Widget.findMany`, the generated Redis key is shaped like
`<prefix>:qry:Widget:findMany:<hash>`. The hash also includes the Prisma
arguments with the extension-only `cache` property removed, so changing a
filter, projection, pagination, or generation produces a different key.

## Tag resolution and granularity

With the default `tenantPrecision: false`, every inferred read and write emits
the unscoped `global:model:<Model>` tag. When a tenant is resolved, tenant,
tenant-model, and tenant-entity tags are added as well; resolved entity ids
also receive global entity tags. The global model tag is the correctness
backstop, so a tenant-less read and a tenant-ful write (or the reverse) still
share a generation. This is model-level invalidation and can evict other
tenants' entries.

`tenantPrecision: true` is an opt-in for applications that guarantee every
cached read and every write includes one of `tenantKeys`. A tenant-resolved read
uses tenant tags only. A tenant-resolved write uses tenant tags plus the
unscoped model tag so tenant-less reads are still invalidated. A write without a
resolved tenant falls back to unscoped global tags and logs a warning; callers
must maintain the invariant for tenant-precise reads to remain sound. When tag
lists are capped, an emitted unscoped model tag is retained before other tags
are truncated.

## What a write does

After a write succeeds, the extension resolves the same inferred and explicit
tags and increments each unique tag counter. Invalidation cost is therefore
independent of how many keys are cached: it is one `INCR` per affected tag, not
one delete per matching key. The tag-resolution mode described above determines
which generations the write advances; the invalidation mechanism itself never
enumerates cache keys. `maxTagsPerQuery` limits only the tags folded into a
cached read key; writes advance every resolved tag.

There is no tag-to-key index to maintain or garbage-collect. Incrementing a
counter makes every older generation unreachable immediately. Those orphaned
keys still occupy memory until their own TTL expires; that is the deliberate
trade-off that keeps invalidation scan-free and independent of the cached-key
count. Tag-version keys also receive an expiry of at least the configured
maximum cache TTL (normally ten times that TTL, with a 3600-second minimum), so
a version cannot disappear while an entry from that generation is still
retained.

## Cache identity and stored values

Each cached value is stored in a serialized envelope containing only the
SuperJSON value. Stage 1 does not store or verify a second fingerprint; the
generated or custom Redis key is the query identity. Both key forms include the
model, operation, cleaned arguments, `schemaVersion`, and normalized tag
generations. `schemaVersion` is therefore the explicit way to retire all
generations after a breaking cached-shape change.

## Transactions

Interactive transactions use the extended client's normal `$transaction`
method; no extra wrapper is required:

```ts
await prisma.$transaction(async (tx) => {
    await tx.widget.update({
        where: { id: 'widget_1' },
        data: { name: 'renamed in transaction' },
    });
});
```

The extension intercepts both callback and array forms of `$transaction` and
places invalidation tags in an `AsyncLocalStorage` context. Writes inside the
transaction add tags to that context instead of incrementing Redis
immediately. After the transaction commits, the unique tags are flushed once.
If the callback or batch rejects and Prisma rolls back, the flush does not run,
so the previous cache generation remains valid.

`withCacheInvalidation(fn, redisAdapter, config?)` is the public wrapper for a
code path that cannot use the extended client's intercepted transaction
callback. It is an optional fallback, not part of the normal setup. Use the
same cache configuration for the wrapper and the extended client:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from 'redis';
import { createCacheTagsExtension, withCacheInvalidation } from 'prisma-extension-cache-tags';
import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
import { PrismaClient } from './generated/prisma/client';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const redisAdapter = createNodeRedisAdapter(redis);
const config = { tenantKeys: ['tenantId'] };
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter }).$extends(createCacheTagsExtension(redisAdapter, config));

await withCacheInvalidation(
    async () => {
        await prisma.widget.update({
            where: { id: 'widget_1' },
            data: { name: 'renamed' },
        });
    },
    redisAdapter,
    config,
);
```

The wrapper buffers tags published by the extension until its callback
resolves. It does not replace Prisma's transaction semantics: database commit
or rollback still comes from the Prisma operation being wrapped.
