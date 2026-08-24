# Query-Aware Tagging Design

## Summary

Replace broad, symmetric tag inference with dependency-aware cache subscriptions and narrow write publications. Cached reads subscribe to their primary Prisma model and every related model referenced by the query. Successful writes publish only the models they can prove changed within a resolved tenant scope.

The change removes ordinary tenant-wide and cross-tenant invalidation while preserving correctness through explicit tenant-root subscriptions, global model fallback subscriptions, and safe cache bypasses for query shapes the analyzer cannot classify.

This is a breaking release. The default Redis namespace changes to `prismaCacheTags:v3`.

## Goals

- Infer read dependencies from Prisma query structure without requiring users to enumerate schema relations.
- Keep normal invalidation inside the affected tenant and affected model dependencies.
- Ensure a write to a related model invalidates cached queries that selected, filtered, ordered, or counted that relation.
- Reserve tenant-wide invalidation for an explicit API.
- Preserve a correctness-safe fallback when a successful write cannot resolve its tenant.
- Avoid Prisma private runtime APIs.
- Keep invalidation scan-free and proportional to the number of published tags.
- Provide explicit escape hatches for application dependencies that Prisma cannot represent.

## Non-goals

- Maintaining a reverse index from tags to cache keys.
- Inferring dependencies from arbitrary scalar references such as `equipmentIds`.
- Entity-only invalidation in the first release. Model tags remain the correctness boundary for writes that can alter query membership.
- Caching raw SQL or query shapes whose model dependencies cannot be classified.
- Preserving the existing `tenantKeys`, `tenantPrecision`, `entityKeys`, or write-oriented `dependencyTags` configuration unchanged.

## Companion Prisma Generator

The package provides a companion Prisma generator:

```prisma
generator cacheTags {
  provider = "prisma-cache-tags-generator"
  output   = "./generated/cache-tags"
}
```

The package exposes `prisma-cache-tags-generator` as its generator executable.
The generator receives Prisma schema metadata during `prisma generate` and writes a TypeScript descriptor. The descriptor contains only the static information needed by the analyzer:

- descriptor format version;
- model names;
- scalar and relation field names;
- relation target models;
- relation cardinality;
- primary and unique key metadata;
- mapped names when needed for diagnostics.

It does not contain datasource credentials or runtime client state.

The generated module exports a literal descriptor compatible with the package runtime:

```ts
import { cacheSchema } from './generated/cache-tags';

createCacheTagsExtension(redisAdapter, {
    schema: cacheSchema,
    models: {
        WorkOrder: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
        Equipment: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
        AuditEvent: {
            tenant: false,
        },
    },
});
```

The runtime must not inspect `_runtimeDataModel`, import generated Prisma internal files, or depend on another undocumented Prisma API. An unsupported descriptor format or malformed descriptor fails extension initialization with a specific configuration error.

## Model Scope Configuration

Every cacheable model must be declared as tenant-scoped or global.

A tenant-scoped declaration contains:

- `field`: the scalar field carrying the tenant identity for that model;
- `namespace`: the logical tenant type shared across related models.

The namespace allows related models to use different field names while sharing one invalidation scope. It also prevents identical raw values from different tenant dimensions from aliasing.

Assigning the same namespace to related models is an explicit application invariant: related rows in that namespace must carry the same tenant identity. The analyzer may inherit the primary query's resolved scope across those relations. Relations assigned different namespaces require an independently provable scope or a custom resolver; otherwise the read bypasses caching.

The configured tenant field must exist as a scalar field in the generated descriptor. Invalid model names, relation names, or tenant fields fail initialization.

A read of an unconfigured model bypasses caching with reason `model-scope-unconfigured`. A successful write to an unconfigured model uses the global model fallback and emits a warning.

## Tag Grammar

All dynamic tag components use one collision-safe encoder. Raw values are never concatenated ambiguously.

Tenant-scoped tags:

```text
scope:<namespace>:<tenantId>:root
scope:<namespace>:<tenantId>:model:<Model>
scope:<namespace>:<tenantId>:entity:<Model>:<entityIdentity>
```

Global fallback tags:

```text
global:model:<Model>
```

Global models use:

```text
global:model:<Model>
global:entity:<Model>:<entityIdentity>
```

The tenant-root tag is a read subscription and an explicit administrative invalidation target. Normal writes never publish it.

Entity tags are additive in the first release. A cached relation dependency does not replace its tenant-model subscription with only an entity tag because a bulk or membership-changing write may not expose every affected entity identity.

## Read Dependency Analysis

The analyzer receives:

- generated schema descriptor;
- primary model;
- Prisma operation;
- cleaned query arguments;
- normalized model-scope configuration.

It returns:

- resolved tenant scope;
- primary and dependency models;
- optional entity identities;
- normalized tags;
- cacheability and a bounded bypass reason.

The primary tenant identity is resolved schema-aware from the configured tenant field at the primary model's argument level. The analyzer does not collect matching property names blindly from unrelated nested models. It may inherit that identity across a relation only when both models declare the same namespace.

