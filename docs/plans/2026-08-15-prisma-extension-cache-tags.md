# prisma-extension-cache-tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract KitCompass's Redis-backed Prisma cache extension into a standalone, Prisma 7 compatible, open-source npm package called `prisma-extension-cache-tags`, with unit, integration, load, and end-to-end test coverage.

**Architecture:** A Prisma Client Extension (`Prisma.defineExtension`) that adds opt-in read-through Redis caching via a `cache: {...}` property on query args, and automatic write-triggered invalidation using **generational (version-token) tags**: each tag has a Redis counter whose current value is folded into the cache key hash, so invalidating a tag is a single `INCR` that orphans every key derived from the old version — O(1), no `SCAN`, no tag→key index. Tags are inferred automatically from Prisma args (tenant id, entity id, model), extended by a configurable cross-model `dependencyTags` graph, and buffered inside `$transaction` so they flush once after commit. All host-application coupling (logging, metrics, the Redis client itself) is injected through interfaces.

**Tech Stack:** TypeScript 5.x, Prisma 7 (`@prisma/client` as a peer dependency, `@prisma/adapter-pg` for tests), `superjson`, `hash-object`, `tsup` (dual CJS/ESM), `vitest`, Docker Compose (local), GitHub Actions `services:` (CI).

**Spec:** No formal spec document exists. This plan is grounded in the research spike recorded at `~/Documents/obsidian-vault/Personal/KitCompass/Prisma Redis Cache - OSS Opportunity.md`, which contains the competitive analysis, the mechanism description, and the extraction-cost assessment. Read that note before starting — it explains *why* the generational-invalidation mechanism is the product, and therefore which behaviours are non-negotiable.

**Source material:** The code being ported lives in the KitCompass repo at `packages/database/src/lib/cache/`. Later tasks copy files with `cp "$KC/..."`, so **export `KC` in every shell you use** (Task 1, Step 1 does this):

```bash
export KC=/Users/nmb0032/Workspace/KitCompass
# Verify the source files are present on the current branch:
ls "$KC/packages/database/src/lib/cache/"
```

Expected: `cache-tags.ts`, `invalidation.ts`, `keys.ts`, `locks.ts`, `prisma-cache-extension.ts`, `serialization.ts`, `tags.ts`, `types.ts`, `verify-cache.ts`. If that directory is missing or empty, the checkout is on a branch without it — use the worktree `/Users/nmb0032/Workspace/copilot-worktrees/KitCompass/nmb0032-vigilant-doodle` instead and export `KC` to that path.

Note that `verify-cache.ts` is deliberately **not** ported: it is a standalone dev script that reaches into KitCompass application singletons and is referenced by nothing.

**Target repo:** `~/Workspace/prisma-extension-cache-tags` (note: the machine has `~/Workspace`, singular — there is no `~/Workspaces`).

---

## Global Constraints

These apply to **every** task. Do not restate them per-task; do not violate them.

- **Package name:** `prisma-extension-cache-tags` (verified unclaimed on npm as of 2026-08-15).
- **License:** MIT. Copyright holder: the repository owner.
- **Node engines:** `^20.19 || ^22.12 || >=24.0` (matches `@prisma/client@7.9.1`).
- **Prisma:** `@prisma/client` is a **peerDependency** at `^7.2.0`. Never a direct dependency. Dev/test uses `7.9.1`.
- **Prisma import paths — mandatory.** In library source, import Prisma *only* from these two stable subpaths:
  - `import { Prisma } from '@prisma/client/extension';`
  - `import type { Operation } from '@prisma/client/runtime/client';`
  Never `import ... from '@prisma/client'` and never `@prisma/client/runtime/library` (removed in Prisma 7). This is what makes the library work regardless of where the consumer generated their client.
- **Runtime dependencies:** exactly `superjson` (^2.2.6) and `hash-object` (^5.1.0). Adding any other runtime dependency requires an explicit decision — do not add one silently.
- **Optional peer dependencies:** `redis` (^5 || ^6) and `ioredis` (^5 || ^6), both marked optional in `peerDependenciesMeta`. The built-in adapters must be reachable only through subpath exports so that a user of one client never needs the other installed.
- **Module format:** dual CJS + ESM via `tsup` with `dts: true`. Package root stays `"type": "commonjs"`.
- **No KitCompass identifiers anywhere in the published package** — no `kitcompass` strings, no KitCompass model names, no `@kitcompass/*` imports. Grep for `kitcompass` (case-insensitive) before every commit that touches `src/`.
- **Tag string format** (fixed; tests depend on exact strings):
  - tenant root: `tenant:<tenantId>`
  - model: `tenant:<tenantId>:model:<Model>` or, with no tenant, `global:model:<Model>`
  - entity: `tenant:<tenantId>:<modelCamelCase>:<entityId>` or `global:<modelCamelCase>:<entityId>`
- **Default config is generic, not KitCompass-shaped:** `dependencyTags` defaults to `{}`, `tenantKeys` defaults to `[]`, `entityKeys` defaults to `['id']`.
- **TDD:** every task writes a failing test first, watches it fail, then implements. Commit at the end of each task with a Conventional Commit subject.
- **Commit messages:** Conventional Commits. No AI attribution trailers, no co-author trailers.

---

## File Structure

**New repo `~/Workspace/prisma-extension-cache-tags`:**

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Public API surface. Re-exports the extension factory, tag helpers, and all public types. |
| `src/types.ts` | `RedisAdapter`, `Logger`, `Metrics`, config interfaces, cache option interfaces, operation constants, and the `ExtendedModel` type-level args augmentation. |
| `src/config.ts` | `DEFAULT_CONFIG` and `normalizeConfig`. Separate from `extension.ts` so `invalidation.ts` can normalize a public config without a circular import. |
| `src/extension.ts` | The extension factory: intercepts `$allOperations`, routes reads to the cache and writes to invalidation. Re-exports `normalizeConfig`. |
| `src/keys.ts` | Cache key + fingerprint construction, tag-version key naming, tag-version reads. |
| `src/tags.ts` | Tag inference from Prisma args, normalization, dependency-tag resolution. |
| `src/invalidation.ts` | Tag version bumping and the AsyncLocalStorage deferred-invalidation context. |
| `src/locks.ts` | Distributed single-flight lock for cache misses. |
| `src/serialization.ts` | superjson envelope encode/decode and stable stringify. |
| `src/cache-tags.ts` | Ergonomic tag-builder helpers for consumers. |
| `src/observability.ts` | No-op `Logger` and `Metrics` defaults, so host wiring is optional. |
| `src/adapters/node-redis.ts` | `createNodeRedisAdapter` for the `redis` package. |
| `src/adapters/ioredis.ts` | `createIoRedisAdapter` for the `ioredis` package. |
| `tests/unit/*.test.ts` | Pure-logic tests against an in-memory fake `RedisAdapter`. No Docker. |
| `tests/integration/*.test.ts` | Real Postgres + real Redis + real Prisma 7 client. |
| `tests/fixture/` | Prisma 7 schema, generated client output, and the adapter-backed test client. |
| `tests/load/` | Load harness proving invalidation cost is independent of keyspace size. |
| `tests/e2e/` | Packaging tests: `npm pack`, install into a scratch dir, `require()` and `import` smoke checks. |
| `docker-compose.yml` | Local Postgres + Redis for integration and load tests. |
| `.github/workflows/ci.yml` | Lint, typecheck, unit, integration, packaging gates, and release. |

**Modified in KitCompass (final task only):** `packages/database/package.json`, `packages/database/src/index.ts`, and deletion of `packages/database/src/lib/cache/`.

---

## Risk Register

Read this before Task 1. Two items can change the design.

1. **`$transaction` override on Prisma 7 is unverified (HIGH).** Today the extension monkey-patches `$transaction` on the extended client to install an AsyncLocalStorage context, which is what makes invalidation defer until commit. Prisma 7's `$extends` return type is a complex intersection, and the reference implementation `prisma-extension-redis` deliberately never patches `$transaction`. Task 2 proves or disproves this **before** any porting work depends on it. If it fails, the fallback is to expose an explicit `withCacheInvalidation(fn)` wrapper the consumer calls instead of relying on implicit `$transaction` interception, and to document the difference.
2. **Extra properties on args (MEDIUM-LOW).** The whole `cache: {...}` API depends on Prisma tolerating unknown properties on args at runtime, provided the extension strips them before calling `query()`. Verified working in Prisma 7 by a shipping library, but Task 2 confirms it directly in our own fixture rather than trusting the report.

---

## Task 1: Repository scaffold and green toolchain

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/package.json`
- Create: `~/Workspace/prisma-extension-cache-tags/tsconfig.json`
- Create: `~/Workspace/prisma-extension-cache-tags/tsup.config.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/vitest.config.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/.gitignore`
- Create: `~/Workspace/prisma-extension-cache-tags/LICENSE`
- Create: `~/Workspace/prisma-extension-cache-tags/docker-compose.yml`
- Create: `~/Workspace/prisma-extension-cache-tags/src/index.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable, testable package skeleton. Later tasks assume `pnpm build`, `pnpm test:unit`, `pnpm typecheck`, and `pnpm lint` all exist and pass.

- [ ] **Step 1: Create the repo and initialise git**

```bash
export KC=/Users/nmb0032/Workspace/KitCompass
ls "$KC/packages/database/src/lib/cache/types.ts"   # must exist before continuing

mkdir -p ~/Workspace/prisma-extension-cache-tags
cd ~/Workspace/prisma-extension-cache-tags
git init
pnpm init
```

`KC` must be exported in every shell that runs a `cp "$KC/..."` step in Tasks 3–8. If it is unset, those copies silently read from the wrong path.

- [ ] **Step 2: Write `package.json`**

Replace the generated file entirely with this:

```json
{
  "name": "prisma-extension-cache-tags",
  "version": "0.0.0",
  "description": "Redis caching for Prisma with automatic, generational tag invalidation. O(1) invalidation, no SCAN, transaction-safe.",
  "keywords": ["prisma", "prisma-extension", "redis", "cache", "invalidation", "multi-tenant"],
  "license": "MIT",
  "type": "commonjs",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    },
    "./node-redis": {
      "import": { "types": "./dist/adapters/node-redis.d.mts", "default": "./dist/adapters/node-redis.mjs" },
      "require": { "types": "./dist/adapters/node-redis.d.ts", "default": "./dist/adapters/node-redis.js" }
    },
    "./ioredis": {
      "import": { "types": "./dist/adapters/ioredis.d.mts", "default": "./dist/adapters/ioredis.mjs" },
      "require": { "types": "./dist/adapters/ioredis.d.ts", "default": "./dist/adapters/ioredis.js" }
    },
    "./package.json": "./package.json"
  },
  "engines": { "node": "^20.19 || ^22.12 || >=24.0" },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "pnpm run test:unit",
    "test:unit": "vitest run --dir tests/unit",
    "test:integration": "vitest run --dir tests/integration",
    "test:load": "tsx tests/load/invalidation-scaling.ts",
    "test:e2e": "tsx tests/e2e/package-smoke.ts",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down -v"
  },
  "dependencies": {
    "hash-object": "^5.1.0",
    "superjson": "^2.2.6"
  },
  "peerDependencies": {
    "@prisma/client": "^7.2.0",
    "ioredis": "^5.0.0 || ^6.0.0",
    "redis": "^5.0.0 || ^6.0.0"
  },
  "peerDependenciesMeta": {
    "ioredis": { "optional": true },
    "redis": { "optional": true }
  },
  "devDependencies": {
    "@prisma/adapter-pg": "7.9.1",
    "@prisma/client": "7.9.1",
    "@types/node": "^24.7.2",
    "prisma": "7.9.1",
    "tsup": "^8.5.1",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "tests"],
  "exclude": ["node_modules", "dist", "tests/fixture/generated"]
}
```

- [ ] **Step 4: Write `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
    clean: true,
    dts: true,
    entry: {
        index: 'src/index.ts',
        'adapters/node-redis': 'src/adapters/node-redis.ts',
        'adapters/ioredis': 'src/adapters/ioredis.ts',
    },
    format: ['cjs', 'esm'],
    sourcemap: true,
    target: 'node20',
});
```

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        fileParallelism: false,
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
```

- [ ] **Step 6: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: cachetags
      POSTGRES_PASSWORD: cachetags
      POSTGRES_DB: cachetags
    ports:
      - '5433:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U cachetags']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - '6380:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10
```

Ports are deliberately non-default (5433, 6380) so this never collides with a locally running Postgres or Redis.

- [ ] **Step 7: Write `.gitignore`**

```
node_modules/
dist/
coverage/
*.log
.DS_Store
tests/fixture/generated/
.env
```

- [ ] **Step 8: Write `LICENSE`**

Standard MIT license text, year `2026`, copyright holder set to the repository owner's name.

- [ ] **Step 9: Write the placeholder entry point `src/index.ts`**

