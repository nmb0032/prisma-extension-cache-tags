# Query-Aware Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace broad symmetric cache invalidation with generated-schema, query-aware read subscriptions and narrow tenant-scoped write publications.

**Architecture:** A companion Prisma generator emits a static relation descriptor. Pure read and write analyzers combine that descriptor with per-model scope configuration to produce version tags; the Prisma extension consumes those results without accessing private Prisma metadata. Reads subscribe to primary, dependency, tenant-root, and global fallback tags, while normal writes publish only tenant-model and entity tags.

**Tech Stack:** TypeScript 5.6, Prisma 7 custom generator protocol, `@prisma/generator-helper`, Prisma Client extensions, Vitest 4, Redis generational tag counters, tsup.

**Spec:** `docs/superpowers/specs/2026-08-23-query-aware-tagging-design.md`

## Global Constraints

- This is a breaking release; the default Redis namespace is exactly `prismaCacheTags:v3`.
- Runtime code must not access Prisma `_runtimeDataModel`, generated Prisma internal files, or another undocumented Prisma API.
- Every cacheable model is explicitly tenant-scoped or global; missing model configuration causes a safe read bypass.
- Models sharing a tenant namespace assert that related rows preserve the same tenant identity.
- Normal tenant-resolved writes never publish tenant-root or global model tags.
- Tenant-unresolved successful writes publish a global model fallback and warn.
- Unsupported or ambiguous reads bypass caching; correctness-bearing tags are never truncated.
- Invalidation remains scan-free and O(published tags).
- Dynamic tag components use one collision-safe encoder.
- Logs and metrics must not expose full query arguments, returned rows, tag strings, or tenant IDs.
- Do not add Copilot attribution trailers or tags to commits.

## File Structure

### New runtime units

- `src/schema.ts` — generated descriptor contract, model-scope configuration, validation, and indexed analysis context.
- `src/tag-format.ts` — collision-safe v3 tag builders and normalization.
- `src/scope-resolution.ts` — schema-aware tenant and entity extraction shared by read and write analysis.
- `src/read-analysis.ts` — schema-aware tenant resolution and relation dependency traversal for reads.
- `src/write-analysis.ts` — primary/nested write publication analysis and global fallback selection.
- `src/scope-invalidation.ts` — explicit tenant-root invalidation API.

### New generator units

- `src/generator/index.ts` — Prisma generator protocol entrypoint.
- `src/generator/descriptor.ts` — DMMF-to-descriptor conversion.
- `src/generator/render.ts` — deterministic generated TypeScript rendering.

### Existing runtime integration

- `src/types.ts` — v3 public configuration, resolver, metrics, envelope, and analysis types.
- `src/config.ts` — v3 defaults and validated normalization.
- `src/extension.ts` — consume read/write analyzer results.
- `src/keys.ts` — accept normalized logical scope identities.
- `src/cache-tags.ts` — expose v3 explicit tag helpers.
- `src/index.ts` — export v3 public APIs and types.
- `src/serialization.ts` — rename the envelope contract to v3 without changing identity verification.
- `src/tags.ts` — remove after all callers move to focused analyzer/tag-format modules.

### Packaging and fixtures

- `package.json` / `pnpm-lock.yaml` — generator dependency, binary, exports, scripts, and v3 package metadata.
- `tsup.config.ts` — executable generator build plus existing CJS/ESM runtime builds.
- `tests/fixture/cache-schema.ts` — stable descriptor used by runtime tests.
- `tests/fixture/schema.prisma` — relation fixtures used to validate generated output.
- `tests/integration/helpers.ts` — construct clients with the descriptor and per-model scopes.

### Tests and documentation

- `tests/unit/schema.test.ts`
- `tests/unit/tag-format.test.ts`
- `tests/unit/generator.test.ts`
- `tests/unit/read-analysis.test.ts`
- `tests/unit/write-analysis.test.ts`
- `tests/unit/scope-invalidation.test.ts`
- `tests/integration/query-aware-invalidation.test.ts`
- `tests/load/dependency-invalidation.ts`
- `README.md`
- `docs/configuration.md`
- `docs/how-invalidation-works.md`
- `docs/migration-v3.md`

---

### Task 1: Schema Contracts and V3 Tag Grammar

**Files:**

- Create: `src/schema.ts`
- Create: `src/tag-format.ts`
- Create: `tests/unit/schema.test.ts`
- Create: `tests/unit/tag-format.test.ts`

**Interfaces:**

- Produces: `CACHE_SCHEMA_FORMAT_VERSION`, `CacheSchemaDescriptor`, `CacheModelDescriptor`, `CacheFieldDescriptor`, `CacheScope`, `CacheModelScopeConfig`, `CacheModelConfig`, `CacheModelConfigs`, `AnalysisContext`, `createAnalysisContext()`.
- Produces: `scopeRootTag()`, `scopeModelTag()`, `scopeEntityTag()`, `globalModelTag()`, `globalEntityTag()`, `normalizeTags()`.
- Consumes: no new project interfaces.

- [ ] **Step 1: Write failing schema validation tests**

