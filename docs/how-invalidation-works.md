# How invalidation works

This package uses generations instead of a reverse index from tags to Redis
keys. A cache read selects the current generation, while a write advances the
generation. No cache-key scan is needed.

## Generational cache keys

For every read, the generated base cache key is the SHA-256 hash of one
canonical identity:

```text
{ model, operation, args, schemaVersion, tags, tenantScope, customKey? }
```

`args` are the cleaned Prisma arguments with the extension-only `cache`
property removed. The caller-provided `customKey`, when present, participates
in the same identity; it never replaces the model, operation, arguments, tags,
or tenant scope. Object properties are sorted by the canonical encoder, so
semantically equal Prisma calls share one base key regardless of insertion
order.

For a read of `Widget.findMany`, the generated Redis key is shaped like
`<prefix>:qry:Widget:findMany:<sha256>:<version-token>`. Current tag versions
come from an `MGET` of `<prefix>:tagver:<tag>` counters on every fallback read.
Missing versions are represented as zero, and the ordered values are joined
with dots (for example, `0.2.10`). With no tags, the token is empty. The
standalone optimized path performs the same ordered version reads, token
construction, and cache lookup in one Lua primitive, so its key bytes are
identical to the fallback key.

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
are truncated. In tenant-precision mode, reads whose complete tenant,
dependency, or entity tag set exceeds `maxTagsPerQuery` bypass caching instead
of dropping a correctness-bearing tag; the bypass is reported with reason
`tenant-tag-limit`.

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

When the optimized primitive is available, invalidation passes the unique
version keys to one Lua script. The script performs each `INCR` and matching
`EXPIRE` atomically, preserving the same O(tags), scan-free behavior. If the
script fails after a partial increment, the command fallback increments every
key again and applies the retention TTL; an extra generation is safe because
it cannot expose stale data.

The version retention TTL is `Math.max(maxTtlSeconds * 10, 3600)`: the tenfold
margin keeps counters available well beyond the longest cache entry, while the
one-hour floor avoids premature generation resets for short-lived caches.

## Cache identity and stored values

Each v2 cached value is stored as one flat SuperJSON string containing
`{ identity, tenantScope, value }`. The identity is the exact canonical string
hashed for the base key, and `tenantScope` is sorted and deduplicated. Every
fallback read deserializes this envelope and verifies both fields before
returning `value`. A mismatch is logged without full query arguments, deleted
when possible, measured as `result: 'bypass', path: 'fallback'`, and sent to
Prisma instead. A deletion failure does not change that safe behavior.

The default prefix is `prismaCacheTags:v2`; v1 entries are deliberately
ignored and are neither read nor migrated. The raw `RedisAdapter` methods
`getString` and `setString` exchange these serialized strings directly, so the
extension does not perform an intermediate JSON conversion.

The optimized lookup also atomically derives `<versioned-cache-key>:lock`,
checks the value twice around `SET NX PX`, and returns the raw string plus
ownership flag. A matching owner uses a second Lua primitive to verify the
token, set the envelope TTL, and delete the lock in one operation. Waiters
check immediately and then poll with bounded `2, 4, 8, ...` millisecond
backoff, capped by their configured interval and deadline.

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