```ts
export const VERSION = '0.0.0';
```

- [ ] **Step 10: Write the failing smoke test `tests/unit/smoke.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { VERSION } from '../../src/index';

describe('package scaffold', () => {
    test('exports a version constant', () => {
        expect(VERSION).toBe('0.0.0');
    });
});
```

- [ ] **Step 11: Install dependencies and run the test**

```bash
cd ~/Workspace/prisma-extension-cache-tags
pnpm install
pnpm test:unit
```

Expected: PASS (1 test).

- [ ] **Step 12: Verify the build and typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`, and `dist/index.d.mts` all exist; typecheck exits 0.

Note: `tsup` will fail on the `adapters/*` entries because those files do not exist yet. Comment those two entries out of `tsup.config.ts` for now and restore them in Task 9. Leave a `// restored in Task 9` comment so it is not forgotten.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "chore: scaffold package with tsup, vitest, and docker compose"
```

---

## Task 2: Prisma 7 fixture and compatibility spike

This task exists to **de-risk the two items in the Risk Register before any porting happens**. It produces the Prisma 7 test fixture that every later integration test reuses, and it answers definitively whether `$transaction` can be intercepted.

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/tests/fixture/schema.prisma`
- Create: `~/Workspace/prisma-extension-cache-tags/tests/fixture/client.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/prisma.config.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/integration/prisma7-compat.test.ts`

**Interfaces:**
- Consumes: the scaffold from Task 1.
- Produces:
  - `tests/fixture/client.ts` exporting `createTestPrismaClient(): PrismaClient` and `TEST_DATABASE_URL: string`.
  - A recorded answer to "can we intercept `$transaction`", written into `docs/decisions/001-transaction-interception.md`.

- [ ] **Step 1: Write the Prisma 7 fixture schema**

Create `tests/fixture/schema.prisma`. Two models are enough: one tenant-scoped model with an id, and one related model to exercise dependency tags.

```prisma
generator client {
  provider = "prisma-client"
  output   = "./generated"
}

datasource db {
  provider = "postgresql"
  url      = env("TEST_DATABASE_URL")
}

model Widget {
  id       String  @id @default(uuid())
  tenantId String
  name     String
  parts    Part[]

  @@index([tenantId])
}

model Part {
  id       String @id @default(uuid())
  tenantId String
  label    String
  widgetId String
  widget   Widget @relation(fields: [widgetId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}
```

- [ ] **Step 2: Write `prisma.config.ts`**

Prisma 7 uses a config file rather than `package.json` fields.

```ts
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
    schema: path.join('tests', 'fixture', 'schema.prisma'),
});
```

- [ ] **Step 3: Start the databases and generate the client**

```bash
cd ~/Workspace/prisma-extension-cache-tags
pnpm db:up
export TEST_DATABASE_URL="postgresql://cachetags:cachetags@localhost:5433/cachetags"
pnpm exec prisma generate
pnpm exec prisma db push
```

Expected: `tests/fixture/generated/` is created and the two tables exist in Postgres.

- [ ] **Step 4: Write the adapter-backed test client `tests/fixture/client.ts`**

Prisma 7 **requires** a driver adapter — `new PrismaClient()` with no argument is removed.

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgresql://cachetags:cachetags@localhost:5433/cachetags';

export function createTestPrismaClient(): PrismaClient {
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
    return new PrismaClient({ adapter });
}
```

- [ ] **Step 5: Write the failing compatibility test `tests/integration/prisma7-compat.test.ts`**

This is a spike test with three assertions, each mapping to a risk.

```ts
import { Prisma } from '@prisma/client/extension';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestPrismaClient } from '../fixture/client';

const base = createTestPrismaClient();

afterAll(async () => {
    await base.$disconnect();
});

beforeEach(async () => {
    await base.part.deleteMany();
    await base.widget.deleteMany();
});

describe('prisma 7 extension compatibility', () => {
    test('extra properties on args reach $allOperations and can be stripped', async () => {
        const seen: Array<{ model?: string; operation: string; extra: unknown }> = [];

        const extended = base.$extends(
            Prisma.defineExtension((client) =>
                client.$extends({
                    name: 'spike',
                    query: {
                        async $allOperations({ model, operation, args, query }) {
                            const { cache, ...cleaned } = (args ?? {}) as Record<string, unknown>;
                            seen.push({ model, operation, extra: cache });
                            return query(cleaned);
                        },
                    },
                }),
            ),
        );

        await extended.widget.create({ data: { tenantId: 't1', name: 'w1' } });

        // The unknown `cache` property must survive to the interceptor and must not
        // reach Prisma itself (stripping it is what keeps the query valid).
        const result = await (extended.widget as unknown as {
            findMany: (args: unknown) => Promise<unknown[]>;
        }).findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 30 } });

        expect(result).toHaveLength(1);
        expect(seen.some((entry) => entry.operation === 'findMany' && entry.extra !== undefined)).toBe(true);
    });

    test('$transaction can be intercepted on the extended client', async () => {
        let intercepted = 0;

        const extended = base.$extends(
            Prisma.defineExtension((client) => {
                const withQuery = client.$extends({
                    name: 'spike-tx',
                    query: {
                        async $allOperations({ args, query }) {
                            return query(args);
                        },
                    },
                });

                const patched = withQuery as typeof withQuery & { $transaction: typeof withQuery.$transaction };
                const original = patched.$transaction.bind(patched);

                patched.$transaction = ((input: unknown, ...rest: unknown[]) => {
                    if (typeof input === 'function') {
                        intercepted += 1;
                    }
                    return original(input as never, ...(rest as never[]));
                }) as typeof withQuery.$transaction;

                return patched;
            }),
        );

        await extended.$transaction(async (tx) => {
            await tx.widget.create({ data: { tenantId: 't1', name: 'in-tx' } });
        });

        expect(intercepted).toBe(1);
        expect(await base.widget.count()).toBe(1);
    });

    test('interactive transaction rollback still rolls back', async () => {
        await expect(
            base.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await base.widget.count()).toBe(0);
    });
});
```

- [ ] **Step 6: Run the spike**

```bash
pnpm test:integration
```

Expected: all three tests PASS. Record the actual outcome — this is the point of the task.

- [ ] **Step 7: Record the decision**

Create `docs/decisions/001-transaction-interception.md` stating, in a few sentences: whether `$transaction` interception worked on Prisma 7.9.1, the exact Prisma version tested, and the chosen approach.

**If the `$transaction` test FAILED**, stop and do not proceed to Task 6 as written. The fallback design is:
- Do not patch `$transaction`.
- Export `withCacheInvalidation<T>(fn: () => Promise<T>, redisAdapter: RedisAdapter, config?: CacheTagsConfig): Promise<T>` from `src/invalidation.ts` (defined in Task 6), which runs `fn` inside the AsyncLocalStorage context and flushes buffered tags after it resolves.
- Consumers wrap their transaction: `withCacheInvalidation(() => prisma.$transaction(async (tx) => { ... }))`.
- Task 6 and Task 8 must then be adjusted, and the README must document this explicitly as a known limitation.

Write down which branch was taken. Every later task depends on this answer.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: add prisma 7 fixture and extension compatibility spike"
```

---

## Task 3: Core types and observability seams

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/types.ts` (ported from `$KC/packages/database/src/lib/cache/types.ts`)
- Create: `~/Workspace/prisma-extension-cache-tags/src/observability.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/observability.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces (every later task depends on these exact names):
  - `RedisAdapter` — unchanged from the source file: `get<T>(key): Promise<T | null>`, `set(key, value, ttlSeconds?): Promise<void>`, `delete(key): Promise<void>`, `increment(key, amount?): Promise<number>`, `expire(key, ttlSeconds): Promise<void>`, `mgetString(keys): Promise<Array<string | null>>`, optional `setIfNotExists(key, value, ttlMs): Promise<boolean>`, optional `deleteIfValue(key, value): Promise<boolean>`.
  - `Logger` — `{ debug(data, message): void; info(data, message): void; warn(data, message): void; error(data, message): void }` where `data: Record<string, unknown>` and `message: string`.
  - `Metrics` — `{ onCacheEvent(event: { model: string; operation: string; result: 'hit' | 'miss' }): void }`.
  - `noopLogger: Logger`, `noopMetrics: Metrics`.
  - `CacheReadOptions`, `CacheWriteOptions`, `CacheDependencyResolver`, `CacheStampedeOptions`, `CachedEnvelope`, `ExtendedModel`.
  - `ResolvedCacheTags` — `{ tags: string[]; tenantIds: string[]; entityIds: string[] }`. **Note the rename:** the source file calls this field `organizationIds`; rename it to `tenantIds` here in Task 3 so the type is final from this point on. Rename it on the `CacheDependencyResolver` context object too, whose shape becomes `{ model: string; operation: string; tenantIds: string[]; entityIds: string[]; args: unknown }`.
  - `CacheTagsConfig` (public, all-optional) and `NormalizedCacheConfig` (internal, all-required).
  - `READ_OPERATIONS`, `WRITE_OPERATIONS`, `ReadOperation`, `WriteOperation`.

- [ ] **Step 1: Copy the source types file**

```bash
cd ~/Workspace/prisma-extension-cache-tags
cp "$KC/packages/database/src/lib/cache/types.ts" src/types.ts
```

- [ ] **Step 2: Fix the Prisma import paths**

At the top of `src/types.ts`, replace:

```ts
import type { Prisma } from '@prisma/client/extension';
import type { Operation } from '@prisma/client/runtime/library';
```

with:

```ts
import type { Prisma } from '@prisma/client/extension';
import type { Operation } from '@prisma/client/runtime/client';
```

`/runtime/library` does not exist in Prisma 7. Everything else in the type-level `ExtendedModel` machinery (`Prisma.Exact`, `Prisma.Args`, `Prisma.Result`) is unchanged in Prisma 7 and ports as-is.

- [ ] **Step 3: Rename the public config interface and add the generic knobs**

Rename `PrismaCacheExtensionConfig` to `CacheTagsConfig`, and add three fields. The resulting interface:

```ts
export interface CacheTagsConfig {
    /** Enable/disable caching globally (default: true) */
    enabled?: boolean;
    /** Default TTL in seconds when not specified (default: 30) */
    defaultTtlSeconds?: number;
    /** Maximum allowed TTL in seconds (default: 300) */
    maxTtlSeconds?: number;
    /** Key prefix for all cache keys (default: 'prismaCacheTags:v1') */
    keyPrefix?: string;
    /** Cache null results (default: true) */
    cacheNull?: boolean;
    /** Cache empty array results (default: true) */
    cacheEmpty?: boolean;
    /** Bump to invalidate every cache entry after a breaking code change (default: 1) */
    schemaVersion?: number;
    /** Maximum number of tags allowed per query (default: 30) */
    maxTagsPerQuery?: number;
    /** Default stampede protection behaviour */
    stampede?: CacheStampedeOptions;
    /** Models whose caches must also be invalidated when a given model is written */
    dependencyTags?: Record<string, string[] | CacheDependencyResolver>;
    /** Enable automatic tenant/model/entity tag inference (default: true) */
    inferTags?: boolean;
    /**
     * Arg property names that identify the tenant, e.g. ['organizationId', 'accountId'].
     * Default: [] — no tenant scoping, tags fall back to the `global:` namespace.
     */
    tenantKeys?: string[];
    /** Arg property names that identify a single record. Default: ['id'] */
    entityKeys?: string[];
    /** Structured logger. Default: no-op. */
    logger?: Logger;
    /** Metrics sink for cache hit/miss events. Default: no-op. */
    metrics?: Metrics;
}
```

Mirror all of these as required fields on `NormalizedCacheConfig` (`tenantKeys: string[]`, `entityKeys: string[]`, `logger: Logger`, `metrics: Metrics`, and so on).

- [ ] **Step 4: Add the `Logger` and `Metrics` interfaces to `src/types.ts`**

```ts
export type LogData = Record<string, unknown>;

export interface Logger {
    debug(data: LogData, message: string): void;
    info(data: LogData, message: string): void;
    warn(data: LogData, message: string): void;
    error(data: LogData, message: string): void;
}

export interface CacheEvent {
    model: string;
    operation: string;
    result: 'hit' | 'miss';
}

export interface Metrics {
    onCacheEvent(event: CacheEvent): void;
}
```

- [ ] **Step 5: Strip KitCompass from the doc comments**

Every `@example` block in this file references KitCompass models (`prisma.equipment`, `prisma.reservation`, `org:123`). Rewrite them against the neutral fixture vocabulary — `prisma.widget`, `tenant:123`. Then verify:

```bash
grep -ri "kitcompass\|equipment\|reservation\|organizationId" src/types.ts
```

Expected: no output.

- [ ] **Step 6: Write the failing test `tests/unit/observability.test.ts`**

```ts
import { describe, expect, test, vi } from 'vitest';
import { noopLogger, noopMetrics } from '../../src/observability';