For a cached read, the analyzer always includes the primary model. It recursively follows relation fields referenced by:

- `select`;
- `include`;
- relation filters in `where` and `having`, including `is`, `isNot`, `some`, `every`, and `none`;
- relation-aware `orderBy`;
- `_count` relation selections and filters;
- nested relation arguments under any of the preceding constructs.

Each discovered relation target becomes a dependency model. Traversal continues through nested relation selections and predicates. Tags are deduplicated, and cycles terminate naturally because traversal follows the finite argument tree rather than recursively expanding the entire schema graph.

Scalar foreign keys and scalar arrays do not create dependencies by themselves. Applications can add those semantics through explicit tags or a custom read dependency resolver.

For a tenant-scoped WorkOrder query that includes Equipment, the read subscribes to:

```text
scope:organization:org_1:root
scope:organization:org_1:model:WorkOrder
global:model:WorkOrder
scope:organization:org_1:model:Equipment
global:model:Equipment
```

The tenant-root subscription enables an explicit full-tenant flush. Global model subscriptions make tenant-unresolved writes correctness-safe. Neither broad tag is published during a normal tenant-resolved write.

If a dependency belongs to a different tenant namespace and its scope cannot be proven from the query, the read bypasses caching. The analyzer must not assume that the primary model's tenant ID applies across unrelated namespaces.

## Write Publication Analysis

Write analysis runs only after the database operation succeeds. It uses the write arguments and returned result as evidence.

A tenant-resolved write publishes:

- the changed model's tenant-model tag;
- entity tags for identities that can be resolved;
- tags for each nested model that can be proven changed;
- explicit caller-provided tags.

For example, upserting Equipment `123` in organization `org_1` publishes:

```text
scope:organization:org_1:model:Equipment
scope:organization:org_1:entity:Equipment:123
```

It does not publish the organization root or `global:model:Equipment`.

The model tag is always published for creates, upserts, deletes, updates, and bulk writes because any of them can change list membership, aggregates, relation predicates, or ordering. Entity tags supplement model tags; they do not replace them in the first release.

Nested writes are analyzed through generated relation metadata. A nested changed model uses a tenant-scoped publication only when its tenant identity is explicit in the nested arguments or successful result. Sharing a namespace with the parent is not by itself sufficient proof. If the nested tenant cannot be resolved, the analyzer publishes that nested model's global fallback and warns.

If the primary write's tenant cannot be resolved, it publishes `global:model:<Model>` and warns. Because all tenant-scoped reads of that model subscribe to this fallback, the ambiguous write invalidates the model across tenants rather than risking stale data. This broad path is exceptional; normal tenant-resolved writes remain narrow.

## Example Invalidation Flow

Given:

```ts
await prisma.workOrder.findMany({
    where: { organizationId: 'org_1' },
    include: { equipment: true },
    cache: { ttlSeconds: 60 },
});
```

the cached result subscribes to WorkOrder and Equipment within `org_1`, plus their global fallbacks and the organization root.

Then:

```ts
await prisma.equipment.upsert({
    where: { id: '123' },
    create: { id: '123', organizationId: 'org_1', name: 'Pump' },
    update: { name: 'Pump' },
});
```

publishes the tenant-scoped Equipment model and entity tags. The cached WorkOrder query misses on its next read because its Equipment model generation changed. Cached models in `org_1` that do not depend on Equipment remain reachable. Equipment and dependent queries in other organizations remain reachable.

## Explicit Dependencies and Overrides

Automatic analysis covers Prisma-visible relations. The public API retains explicit read and write tags and adds a typed custom read dependency resolver for:

- scalar IDs with application-level relation semantics;
- computed fields;
- externally sourced data;
- cross-model dependencies not represented by Prisma;
- application-specific invalidation scopes.

Custom dependencies merge with inferred dependencies by default. Replacing inferred dependencies remains an advanced option whose correctness is owned by the caller.

The resolver receives the model, operation, arguments, resolved scope, and generated schema descriptor. It returns model dependencies or explicit tags, not Redis keys.

## Explicit Scope Invalidation

The package adds:

```ts
await invalidateScope({ namespace: 'organization', id: 'org_1' }, redisAdapter, config);
```

This operation bumps only:

```text
scope:organization:org_1:root
```

Every tenant-scoped cached read subscribes to the root tag, so this intentionally invalidates the entire tenant without requiring ordinary writes to publish the broad tag.

## Safe Bypass Rules

The analyzer bypasses caching rather than guessing when:

- the primary model has no scope configuration;
- a referenced field is absent from the descriptor;
- a relation construct is unsupported;
- tenant scope is missing from a tenant-scoped read;
- a dependency crosses namespaces without a provable scope;
- the complete correctness-bearing tag set exceeds `maxTagsPerQuery`;
- descriptor and runtime configuration are incompatible.

