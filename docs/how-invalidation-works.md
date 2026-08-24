# How invalidation works

Cache entries use generations rather than a tag-to-key index. A read selects
the current generation for each subscription; a successful write advances only
the generations it publishes. No Redis key scan is needed.

## Read subscriptions and write publications

A cached read subscribes to:

- its primary model;
- every model referenced by `select`, `include`, relation filters, relation
  ordering, `_count`, or nested relation arguments;
- the resolved tenant root;
- the global model fallback for each tenant-scoped dependency.

For example, a tenant-scoped `WorkOrder` read including `Equipment` subscribes
to:

```text
scope:organization:org_1:root
scope:organization:org_1:model:WorkOrder
global:model:WorkOrder
scope:organization:org_1:model:Equipment
global:model:Equipment
```

After a successful write, publications contain only changed models, proven
entity identities, and explicit caller tags. A normal tenant-resolved write
does not publish the tenant root or global model fallback: roots are reserved
for `invalidateScope`, and global fallbacks are reserved for ambiguous writes.
This is why a write stays narrow while a read remains safe if an ambiguous
publication is later required.

Tenant-scoped tags use:

```text
scope:<namespace>:<tenantId>:root
scope:<namespace>:<tenantId>:model:<Model>
scope:<namespace>:<tenantId>:entity:<Model>:<entityIdentity>
```

Global fallbacks use `global:model:<Model>`. Entity tags supplement model tags;
they never replace the model publication needed for list membership, aggregates,
relation predicates, or ordering.

## Tenant evidence and bypasses

The primary tenant is resolved from the configured scalar field at the primary
argument level, and may be inherited through relations only when namespaces
match. A different namespace requires independent evidence or a resolver.
Without that proof, the read bypasses with
`cross-namespace-scope-unknown` rather than guessing.

Reads also bypass when the model is unconfigured, tenant scope is missing, a
relation is unknown/unsupported, or the complete correctness-bearing
subscription list exceeds `maxTagsPerQuery` (`dependency-tag-limit`). Tags are
never truncated to make an unsafe cache entry. Writes are never skipped: an
unresolved primary or nested tenant publishes `global:model:<Model>` and logs a
bounded warning.

## Generational keys and values

The base key hashes one canonical identity:

```text
{ model, operation, args, schemaVersion, tags, tenantScope, customKey? }
```

The extension-only `cache` property is removed before canonicalization. Object
properties are sorted and Prisma-relevant values such as `Date`, `Decimal`, and
`BigInt` retain their types. Current tag counters are read in one multi-get (or
optimized Lua primitive) and appended to the base key as an ordered version
token.

The default namespace is `prismaCacheTags:v3`. Earlier-version entries are
ignored and expire by their own TTL; there is no mixed-version lookup or
migration. Stored envelopes retain the canonical identity and sorted scope,
which are verified before returning a candidate hit.

## Explicit scope invalidation

```ts
await invalidateScope({ namespace: 'organization', id: 'org_1' }, redisAdapter, config);
```

This advances only `scope:organization:org_1:root`, intentionally invalidating
every tenant read subscribed to that root. It is the explicit tenant-wide
operation; ordinary writes do not bump the root.

## Nested writes

Nested writes are analyzed using generated relation metadata. A nested model
gets a tenant-scoped publication only when its tenant is explicit in nested
arguments or in the successful result. Sharing a namespace with the parent is
not proof by itself. If nested evidence is absent, its global model fallback is
published, preserving correctness across all subscribed tenants.

## Transactions

Writes in callback and batch `$transaction` forms accumulate unique publication
tags in an invalidation context. Tags are flushed once after commit; rollback
publishes nothing. Nested publications and global fallbacks follow the same
deferral rule. `invalidateScope` called within the active context joins the
pending set.

`withCacheInvalidation` is an optional wrapper for code that cannot use the
extended client's intercepted transaction callback. It buffers publications
until its callback resolves but does not replace Prisma's database commit or
rollback semantics.

## Complexity and observability

Invalidation cost is O(published tags), independent of the number of cached
keys. Old generations become unreachable immediately and expire later, while
tag-version counters are retained beyond the longest cache TTL.

Metrics report bounded model, operation, result, path, dependency count, and
bypass reason. Logs omit complete query arguments, tenant IDs, returned rows,
and tag strings by default.