```ts
import { describe, expect, test } from 'vitest';
import { CACHE_SCHEMA_FORMAT_VERSION, createAnalysisContext } from '../../src/schema';

const schema = {
    formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
    models: {
        WorkOrder: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: {
                    kind: 'scalar',
                    type: 'String',
                    isId: false,
                    isUnique: false,
                },
                equipment: {
                    kind: 'relation',
                    target: 'Equipment',
                    isList: true,
                    relationName: 'EquipmentToWorkOrder',
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Equipment: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: {
                    kind: 'scalar',
                    type: 'String',
                    isId: false,
                    isUnique: false,
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
    },
} as const;

test('indexes valid model scopes and relations', () => {
    const context = createAnalysisContext(schema, {
        WorkOrder: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
        Equipment: {
            tenant: { field: 'organizationId', namespace: 'organization' },
        },
    });

    expect(context.models.WorkOrder.scope).toEqual({
        kind: 'tenant',
        field: 'organizationId',
        namespace: 'organization',
    });
    expect(context.models.WorkOrder.relations.equipment.target).toBe('Equipment');
});

test('rejects a tenant field absent from the descriptor', () => {
    expect(() =>
        createAnalysisContext(schema, {
            WorkOrder: { tenant: { field: 'missing', namespace: 'organization' } },
        }),
    ).toThrow('WorkOrder tenant field "missing" is not a scalar field');
});
```

- [ ] **Step 2: Write failing collision-safe tag tests**

```ts
import { expect, test } from 'vitest';
import { globalModelTag, scopeModelTag, scopeRootTag } from '../../src/tag-format';

test('encodes dynamic components without delimiter collisions', () => {
    expect(scopeRootTag({ namespace: 'org:type', id: 'a:b%2Fc' })).toBe('scope:org%3Atype:a%3Ab%252Fc:root');
    expect(scopeModelTag({ namespace: 'organization', id: 'org_1' }, 'WorkOrder')).toBe(
        'scope:organization:org_1:model:WorkOrder',
    );
    expect(globalModelTag('Equipment')).toBe('global:model:Equipment');
});
```

- [ ] **Step 3: Run the focused tests and confirm missing-module failures**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/schema.test.ts tests/unit/tag-format.test.ts
```

Expected: FAIL because `src/schema.ts` and `src/tag-format.ts` do not exist.

- [ ] **Step 4: Implement descriptor validation and indexed context**

Create these exact public shapes in `src/schema.ts`:

```ts
export const CACHE_SCHEMA_FORMAT_VERSION = 1 as const;

export type CacheFieldDescriptor =
    | { kind: 'scalar'; type: string; isId: boolean; isUnique: boolean }
    | { kind: 'relation'; target: string; isList: boolean; relationName: string };

export interface CacheModelDescriptor {
    fields: Record<string, CacheFieldDescriptor>;
    primaryKey: string[];
    uniqueKeys: string[][];
}

export interface CacheSchemaDescriptor {
    formatVersion: typeof CACHE_SCHEMA_FORMAT_VERSION;
    models: Record<string, CacheModelDescriptor>;
}

export interface CacheScope {
    namespace: string;
    id: string;
}

export type CacheModelScopeConfig = { tenant: false } | { tenant: { field: string; namespace: string } };

export type CacheModelConfigs<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> = Partial<
    Record<keyof TSchema['models'] & string, CacheModelScopeConfig>
>;

export interface IndexedModel {
    descriptor: CacheModelDescriptor;
    relations: Record<string, Extract<CacheFieldDescriptor, { kind: 'relation' }>>;
    scope: { kind: 'global' } | { kind: 'tenant'; field: string; namespace: string } | { kind: 'unconfigured' };
}

export interface AnalysisContext {
    schema: CacheSchemaDescriptor;
    models: Record<string, IndexedModel>;
}

export function createAnalysisContext<TSchema extends CacheSchemaDescriptor>(
    schema: TSchema,
    configs: CacheModelConfigs<TSchema>,
): AnalysisContext;
```

Validate the format version, every relation target, every configured model, tenant field kind, and non-empty namespace. Build relation indexes once.

- [ ] **Step 5: Implement v3 tag builders**

Use `encodeURIComponent` for every dynamic namespace, ID, model, and entity component:

```ts
export function scopeRootTag(scope: CacheScope): string;
export function scopeModelTag(scope: CacheScope, model: string): string;
export function scopeEntityTag(scope: CacheScope, model: string, identity: string): string;
export function globalModelTag(model: string): string;
export function globalEntityTag(model: string, identity: string): string;
export function normalizeTags(tags: readonly string[]): string[];
```

`normalizeTags` trims, removes empty values, deduplicates, and sorts. Do not apply a limit in this helper.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/schema.test.ts tests/unit/tag-format.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/tag-format.ts tests/unit/schema.test.ts tests/unit/tag-format.test.ts
git commit -m "feat: add query-aware schema contracts"
```

---

### Task 2: Companion Prisma Generator

**Files:**

- Create: `src/generator/index.ts`
- Create: `src/generator/descriptor.ts`
- Create: `src/generator/render.ts`
- Create: `tests/unit/generator.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsup.config.ts`

**Interfaces:**

- Consumes: `CacheSchemaDescriptor` and `CACHE_SCHEMA_FORMAT_VERSION` from Task 1.
- Produces: `buildCacheSchemaDescriptor(datamodel)`, `renderCacheSchemaModule(descriptor)`, and executable `prisma-cache-tags-generator`.

- [ ] **Step 1: Add the generator helper dependency**

Run:

```bash
pnpm add @prisma/generator-helper@7.9.1
```

Expected: `package.json` and `pnpm-lock.yaml` record the exact Prisma-compatible version.

- [ ] **Step 2: Write failing descriptor and renderer tests**

Create a minimal DMMF-shaped fixture and assert relation metadata, deterministic key ordering, primary keys, and unique keys:

```ts
test('converts Prisma models and relations into a deterministic descriptor', () => {
    const descriptor = buildCacheSchemaDescriptor(datamodelFixture);

    expect(descriptor.models.WorkOrder.fields.equipment).toEqual({
        kind: 'relation',
        target: 'Equipment',
        isList: true,
        relationName: 'EquipmentToWorkOrder',
    });
    expect(descriptor.models.WorkOrder.primaryKey).toEqual(['id']);
    expect(renderCacheSchemaModule(descriptor)).toContain('export const cacheSchema =');
});
```

Add separate fixture cases for one-to-one, one-to-many, implicit many-to-many, self-relations, `@map`/`@@map`, compound primary keys, and compound unique constraints. Assert only Prisma model/field names appear in query-analysis keys; mapped database names are retained only as descriptor diagnostic metadata.

- [ ] **Step 3: Run the test and confirm missing exports**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/generator.test.ts
```

Expected: FAIL because generator modules do not exist.

- [ ] **Step 4: Implement descriptor conversion**

In `src/generator/descriptor.ts`, accept `GeneratorOptions['dmmf']['datamodel']`. Sort models, fields, and unique key arrays by name/content before returning the descriptor. Convert DMMF object fields into relation descriptors and scalar fields into scalar descriptors. Preserve composite `primaryKey.fields` and `uniqueFields`.

```ts
export function buildCacheSchemaDescriptor(datamodel: GeneratorOptions['dmmf']['datamodel']): CacheSchemaDescriptor;
```

- [ ] **Step 5: Implement deterministic TypeScript rendering**

```ts
export function renderCacheSchemaModule(descriptor: CacheSchemaDescriptor): string {
    return [
        '/* Generated by prisma-cache-tags-generator. Do not edit. */',
        "import type { CacheSchemaDescriptor } from 'prisma-extension-cache-tags';",
        '',
        `export const cacheSchema = ${JSON.stringify(descriptor, null, 4)} as const satisfies CacheSchemaDescriptor;`,
        '',
    ].join('\n');
}
```

Write via `mkdir(output, { recursive: true })` and `writeFile(join(output, 'index.ts'), rendered, 'utf8')`.

- [ ] **Step 6: Register the Prisma generator protocol**

`src/generator/index.ts` must call:

```ts
generatorHandler({
    onManifest() {
        return {
            defaultOutput: './generated/cache-tags',
            prettyName: 'Prisma Cache Tags Schema Generator',
            requiresEngines: [],
        };
    },
    async onGenerate(options) {
        const output = options.generator.output?.value;
        if (!output) {
            throw new Error('prisma-cache-tags-generator requires an output path');
        }
        const descriptor = buildCacheSchemaDescriptor(options.dmmf.datamodel);
        await writeGeneratedCacheSchema(output, descriptor);
    },
});
```

- [ ] **Step 7: Build the executable separately from runtime bundles**

Change `tsup.config.ts` to return two configs. Keep existing runtime entries/formats. Add a CJS-only generator build with entry `generator: 'src/generator/index.ts'`, `clean: false`, and:

```ts
banner: { js: '#!/usr/bin/env node' },
onSuccess: async () => {
    await chmod('dist/generator.js', 0o755);
},
```

Import `chmod` from `node:fs/promises`. This makes the packed npm `bin` executable rather than relying only on the shebang.

Add:

```json
"bin": {
  "prisma-cache-tags-generator": "./dist/generator.js"
}
```

Do not export generator internals from the runtime package root.

- [ ] **Step 8: Run generator tests and inspect the executable**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/generator.test.ts
pnpm run build
test -x dist/generator.js
head -1 dist/generator.js
```

Expected: tests pass, the file is executable, and its first line is `#!/usr/bin/env node`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsup.config.ts src/generator tests/unit/generator.test.ts
git commit -m "feat: add Prisma cache schema generator"
```

---

### Task 3: Schema-Aware Read Dependency Analyzer

**Files:**

- Create: `src/read-analysis.ts`
- Create: `src/scope-resolution.ts`
- Create: `tests/unit/read-analysis.test.ts`
- Modify: `src/schema.ts`
- Modify: `src/types.ts`

**Interfaces:**

- Consumes: `AnalysisContext`, v3 tag builders.
- Produces: `CacheBypassReason`, `ReadDependency`, `ReadDependencyResolver`, `ReadAnalysis`, `resolveModelScopes()`, `serializeScope()`, `analyzePrimaryScope()`, `analyzeReadTags()`.

- [ ] **Step 1: Define read analysis contracts**

Add:

```ts
export type CacheBypassReason =
    | 'model-scope-unconfigured'
    | 'tenant-scope-missing'
    | 'query-shape-unsupported'
    | 'relation-field-unknown'
    | 'cross-namespace-scope-unknown'
    | 'dependency-tag-limit'
    | 'canonicalization'
    | 'identity-mismatch'
    | 'invalid-envelope';

export type ReadDependency = { model: string; scope?: CacheScope } | { tag: string };

export type ReadDependencyResolver = (context: {
    model: string;
    operation: string;
    args: unknown;
    scopes: readonly CacheScope[];
    schema: CacheSchemaDescriptor;
}) => readonly ReadDependency[];