describe('observability defaults', () => {
    test('noopLogger exposes all four levels and never throws', () => {
        expect(() => {
            noopLogger.debug({ a: 1 }, 'debug');
            noopLogger.info({ a: 1 }, 'info');
            noopLogger.warn({ a: 1 }, 'warn');
            noopLogger.error({ a: 1 }, 'error');
        }).not.toThrow();
    });

    test('noopMetrics accepts a cache event and never throws', () => {
        expect(() => {
            noopMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'hit' });
        }).not.toThrow();
    });

    test('a custom logger receives structured data and a message', () => {
        const warn = vi.fn();
        const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

        logger.warn({ tag: 'tenant:1' }, 'something happened');

        expect(warn).toHaveBeenCalledWith({ tag: 'tenant:1' }, 'something happened');
    });
});
```

- [ ] **Step 7: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — `Cannot find module '../../src/observability'`.

- [ ] **Step 8: Implement `src/observability.ts`**

```ts
import type { Logger, Metrics } from './types';

export const noopLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

export const noopMetrics: Metrics = {
    onCacheEvent: () => undefined,
};
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
pnpm test:unit && pnpm typecheck
```

Expected: PASS, typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add core types and injectable logger/metrics seams"
```

---

## Task 4: Serialization and cache keys

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/serialization.ts` (ported from `$KC/.../serialization.ts`)
- Create: `~/Workspace/prisma-extension-cache-tags/src/keys.ts` (ported from `$KC/.../keys.ts`)
- Create: `~/Workspace/prisma-extension-cache-tags/tests/unit/fake-redis.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/serialization.test.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/keys.test.ts`

**Interfaces:**
- Consumes: `NormalizedCacheConfig`, `RedisAdapter`, `CachedEnvelope` from Task 3.
- Produces:
  - `serializeCacheEnvelope(value: unknown, fingerprint: string)`, `deserializeCacheEnvelope(serialized)`, `deserializeCachedValue(envelope): unknown`, `stableStringify(value: unknown): string`.
  - `getTagVersionKey(tag: string, config: NormalizedCacheConfig): string`, `getCacheLockKey(cacheKey, config): string`, `computeFingerprint(model, operation, args, tags, config): string`, `getTagVersions(tags, config, redisAdapter): Promise<Array<{ tag: string; version: number }>>`, `generateCacheKey(model, operation, args, tags, config, redisAdapter): Promise<string>`, `removeCacheFromArgs(args: unknown): unknown`.
  - `createFakeRedis(): FakeRedis` test double, where `FakeRedis` is a `RedisAdapter` plus `store: Map<string, string>` and `resetCallCounts()` / `callCounts: Record<string, number>`.

- [ ] **Step 1: Copy both source files unchanged**

```bash
cp "$KC/packages/database/src/lib/cache/serialization.ts" src/serialization.ts
cp "$KC/packages/database/src/lib/cache/keys.ts" src/keys.ts
```

`serialization.ts` needs **no changes** — it imports only `superjson` and `./types`.

`keys.ts` needs one change: delete the now-unused `getModelVersionKey` export if nothing references it (grep first), and confirm imports resolve to `./serialization`, `./tags`, and `./types`.

- [ ] **Step 2: Write the shared in-memory `RedisAdapter` double `tests/unit/fake-redis.ts`**

Every unit test in this plan uses this. It must faithfully implement `INCR` and conditional set/delete semantics.

```ts
import type { RedisAdapter } from '../../src/types';

export interface FakeRedis extends RedisAdapter {
    store: Map<string, string>;
    callCounts: Record<string, number>;
    resetCallCounts(): void;
}

export function createFakeRedis(): FakeRedis {
    const store = new Map<string, string>();
    const callCounts: Record<string, number> = {};

    const count = (name: string) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
    };

    return {
        store,
        callCounts,
        resetCallCounts() {
            for (const key of Object.keys(callCounts)) {
                delete callCounts[key];
            }
        },
        async get<T>(key: string): Promise<T | null> {
            count('get');
            const raw = store.get(key);
            return raw === undefined ? null : (JSON.parse(raw) as T);
        },
        async set(key: string, value: unknown): Promise<void> {
            count('set');
            store.set(key, JSON.stringify(value));
        },
        async delete(key: string): Promise<void> {
            count('delete');
            store.delete(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            count('increment');
            const next = Number(store.get(key) ?? '0') + amount;
            store.set(key, String(next));
            return next;
        },
        async expire(): Promise<void> {
            count('expire');
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            count('mgetString');
            return keys.map((key) => store.get(key) ?? null);
        },
        async setIfNotExists(key: string, value: string): Promise<boolean> {
            count('setIfNotExists');
            if (store.has(key)) {
                return false;
            }
            store.set(key, value);
            return true;
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            count('deleteIfValue');
            if (store.get(key) !== value) {
                return false;
            }
            store.delete(key);
            return true;
        },
    };
}
```

Note the asymmetry: `set`/`get` JSON-encode (they carry structured envelopes), while `mgetString`/`increment`/`setIfNotExists` treat values as raw strings — this matches the real adapter contract in Task 9.

- [ ] **Step 3: Write the failing test `tests/unit/serialization.test.ts`**

The point of superjson is that Prisma's rich scalars survive the round trip. Test exactly that.

```ts
import { describe, expect, test } from 'vitest';
import {
    deserializeCacheEnvelope,
    deserializeCachedValue,
    serializeCacheEnvelope,
    stableStringify,
} from '../../src/serialization';

describe('serialization', () => {
    test('round-trips Date, BigInt, Map, and undefined', () => {
        const value = {
            when: new Date('2026-01-02T03:04:05.000Z'),
            big: 10n ** 20n,
            map: new Map([['a', 1]]),
            missing: undefined,
        };

        const serialized = serializeCacheEnvelope(value, 'fp-1');
        const envelope = deserializeCacheEnvelope(serialized);
        const restored = deserializeCachedValue(envelope) as typeof value;

        expect(envelope.fingerprint).toBe('fp-1');
        expect(restored.when).toBeInstanceOf(Date);
        expect(restored.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
        expect(restored.big).toBe(10n ** 20n);
        expect(restored.map).toBeInstanceOf(Map);
        expect(restored.map.get('a')).toBe(1);
        expect('missing' in (restored as object)).toBe(true);
    });

    test('preserves the fingerprint independently of the value', () => {
        const serialized = serializeCacheEnvelope(null, 'fp-2');
        expect(deserializeCacheEnvelope(serialized).fingerprint).toBe('fp-2');
        expect(deserializeCachedValue(deserializeCacheEnvelope(serialized))).toBeNull();
    });

    test('stableStringify is deterministic for equal values', () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ a: 1, b: 2 }));
    });
});
```

- [ ] **Step 4: Write the failing test `tests/unit/keys.test.ts`**

This test locks in the mechanism that *is the product*: the cache key must change when a tag version is bumped.

```ts
import { beforeEach, describe, expect, test } from 'vitest';
import { computeFingerprint, generateCacheKey, getTagVersionKey } from '../../src/keys';
import { noopLogger, noopMetrics } from '../../src/observability';
import type { NormalizedCacheConfig } from '../../src/types';
import { createFakeRedis, type FakeRedis } from './fake-redis';