Bypasses execute Prisma normally and emit a warning plus a cache metric with a stable reason code. Logs must not include complete query arguments or tenant IDs by default.

Writes are never skipped because analysis is ambiguous. They publish the appropriate global model fallback after success and warn.

## Cache Identity and Versioning

Resolved dependency tags and tenant scope remain part of canonical cache identity. The default key prefix changes to:

```text
prismaCacheTags:v3
```

Version 2 entries are ignored and expire by TTL. There is no migration or mixed-version lookup.

The generated descriptor format version is separate from the user-controlled cache `schemaVersion`. A descriptor format mismatch fails initialization; `schemaVersion` continues to represent application-level cached shape changes.

## Transactions

The existing transaction invalidation context remains in place. Writes inside callback and batch transactions accumulate normalized publication tags. Unique tags are bumped only after commit. Rollbacks publish nothing.

Nested and global fallback tags follow the same deferred behavior. Explicit scope invalidation invoked inside an active invalidation context joins the pending tag set.

## Observability

Add bounded cache bypass reasons:

- `model-scope-unconfigured`;
- `tenant-scope-missing`;
- `query-shape-unsupported`;
- `relation-field-unknown`;
- `cross-namespace-scope-unknown`;
- `dependency-tag-limit`.

Debug logging may report model, operation, dependency model names, dependency count, and tag count. It must not report full arguments, tenant IDs, or returned rows.

Metrics may add dependency count and analyzer outcome using bounded values. Tag strings and tenant identities must not become metric dimensions.

## Performance

Descriptor lookup is indexed by model and field. Query analysis is linear in the traversed argument tree and performs no database, Redis, filesystem, or Prisma metadata lookup.

Reads continue to fetch tag versions in one multi-get or optimized Lua primitive. Writes continue to bump unique tag versions in one optimized primitive or command fallback. The number of cached keys remains irrelevant to invalidation cost.

`maxTagsPerQuery` applies to the complete read subscription. Correctness-bearing tags are never truncated. An over-limit read bypasses caching. Write publications remain uncapped.

The existing load benchmark gains a dependency-aware scenario comparing:

- generations made unreachable per write;
- cache hit rate after writes;
- database refills after writes;
- Redis tag-version operations;
- latency under refill contention.

The benchmark includes unrelated tenants, unrelated models in the same tenant, direct model reads, and relation-dependent reads.

## Testing

### Generator tests

Fixture schemas cover:

- one-to-one, one-to-many, and many-to-many relations;
- optional and required relations;
- self-relations;
- mapped model and field names;
- single and composite primary keys;
- single and composite unique constraints.

Generated output is deterministic and type-checks against the runtime descriptor contract.

### Analyzer unit tests

Tests cover:

- primary model subscriptions;
- nested `select` and `include`;
- relation filters under logical operators;
- relation ordering and `_count`;
- repeated dependencies and cycles;
- scalar fields that resemble relations but must not create dependencies;
- tenant namespaces and cross-namespace bypasses;
- global models;
- nested writes;
- primary and nested tenant fallback;
- explicit dependency merging and replacement;
- tag deduplication and tag-limit bypasses;
- bounded logs and metrics.

### Integration tests

Integration tests prove:

- an Equipment upsert invalidates an Equipment-dependent WorkOrder cache;
- an Equipment write does not invalidate unrelated model caches in the same organization;
- an Equipment write does not invalidate another organization's caches;
- a WorkOrder write invalidates WorkOrder reads without invalidating unrelated Equipment-only reads;
- a tenant-unresolved write invalidates subscribed caches through the global fallback;
- explicit scope invalidation invalidates every subscribed read in one organization only;
- transaction commit flushes dependency tags and rollback does not;
- v2 entries are ignored under the v3 namespace.

## Migration

This behavior replaces current inference in a breaking release.

- Remove `tenantKeys` and `tenantPrecision`.
- Replace `entityKeys` with generated primary and unique identity metadata.
- Replace write-oriented `dependencyTags` with inferred read dependencies and typed custom read resolvers.
- Require the generated descriptor and explicit model scope declarations.
- Remove `inferTags`; query-aware inference is the default correctness mechanism.
- Preserve explicit `cache.tags` and `mergeTags`; documentation must state that replacing inferred tags transfers correctness responsibility to the caller.
- Change the default key prefix to `prismaCacheTags:v3`.

The migration guide includes before-and-after configuration, generator setup, explicit dependency examples, safe bypass behavior, and the distinction between read subscriptions and write publications.

## Success Criteria

- Normal tenant-resolved writes never bump tenant-root or global model tags.
- Related cached reads invalidate because they subscribe to the written model.
- Unrelated models and tenants remain cache hits after a narrow write.
- Ambiguous writes cannot leave tenant-scoped cached reads stale.
- Unsupported reads bypass caching rather than receiving incomplete tags.
- Runtime code does not access Prisma private metadata.
- Invalidation remains scan-free and O(published tags).