export interface ReadAnalysis {
    cacheable: boolean;
    tags: string[];
    tenantScope: string[];
    dependencies: string[];
    bypassReason?: CacheBypassReason;
}
```

Extend `CacheModelScopeConfig` with optional `readDependencies?: ReadDependencyResolver` on both tenant and global variants.

- [ ] **Step 2: Write failing primary/dependency tests**

Use a WorkOrder → Equipment → Manufacturer fixture. Cover:

```ts
test('subscribes an included relation without broadening unrelated models', () => {
    const result = analyzeReadTags({
        model: 'WorkOrder',
        operation: 'findMany',
        args: {
            where: { organizationId: 'org_1' },
            include: { equipment: { select: { manufacturer: true } } },
        },
        context,
        maxTagsPerQuery: 30,
    });

    expect(result.dependencies).toEqual(['Equipment', 'Manufacturer', 'WorkOrder']);
    expect(result.tags).toEqual(
        expect.arrayContaining([
            'scope:organization:org_1:root',
            'scope:organization:org_1:model:WorkOrder',
            'scope:organization:org_1:model:Equipment',
            'scope:organization:org_1:model:Manufacturer',
            'global:model:WorkOrder',
            'global:model:Equipment',
            'global:model:Manufacturer',
        ]),
    );
});
```

Also test relation filters (`some/every/none/is/isNot`), relation `orderBy`, `_count`, `AND/OR/NOT`, duplicate relations, a scalar `equipmentIds` field, and relation cycles.

Add a custom resolver test:

```ts
test('merges application dependencies with inferred relations', () => {
    const configured = createAnalysisContext(schema, {
        ...modelConfigs,
        WorkOrder: {
            tenant: { field: 'organizationId', namespace: 'organization' },
            readDependencies: () => [{ model: 'MaintenancePolicy' }, { tag: 'external:dispatch-board' }],
        },
    });
    const result = analyzeReadTags({
        model: 'WorkOrder',
        operation: 'findMany',
        args: { where: { organizationId: 'org_1' } },
        context: configured,
        maxTagsPerQuery: 30,
    });

    expect(result.dependencies).toEqual(['MaintenancePolicy', 'WorkOrder']);
    expect(result.tags).toContain('external:dispatch-board');
});
```

- [ ] **Step 3: Write failing safe-bypass tests**

Assert:

- missing primary tenant → `tenant-scope-missing`;
- unconfigured primary model → `model-scope-unconfigured`;
- different relation namespace with no nested tenant predicate → `cross-namespace-scope-unknown`;
- unknown structural field → `relation-field-unknown`;
- complete tags above the cap → `dependency-tag-limit`;
- `mergeTags: false` is handled later by the caller and therefore does not call relation analysis.

- [ ] **Step 4: Run tests and confirm analyzer is absent**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/read-analysis.test.ts
```

Expected: FAIL because `analyzeReadTags` does not exist.

- [ ] **Step 5: Implement schema-aware tenant extraction**

Implement a recursive same-model walker that understands Prisma wrappers (`where`, `having`, `AND`, `OR`, `NOT`) and reads only the configured tenant scalar for the current model. Accept scalar, `{ equals }`, and `{ in }` values. Do not collect the same property name after entering a relation field.

Represent canonical logical scope identity as:

```ts
export function serializeScope(scope: CacheScope): string {
    return `${encodeURIComponent(scope.namespace)}:${encodeURIComponent(scope.id)}`;
}
```

Sort and deduplicate multiple scopes.

Expose the shared resolver from `src/scope-resolution.ts`:

```ts
export function resolveModelScopes(input: {
    model: string;
    values: readonly unknown[];
    context: AnalysisContext;
}): CacheScope[];
```

`values` contains argument and/or result sources. The resolver changes model context when it enters a relation field, so a matching scalar name on a nested model cannot become primary-model tenant evidence.

- [ ] **Step 6: Implement finite query-tree relation traversal**

Walk only the supplied argument tree. At each model:

1. Resolve schema fields and recognized Prisma wrapper/operator keys.
2. When a relation field appears under `select`, `include`, `where`, `having`, `orderBy`, or `_count`, add its target.
3. Recurse into the relation value using the target model descriptor.
4. Inherit scope only when source and target model configurations share a namespace.
5. For a different namespace, require the target tenant field in that relation subtree or return `cross-namespace-scope-unknown`.
6. Deduplicate model/scope subscriptions.

Do not expand schema relations absent from query arguments.

- [ ] **Step 7: Build the complete read subscription**

For every resolved tenant scope add its root tag. For every primary/dependency model add its scoped model tag and global model fallback. Global models receive only global model tags. Merge custom resolver dependencies before normalization. If any model cannot be scoped safely, return a bypass.

Apply `maxTagsPerQuery` only after the complete set is built. Return `cacheable: false` and the full diagnostic dependency list when over limit; do not truncate tags.

Also expose:

```ts
export function analyzePrimaryScope(input: {
    model: string;
    args: unknown;
    context: AnalysisContext;
}): Pick<ReadAnalysis, 'cacheable' | 'tenantScope' | 'dependencies' | 'bypassReason'>;
```

This resolves canonical tenant scope without relation traversal for the explicit `mergeTags: false` path.

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/read-analysis.test.ts tests/unit/schema.test.ts tests/unit/tag-format.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/read-analysis.ts src/scope-resolution.ts src/schema.ts src/types.ts tests/unit/read-analysis.test.ts
git commit -m "feat: infer cache dependencies from Prisma reads"
```

---

### Task 4: Narrow Write Publication Analyzer

**Files:**

- Create: `src/write-analysis.ts`
- Create: `tests/unit/write-analysis.test.ts`
- Modify: `src/types.ts`

**Interfaces:**

- Consumes: `AnalysisContext`, `resolveModelScopes()`, `serializeScope()`, v3 tag builders.
- Produces: `WriteAnalysis`, `analyzeWriteTags()`.

- [ ] **Step 1: Define write result contracts**

```ts
export interface WriteAnalysis {
    tags: string[];
    changedModels: string[];
    tenantScope: string[];
    globalFallbackModels: string[];
}