const config: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v1',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 1500, pollMs: 50, lockTtlMs: 5000 },
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('cache keys', () => {
    test('are deterministic for identical inputs', async () => {
        const args = { where: { tenantId: 't1' } };
        const a = await generateCacheKey('Widget', 'findMany', args, ['tenant:t1'], config, redis);
        const b = await generateCacheKey('Widget', 'findMany', args, ['tenant:t1'], config, redis);
        expect(a).toBe(b);
    });

    test('differ when the query args differ', async () => {
        const a = await generateCacheKey('Widget', 'findMany', { where: { tenantId: 't1' } }, [], config, redis);
        const b = await generateCacheKey('Widget', 'findMany', { where: { tenantId: 't2' } }, [], config, redis);
        expect(a).not.toBe(b);
    });

    test('change when a tag version is bumped — this is the invalidation mechanism', async () => {
        const args = { where: { tenantId: 't1' } };
        const before = await generateCacheKey('Widget', 'findMany', args, ['tenant:t1'], config, redis);

        await redis.increment(getTagVersionKey('tenant:t1', config), 1);

        const after = await generateCacheKey('Widget', 'findMany', args, ['tenant:t1'], config, redis);
        expect(after).not.toBe(before);
    });

    test('ignore the cache property when computing a fingerprint', () => {
        const withCache = computeFingerprint('Widget', 'findMany', { where: { a: 1 }, cache: { ttlSeconds: 5 } }, [], config);
        const without = computeFingerprint('Widget', 'findMany', { where: { a: 1 } }, [], config);
        expect(withCache).toBe(without);
    });
});
```

- [ ] **Step 5: Run both tests to verify they fail**

```bash
pnpm test:unit
```

Expected: FAIL — `keys.ts` imports `./tags`, which does not exist yet.

- [ ] **Step 6: Add a minimal `src/tags.ts` so `keys.ts` resolves**

`keys.ts` only needs `normalizeTags`. Copy just that function from the source file for now; Task 5 replaces the file wholesale.

```ts
export function normalizeTags(tags: string[] | undefined, maxTags: number): string[] {
    if (!tags || tags.length === 0) {
        return [];
    }

    const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
    return uniqueTags.sort().slice(0, maxTags);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: port superjson serialization and generational cache keys"
```

---

## Task 5: Tag inference and dependency resolution

This task removes the last KitCompass-specific logic: the hardcoded `organizationId` tenant convention and the `Organization` relation special case.

**Files:**
- Modify: `~/Workspace/prisma-extension-cache-tags/src/tags.ts` (replace the Task 4 stub with the full port of `$KC/.../tags.ts`)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/tags.test.ts`

**Interfaces:**
- Consumes: `NormalizedCacheConfig`, `CacheReadOptions`, `CacheWriteOptions`, `ResolvedCacheTags` from Task 3.
- Produces:
  - `normalizeTags(tags: string[] | undefined, maxTags: number): string[]` (already exists from Task 4; keep the signature identical).
  - `resolveCacheTags(model: string, operation: string, args: unknown, options: CacheReadOptions | CacheWriteOptions | undefined, config: NormalizedCacheConfig, includeDependencies: boolean): ResolvedCacheTags` where `ResolvedCacheTags` is `{ tags: string[]; tenantIds: string[]; entityIds: string[] }`.

**Note the rename:** `resolveCacheTags` in the source returns `organizationIds`. That field was already renamed to `tenantIds` on `ResolvedCacheTags` in Task 3 — this task updates the implementation to match.

- [ ] **Step 1: Write the failing test `tests/unit/tags.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { noopLogger, noopMetrics } from '../../src/observability';
import { normalizeTags, resolveCacheTags } from '../../src/tags';
import type { NormalizedCacheConfig } from '../../src/types';

function makeConfig(overrides: Partial<NormalizedCacheConfig> = {}): NormalizedCacheConfig {
    return {
        enabled: true,
        defaultTtlSeconds: 30,
        maxTtlSeconds: 300,
        keyPrefix: 'prismaCacheTags:v1',
        cacheNull: true,
        cacheEmpty: true,
        schemaVersion: 1,
        maxTagsPerQuery: 30,
        stampede: { waitMs: 1500, pollMs: 50, lockTtlMs: 5000 },
        dependencyTags: {},
        inferTags: true,
        tenantKeys: [],
        entityKeys: ['id'],
        logger: noopLogger,
        metrics: noopMetrics,
        ...overrides,
    };
}

describe('normalizeTags', () => {
    test('dedupes, trims, drops empties, and sorts', () => {
        expect(normalizeTags(['  b ', 'a', 'b', '', '   '], 30)).toEqual(['a', 'b']);
    });

    test('truncates to maxTags', () => {
        expect(normalizeTags(['d', 'c', 'b', 'a'], 2)).toEqual(['a', 'b']);
    });

    test('returns an empty array for undefined', () => {
        expect(normalizeTags(undefined, 30)).toEqual([]);
    });
});

describe('resolveCacheTags', () => {
    test('falls back to the global namespace when no tenantKeys are configured', () => {
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, undefined, makeConfig(), false);

        expect(resolved.tags).toContain('global:model:Widget');
        expect(resolved.tenantIds).toEqual([]);
    });

    test('infers tenant, model, and entity tags when tenantKeys is configured', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findUnique', { where: { tenantId: 't1', id: 'w9' } }, undefined, config, false);

        expect(resolved.tenantIds).toEqual(['t1']);
        expect(resolved.entityIds).toEqual(['w9']);
        expect(resolved.tags).toEqual(
            expect.arrayContaining(['tenant:t1', 'tenant:t1:model:Widget', 'tenant:t1:widget:w9']),
        );
    });

    test('extracts tenant ids from a nested relation filter', () => {
        const config = makeConfig({ tenantKeys: ['tenant'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenant: { id: 't7' } } }, undefined, config, false);

        expect(resolved.tenantIds).toEqual(['t7']);
    });

    test('extracts every value from an `in` filter', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: { in: ['t1', 't2'] } } }, undefined, config, false);

        expect(resolved.tenantIds.sort()).toEqual(['t1', 't2']);
    });

    test('merges explicit tags with inferred tags by default', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, { tags: ['custom:thing'] }, config, false);

        expect(resolved.tags).toContain('custom:thing');
        expect(resolved.tags).toContain('tenant:t1:model:Widget');
    });

    test('explicit tags replace inferred tags when mergeTags is false', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' } },
            { tags: ['only:this'], mergeTags: false },
            config,
            false,
        );

        expect(resolved.tags).toEqual(['only:this']);
    });

    test('skips inference entirely when inferTags is false', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'], inferTags: false });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, undefined, config, false);

        expect(resolved.tags).toEqual([]);
    });

    test('adds dependency model tags on writes when includeDependencies is true', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'], dependencyTags: { Widget: ['Part'] } });
        const resolved = resolveCacheTags('Widget', 'update', { where: { tenantId: 't1', id: 'w1' } }, undefined, config, true);

        expect(resolved.tags).toContain('tenant:t1:model:Part');
    });

    test('supports a dependency resolver function', () => {
        const config = makeConfig({
            tenantKeys: ['tenantId'],
            dependencyTags: {
                Widget: ({ tenantIds }) => tenantIds.map((tenantId) => `tenant:${tenantId}:custom`),
            },
        });
        const resolved = resolveCacheTags('Widget', 'update', { where: { tenantId: 't1' } }, undefined, config, true);

        expect(resolved.tags).toContain('tenant:t1:custom');
    });

    test('ignores pagination and projection keys when collecting ids', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' }, select: { id: true }, orderBy: { id: 'asc' }, take: 10 },
            undefined,
            config,
            false,
        );

        expect(resolved.entityIds).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — `resolveCacheTags` is not exported from the Task 4 stub.

- [ ] **Step 3: Port the full `tags.ts`**

```bash
cp "$KC/packages/database/src/lib/cache/tags.ts" src/tags.ts
```

Then apply these five edits:

**(a) Replace the logger import** — delete `import { getChildLogger } from '@kitcompass/logger';` and the `const logger = ...` line. `normalizeTags` used the logger to warn on truncation; it has no config access, so drop that warning (the truncation itself is still tested).

**(b) Delete the hardcoded key sets.** Remove:

```ts
const ORGANIZATION_ID_KEYS = new Set(['organizationId', 'Organization', 'organization']);
const ENTITY_ID_KEYS = new Set(['id']);
```

These become per-call values read from `config.tenantKeys` and `config.entityKeys`, converted to a `Set` inside `resolveCacheTags`.

**(c) Generalise the relation special case.** The source has an `Organization`-specific branch inside `collectStringValues`. Replace it with a general rule: whenever a matched key's value is a plain object, also try its `id` property.

```ts
function addFilterValue(value: unknown, results: Set<string>): void {
    if (typeof value === 'string' || typeof value === 'number') {
        results.add(String(value));
        return;
    }

    if (!isRecord(value)) {
        return;
    }

    const { equals, in: inValue, id } = value as { equals?: unknown; in?: unknown; id?: unknown };

    if (typeof equals === 'string' || typeof equals === 'number') {
        results.add(String(equals));
    }

    // Relation-style filters: { tenant: { id: 't7' } }
    if (typeof id === 'string' || typeof id === 'number') {
        results.add(String(id));
    }

    if (Array.isArray(inValue)) {
        for (const item of inValue) {
            if (typeof item === 'string' || typeof item === 'number') {
                results.add(String(item));
            }
        }
    }
}
```

Then simplify the matched-key branch in `collectStringValues` to just `addFilterValue(child, results)` — the `Organization`/`organization` conditional is no longer needed.

**(d) Rename the tag builders and the `organizationIds` variable.**

```ts
function createModelTag(model: string, tenantId?: string): string {
    return tenantId ? `tenant:${tenantId}:model:${model}` : `global:model:${model}`;
}

function createEntityTag(model: string, entityId: string, tenantId?: string): string {
    const normalizedModel = model.charAt(0).toLowerCase() + model.slice(1);
    return tenantId ? `tenant:${tenantId}:${normalizedModel}:${entityId}` : `global:${normalizedModel}:${entityId}`;
}
```

Rename `organizationIds` → `tenantIds` everywhere, including the root tag `tenant:${tenantId}` (was `org:${organizationId}`) and the `resolveDependencyTags` signature.

**(e) Read the key sets from config** inside `resolveCacheTags`:

```ts
const tenantKeys = new Set(config.tenantKeys);
const entityKeys = new Set(config.entityKeys);
const tenantIds = shouldInfer && tenantKeys.size > 0 ? Array.from(collectStringValues(args, tenantKeys)) : [];
const entityIds = shouldInfer ? Array.from(collectStringValues(args, entityKeys)) : [];
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test:unit && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Verify no KitCompass vocabulary survived**

```bash
grep -rin "kitcompass\|organization" src/
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: generalise tag inference with configurable tenant and entity keys"
```

---

## Task 6: Invalidation and the deferred-flush context

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/invalidation.ts` (ported from `$KC/.../invalidation.ts`)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/invalidation.test.ts`

**Interfaces:**
- Consumes: `getTagVersionKey` (Task 4), `NormalizedCacheConfig`, `RedisAdapter` (Task 3).
- Produces:
  - `bumpTagVersions(tags: string[], config: NormalizedCacheConfig, redisAdapter: RedisAdapter): Promise<void>`
  - `publishInvalidation(tags: string[], config: NormalizedCacheConfig, redisAdapter: RedisAdapter): Promise<void>`
  - `runWithInvalidationContext<T>(callback: () => Promise<T>, flush: (tags: string[]) => Promise<void>): Promise<T>`
  - `getActiveInvalidationContext(): { tags: Set<string> } | undefined`
  - `withCacheInvalidation<T>(fn: () => Promise<T>, redisAdapter: RedisAdapter, config?: CacheTagsConfig): Promise<T>` — **new in this port**, the public escape hatch, and the required fallback if the Task 2 `$transaction` spike failed. Note it takes the **public** `CacheTagsConfig`, not the internal `NormalizedCacheConfig`, and normalizes internally — it is exported to consumers in Task 10, so it must be callable using only public types.

- [ ] **Step 1: Write the failing test `tests/unit/invalidation.test.ts`**

```ts
import { beforeEach, describe, expect, test } from 'vitest';
import {
    bumpTagVersions,
    getActiveInvalidationContext,
    publishInvalidation,
    runWithInvalidationContext,
} from '../../src/invalidation';
import { getTagVersionKey } from '../../src/keys';
import { noopLogger, noopMetrics } from '../../src/observability';
import type { NormalizedCacheConfig } from '../../src/types';
import { createFakeRedis, type FakeRedis } from './fake-redis';

const config: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v1',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 1500, pollMs: 50, lockTtlMs: 5000 },
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('bumpTagVersions', () => {
    test('increments each tag version exactly once', async () => {
        await bumpTagVersions(['tenant:t1', 'tenant:t1:model:Widget'], config, redis);

        expect(redis.store.get(getTagVersionKey('tenant:t1', config))).toBe('1');
        expect(redis.store.get(getTagVersionKey('tenant:t1:model:Widget', config))).toBe('1');
    });

    test('dedupes repeated tags', async () => {
        await bumpTagVersions(['tenant:t1', 'tenant:t1'], config, redis);
        expect(redis.store.get(getTagVersionKey('tenant:t1', config))).toBe('1');
    });

    test('is a no-op for an empty tag list', async () => {
        await bumpTagVersions([], config, redis);
        expect(redis.callCounts.increment).toBeUndefined();
    });

    test('invalidation cost is one increment per tag, independent of cached key count', async () => {
        for (let index = 0; index < 500; index += 1) {
            redis.store.set(`prismaCacheTags:v1:qry:Widget:findMany:key${index}`, '"cached"');
        }
        redis.resetCallCounts();

        await bumpTagVersions(['tenant:t1'], config, redis);

        expect(redis.callCounts.increment).toBe(1);
        expect(redis.callCounts.delete ?? 0).toBe(0);
    });
});

describe('deferred invalidation context', () => {
    test('buffers tags inside the context and flushes once on completion', async () => {
        const flushed: string[][] = [];

        await runWithInvalidationContext(
            async () => {
                await publishInvalidation(['tenant:t1'], config, redis);
                await publishInvalidation(['tenant:t1', 'tenant:t2'], config, redis);
            },
            async (tags) => {
                flushed.push([...tags].sort());
            },
        );

        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toEqual(['tenant:t1', 'tenant:t2']);
        // Nothing was bumped during the context itself.
        expect(redis.callCounts.increment).toBeUndefined();
    });

    test('bumps immediately when no context is active', async () => {
        await publishInvalidation(['tenant:t1'], config, redis);
        expect(redis.store.get(getTagVersionKey('tenant:t1', config))).toBe('1');
    });

    test('does not flush when the callback throws', async () => {
        const flushed: string[][] = [];

        await expect(
            runWithInvalidationContext(
                async () => {
                    await publishInvalidation(['tenant:t1'], config, redis);
                    throw new Error('rollback');
                },
                async (tags) => {
                    flushed.push(tags);
                },
            ),
        ).rejects.toThrow('rollback');

        expect(flushed).toHaveLength(0);
        expect(redis.store.get(getTagVersionKey('tenant:t1', config))).toBeUndefined();
    });

    test('exposes no context outside of a run', () => {
        expect(getActiveInvalidationContext()).toBeUndefined();
    });
});
```

The "does not flush when the callback throws" test encodes the correctness property that makes this transaction-safe: a rolled-back transaction must not invalidate.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — module `../../src/invalidation` not found.

- [ ] **Step 3: Port `invalidation.ts`**

```bash
cp "$KC/packages/database/src/lib/cache/invalidation.ts" src/invalidation.ts
```

Apply these edits:

**(a)** Delete the `@kitcompass/logger` import and the module-level `logger`. Replace the debug call inside `bumpTagVersions` with `config.logger.debug(...)`.

**(b)** Add the public wrapper at the end of the file:

```ts
export async function withCacheInvalidation<T>(
    fn: () => Promise<T>,
    redisAdapter: RedisAdapter,
    config?: CacheTagsConfig,
): Promise<T> {
    const normalized = normalizeConfig(config);

    return runWithInvalidationContext(fn, async (tags) => {
        try {
            await bumpTagVersions(tags, normalized, redisAdapter);
        } catch (error) {
            normalized.logger.error({ tags, error: (error as Error).message }, 'Deferred cache invalidation failed');
        }
    });
}
```

`normalizeConfig` lives in `src/extension.ts` (Task 8) and `src/extension.ts` imports from `src/invalidation.ts`, so importing it here would be circular. Move `normalizeConfig` and `DEFAULT_CONFIG` into a new `src/config.ts` that both files import, and have Task 8 re-export `normalizeConfig` from `src/extension.ts` so the Task 8 and Task 12 imports in this plan keep working unchanged.

**(c)** Confirm the existing `runWithInvalidationContext` awaits the callback *before* flushing, so a thrown error propagates without flushing. The source already does this — do not add a `try/finally`, which would break the rollback property the test asserts.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test:unit && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: port generational invalidation with transaction-deferred flush"
```

---

## Task 7: Distributed single-flight lock

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/locks.ts` (ported from `$KC/.../locks.ts`)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: `getCacheLockKey` (Task 4), `CacheReadOptions`, `NormalizedCacheConfig`, `RedisAdapter` (Task 3).
- Produces:
  - `interface CacheLock { key: string; token: string }`
  - `acquireCacheLock(cacheKey, options, config, redisAdapter): Promise<CacheLock | null>`
  - `releaseCacheLock(lock: CacheLock, redisAdapter: RedisAdapter, config: NormalizedCacheConfig): Promise<void>` — note the third parameter, added in this port so lock-release failures stay observable through the injected logger
  - `waitForCachedValue<T>(cacheKey, options, config, redisAdapter, getCachedValue: () => Promise<T | undefined>): Promise<T | undefined>`

- [ ] **Step 1: Write the failing test `tests/unit/locks.test.ts`**

```ts
import { beforeEach, describe, expect, test } from 'vitest';
import { getCacheLockKey } from '../../src/keys';
import { acquireCacheLock, releaseCacheLock, waitForCachedValue } from '../../src/locks';
import { noopLogger, noopMetrics } from '../../src/observability';
import type { NormalizedCacheConfig } from '../../src/types';
import { createFakeRedis, type FakeRedis } from './fake-redis';

const config: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v1',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 200, pollMs: 10, lockTtlMs: 5000 },
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('cache locks', () => {
    test('the first caller acquires and the second is refused', async () => {
        const first = await acquireCacheLock('key-1', undefined, config, redis);
        const second = await acquireCacheLock('key-1', undefined, config, redis);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    test('releasing allows a subsequent acquire', async () => {
        const first = await acquireCacheLock('key-1', undefined, config, redis);
        expect(first).not.toBeNull();

        await releaseCacheLock(first!, redis, config);

        expect(await acquireCacheLock('key-1', undefined, config, redis)).not.toBeNull();
    });

    test('release only removes a lock the caller owns', async () => {
        const lock = await acquireCacheLock('key-1', undefined, config, redis);
        expect(lock).not.toBeNull();

        await releaseCacheLock({ key: lock!.key, token: 'someone-elses-token' }, redis, config);

        expect(redis.store.has(getCacheLockKey('key-1', config))).toBe(true);
    });

    test('returns null when the adapter cannot do conditional set', async () => {
        const withoutSetNx = { ...redis, setIfNotExists: undefined };
        expect(await acquireCacheLock('key-1', undefined, config, withoutSetNx)).toBeNull();
    });

    test('waitForCachedValue resolves once the value appears', async () => {
        let value: string | undefined;
        setTimeout(() => {
            value = 'populated';
        }, 30);

        const result = await waitForCachedValue('key-1', undefined, config, redis, async () => value);
        expect(result).toBe('populated');
    });

    test('waitForCachedValue gives up after waitMs', async () => {
        const startedAt = Date.now();
        const result = await waitForCachedValue('key-1', undefined, config, redis, async () => undefined);

        expect(result).toBeUndefined();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    });

    test('per-query stampede options override the config defaults', async () => {
        const startedAt = Date.now();
        const result = await waitForCachedValue(
            'key-1',
            { stampede: { waitMs: 50, pollMs: 10 } },
            config,
            redis,
            async () => undefined,
        );

        expect(result).toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(150);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — module `../../src/locks` not found.

- [ ] **Step 3: Port `locks.ts`**

```bash
cp "$KC/packages/database/src/lib/cache/locks.ts" src/locks.ts
```

Apply one edit: delete the `@kitcompass/logger` import and the module-level `logger`, and route both log calls through `config.logger`. `waitForCachedValue` already receives `config`; `releaseCacheLock` does not, so **add `config: NormalizedCacheConfig` as its third parameter** and log the release failure through `config.logger.warn`.

Resulting signature: `releaseCacheLock(lock: CacheLock, redisAdapter: RedisAdapter, config: NormalizedCacheConfig): Promise<void>`. The Step 1 test already calls it with three arguments, and Task 8 passes `config` at the call site.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test:unit && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: port distributed single-flight cache lock"
```

---

## Task 8: Extension assembly

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/extension.ts` (ported from `$KC/.../prisma-cache-extension.ts`)
- Create: `~/Workspace/prisma-extension-cache-tags/src/config.ts` (`DEFAULT_CONFIG` + `normalizeConfig`, extracted here so `src/invalidation.ts` can use them without a circular import — see Task 6)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/extension.test.ts`

**Note:** Task 6 already created `src/config.ts` if it needed it first. If it exists, use it rather than creating a second copy; put `DEFAULT_CONFIG` and `normalizeConfig` there and have `src/extension.ts` re-export `normalizeConfig` so `import { normalizeConfig } from '../../src/extension'` keeps working in this task's tests and in Task 12.

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces:
  - `createCacheTagsExtension(redisAdapter: RedisAdapter, config?: CacheTagsConfig)` — the primary export, returning the value of `Prisma.defineExtension(...)`.
  - `normalizeConfig(config?: CacheTagsConfig): NormalizedCacheConfig` (exported for tests and for `withCacheInvalidation` wiring).

- [ ] **Step 1: Write the failing test `tests/unit/extension.test.ts`**

This tests the read/write routing logic directly against the exported helpers, without needing a real Prisma client. Extract the operation handlers so they are unit-testable: `readThroughCache` and `handleWrite` must be exported from `src/extension.ts`.

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleWrite, normalizeConfig, readThroughCache } from '../../src/extension';
import { getTagVersionKey } from '../../src/keys';
import { createFakeRedis, type FakeRedis } from './fake-redis';

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('normalizeConfig', () => {
    test('applies generic defaults with no KitCompass model graph', () => {
        const config = normalizeConfig();

        expect(config.dependencyTags).toEqual({});
        expect(config.tenantKeys).toEqual([]);
        expect(config.entityKeys).toEqual(['id']);
        expect(config.keyPrefix).toBe('prismaCacheTags:v1');
        expect(config.enabled).toBe(true);
    });

    test('merges nested stampede options rather than replacing them', () => {
        const config = normalizeConfig({ stampede: { waitMs: 99 } });

        expect(config.stampede.waitMs).toBe(99);
        expect(config.stampede.pollMs).toBe(50);
        expect(config.stampede.lockTtlMs).toBe(5000);
    });
});

