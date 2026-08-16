# Fix wave 2 report

Date: 2026-08-16
Repository: `prisma-extension-cache-tags`
Branch: `main`

## Summary

All four fix-wave items are implemented and verified. The three commits are:

- `649a96c fix: make tenant invalidation safe by default`
- `d00fe1a chore: refresh package metadata and test config`
- `ed5ed5b test: cover lock timing and deferred fixes`

The runtime dependency set remains exactly `hash-object` and `superjson`.

## Item 1 — safe default tag invalidation

Implemented the specified `tenantPrecision` option in `CacheTagsConfig` and
`NormalizedCacheConfig`, with a default of `false`.

In the safe default mode, inferred tenant-resolved reads and writes emit the
unscoped `global:model:<Model>` tag in addition to the tenant/model/entity tags.
Tenant-less operations continue to emit the global namespace. In precision mode,
tenant-resolved reads remain tenant-only; tenant-resolved writes include the
global model fallback; and unresolved writes warn through the configured logger.

`normalizeTags` now retains an emitted global model tag before truncating other
tags, including when `maxTagsPerQuery` is `1`. The invalidation mechanism itself
was not changed: it still increments tag-version counters and never scans or
enumerates cached keys.

Added or updated tests cover:

- all four default-mode read/write tenant-resolution combinations, with
  non-empty overlap assertions;
- overlap preservation at `maxTagsPerQuery: 1`;
- precision-mode disjoint tenants;
- precision-mode tenant-ful write versus tenant-less read;
- precision-mode unresolved-write warning;
- unit and integration cross-tenant behavior, moving the old precise assertions
  under `tenantPrecision: true` and adding safe-default counterparts.

README and both invalidation/configuration documents now state plainly that the
default granularity is model-level and document the precision invariant and
trade-off.

### Item 1 TDD evidence

The failing tests were written first. The RED run showed the original
tenant-less/tenant-ful asymmetry in both directions:

```text
$ pnpm exec vitest run tests/unit/tags.test.ts

FAIL  tests/unit/tags.test.ts
  resolveCacheTags > safe default tag overlap > overlaps a tenant-less read with a tenant-ful write
  AssertionError: expected 0 to be greater than 0
  resolveCacheTags > safe default tag overlap > overlaps a tenant-ful read with a tenant-less write
  AssertionError: expected 0 to be greater than 0
```

The relevant RED observations were:

```text
READ  tags: [ 'global:model:Widget' ]
WRITE tags: [ 'tenant:t1', 'tenant:t1:model:Widget' ]
OVERLAP: []

READ  tags: [ 'tenant:t1', 'tenant:t1:model:Widget' ]
WRITE tags: [ 'global:model:Widget', 'global:widget:w1' ]
OVERLAP: []
```

After implementing the safe fallback and truncation retention, the focused
GREEN run was:

```text
$ pnpm exec vitest run tests/unit/tags.test.ts

 RUN  v4.1.10 /Users/nmb0032/Workspace/prisma-extension-cache-tags

 Test Files  1 passed (1)
      Tests  24 passed (24)
   Start at  11:25:50
   Duration  137ms (transform 31ms, setup 0ms, import 42ms, tests 7ms, environment 0ms)
```

## Item 2 — package identity metadata

- Corrected the MIT copyright holder to `Nick Belvin`.
- Added the exact requested `author`, `homepage`, `repository`, and `bugs`
  fields after `keywords`.
- Left all other package fields unchanged.
- Re-ran the packaging gate successfully.

## Item 3 — warning-free test output

- Renamed `vitest.config.ts` to `vitest.config.mts` without changing contents.
- Added the exact requested `packageManager` value.
- Did not change the deliberate CommonJS package type.
- The final unit run emitted no Vitest or Corepack warnings.

## Item 4 — deferred minors

1. Added direct unit coverage for `withCacheInvalidation` with omitted and
   partial configuration, and for deferred invalidation errors being logged
   without rejecting the wrapper.
2. Hardened `releaseCacheLock` logging for non-`Error` rejections and added a
   string-rejection test.