export function analyzeWriteTags(input: {
    model: string;
    operation: string;
    args: unknown;
    result: unknown;
    context: AnalysisContext;
}): WriteAnalysis;
```

- [ ] **Step 2: Write failing tenant-resolved publication tests**

```ts
test('publishes model and entity tags without root or global tags', () => {
    const result = analyzeWriteTags({
        model: 'Equipment',
        operation: 'upsert',
        args: {
            where: { id: '123' },
            create: { id: '123', organizationId: 'org_1', name: 'Pump' },
            update: { name: 'Pump' },
        },
        result: { id: '123', organizationId: 'org_1', name: 'Pump' },
        context,
    });

    expect(result.tags).toEqual([
        'scope:organization:org_1:entity:Equipment:123',
        'scope:organization:org_1:model:Equipment',
    ]);
    expect(result.tags.some((tag) => tag.endsWith(':root'))).toBe(false);
    expect(result.tags.some((tag) => tag.startsWith('global:'))).toBe(false);
});
```

Add cases for create/update/delete/upsert, `updateMany` with tenant criteria, multiple tenants in `in`, global models, and composite identities.

- [ ] **Step 3: Write failing fallback and nested-write tests**

Assert:

- a primary write with no tenant evidence publishes `global:model:<Model>`;
- a nested create with explicit tenant publishes the nested tenant-model tag;
- a nested update without child tenant evidence publishes the child global fallback;
- a relation `connect` alone does not claim the related record was mutated;
- nested `create`, `update`, `upsert`, `delete`, `createMany`, `updateMany`, and `deleteMany` mark the target model changed.

- [ ] **Step 4: Run tests and confirm analyzer is absent**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/write-analysis.test.ts
```

Expected: FAIL because `analyzeWriteTags` does not exist.

- [ ] **Step 5: Implement primary scope and entity resolution**

Resolve tenant evidence from schema-aware write arguments and successful results. Support object/array results and scalar, `equals`, and `in` filters. For entity identity:

- use every generated primary-key field when all are available;
- canonicalize a composite identity object with `canonicalizePrismaValue`;
- use the canonical string as the input to the collision-safe tag encoder;
- omit entity tags when identity is incomplete.

Always publish the changed model tag, even when an entity tag exists.

- [ ] **Step 6: Implement nested write traversal**

Traverse only relation fields under mutation-bearing keys. Treat `connect`, `disconnect`, and `set` as relationship changes on the primary model, not proof that the related entity itself changed. For a genuinely changed nested target:

- use its explicit/result tenant evidence when available;
- otherwise publish its global model fallback;
- never inherit the parent tenant merely because namespaces match.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/write-analysis.test.ts tests/unit/read-analysis.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/write-analysis.ts src/types.ts tests/unit/write-analysis.test.ts
git commit -m "feat: publish narrow write invalidation tags"
```

---

### Task 5: V3 Configuration and Public Type Migration

**Files:**

- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/serialization.ts`
- Modify: `tests/unit/extension.test.ts`
- Modify: `tests/unit/serialization.test.ts`
- Create: `tests/fixture/cache-schema.ts`

**Interfaces:**

- Consumes: schema and analyzer contracts from Tasks 1–4.
- Produces: required `CacheTagsConfig<TSchema>`, `NormalizedCacheConfig`, and v3 defaults used by extension integration.

- [ ] **Step 1: Add a stable test descriptor**

Create `tests/fixture/cache-schema.ts` matching `Widget` and `Part` in the Prisma fixture. Include the `parts` and `widget` relation descriptors and primary keys. Export:

```ts
export const cacheSchema = {/* literal descriptor */} as const satisfies CacheSchemaDescriptor;
export const cacheModels = {
    Widget: { tenant: { field: 'tenantId', namespace: 'tenant' } },
    Part: { tenant: { field: 'tenantId', namespace: 'tenant' } },
} as const satisfies CacheModelConfigs<typeof cacheSchema>;
```

- [ ] **Step 2: Rewrite config tests for the breaking API**

Replace assertions for `tenantKeys`, `tenantPrecision`, `entityKeys`, and `dependencyTags` with:

```ts
const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
expect(config.keyPrefix).toBe('prismaCacheTags:v3');
expect(config.analysis.models.Widget.scope).toEqual({
    kind: 'tenant',
    field: 'tenantId',
    namespace: 'tenant',
});
```

Assert invalid descriptors/configs throw synchronously.

- [ ] **Step 3: Run focused tests and confirm old defaults fail**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/extension.test.ts tests/unit/serialization.test.ts
```

Expected: FAIL on v2 and legacy inference expectations.

- [ ] **Step 4: Replace public configuration fields**

Make `schema` and `models` required:

```ts
export interface CacheTagsConfig<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> {
    schema: TSchema;
    models: CacheModelConfigs<TSchema>;
    enabled?: boolean;
    defaultTtlSeconds?: number;
    maxTtlSeconds?: number;
    keyPrefix?: string;
    cacheNull?: boolean;
    cacheEmpty?: boolean;
    schemaVersion?: number;
    maxTagsPerQuery?: number;
    stampede?: CacheStampedeOptions;
    logger?: Logger;
    metrics?: Metrics;
}
```

Remove `tenantKeys`, `tenantPrecision`, `entityKeys`, `dependencyTags`, and global/per-query `inferTags`. Retain `tags` and `mergeTags` on read/write options.

`NormalizedCacheConfig` contains `analysis: AnalysisContext` and the remaining normalized runtime settings.

Keep schema typing through normalization and extension construction:

```ts
export function normalizeConfig<TSchema extends CacheSchemaDescriptor>(
    config: CacheTagsConfig<TSchema>,
): NormalizedCacheConfig;