describe('readThroughCache', () => {
    test('misses, calls the query, and populates the cache', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.set).toBe(1);
    });

    test('serves the second identical read from cache without calling the query', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        const second = await readThroughCache(params);

        expect(second).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('clamps the TTL to maxTtlSeconds', async () => {
        const config = normalizeConfig({ maxTtlSeconds: 10 });
        const set = vi.spyOn(redis, 'set');

        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([]),
            cacheOptions: { ttlSeconds: 9999 },
            config,
            redisAdapter: redis,
        });

        expect(set).toHaveBeenCalledWith(expect.any(String), expect.anything(), 10);
    });

    test('falls back to the query when the cache read throws', async () => {
        const config = normalizeConfig();
        vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('does not cache empty results when cacheEmpty is false', async () => {
        const config = normalizeConfig({ cacheEmpty: false });

        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([]),
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(redis.callCounts.set ?? 0).toBe(0);
    });

    test('reports hit and miss to the metrics sink', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ metrics: { onCacheEvent } });
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([{ id: 'w1' }]),
            cacheOptions: {},
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        await readThroughCache(params);

        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss' });
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'hit' });
    });
});

describe('handleWrite', () => {
    test('runs the write then bumps the resolved tag versions', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue({ id: 'w1' });

        const result = await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't1', id: 'w1' } },
            cleanedArgs: { where: { tenantId: 't1', id: 'w1' } },
            query,
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual({ id: 'w1' });
        expect(redis.store.get(getTagVersionKey('tenant:t1:model:Widget', config))).toBe('1');
    });

    test('a write invalidates a previously cached read of the same tenant and model', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        expect(readQuery).toHaveBeenCalledTimes(1);

        await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't1', id: 'w1' } },
            cleanedArgs: { where: { tenantId: 't1', id: 'w1' } },
            query: vi.fn().mockResolvedValue({ id: 'w1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        await readThroughCache(readParams);

        // The tag version bump changed the key, so the read had to hit the database again.
        expect(readQuery).toHaveBeenCalledTimes(2);
    });

    test('a write to an unrelated tenant does not invalidate', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't2', id: 'w2' } },
            cleanedArgs: { where: { tenantId: 't2', id: 'w2' } },
            query: vi.fn().mockResolvedValue({ id: 'w2' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        await readThroughCache(readParams);

        expect(readQuery).toHaveBeenCalledTimes(1);
    });

    test('a dependency tag propagates invalidation across models', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'], dependencyTags: { Part: ['Widget'] } });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        await handleWrite({
            model: 'Part',
            operation: 'create',
            args: { data: { tenantId: 't1', label: 'p1' } },
            cleanedArgs: { data: { tenantId: 't1', label: 'p1' } },
            query: vi.fn().mockResolvedValue({ id: 'p1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        await readThroughCache(readParams);

        expect(readQuery).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — module `../../src/extension` not found.

- [ ] **Step 3: Port `extension.ts`**

```bash
cp "$KC/packages/database/src/lib/cache/prisma-cache-extension.ts" src/extension.ts
```

Apply these edits:

**(a) Imports.** Replace the first four imports:

```ts
import { Prisma } from '@prisma/client/extension';
import hash from 'hash-object';
```

Delete the `@kitcompass/logger` and `@kitcompass/telemetry` imports and the module-level `logger` / `prismaCacheCounter` constants. Update the remaining relative imports to `./invalidation`, `./keys`, `./locks`, `./serialization`, `./tags`, `./types`.

**(b) Rename the factory** from `createCachedPrismaExtension` to `createCacheTagsExtension`, and rename the extension's `name` field to `'prisma-extension-cache-tags'`.

**(c) Replace `DEFAULT_CONFIG` with generic defaults.** The source hardcodes nine KitCompass models in `dependencyTags`. The replacement:

```ts
const DEFAULT_CONFIG: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v1',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 1_500, pollMs: 50, lockTtlMs: 5_000 },
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};
```

Import `noopLogger` and `noopMetrics` from `./observability`.

**(d) Export `normalizeConfig`, `readThroughCache`, and `handleWrite`.** They are module-private in the source; add `export` to each so the unit tests can drive them.

**(e) Replace every logging call** `logger.warn(...)` / `logger.debug(...)` / `logger.error(...)` with `config.logger.warn(...)` etc. In `tryGetCachedValue`, which does not currently receive `config`... it does — `config` is already a parameter. Good.

**(f) Replace the telemetry counter** with the metrics hook:

```ts
config.metrics.onCacheEvent({ model, operation, result: 'hit' });
// and
config.metrics.onCacheEvent({ model, operation, result: 'miss' });
```

**(g) Update the `releaseCacheLock` call** to pass `config` as the third argument (per Task 7).

**(h) `$transaction` handling.** If the Task 2 spike **passed**, keep the existing monkey-patch, changing only the flush body to use `config.logger.error`. If the spike **failed**, delete the entire `clientWithTransaction` block, `return extendedClient` directly, and instead re-export `withCacheInvalidation` bound to the configured adapter from `src/index.ts` in Task 10.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test:unit && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Verify no host-application coupling remains**

```bash
grep -rin "kitcompass\|@kitcompass" src/
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: assemble the cache-tags prisma extension"
```

---

## Task 9: Built-in Redis adapters

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/src/adapters/node-redis.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/src/adapters/ioredis.ts`
- Modify: `~/Workspace/prisma-extension-cache-tags/tsup.config.ts` (restore the two adapter entries commented out in Task 1)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/integration/adapters.test.ts`

**Interfaces:**
- Consumes: `RedisAdapter` from Task 3.
- Produces:
  - `createNodeRedisAdapter(client: NodeRedisClientLike): RedisAdapter`
  - `createIoRedisAdapter(client: IoRedisClientLike): RedisAdapter`

Both adapters must implement **all eight** methods including the optional `setIfNotExists` and `deleteIfValue` — without them the distributed lock silently degrades to no stampede protection, which is one of the package's headline features.

Neither file may `import` the client package at runtime. Type the client structurally so a user with only `ioredis` installed never resolves `redis`.

- [ ] **Step 1: Write the failing test `tests/integration/adapters.test.ts`**

This is an integration test because it exercises real Redis semantics (`SET NX PX`, `INCR`, `MGET`).

```ts
import { createClient } from 'redis';
import IoRedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createIoRedisAdapter } from '../../src/adapters/ioredis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import type { RedisAdapter } from '../../src/types';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

const nodeRedisClient = createClient({ url: REDIS_URL });
const ioRedisClient = new IoRedis(REDIS_URL);

await nodeRedisClient.connect();

const cases: Array<[string, RedisAdapter]> = [
    ['node-redis', createNodeRedisAdapter(nodeRedisClient)],
    ['ioredis', createIoRedisAdapter(ioRedisClient)],
];

afterAll(async () => {
    await nodeRedisClient.flushDb();
    await nodeRedisClient.quit();
    ioRedisClient.disconnect();
});

beforeEach(async () => {
    await nodeRedisClient.flushDb();
});

describe.each(cases)('%s adapter', (_name, adapter) => {
    test('set and get round-trip a structured value', async () => {
        await adapter.set('k1', { a: 1, b: ['x'] }, 60);
        expect(await adapter.get('k1')).toEqual({ a: 1, b: ['x'] });
    });

    test('get returns null for a missing key', async () => {
        expect(await adapter.get('nope')).toBeNull();
    });

    test('delete removes a key', async () => {
        await adapter.set('k1', { a: 1 }, 60);
        await adapter.delete('k1');
        expect(await adapter.get('k1')).toBeNull();
    });

    test('increment starts at the amount and accumulates', async () => {
        expect(await adapter.increment('counter', 1)).toBe(1);
        expect(await adapter.increment('counter', 2)).toBe(3);
    });

    test('mgetString returns raw strings and nulls positionally', async () => {
        await adapter.increment('ver:a', 5);
        expect(await adapter.mgetString(['ver:a', 'ver:missing'])).toEqual(['5', null]);
    });

    test('mgetString returns an empty array for no keys', async () => {
        expect(await adapter.mgetString([])).toEqual([]);
    });

    test('setIfNotExists succeeds once then refuses', async () => {
        expect(await adapter.setIfNotExists!('lock', 'token-1', 5000)).toBe(true);
        expect(await adapter.setIfNotExists!('lock', 'token-2', 5000)).toBe(false);
    });

    test('deleteIfValue only deletes on a token match', async () => {
        await adapter.setIfNotExists!('lock', 'token-1', 5000);

        expect(await adapter.deleteIfValue!('lock', 'wrong')).toBe(false);
        expect(await adapter.deleteIfValue!('lock', 'token-1')).toBe(true);
        expect(await adapter.setIfNotExists!('lock', 'token-3', 5000)).toBe(true);
    });

    test('expire sets a ttl that redis reports', async () => {
        await adapter.set('k1', { a: 1 });
        await adapter.expire('k1', 100);
        expect(await nodeRedisClient.ttl('k1')).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Install the peer packages as devDependencies and run the test**

```bash
pnpm add -D redis@^6.2.1 ioredis@^6.0.0
pnpm db:up
pnpm test:integration
```

Expected: FAIL — adapter modules not found.

- [ ] **Step 3: Implement `src/adapters/node-redis.ts`**

```ts
import type { RedisAdapter } from '../types';

/** Structural type for the `redis` (node-redis) client. Avoids a runtime import. */
export interface NodeRedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number; NX?: boolean; PX?: number }): Promise<string | null>;
    del(key: string): Promise<number>;
    incrBy(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<boolean | number>;
    mGet(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export function createNodeRedisAdapter(client: NodeRedisClientLike): RedisAdapter {
    return {
        async get<T>(key: string): Promise<T | null> {
            const raw = await client.get(key);
            return raw === null ? null : (JSON.parse(raw) as T);
        },
        async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
            const payload = JSON.stringify(value);
            await (ttlSeconds ? client.set(key, payload, { EX: ttlSeconds }) : client.set(key, payload));
        },
        async delete(key: string): Promise<void> {
            await client.del(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            return client.incrBy(key, amount);
        },
        async expire(key: string, ttlSeconds: number): Promise<void> {
            await client.expire(key, ttlSeconds);
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            return keys.length === 0 ? [] : client.mGet(keys);
        },
        async setIfNotExists(key: string, value: string, ttlMs: number): Promise<boolean> {
            const result = await client.set(key, value, { NX: true, PX: ttlMs });
            return result === 'OK';
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            const deleted = await client.eval(RELEASE_IF_VALUE, { keys: [key], arguments: [value] });
            return Number(deleted) === 1;
        },
    };
}
```

- [ ] **Step 4: Implement `src/adapters/ioredis.ts`**

```ts
import type { RedisAdapter } from '../types';

/** Structural type for the `ioredis` client. Avoids a runtime import. */
export interface IoRedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<string | null>;
    del(key: string): Promise<number>;
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    mget(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export function createIoRedisAdapter(client: IoRedisClientLike): RedisAdapter {
    return {
        async get<T>(key: string): Promise<T | null> {
            const raw = await client.get(key);
            return raw === null ? null : (JSON.parse(raw) as T);
        },
        async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
            const payload = JSON.stringify(value);
            if (ttlSeconds) {
                await client.set(key, payload, 'EX', ttlSeconds);
                return;
            }
            await client.set(key, payload);
        },
        async delete(key: string): Promise<void> {
            await client.del(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            return client.incrby(key, amount);
        },
        async expire(key: string, ttlSeconds: number): Promise<void> {
            await client.expire(key, ttlSeconds);
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            return keys.length === 0 ? [] : client.mget(keys);
        },
        async setIfNotExists(key: string, value: string, ttlMs: number): Promise<boolean> {
            const result = await client.set(key, value, 'PX', ttlMs, 'NX');
            return result === 'OK';
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            const deleted = await client.eval(RELEASE_IF_VALUE, 1, key, value);
            return Number(deleted) === 1;
        },
    };
}
```

- [ ] **Step 5: Restore the adapter entries in `tsup.config.ts`**

Uncomment the `'adapters/node-redis'` and `'adapters/ioredis'` entries added in Task 1 and delete the `// restored in Task 9` comment.

- [ ] **Step 6: Run the tests and build**

```bash
pnpm test:integration && pnpm build && pnpm typecheck
```

Expected: all adapter tests PASS for both clients; `dist/adapters/*.js`, `*.mjs`, `*.d.ts`, `*.d.mts` all exist.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add built-in node-redis and ioredis adapters"
```

---

## Task 10: Public API surface

**Files:**
- Modify: `~/Workspace/prisma-extension-cache-tags/src/index.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/src/cache-tags.ts` (ported from `$KC/.../cache-tags.ts`)
- Test: `~/Workspace/prisma-extension-cache-tags/tests/unit/public-api.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces the complete public API. Nothing outside this list is supported:
  - `createCacheTagsExtension`
  - `withCacheInvalidation`
  - `createCacheTags` (tag-builder helpers)
  - types: `RedisAdapter`, `Logger`, `Metrics`, `CacheEvent`, `CacheTagsConfig`, `CacheReadOptions`, `CacheWriteOptions`, `CacheDependencyResolver`, `CacheStampedeOptions`, `ExtendedModel`

- [ ] **Step 1: Port and genericise `cache-tags.ts`**

```bash
cp "$KC/packages/database/src/lib/cache/cache-tags.ts" src/cache-tags.ts
```

Rewrite the helpers to match the tag format fixed in the Global Constraints, and rewrite every doc comment away from KitCompass vocabulary. The resulting API:

```ts
export const createCacheTags = {
    /** All cached reads for a tenant: `tenant:<tenantId>` */
    forTenant(tenantId: string): string[] {
        return [`tenant:${tenantId}`];
    },
    /** All cached reads of a model within a tenant, or globally when tenantId is omitted */
    forModel(tenantId: string | undefined, model: string): string[] {
        return [tenantId ? `tenant:${tenantId}:model:${model}` : `global:model:${model}`];
    },
    /** A single record: `tenant:<tenantId>:<model>:<entityId>` */
    forEntity(tenantId: string | undefined, model: string, entityId: string): string[] {
        const normalizedModel = model.charAt(0).toLowerCase() + model.slice(1);
        return [tenantId ? `tenant:${tenantId}:${normalizedModel}:${entityId}` : `global:${normalizedModel}:${entityId}`];
    },
    /** Combine several tag lists into one deduped list */
    combine(...tagLists: string[][]): string[] {
        return Array.from(new Set(tagLists.flat()));
    },
};
```

- [ ] **Step 2: Write the failing test `tests/unit/public-api.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import * as api from '../../src/index';

describe('public api', () => {
    test('exports the extension factory and invalidation wrapper', () => {
        expect(typeof api.createCacheTagsExtension).toBe('function');
        expect(typeof api.withCacheInvalidation).toBe('function');
    });

    test('tag helpers produce the documented formats', () => {
        expect(api.createCacheTags.forTenant('t1')).toEqual(['tenant:t1']);
        expect(api.createCacheTags.forModel('t1', 'Widget')).toEqual(['tenant:t1:model:Widget']);
        expect(api.createCacheTags.forModel(undefined, 'Widget')).toEqual(['global:model:Widget']);
        expect(api.createCacheTags.forEntity('t1', 'Widget', 'w9')).toEqual(['tenant:t1:widget:w9']);
        expect(api.createCacheTags.forEntity(undefined, 'Widget', 'w9')).toEqual(['global:widget:w9']);
    });

    test('combine dedupes across lists', () => {
        expect(
            api.createCacheTags.combine(api.createCacheTags.forTenant('t1'), api.createCacheTags.forTenant('t1')),
        ).toEqual(['tenant:t1']);
    });

    test('does not leak internal helpers', () => {
        expect('readThroughCache' in api).toBe(false);
        expect('handleWrite' in api).toBe(false);
        expect('bumpTagVersions' in api).toBe(false);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm test:unit
```

Expected: FAIL — `createCacheTagsExtension` is not exported from `src/index.ts` (it still only exports `VERSION`).

- [ ] **Step 4: Write `src/index.ts`**

```ts
export { createCacheTags } from './cache-tags';
export { createCacheTagsExtension } from './extension';
export { withCacheInvalidation } from './invalidation';
export type {
    CacheDependencyResolver,
    CacheEvent,
    CacheReadOptions,
    CacheStampedeOptions,
    CacheTagsConfig,
    CacheWriteOptions,
    ExtendedModel,
    Logger,
    Metrics,
    RedisAdapter,
} from './types';
```

Delete the `VERSION` placeholder and the Task 1 smoke test that asserted it.

`withCacheInvalidation` takes `(fn, redisAdapter, config?)` and normalizes the config internally, so it is callable using only public types. Document it in the README (Task 15), and if the Task 2 spike failed, document it as the **required** way to get transaction-deferred invalidation rather than as an escape hatch.

- [ ] **Step 5: Run all tests and build**

```bash
pnpm test:unit && pnpm build && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: define the public api surface and tag helpers"
```

---

## Task 11: Integration tests against real Prisma, Postgres, and Redis

The unit tests prove the mechanism against a fake adapter. These prove the extension actually works when wired into a real Prisma 7 client — including the two things a fake cannot show: real query interception and real transaction semantics.

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/tests/integration/helpers.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/integration/caching.test.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/integration/transactions.test.ts`
- Test: `~/Workspace/prisma-extension-cache-tags/tests/integration/stampede.test.ts`

**Interfaces:**
- Consumes: `createTestPrismaClient` (Task 2), `createNodeRedisAdapter` (Task 9), `createCacheTagsExtension` (Task 8).
- Produces: `createCachedClient(config?: CacheTagsConfig)` and `countQueries()` helpers in `tests/integration/helpers.ts`.

- [ ] **Step 1: Write `tests/integration/helpers.ts`**

Counting real database round-trips is how these tests distinguish a cache hit from a miss. Use Prisma's `$on('query')`... which requires `log: [{ emit: 'event', level: 'query' }]`. Simpler and more robust: count through a second extension layered beneath the cache extension.

```ts
import { createClient } from 'redis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { createCacheTagsExtension } from '../../src/extension';
import type { CacheTagsConfig } from '../../src/types';
import { createTestPrismaClient } from '../fixture/client';

export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

export async function createRedis() {
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    return client;
}

export interface QueryCounter {
    total: number;
    byModel: Record<string, number>;
    reset(): void;
}

export function createQueryCounter(): QueryCounter {
    return {
        total: 0,
        byModel: {},
        reset() {
            this.total = 0;
            this.byModel = {};
        },
    };
}

export function createCachedClient(
    redisClient: Awaited<ReturnType<typeof createRedis>>,
    counter: QueryCounter,
    config: CacheTagsConfig = {},
) {
    const base = createTestPrismaClient();

    // Counting layer sits closest to the database, so it only sees queries the
    // cache layer actually let through.
    const counted = base.$extends({
        name: 'query-counter',
        query: {
            async $allOperations({ model, args, query }) {
                counter.total += 1;
                if (model) {
                    counter.byModel[model] = (counter.byModel[model] ?? 0) + 1;
                }
                return query(args);
            },
        },
    });

    return counted.$extends(
        createCacheTagsExtension(createNodeRedisAdapter(redisClient), {
            tenantKeys: ['tenantId'],
            ...config,
        }),
    );
}
```

**Important ordering note:** Prisma applies extensions outermost-last, so `counted.$extends(cacheExtension)` puts the cache layer *above* the counter. A cache hit short-circuits before the counter runs. Verify this ordering holds in Step 3's first test — if the counter increments on a cache hit, swap the order.

- [ ] **Step 2: Write the failing test `tests/integration/caching.test.ts`**

```ts
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);

afterAll(async () => {
    await redis.flushDb();
    await redis.quit();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await redis.flushDb();
    await prisma.part.deleteMany();
    await prisma.widget.deleteMany();
    counter.reset();
});

describe('read-through caching', () => {
    test('an uncached read hits the database every time', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' } });

        expect(counter.byModel.Widget).toBe(2);
    });

    test('a cached read hits the database once', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        const first = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const second = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(second).toEqual(first);
        expect(counter.byModel.Widget).toBe(1);
    });

    test('the cached result is structurally identical to the database result', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        const fresh = await prisma.widget.findMany({ where: { tenantId: 't1' } });
        const cachedMiss = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const cachedHit = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(cachedMiss).toEqual(fresh);
        expect(cachedHit).toEqual(fresh);
    });

    test('a write to the same tenant and model invalidates the cached read', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w2' } });

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(after).toHaveLength(2);
        expect(counter.byModel.Widget).toBe(3); // initial read + create + re-read
    });

    test('a write to a different tenant does not invalidate', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + cache hit (0)
        expect(counter.byModel.Widget).toBe(2);
    });

    test('dependency tags invalidate across models', async () => {
        const dependent = createCachedClient(redis, counter, { dependencyTags: { Part: ['Widget'] } });
        const widget = await dependent.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await dependent.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await dependent.part.create({ data: { tenantId: 't1', label: 'p1', widgetId: widget.id } });
        await dependent.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(counter.byModel.Widget).toBe(2); // the Part write forced a Widget re-read
        await dependent.$disconnect();
    });

    test('findUnique caches per entity', async () => {
        const widget = await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findUnique({ where: { id: widget.id }, cache: { ttlSeconds: 60 } });
        await prisma.widget.findUnique({ where: { id: widget.id }, cache: { ttlSeconds: 60 } });

        expect(counter.byModel.Widget).toBe(1);
    });

    test('count is cacheable', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        expect(await prisma.widget.count({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } })).toBe(1);
        expect(await prisma.widget.count({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } })).toBe(1);
        expect(counter.byModel.Widget).toBe(1);
    });

    test('cache: { enabled: false } bypasses the cache entirely', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { enabled: false } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { enabled: false } });

        expect(counter.byModel.Widget).toBe(2);
    });

    test('a ttl of 1 second expires', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 1 } });

        expect(counter.byModel.Widget).toBe(2);
    });
});
```

- [ ] **Step 3: Run it and confirm the extension ordering assumption**

```bash
pnpm db:up && pnpm test:integration
```

Expected: FAIL initially (helpers not yet written / ordering wrong). Fix the ordering per the note in Step 1 until all tests PASS.

- [ ] **Step 4: Write `tests/integration/transactions.test.ts`**

This is the differentiator no competitor has. If the Task 2 spike failed, rewrite these to wrap with `withCacheInvalidation` and note that in the file header.

```ts
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);

