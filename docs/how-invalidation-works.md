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
`<prefix>:custom:<hash({ key, schemaVersion, tagVersions })>` instead. The
custom key replaces the generated model/operation/argument identity in the
Redis key, while the cached envelope still performs its full fingerprint check
on read.

For a read of `Widget.findMany`, the generated Redis key is shaped like
`<prefix>:qry:Widget:findMany:<hash>`. The hash also includes the Prisma
arguments with the extension-only `cache` property removed, so changing a
filter, projection, pagination, or generation produces a different key.

## What a write does

After a write succeeds, the extension resolves the same inferred and explicit
tags and increments each unique tag counter. Invalidation cost is therefore
independent of how many keys are cached: it is one `INCR` per affected tag, not
one delete per matching key.

There is no tag-to-key index to maintain or garbage-collect. Incrementing a
counter makes every older generation unreachable immediately. Those orphaned
keys still occupy memory until their own TTL expires; that is the deliberate
trade-off that makes invalidation constant-time. Tag-version keys also receive
an expiry of at least the configured maximum cache TTL (normally ten times that
TTL, with a 3600-second minimum), so a version cannot disappear while an entry
from that generation is still retained.

## Fingerprint verification

Each cached value is stored in a serialized envelope with a fingerprint. On a
read, the extension recomputes the fingerprint from the model, operation,
arguments, normalized tags, and `schemaVersion`, then compares it with the
envelope before deserializing the value.

If the fingerprint differs, the entry is deleted and treated as a miss. This
means a hash collision, a stale schema, or an entry written for a different
request cannot be served as a valid result. `schemaVersion` is also part of
cache identity, so bumping it is the explicit way to retire all generations
after a breaking cached-shape change.

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