3. Corrected the stale Task 7 report wording so it describes the old unsafe
   fallback as pre-fix behavior.
4. Corrected the `src/types.ts` factory example to use the actual
   `createCacheTagsExtension(redisAdapter, config?)` signature and checked the
   other examples in that file.
5. Made the stampede timeout integration test deterministic by holding the
   owner lock and asserting that the waiter performs its own database query and
   returns the correct result.
6. Documented the one-second TTL floor, including zero/negative requests, and
   corrected the logger documentation to state that core operations emit debug,
   warning, and error events, not info events.

## Verification outputs

The verification database URL used the credentials from `docker-compose.yml`;
the brief's URL was intentionally redacted:
`postgresql://cachetags:cachetags@localhost:5433/cachetags`.

### `pnpm db:up`

```text
> prisma-extension-cache-tags@0.0.0 db:up /Users/nmb0032/Workspace/prisma-extension-cache-tags
> docker compose up -d --wait

 Container prisma-extension-cache-tags-redis-1 Running
 Container prisma-extension-cache-tags-postgres-1 Running
 Container prisma-extension-cache-tags-redis-1 Waiting
 Container prisma-extension-cache-tags-postgres-1 Waiting
 Container prisma-extension-cache-tags-redis-1 Healthy
 Container prisma-extension-cache-tags-postgres-1 Healthy
```

### `pnpm test:unit`

```text
> prisma-extension-cache-tags@0.0.0 test:unit /Users/nmb0032/Workspace/prisma-extension-cache-tags
> vitest run --dir tests/unit


 RUN  v4.1.10 /Users/nmb0032/Workspace/prisma-extension-cache-tags


 Test Files  8 passed (8)
      Tests  81 passed (81)
   Start at  11:25:19
   Duration  1.30s (transform 85ms, setup 0ms, import 248ms, tests 355ms, environment 0ms)
```

This output is warning-free.

### `pnpm test:integration`

```text
> prisma-extension-cache-tags@0.0.0 test:integration /Users/nmb0032/Workspace/prisma-extension-cache-tags
> vitest run --dir tests/integration


 RUN  v4.1.10 /Users/nmb0032/Workspace/prisma-extension-cache-tags


 Test Files  5 passed (5)
      Tests  40 passed (40)
   Start at  11:25:23
   Duration  3.27s (transform 86ms, setup 0ms, import 824ms, tests 2.00s, environment 0ms)
```

### `pnpm test:load`

```text
> prisma-extension-cache-tags@0.0.0 test:load /Users/nmb0032/Workspace/prisma-extension-cache-tags
> tsx tests/load/invalidation-scaling.ts

┌─────────┬─────────────┬─────────────────────┬─────────────────────┐
│ (index) │ cached keys │ invalidate p50 (ms) │ invalidate p99 (ms) │
├─────────┼─────────────┼─────────────────────┼─────────────────────┤
│ 0       │ '1,000'     │ '0.382'             │ '0.805'             │
│ 1       │ '10,000'    │ '0.326'             │ '0.405'             │
│ 2       │ '100,000'   │ '0.324'             │ '0.435'             │
└─────────┴─────────────┴─────────────────────┴─────────────────────┘
Observed Redis INCRBY calls per keyspace: 200, 200, 200.

Keyspace grew 100x; p50 invalidation latency grew 0.85x.
PASS: invalidation cost is independent of keyspace size.
```

### `pnpm build`