afterAll(async () => {
    await redis.flushDb();
    await redis.quit();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await redis.flushDb();
    await prisma.part.deleteMany();
    await prisma.widget.deleteMany();
    counter.reset();
});

describe('transaction-aware invalidation', () => {
    test('a committed transaction invalidates once, after commit', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        await prisma.$transaction(async (tx) => {
            await tx.widget.create({ data: { tenantId: 't1', name: 'w2' } });
            await tx.widget.create({ data: { tenantId: 't1', name: 'w3' } });
        });

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        expect(after).toHaveLength(3);
    });

    test('a rolled-back transaction does NOT invalidate the cache', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const readsAfterFirst = counter.byModel.Widget;

        await expect(
            prisma.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // Cache still valid: the failed write must not have bumped any tag version.
        expect(after).toHaveLength(1);
        expect(counter.byModel.Widget).toBe(readsAfterFirst + 1); // +1 for the create attempt only
    });

    test('the database really did roll back', async () => {
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await prisma.widget.count()).toBe(0);
    });
});
```

- [ ] **Step 5: Write `tests/integration/stampede.test.ts`**

This proves the lock is *distributed* — the property `prisma-extension-redis` explicitly does not have. Two independent client instances stand in for two pods.

```ts
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const counterA = createQueryCounter();
const counterB = createQueryCounter();