export function createCacheTagsExtension<TSchema extends CacheSchemaDescriptor>(
    redisAdapter: RedisAdapter,
    config: CacheTagsConfig<TSchema>,
): ReturnType<typeof Prisma.defineExtension>;
```

- [ ] **Step 5: Move defaults to v3 and validate on normalization**

`normalizeConfig(config)` must call `createAnalysisContext(config.schema, config.models)` once. Set `keyPrefix: 'prismaCacheTags:v3'`. Require config in `withCacheInvalidation` and extension creation.

Rename `CachedEnvelopeV2` to `CachedEnvelopeV3`; keep exact identity and tenant-scope verification behavior.

- [ ] **Step 6: Update affected unit fixtures without integrating analyzers yet**

Replace `normalizeConfig()` calls with a shared `makeConfig()` using `cacheSchema` and `cacheModels`. Preserve existing tests unrelated to tag semantics.

- [ ] **Step 7: Run config/serialization tests and typecheck**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/extension.test.ts tests/unit/serialization.test.ts tests/unit/schema.test.ts
pnpm run typecheck
```

Expected: PASS for the migrated config and serialization tests. Do not run the full unit suite until Task 6 replaces the legacy tag resolver.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts src/serialization.ts tests/fixture/cache-schema.ts tests/unit/extension.test.ts tests/unit/serialization.test.ts
git commit -m "feat: migrate cache configuration to v3"
```

---

### Task 6: Extension Integration and Legacy Resolver Removal

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/keys.ts`
- Modify: `src/cache-tags.ts`
- Modify: `src/index.ts`
- Delete: `src/tags.ts`
- Modify: `tests/unit/extension.test.ts`
- Modify: `tests/unit/keys.test.ts`
- Modify: `tests/unit/public-api.test.ts`
- Delete or replace: `tests/unit/tags.test.ts`

**Interfaces:**

- Consumes: `analyzeReadTags()`, `analyzeWriteTags()`, `ReadAnalysis`, `WriteAnalysis`.
- Produces: v3 read/write behavior through `createCacheTagsExtension()`.

- [ ] **Step 1: Write failing extension behavior tests**

Add tests proving:

- a WorkOrder read including Equipment prepares both model subscriptions;
- a plain WorkOrder read does not subscribe to Equipment;
- a tenant-resolved Equipment write publishes only scoped Equipment model/entity tags;
- a tenant-unresolved write publishes the global fallback and logs once;
- an unsupported read bypasses Prisma caching and emits its stable reason;
- explicit tags merge by default and replace inference with `mergeTags: false`.

Use direct `prepareRead`, `readThroughCache`, and `handleWrite` tests to inspect Redis tag-version keys.

- [ ] **Step 2: Run tests and confirm legacy behavior fails**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/extension.test.ts tests/unit/keys.test.ts tests/unit/public-api.test.ts
```

Expected: FAIL because the extension still calls `resolveCacheTags`.

- [ ] **Step 3: Integrate read analysis**

Replace `resolveCacheTags` in `prepareRead`:

```ts
const analysis =
    cacheOptions.mergeTags === false
        ? analyzePrimaryScope({ model, args, context: config.analysis })
        : analyzeReadTags({
              model,
              operation,
              args,
              context: config.analysis,
              maxTagsPerQuery: config.maxTagsPerQuery,
          });

const tags = normalizeTags(
    cacheOptions.mergeTags === false ? (cacheOptions.tags ?? []) : [...analysis.tags, ...(cacheOptions.tags ?? [])],
);
```

When inference is replaced, still resolve tenant scope for canonical identity. Caller-supplied replacement tags own invalidation correctness.

Change `prepareCacheKey` to accept logical `tenantScope: string[]` directly rather than unnamed tenant IDs.

- [ ] **Step 4: Integrate write analysis**

After the write succeeds, call `analyzeWriteTags`. Merge or replace explicit tags according to `mergeTags`. Publish every normalized tag without applying `maxTagsPerQuery`.

Warn once per operation when `globalFallbackModels` is non-empty, logging only model, operation, and fallback model names.

- [ ] **Step 5: Wire bounded bypass observability**

Change `PreparedRead.bypassReason` and cache metrics to `CacheBypassReason`. Emit:

```ts
config.metrics.onCacheEvent({
    model,
    operation,
    result: 'bypass',
    path: 'bypass',
    reason,
    dependencyCount: analysis.dependencies.length,
});
```

Add optional bounded `dependencyCount?: number` to `CacheEvent`. Do not emit tags/scopes.

- [ ] **Step 6: Replace public tag helpers**

Change `createCacheTags` to expose:

```ts
forScope(scope: CacheScope): string[];
forModel(scope: CacheScope | undefined, model: string): string[];
forEntity(scope: CacheScope | undefined, model: string, identity: string): string[];
combine(...tagLists: string[][]): string[];
```

Remove legacy tenant-ID-only formats. Re-export schema/config/analyzer public types from `src/index.ts`, but keep low-level analyzers internal.

- [ ] **Step 7: Remove the legacy resolver**

Move any still-needed `normalizeTags` use to `src/tag-format.ts`, delete `src/tags.ts`, and replace `tests/unit/tags.test.ts` with focused read/write analyzer coverage.

- [ ] **Step 8: Run targeted and full unit suites**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/extension.test.ts tests/unit/keys.test.ts tests/unit/public-api.test.ts tests/unit/read-analysis.test.ts tests/unit/write-analysis.test.ts
pnpm run test:unit
pnpm run typecheck
pnpm run lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src tests/unit
git commit -m "feat: wire query-aware cache invalidation"
```