```text
> prisma-extension-cache-tags@0.0.0 build /Users/nmb0032/Workspace/prisma-extension-cache-tags
> tsup

CLI Building entry: {"index":"src/index.ts","adapters/node-redis":"src/adapters/node-redis.ts","adapters/ioredis":"src/adapters/ioredis.ts"}
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Using tsup config: /Users/nmb0032/Workspace/prisma-extension-cache-tags/tsup.config.ts
CLI Target: node20
CLI Cleaning output folder
CJS Build start
ESM Build start
CJS dist/index.js                   23.00 KB
CJS dist/adapters/node-redis.js     2.26 KB
CJS dist/adapters/ioredis.js        2.26 KB
CJS dist/adapters/node-redis.js.map 3.36 KB
CJS dist/index.js.map               58.51 KB
CJS dist/adapters/ioredis.js.map    3.47 KB
CJS ⚡️ Build success in 15ms
ESM dist/adapters/ioredis.mjs        1.25 KB
ESM dist/adapters/node-redis.mjs    1.24 KB
ESM dist/index.mjs                   20.99 KB
ESM dist/adapters/node-redis.mjs.map 3.32 KB
ESM dist/index.mjs.map               57.96 KB
ESM dist/adapters/ioredis.mjs.map   3.42 KB
ESM ⚡️ Build success in 15ms
DTS Build start
DTS ⚡️ Build success in 852ms
DTS dist/adapters/ioredis.d.ts     964.00 B
DTS dist/adapters/node-redis.d.ts  927.00 B
DTS dist/index.d.ts                1.56 KB
DTS dist/types-q0HjCq5I.d.ts       12.17 KB
DTS dist/adapters/ioredis.d.mts    965.00 B
DTS dist/adapters/node-redis.d.mts 928.00 B
DTS dist/index.d.mts               1.56 KB
DTS dist/types-q0HjCq5I.d.mts      12.17 KB
```

### `pnpm typecheck`

```text
> prisma-extension-cache-tags@0.0.0 typecheck /Users/nmb0032/Workspace/prisma-extension-cache-tags
> tsc --noEmit
```

### `pnpm test:e2e`

```text
> prisma-extension-cache-tags@0.0.0 test:e2e /Users/nmb0032/Workspace/prisma-extension-cache-tags
> tsx tests/e2e/package-smoke.ts

Building...
Packing...
npm notice
npm notice 📦  prisma-extension-cache-tags@0.0.0
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 4.8kB README.md
npm notice 965B dist/adapters/ioredis.d.mts
npm notice 964B dist/adapters/ioredis.d.ts
npm notice 2.3kB dist/adapters/ioredis.js
npm notice 3.6kB dist/adapters/ioredis.js.map
npm notice 1.3kB dist/adapters/ioredis.mjs
npm notice 3.5kB dist/adapters/ioredis.mjs.map
npm notice 928B dist/adapters/node-redis.d.mts
npm notice 927B dist/adapters/node-redis.d.ts
npm notice 2.3kB dist/adapters/node-redis.js
npm notice 3.4kB dist/adapters/node-redis.js.map
npm notice 1.3kB dist/adapters/node-redis.mjs
npm notice 3.4kB dist/adapters/node-redis.mjs.map
npm notice 1.6kB dist/index.d.mts
npm notice 1.6kB dist/index.d.ts
npm notice 23.6kB dist/index.js
npm notice 59.9kB dist/index.js.map
npm notice 21.5kB dist/index.mjs
npm notice 59.4kB dist/index.mjs.map
npm notice 12.5kB dist/types-q0HjCq5I.d.mts
npm notice 12.5kB dist/types-q0HjCq5I.d.ts
npm notice 3.9kB package.json
npm notice Tarball Details
npm notice name: prisma-extension-cache-tags
npm notice version: 0.0.0
npm notice filename: prisma-extension-cache-tags-0.0.0.tgz
npm notice package size: 46.7 kB
npm notice unpacked size: 227.1 kB
npm notice shasum: 1e1028078dbad86978ab8b4107022cf0749b6c86
npm notice integrity: sha512-TFT01rVaTKXOm[...]F5vRHgJbAXYMQ==
npm notice total files: 23
npm notice
Installing into /var/folders/8w/ypsj3w1x2nq058z1rj053s_m0000gn/T/cache-tags-e2e-lamI1c...
Verifying CommonJS require()...
Verifying ESM dynamic import()...
Verifying adapter subpath exports...
Checking package exports metadata with publint...
Checking type resolution with are-the-types-right...

PASS: package installs and resolves under both CJS and ESM.
```

### `grep -rin "kitcompass\|Nick Bair" src/ docs/ README.md LICENSE package.json`

The exact required command produced the following output:

```text
docs/plans/2026-08-15-prisma-extension-cache-tags.md:5:**Goal:** Extract KitCompass's Redis-backed Prisma cache extension into a standalone, Prisma 7 compatible, open-source npm package called `prisma-extension-cache-tags`, with unit, integration, load, and end-to-end test coverage.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:11:**Spec:** No formal spec document exists. This plan is grounded in the research spike recorded at `~/Documents/obsidian-vault/Personal/KitCompass/Prisma Redis Cache - OSS Opportunity.md`, which contains the competitive analysis, the mechanism description, and the extraction-cost assessment. Read that note before starting — it explains *why* the generational-invalidation mechanism is the product, and therefore which behaviours are non-negotiable.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:13:**Source material:** The code being ported lives in the KitCompass repo at `packages/database/src/lib/cache/`. Later tasks copy files with `cp "$KC/..."`, so **export `KC` in every shell you use** (Task 1, Step 1 does this):
docs/plans/2026-08-15-prisma-extension-cache-tags.md:16:export KC=/Users/nmb0032/Workspace/KitCompass
docs/plans/2026-08-15-prisma-extension-cache-tags.md:21:Expected: `cache-tags.ts`, `invalidation.ts`, `keys.ts`, `locks.ts`, `prisma-cache-extension.ts`, `serialization.ts`, `tags.ts`, `types.ts`, `verify-cache.ts`. If that directory is missing or empty, the checkout is on a branch without it — use the worktree `/Users/nmb0032/Workspace/copilot-worktrees/KitCompass/nmb0032-vigilant-doodle` instead and export `KC` to that path.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:23:Note that `verify-cache.ts` is deliberately **not** ported: it is a standalone dev script that reaches into KitCompass application singletons and is referenced by nothing.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:44:- **No KitCompass identifiers anywhere in the published package** — no `kitcompass` strings, no KitCompass model names, no `@kitcompass/*` imports. Grep for `kitcompass` (case-insensitive) before every commit that touches `src/`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:49:- **Default config is generic, not KitCompass-shaped:** `dependencyTags` defaults to `{}`, `tenantKeys` defaults to `[]`, `entityKeys` defaults to `['id']`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:82:**Modified in KitCompass (final task only):** `packages/database/package.json`, `packages/database/src/index.ts`, and deletion of `packages/database/src/lib/cache/`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:115:export KC=/Users/nmb0032/Workspace/KitCompass
docs/plans/2026-08-15-prisma-extension-cache-tags.md:684:- [ ] **Step 5: Strip KitCompass from the doc comments**
docs/plans/2026-08-15-prisma-extension-cache-tags.md:686:Every `@example` block in this file references KitCompass models (`prisma.equipment`, `prisma.reservation`, `org:123`). Rewrite them against the neutral fixture vocabulary — `prisma.widget`, `tenant:123`. Then verify:
docs/plans/2026-08-15-prisma-extension-cache-tags.md:689:grep -ri "kitcompass\|equipment\|reservation\|organizationId" src/types.ts
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1029:This task removes the last KitCompass-specific logic: the hardcoded `organizationId` tenant convention and the `Organization` relation special case.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1199:**(a) Replace the logger import** — delete `import { getChildLogger } from '@kitcompass/logger';` and the `const logger = ...` line. `normalizeTags` used the logger to warn on truncation; it has no config access, so drop that warning (the truncation itself is still tested).
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1278:- [ ] **Step 5: Verify no KitCompass vocabulary survived**
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1281:grep -rin "kitcompass\|organization" src/
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1448:**(a)** Delete the `@kitcompass/logger` import and the module-level `logger`. Replace the debug call inside `bumpTagVersions` with `config.logger.debug(...)`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1619:Apply one edit: delete the `@kitcompass/logger` import and the module-level `logger`, and route both log calls through `config.logger`. `waitForCachedValue` already receives `config`; `releaseCacheLock` does not, so **add `config: NormalizedCacheConfig` as its third parameter** and log the release failure through `config.logger.warn`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1672:    test('applies generic defaults with no KitCompass model graph', () => {
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1949:Delete the `@kitcompass/logger` and `@kitcompass/telemetry` imports and the module-level `logger` / `prismaCacheCounter` constants. Update the remaining relative imports to `./invalidation`, `./keys`, `./locks`, `./serialization`, `./tags`, `./types`.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:1953:**(c) Replace `DEFAULT_CONFIG` with generic defaults.** The source hardcodes nine KitCompass models in `dependencyTags`. The replacement:
docs/plans/2026-08-15-prisma-extension-cache-tags.md:2004:grep -rin "kitcompass\|@kitcompass" src/
docs/plans/2026-08-15-prisma-extension-cache-tags.md:2293:Rewrite the helpers to match the tag format fixed in the Global Constraints, and rewrite every doc comment away from KitCompass vocabulary. The resulting API:
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3120:          if grep -rin "kitcompass" src/; then
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3294:## Task 16: Adopt the package in KitCompass
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3296:Extraction is not complete while KitCompass still carries a private copy — that is duplicate code that will drift. This task deletes the original and consumes the package.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3298:**Files (all in the KitCompass repo, not the new one):**
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3306:- Produces: `@kitcompass/database` re-exporting the same public names it exports today, so no call site in `apps/web` or `apps/api` changes.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3308:**Prerequisite:** KitCompass is on Prisma 6.19.2 and this package requires Prisma `^7.2.0`. **Do not start this task until KitCompass has been upgraded to Prisma 7.** That upgrade is a separate piece of work with its own risks (driver adapters become mandatory, the generated client moves out of `node_modules`, ESM changes) and is explicitly out of scope for this plan. If KitCompass is still on Prisma 6, stop after Task 15 and treat Task 16 as a follow-up.
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3313:cd /Users/nmb0032/Workspace/KitCompass
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3322:pnpm --filter @kitcompass/database add prisma-extension-cache-tags
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3327:Replace the local extension import with the package, and pass the KitCompass-specific configuration that used to be hardcoded in `DEFAULT_CONFIG`:
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3330:import { getChildLogger } from '@kitcompass/logger';
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3331:import { getCounter } from '@kitcompass/telemetry';
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3338:    'kitcompass.prisma.cache.operations',
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3340:    'kitcompass-database',
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3403:cd /Users/nmb0032/Workspace/KitCompass
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3415:pnpm --filter @kitcompass/database run build
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3416:pnpm --filter @kitcompass/web run typecheck
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3417:pnpm --filter @kitcompass/database run test
docs/plans/2026-08-15-prisma-extension-cache-tags.md:3426:pnpm --filter @kitcompass/web run test:integration
```

The matches are confined to the historical implementation plan
`docs/plans/2026-08-15-prisma-extension-cache-tags.md`; there are no stale
package-identity references in `src`, README, LICENSE, package.json, or the
publishable documentation. I did not rewrite the historical plan because that
would destroy its source/provenance and task instructions. This is the one
verification expectation from the brief that is not literally met.

### Additional checks

```text
$ pnpm run lint
> prisma-extension-cache-tags@0.0.0 lint /Users/nmb0032/Workspace/prisma-extension-cache-tags
> eslint .
```

`git diff --check` also completed with no output, and the final working tree was
clean after verification.

## Load-harness interpretation

The load harness observed exactly 200 Redis `INCRBY` calls at each keyspace
size. Going from 1,000 to 100,000 cached keys produced p50 values of 0.382 ms,
0.326 ms, and 0.324 ms, respectively; the reported ratio was 0.85x. This
confirms the tag-resolution changes did not introduce key enumeration or
keyspace-dependent invalidation cost.

## Self-review

- Completeness: all four items and all required tests are present.
- Correctness: all four default read/write state combinations assert non-empty
  tag overlap; precision-mode different tenants assert no overlap; the
  max-tags truncation case asserts overlap.
- Discipline: no new dependency was added; runtime dependencies remain exactly
  `hash-object` and `superjson`; no invalidation mechanism or tag string format
  was changed.
- Documentation: README, configuration, and invalidation docs state the actual
  model-level default and the precision invariant.
- Test hygiene: the final unit output is warning-free.
- Scope finding: the exact identity grep includes historical KitCompass
  references in the tracked implementation plan. Those references are not in
  published files and were intentionally left intact.