// Two separate extended clients = two separate processes, as far as any
// in-process coalescing map is concerned.
const podA = createCachedClient(redis, counterA);
const podB = createCachedClient(redis, counterB);

afterAll(async () => {
    await redis.flushDb();
    await redis.quit();
    await podA.$disconnect();
    await podB.$disconnect();
});

beforeEach(async () => {
    await redis.flushDb();
    await podA.widget.deleteMany();
    counterA.reset();
    counterB.reset();
});

describe('distributed stampede protection', () => {
    test('concurrent identical misses across two clients cause one database read', async () => {
        await podA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counterA.reset();
        counterB.reset();

        const [resultA, resultB] = await Promise.all([
            podA.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
            podB.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
        ]);

        expect(resultA).toEqual(resultB);

        const totalReads = (counterA.byModel.Widget ?? 0) + (counterB.byModel.Widget ?? 0);
        expect(totalReads).toBe(1);
    });

    test('a waiter that times out still returns correct data', async () => {
        await podA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counterA.reset();
        counterB.reset();

        const [a, b] = await Promise.all([
            podA.widget.findMany({
                where: { tenantId: 't1' },
                cache: { ttlSeconds: 60, stampede: { waitMs: 1, pollMs: 1 } },
            }),
            podB.widget.findMany({
                where: { tenantId: 't1' },
                cache: { ttlSeconds: 60, stampede: { waitMs: 1, pollMs: 1 } },
            }),
        ]);

        // Correctness must never depend on winning the lock race.
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });
});
```

- [ ] **Step 6: Run the full integration suite**

```bash
pnpm test:integration
```

Expected: all PASS. If the "one database read" assertion is flaky, that is a real signal — investigate the lock, do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: add integration coverage for caching, transactions, and stampede"
```

---

## Task 12: Load test proving invalidation does not degrade

The competitive claim is that invalidation is O(1) while `SCAN`-based alternatives are O(keyspace). This harness produces the evidence for that claim, so it must be honest and reproducible.

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/tests/load/invalidation-scaling.ts`
- Create: `~/Workspace/prisma-extension-cache-tags/tests/load/README.md`

**Interfaces:**
- Consumes: `createNodeRedisAdapter` (Task 9), `bumpTagVersions` and `normalizeConfig` (Tasks 6, 8).
- Produces: a script run by `pnpm test:load` that prints a table and exits non-zero if invalidation latency grows with keyspace size.

- [ ] **Step 1: Write `tests/load/invalidation-scaling.ts`**

```ts
import { createClient } from 'redis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { normalizeConfig } from '../../src/extension';
import { bumpTagVersions } from '../../src/invalidation';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
const KEYSPACE_SIZES = [1_000, 10_000, 100_000];
const INVALIDATIONS_PER_SIZE = 200;

async function seedKeyspace(client: ReturnType<typeof createClient>, count: number): Promise<void> {
    const batchSize = 1_000;
    for (let start = 0; start < count; start += batchSize) {
        const pipeline = client.multi();
        for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
            pipeline.set(`prismaCacheTags:v1:qry:Widget:findMany:${index}`, '"cached"');
        }
        await pipeline.exec();
    }
}

function percentile(sorted: number[], p: number): number {
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
}

async function main(): Promise<void> {
    const client = createClient({ url: REDIS_URL });
    await client.connect();

    const config = normalizeConfig({ tenantKeys: ['tenantId'] });
    const adapter = createNodeRedisAdapter(client);
    const results: Array<{ keyspace: number; p50: number; p99: number }> = [];

    for (const size of KEYSPACE_SIZES) {
        await client.flushDb();
        await seedKeyspace(client, size);

        const durations: number[] = [];
        for (let index = 0; index < INVALIDATIONS_PER_SIZE; index += 1) {
            const startedAt = process.hrtime.bigint();
            await bumpTagVersions([`tenant:t${index}:model:Widget`], config, adapter);
            durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
        }

        durations.sort((a, b) => a - b);
        results.push({ keyspace: size, p50: percentile(durations, 50), p99: percentile(durations, 99) });
    }

    await client.flushDb();
    await client.quit();

    console.table(
        results.map((row) => ({
            'cached keys': row.keyspace.toLocaleString(),
            'invalidate p50 (ms)': row.p50.toFixed(3),
            'invalidate p99 (ms)': row.p99.toFixed(3),
        })),
    );

    const smallest = results[0]!;
    const largest = results[results.length - 1]!;
    const growth = largest.p50 / Math.max(smallest.p50, 0.0001);

    console.log(`\nKeyspace grew ${largest.keyspace / smallest.keyspace}x; p50 invalidation latency grew ${growth.toFixed(2)}x.`);

    // Invalidation is a single INCR; latency must not track keyspace size.
    if (growth > 2) {
        console.error('FAIL: invalidation latency scales with keyspace size. The generational-key property is broken.');
        process.exit(1);
    }

    console.log('PASS: invalidation cost is independent of keyspace size.');
}

await main();
```

- [ ] **Step 2: Run it**

```bash
pnpm db:up
pnpm test:load
```

Expected: a printed table and `PASS`. The 100x keyspace growth should produce roughly flat latency.

- [ ] **Step 3: Write `tests/load/README.md`**

Document, in a short page: what the harness measures, how to run it, what the pass condition is (p50 growth ≤ 2x across a 100x keyspace increase), and an explicit statement that these numbers are measured against local Docker Redis and are not a benchmark against other packages. Do not publish comparative benchmark claims from this harness — it only measures our own scaling property.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: add load harness proving invalidation is keyspace-independent"
```

---

## Task 13: End-to-end packaging tests

A library that fails to install or resolve types is broken regardless of how good its logic is. These tests catch that class of failure.

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/tests/e2e/package-smoke.ts`

**Interfaces:**
- Consumes: `pnpm build` output in `dist/`.
- Produces: `pnpm test:e2e`, which packs the tarball, installs it into a scratch directory, and verifies both module systems resolve.

- [ ] **Step 1: Write `tests/e2e/package-smoke.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

function run(command: string, args: string[], cwd: string): string {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main(): void {
    console.log('Building...');
    run('pnpm', ['build'], repoRoot);

    console.log('Packing...');
    run('npm', ['pack'], repoRoot);
    const tarball = readdirSync(repoRoot).find((file) => file.startsWith('prisma-extension-cache-tags-') && file.endsWith('.tgz'));
    if (!tarball) {
        throw new Error('npm pack produced no tarball');
    }

    const scratch = mkdtempSync(join(tmpdir(), 'cache-tags-e2e-'));
    console.log(`Installing into ${scratch}...`);

    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'e2e-consumer', version: '1.0.0', private: true }, null, 2));
    run('npm', ['install', join(repoRoot, tarball), '--no-audit', '--no-fund'], scratch);

    console.log('Verifying CommonJS require()...');
    run(
        'node',
        [
            '-e',
            "const m = require('prisma-extension-cache-tags');" +
                "if (typeof m.createCacheTagsExtension !== 'function') { throw new Error('createCacheTagsExtension missing from CJS build'); }" +
                "if (typeof m.createCacheTags.forTenant !== 'function') { throw new Error('createCacheTags missing from CJS build'); }",
        ],
        scratch,
    );

    console.log('Verifying ESM import...');
    run(
        'node',
        [
            '--input-type=module',
            '-e',
            "import { createCacheTagsExtension, createCacheTags } from 'prisma-extension-cache-tags';" +
                "if (typeof createCacheTagsExtension !== 'function') { throw new Error('createCacheTagsExtension missing from ESM build'); }" +
                "if (typeof createCacheTags.forTenant !== 'function') { throw new Error('createCacheTags missing from ESM build'); }",
        ],
        scratch,
    );

    console.log('Verifying adapter subpath exports...');
    run(
        'node',
        [
            '-e',
            "const a = require('prisma-extension-cache-tags/node-redis');" +
                "const b = require('prisma-extension-cache-tags/ioredis');" +
                "if (typeof a.createNodeRedisAdapter !== 'function') { throw new Error('node-redis subpath broken'); }" +
                "if (typeof b.createIoRedisAdapter !== 'function') { throw new Error('ioredis subpath broken'); }",
        ],
        scratch,
    );

    console.log('Checking package exports metadata with publint...');
    run('npx', ['--yes', 'publint', join(repoRoot, tarball)], repoRoot);

    console.log('Checking type resolution with are-the-types-wrong...');
    run('npx', ['--yes', '@arethetypeswrong/cli', join(repoRoot, tarball), '--pack', '--ignore-rules', 'cjs-resolves-to-esm'], repoRoot);

    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(repoRoot, tarball), { force: true });

    console.log('\nPASS: package installs and resolves under both CJS and ESM.');
}

main();
```

The adapter subpath check requires neither `redis` nor `ioredis` to be installed in the scratch directory — that is the point. If either `require` fails because the client package is missing, the adapter is doing a runtime import it should not be doing; fix the adapter, not the test.

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e
```

Expected: `PASS`. Common failures and their fixes:
- `publint` complains about missing `types` conditions → check the `exports` map ordering in `package.json` (types must come first within each condition).
- `attw` reports masquerading types → confirm `tsup` emitted both `.d.ts` and `.d.mts`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: add end-to-end packaging and type-resolution smoke tests"
```

---

## Task 14: CI pipeline and release automation

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/.github/workflows/ci.yml`
- Create: `~/Workspace/prisma-extension-cache-tags/.github/workflows/release.yml`
- Modify: `~/Workspace/prisma-extension-cache-tags/package.json` (add the `publishConfig` block)