---

### Task 7: Explicit Scope Invalidation and Transaction Semantics

**Files:**

- Create: `src/scope-invalidation.ts`
- Create: `tests/unit/scope-invalidation.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/unit/invalidation.test.ts`
- Modify: `tests/integration/transactions.test.ts`

**Interfaces:**

- Consumes: `scopeRootTag()`, `publishInvalidation()`, `CacheScope`, normalized config.
- Produces: `invalidateScope()`.

- [ ] **Step 1: Write failing direct and deferred invalidation tests**

```ts
test('bumps only the requested scope root', async () => {
    const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
    await invalidateScope({ namespace: 'organization', id: 'org_1' }, redis, config);

    expect(redis.store.get(getTagVersionKey('scope:organization:org_1:root', config))).toBe('1');
    expect([...redis.store.keys()]).toHaveLength(1);
});
```

Add a transaction-context test showing two repeated scope invalidations deduplicate and flush after commit.

- [ ] **Step 2: Run tests and confirm missing API**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/scope-invalidation.test.ts tests/unit/invalidation.test.ts
```

Expected: FAIL because `invalidateScope` is not exported.

- [ ] **Step 3: Implement the explicit API**

Use this signature:

```ts
export async function invalidateScope(
    scope: CacheScope,
    redisAdapter: RedisAdapter,
    config: CacheTagsConfig,
): Promise<void> {
    const normalized = normalizeConfig(config);
    await publishInvalidation([scopeRootTag(scope)], normalized, redisAdapter);
}
```

Validate non-empty namespace/ID before publishing. Reuse active invalidation context through `publishInvalidation`.

- [ ] **Step 4: Run unit and transaction tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/scope-invalidation.test.ts tests/unit/invalidation.test.ts
pnpm exec vitest run --project integration tests/integration/transactions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scope-invalidation.ts src/index.ts tests/unit/scope-invalidation.test.ts tests/unit/invalidation.test.ts tests/integration/transactions.test.ts
git commit -m "feat: add explicit tenant scope invalidation"
```

---

### Task 8: End-to-End Dependency Invalidation Coverage

**Files:**

- Create: `tests/integration/query-aware-invalidation.test.ts`
- Modify: `tests/integration/helpers.ts`
- Modify: `tests/integration/caching.test.ts`
- Modify: `tests/fixture/schema.prisma`

**Interfaces:**

- Consumes: v3 extension and fixture descriptor.
- Produces: database/Redis proof of dependency invalidation and isolation.

- [ ] **Step 1: Update integration client construction**

`createCachedClient` must always pass:

```ts
{
    schema: cacheSchema,
    models: cacheModels,
    ...config,
}
```

Remove `tenantKeys`. Update old explicit replacement tests from `inferTags: false` to `mergeTags: false`.

- [ ] **Step 2: Write the failing related-model scenario**

Using existing Widget/Part relations:

1. Seed Widget `w1` and Part `p1` in tenant `t1`, Widget `w2` and Part `p2` in `t2`.
2. Cache four reads: `t1` Widget with `parts`, `t1` plain Widget, `t2` Widget with `parts`, and an unrelated `t1` Part query.
3. Update `p1`.
4. Repeat all reads.

Assert only the `t1` Widget-with-parts query and affected Part query miss. Plain Widget and `t2` relation query remain hits.

- [ ] **Step 3: Add fallback and explicit-root scenarios**

Add tests proving:

- a Part write whose selected result omits `tenantId` triggers global Part fallback and invalidates Part-dependent reads in both tenants;
- `invalidateScope({ namespace: 'tenant', id: 't1' })` invalidates all `t1` cached reads but no `t2` reads;
- rollback preserves all prior generations.

- [ ] **Step 4: Run integration tests**

Run:

```bash
pnpm run db:up
pnpm exec vitest run --project integration tests/integration/query-aware-invalidation.test.ts tests/integration/caching.test.ts tests/integration/transactions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/fixture/schema.prisma tests/integration
git commit -m "test: cover query-aware invalidation isolation"
```

---

### Task 9: Generator Packaging Smoke Test

**Files:**

- Modify: `tests/e2e/package-smoke.ts`
- Modify: `tests/unit/public-api.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: built package binary and runtime types.
- Produces: proof that an installed consumer can invoke the generator and import its output.

- [ ] **Step 1: Extend the package smoke fixture**

After installing the packed tarball, write a scratch `schema.prisma` containing:

```prisma
generator cacheTags {
  provider = "prisma-cache-tags-generator"
  output   = "./generated/cache-tags"
}

datasource db {
  provider = "sqlite"
}

model WorkOrder {
  id          String      @id
  equipmentId String
  equipment   Equipment   @relation(fields: [equipmentId], references: [id])
}

model Equipment {
  id         String      @id
  workOrders WorkOrder[]
}
```

Invoke the repository's installed Prisma CLI with the scratch directory as `cwd`. Assert `generated/cache-tags/index.ts` exists and includes the `equipment → Equipment` relation.

- [ ] **Step 2: Assert package metadata**

In the smoke test, assert:

- `node_modules/.bin/prisma-cache-tags-generator` exists;
- the package root exports `invalidateScope`;
- CJS and ESM runtime imports still work;
- the generator is not exported as a runtime function.

- [ ] **Step 3: Run build and package smoke**

Run:

```bash
pnpm run build
pnpm run test:e2e
```

Expected: generated descriptor succeeds; publint and are-the-types-wrong pass.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/e2e/package-smoke.ts tests/unit/public-api.test.ts
git commit -m "test: verify packaged Prisma generator"
```