**Interfaces:**
- Consumes: the `test:unit`, `test:integration`, `test:e2e`, `build`, `typecheck` scripts from prior tasks.
- Produces: a CI run that gates every push and PR, and a tag-triggered npm publish with provenance.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

Use GitHub Actions `services:` for Postgres and Redis — the same approach the reference implementation uses. Note the service ports are the container defaults (5432/6379), unlike the local Docker Compose file which offsets them.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    strategy:
      fail-fast: false
      matrix:
        include:
          - label: current
            node: 22
            prisma: ''
          - label: prisma-floor
            node: 22
            prisma: '7.2.0'
          - label: node-20
            node: 20
            prisma: ''

    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: cachetags
          POSTGRES_PASSWORD: cachetags
          POSTGRES_DB: cachetags
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U cachetags"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      TEST_DATABASE_URL: postgresql://cachetags:cachetags@localhost:5432/cachetags
      TEST_REDIS_URL: redis://localhost:6379

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Pin Prisma to the peer floor
        if: matrix.prisma != ''
        run: pnpm add -D prisma@${{ matrix.prisma }} @prisma/client@${{ matrix.prisma }} @prisma/adapter-pg@${{ matrix.prisma }}

      - run: pnpm exec prisma generate
      - run: pnpm exec prisma db push --skip-generate

      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm test:integration
      - run: pnpm build
      - run: pnpm test:e2e

      - name: Assert no host-application coupling leaked into the package
        run: |
          if grep -rin "kitcompass" src/; then
            echo "Host-application identifiers found in src/"
            exit 1
          fi
```

The `prisma-floor` matrix entry is what stops the declared `^7.2.0` peer range from silently drifting into a lie.

- [ ] **Step 2: Add `publishConfig` to `package.json`**

```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

- [ ] **Step 3: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm build

      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Integration tests are deliberately omitted from the release job — they already gated the commit in CI, and adding service containers to the publish path only creates new ways for a release to fail.

- [ ] **Step 4: Verify the workflow files parse**

```bash
pnpm exec tsx -e "console.log('yaml check is manual')"
```

There is no local YAML runner in this project. Instead, push the branch and confirm the Actions tab shows the workflow as recognised (not "invalid workflow file"). Fix any parse errors before proceeding.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: add test matrix with prisma floor and provenance release workflow"
```

---

## Task 15: Documentation

This task carries the "easy for anyone to jump in" requirement. A reader with a Prisma app and a Redis instance must reach a working cache in under five minutes.

**Files:**
- Create: `~/Workspace/prisma-extension-cache-tags/README.md`
- Create: `~/Workspace/prisma-extension-cache-tags/docs/configuration.md`
- Create: `~/Workspace/prisma-extension-cache-tags/docs/how-invalidation-works.md`
- Create: `~/Workspace/prisma-extension-cache-tags/CONTRIBUTING.md`

**Interfaces:**
- Consumes: the finished public API from Task 10.
- Produces: no code. Every code sample in these files must be copy-pasteable and must match the real API — verify each one against `src/index.ts` before committing.

- [ ] **Step 1: Write `README.md`**

Required sections, in this order:

1. **One-line description and the differentiator.** Lead with the mechanism: "Redis caching for Prisma with automatic, generational tag invalidation — a write is a single `INCR`, never a `SCAN`."
2. **Install:**

```bash
npm install prisma-extension-cache-tags
# plus whichever Redis client you already use
npm install redis    # or: npm install ioredis
```

3. **Quickstart** — a complete, runnable example:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from 'redis';
import { createCacheTagsExtension } from 'prisma-extension-cache-tags';
import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
import { PrismaClient } from './generated/prisma/client';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter }).$extends(
    createCacheTagsExtension(createNodeRedisAdapter(redis), {
        tenantKeys: ['organizationId'],
    }),
);

// Opt in per query. Tags are inferred automatically.
const widgets = await prisma.widget.findMany({
    where: { organizationId: 'org_123' },
    cache: { ttlSeconds: 60 },
});

// A write invalidates every cached read that shares a tag. No extra code.
await prisma.widget.update({
    where: { id: 'widget_1' },
    data: { name: 'renamed' },
});
```

4. **How invalidation works** — three short paragraphs plus a link to `docs/how-invalidation-works.md`. Cover: tags are inferred from args; each tag has a version counter folded into the cache key; a write increments the counter, which orphans old keys instantly.
5. **Requirements** — Prisma `^7.2.0` with a driver adapter, Node `^20.19 || ^22.12 || >=24.0`, any Redis.
6. **Feature list** — generational O(1) invalidation, automatic tag inference, cross-model `dependencyTags`, transaction-deferred flush, distributed single-flight lock, superjson serialization (Date/Decimal/BigInt safe).
7. **Comparison table** — honest and defensible. State what this package does *not* do: no stale-while-revalidate, no RedisJSON, no edge-runtime testing, no hosted option. Do **not** publish latency comparisons against other packages; the load harness only measures our own scaling.
8. **License:** MIT.

- [ ] **Step 2: Write `docs/configuration.md`**

Document every field of `CacheTagsConfig` in a table: name, type, default, and what it does. Give each of `tenantKeys`, `entityKeys`, `dependencyTags`, `stampede`, `schemaVersion`, `logger`, and `metrics` a worked example. `schemaVersion` needs an explicit explanation: bump it to invalidate every cache entry at once after a breaking change to cached shapes.

Document `CacheReadOptions` and `CacheWriteOptions` the same way.

- [ ] **Step 3: Write `docs/how-invalidation-works.md`**

Explain the generational mechanism properly, because it is the reason to choose this package:
- Cache key = hash of `{ model, operation, args, schemaVersion, tags, tagVersions }`.
- `tagVersions` come from an `MGET` of `<prefix>:tagver:<tag>` counters on every read.
- Invalidation increments those counters. Old keys become unreachable immediately and are reclaimed by their own TTL.
- Consequences to state plainly: invalidation cost is independent of how many keys are cached; there is no tag→key index to maintain or garbage-collect; orphaned keys occupy memory until their TTL expires, which is the deliberate trade-off.
- Explain the fingerprint check: the cached envelope stores a fingerprint that is re-verified on read, so a hash collision or a stale schema is detected and treated as a miss rather than served.
- Explain transaction behaviour (or the `withCacheInvalidation` fallback, per the Task 2 outcome).

- [ ] **Step 4: Write `CONTRIBUTING.md`**

Cover: `pnpm install`, `pnpm db:up`, `pnpm exec prisma generate && pnpm exec prisma db push`, then `pnpm test:unit` / `pnpm test:integration` / `pnpm test:load` / `pnpm test:e2e`. State the Conventional Commits requirement and that unit tests must not require Docker.

- [ ] **Step 5: Verify every code sample compiles**

Copy each TypeScript sample from the README into a scratch file under `tests/e2e/` and typecheck it, or paste them into the fixture and run `pnpm typecheck`. Fix any drift. Delete the scratch file afterwards.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: add readme, configuration reference, and invalidation explainer"
```

---

## Task 16: Adopt the package in KitCompass

Extraction is not complete while KitCompass still carries a private copy — that is duplicate code that will drift. This task deletes the original and consumes the package.

**Files (all in the KitCompass repo, not the new one):**
- Delete: `packages/database/src/lib/cache/` (the whole directory)
- Delete: `packages/database/tests/prisma-cache-extension.test.ts`, `packages/database/tests/cache-tags.test.ts`, `packages/database/tests/redis-cache-helpers.test.ts`
- Modify: `packages/database/package.json`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: the published (or locally linked) `prisma-extension-cache-tags`.
- Produces: `@kitcompass/database` re-exporting the same public names it exports today, so no call site in `apps/web` or `apps/api` changes.

**Prerequisite:** KitCompass is on Prisma 6.19.2 and this package requires Prisma `^7.2.0`. **Do not start this task until KitCompass has been upgraded to Prisma 7.** That upgrade is a separate piece of work with its own risks (driver adapters become mandatory, the generated client moves out of `node_modules`, ESM changes) and is explicitly out of scope for this plan. If KitCompass is still on Prisma 6, stop after Task 15 and treat Task 16 as a follow-up.

- [ ] **Step 1: Confirm the prerequisite**

```bash
cd /Users/nmb0032/Workspace/KitCompass
grep '"@prisma/client"' packages/database/package.json
```

Expected: `^7.x`. If it shows `^6.x`, stop — record that Task 16 is blocked and finish the plan at Task 15.

- [ ] **Step 2: Add the dependency**

```bash
pnpm --filter @kitcompass/database add prisma-extension-cache-tags
```

- [ ] **Step 3: Rewire `packages/database/src/index.ts`**

Replace the local extension import with the package, and pass the KitCompass-specific configuration that used to be hardcoded in `DEFAULT_CONFIG`:

```ts
import { getChildLogger } from '@kitcompass/logger';
import { getCounter } from '@kitcompass/telemetry';
import { createCacheTagsExtension } from 'prisma-extension-cache-tags';
import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
import { redis } from './lib/redis';

const cacheLogger = getChildLogger('prisma-cache');
const cacheCounter = getCounter(
    'kitcompass.prisma.cache.operations',
    { description: 'Count of Prisma cache hits and misses.' },
    'kitcompass-database',
);

const cacheExtension = createCacheTagsExtension(createNodeRedisAdapter(redis.rawClient), {
    tenantKeys: ['organizationId', 'Organization', 'organization'],
    logger: {
        debug: (data, message) => cacheLogger.debug(data, message),
        info: (data, message) => cacheLogger.info(data, message),
        warn: (data, message) => cacheLogger.warn(data, message),
        error: (data, message) => cacheLogger.error(data, message),
    },
    metrics: {
        onCacheEvent: ({ model, operation, result }) => cacheCounter.add(1, { model, operation, result }),
    },
    dependencyTags: {
        BlackoutDate: ['Equipment'],
        Equipment: ['Reservation', 'Issue', 'Comment'],
        Group: ['Reservation', 'Notification'],
        Reservation: ['Equipment', 'Notification'],
        ReservationEquipment: ['Reservation', 'Equipment'],
        ReservationParticipant: ['Reservation'],
        RSVP: ['Reservation', 'Notification'],
        Role: ['User'],
        Template: ['Equipment'],
    },
});
```

Then use `cacheExtension` where `createCachedPrismaExtension(redisAdapter)` was used in `prismaClientSingleton`.

**Note on `redis.rawClient`:** the existing `redis` singleton in `packages/database/src/lib/redis/index.ts` is a wrapper, not a raw node-redis client. Either expose the underlying client as `rawClient`, or keep the existing hand-written `RedisAdapter` object from `src/index.ts` and pass that directly instead of `createNodeRedisAdapter(...)` — it already satisfies the `RedisAdapter` interface. **Prefer the second option**: it is a smaller change and the adapter object already exists and works.

- [ ] **Step 4: Update the re-exports in `packages/database/src/index.ts`**

The current file exports these cache symbols. Repoint each to the package so no consumer changes:

```ts
export { createCacheTags } from 'prisma-extension-cache-tags';
export { createCacheTagsExtension } from 'prisma-extension-cache-tags';
export type {
    CacheReadOptions,
    CacheTagsConfig,
    CacheWriteOptions,
    ExtendedModel,
    RedisAdapter,
} from 'prisma-extension-cache-tags';
```

The old names `createCachedPrismaExtension` and `PrismaCacheExtensionConfig` are gone. Grep for them and update the call sites:

```bash
grep -rn "createCachedPrismaExtension\|PrismaCacheExtensionConfig" apps packages --include=*.ts
```

Also remove the `./cache-tags` subpath entry from `packages/database/package.json` exports if nothing imports it after this change — grep first.

- [ ] **Step 5: Handle the tag format change**

Tags move from `org:<id>:...` to `tenant:<id>:...`, so every existing cache key changes. This is safe — the old keys become unreachable and expire by TTL — but it means one cold-cache period after deploy. Note this in the PR description. No migration is needed.

- [ ] **Step 6: Delete the old implementation and its tests**

```bash
cd /Users/nmb0032/Workspace/KitCompass
rm -rf packages/database/src/lib/cache
rm packages/database/tests/prisma-cache-extension.test.ts
rm packages/database/tests/cache-tags.test.ts
rm packages/database/tests/redis-cache-helpers.test.ts
```

The behaviour these tests covered now lives in the package's own suite.

- [ ] **Step 7: Verify the monorepo still builds and passes**

```bash
pnpm --filter @kitcompass/database run build
pnpm --filter @kitcompass/web run typecheck
pnpm --filter @kitcompass/database run test
pnpm run lint
```

Expected: all green. Any remaining references to the deleted module surface here.

- [ ] **Step 8: Run one real integration check**

```bash
pnpm --filter @kitcompass/web run test:integration
```

Expected: PASS. This exercises the cached tRPC routers against real Redis, which is the strongest available signal that the swap preserved behaviour.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: consume prisma-extension-cache-tags instead of the local cache layer"
```

---