---

### Task 10: Invalidation Fanout Benchmark

**Files:**

- Create: `tests/load/dependency-invalidation-model.ts`
- Create: `tests/load/dependency-invalidation.ts`
- Create: `tests/unit/dependency-invalidation-benchmark.test.ts`
- Modify: `package.json`
- Modify: `tests/load/README.md`

**Interfaces:**

- Consumes: `analyzeReadTags()`, `analyzeWriteTags()`.
- Produces: deterministic fanout comparison and runnable benchmark command.

- [ ] **Step 1: Write failing benchmark-math tests**

Extract a pure workload function:

```ts
export interface DependencyInvalidationProfile {
    tenants: number;
    modelsPerTenant: number;
    queriesPerModel: number;
    dependentModels: number;
}

export function compareInvalidationFanout(profile: DependencyInvalidationProfile): {
    totalEntries: number;
    legacyAffectedPerWrite: number;
    queryAwareAffectedPerWrite: number;
    reduction: number;
};
```

Place this interface and function in `tests/load/dependency-invalidation-model.ts`. The executable `tests/load/dependency-invalidation.ts` imports it, so unit tests never execute benchmark side effects.

For `{ tenants: 100, modelsPerTenant: 20, queriesPerModel: 50, dependentModels: 2 }`, assert:

```ts
expect(result).toEqual({
    totalEntries: 100_000,
    legacyAffectedPerWrite: 5_950,
    queryAwareAffectedPerWrite: 150,
    reduction: 5_950 / 150,
});
```

- [ ] **Step 2: Run the unit test and confirm missing module**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/dependency-invalidation-benchmark.test.ts
```

Expected: FAIL because the benchmark module does not exist.

- [ ] **Step 3: Implement deterministic and runtime phases**

The script must:

- print the deterministic workload/fanout table;
- construct representative primary-only and relation-dependent read analyses;
- publish one tenant-scoped model write through the real tag analyzer;
- report tag counts, affected synthetic subscriptions, and 10%-reuse refill estimates;
- never call `FLUSHDB` outside the benchmark's existing isolated Redis setup;
- avoid tenant IDs in metrics output beyond synthetic benchmark labels.

Add:

```json
"test:benchmark:dependencies": "tsx tests/load/dependency-invalidation.ts"
```

- [ ] **Step 4: Run the benchmark tests**

Run:

```bash
pnpm exec vitest run --project unit tests/unit/dependency-invalidation-benchmark.test.ts
pnpm run test:benchmark:dependencies
```

Expected: PASS and approximately `39.67x` lower invalidation fanout for the representative profile.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/load tests/unit/dependency-invalidation-benchmark.test.ts
git commit -m "perf: benchmark dependency-aware invalidation"
```

---

### Task 11: Documentation, Migration, and Final Validation

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/how-invalidation-works.md`
- Create: `docs/migration-v3.md`
- Modify: any remaining tests/files found by legacy API search

**Interfaces:**

- Consumes: final v3 APIs.
- Produces: complete user migration and operational documentation.

- [ ] **Step 1: Search for every legacy contract**

Run:

```bash
rg -n "tenantKeys|tenantPrecision|entityKeys|dependencyTags|inferTags|prismaCacheTags:v2|tenant:" \
  src tests README.md docs package.json
```

Classify each match as historical design documentation or active code/docs. Update every active match.

- [ ] **Step 2: Rewrite the quickstart**

Document:

1. the `generator cacheTags` block;
2. running `prisma generate`;
3. importing `cacheSchema`;
4. declaring per-model tenant/global scopes;
5. automatic relation dependency inference;
6. `invalidateScope`;
7. explicit dependency resolvers for scalar/application relations.

Use the WorkOrder/Equipment example from the spec.

- [ ] **Step 3: Write the v3 migration guide**

`docs/migration-v3.md` must include a table:

| v2                   | v3                                               |
| -------------------- | ------------------------------------------------ |
| `tenantKeys`         | per-model `{ tenant: { field, namespace } }`     |
| `tenantPrecision`    | removed; narrow publication is the default       |
| `entityKeys`         | generated primary/unique metadata                |
| `dependencyTags`     | inferred read dependencies or `readDependencies` |
| `inferTags: false`   | `mergeTags: false` with caller-owned correctness |
| `prismaCacheTags:v2` | `prismaCacheTags:v3`                             |

Explain that v2 keys are ignored and expire naturally.

- [ ] **Step 4: Document invalidation invariants**

Update `docs/how-invalidation-works.md` with:

- read subscriptions versus write publications;
- why reads carry root/global fallbacks but normal writes do not bump them;
- nested-write fallback behavior;
- cross-namespace bypasses;
- tag limit bypasses;
- transaction deferral.

- [ ] **Step 5: Run complete validation**

Run:

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run build
pnpm run test:e2e
pnpm run db:up
pnpm run test:integration
```

Expected: every command passes.

- [ ] **Step 6: Confirm no active legacy API remains**

Run:

```bash
rg -n "tenantKeys|tenantPrecision|entityKeys|dependencyTags|inferTags|prismaCacheTags:v2" \
  src tests README.md docs/configuration.md docs/how-invalidation-works.md docs/migration-v3.md package.json
```

Expected: only intentional migration-guide references remain.

- [ ] **Step 7: Commit**

```bash
git add README.md docs src tests package.json pnpm-lock.yaml tsup.config.ts
git commit -m "docs: document query-aware cache tagging"
```
