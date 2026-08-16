# Final review fix report

Date: 2026-08-16

Base reviewed: `ee44a8a` (`docs: add readme, configuration reference, and invalidation explainer`)

## Scope

This fix wave addressed all seven findings from the whole-branch review while
keeping generational invalidation O(1), avoiding Redis key scans, and retaining
database transaction commit/rollback semantics.

## Changes

### Critical 1: tenant-scoped ID-only writes

- `src/tags.ts`
  - `resolveCacheTags` can now inspect additional post-write sources in
    addition to the original Prisma arguments.
  - Read resolution includes a deliberate `global:model:<Model>` fallback
    generation alongside tenant-specific tags when tenant inference is active.
    This makes a genuinely tenant-unknown write safe without weakening data
    isolation or requiring a tenant registry/scan.
- `src/extension.ts`
  - `handleWrite` resolves tags after the database write and includes returned
    write data, so normal `update({ where: { id } })` and
    `delete({ where: { id } })` operations use the returned tenant key.
  - If inference is enabled but no tenant is present in arguments or returned
    data, a warning is emitted and the model-wide fallback is published.
    Explicit tags remain the caller's responsibility when inference or merging
    is disabled.
- `README.md` and `docs/configuration.md` document returned-row inference and
  the intentionally broad fallback.
- Regression tests cover unit-level update/delete behavior, fallback behavior,
  real tenant-scoped cached reads, and ensuring another tenant remains cached.

### Critical 2: tag-version retention

- `src/invalidation.ts` now retains tag-version counters for
  `max(maxTtlSeconds * 10, 3600)` seconds. The previous one-hour cap could
  expire a counter before a configured cache entry.
- `tests/unit/invalidation.test.ts` verifies a seven-thousand-two-hundred
  second cache limit receives a seventy-two-thousand second counter TTL.
- Configuration and invalidation documentation describe the retention policy.

### Critical 3: array transactions

- `src/extension.ts` now installs the `AsyncLocalStorage` invalidation context
  for both callback and array `$transaction` forms. The original transaction
  promise is awaited before a single deduplicated flush; rejection skips the
  flush.
- `tests/integration/transactions.test.ts` adds real Docker-backed commit and
  rollback coverage for `$transaction([...])`.
- The integration helper contains a narrow `asTransactionBatch` bridge because
  Prisma's generated type for this async query extension exposes the lazy
  operations as `Promise` rather than `PrismaPromise`; runtime integration
  execution is verified with the real client.

### Minor documentation and setup findings

- `CONTRIBUTING.md` now exports the exact Prisma 7 setup variable:
  `TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags'`
  and also documents the local Redis URL.
- The `CacheTagsConfig` example in `src/types.ts` now uses the public factory
  signature, `createNodeRedisAdapter`, `PrismaPg`, and a Prisma 7 generated
  client adapter.
- `docs/configuration.md` documents the one-second TTL floor and accurately
  describes logger events (core does not emit `info`).
- `docs/how-invalidation-works.md` limits the generated-key formula to reads
  without `cache.key` and explains the custom-key form.
- `.superpowers/.../task-7-report.md` no longer claims that lock release falls
  back to unconditional deletion; it accurately records the ownership-safe
  no-delete behavior.

## Files changed

```text
CONTRIBUTING.md
README.md
docs/configuration.md
docs/how-invalidation-works.md
src/extension.ts
src/invalidation.ts
src/tags.ts
src/types.ts
tests/integration/caching.test.ts
tests/integration/helpers.ts
tests/integration/transactions.test.ts
tests/unit/extension.test.ts
tests/unit/invalidation.test.ts
tests/unit/tags.test.ts
.superpowers/sdd/2026-08-15-prisma-extension-cache-tags/task-7-report.md
```

## TDD and focused regression evidence

The focused regression suite was run before production changes:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run \
  tests/unit/tags.test.ts tests/unit/invalidation.test.ts tests/unit/extension.test.ts

Test Files  3 failed (3)
Tests       4 failed | 41 passed (45)
```

The failures were the expected missing fallback tag, short counter TTL, and
stale ID-only write-cache behavior. After implementation:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run \
  tests/unit/tags.test.ts tests/unit/invalidation.test.ts tests/unit/extension.test.ts

Test Files  3 passed (3)
Tests       45 passed (45)
```

## Validation commands and outputs

Prisma 7 fixture setup:

```text
TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
  COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec prisma generate
✔ Generated Prisma Client (7.9.1) to ./tests/fixture/generated

TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
  COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec prisma db push
The database is already in sync with the Prisma schema.
```

Unit tests:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:unit
Test Files  8 passed (8)
Tests       68 passed (68)
```

Docker-backed integration tests:

```text
TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
TEST_REDIS_URL='redis://localhost:6380' \
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:integration
Test Files  5 passed (5)
Tests       39 passed (39)
```

Typecheck:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck
Process exited with code 0.
```

Lint:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm lint
Process exited with code 0.
```

Build:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm build
CJS Build success
ESM Build success
DTS Build success
```

Packaging and consumer smoke tests:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:e2e
PASS: package installs and resolves under both CJS and ESM.
```

O(1) load harness, run in isolation against the disposable Redis service:

```text
TEST_REDIS_URL='redis://localhost:6380' COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:load
Observed Redis INCRBY calls per keyspace: 200, 200, 200.
Keyspace grew 100x; p50 invalidation latency grew 0.87x.
PASS: invalidation cost is independent of keyspace size.
```

One parallel validation attempt ran the load harness concurrently with the
integration suite and observed `200, 205, 200` calls because both suites used
the same Redis instance. The isolated rerun above passed; no product failure
was involved.

Documentation sample check:

```text
An adjusted copy of the published adapter/configuration example was typechecked
with COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck, then deleted.
Result: Process exited with code 0.
```

Whitespace:

```text
git diff --check
No whitespace errors.
```

## Residual concerns

- Vitest continues to print the repository's pre-existing ESM/CommonJS
  configuration warning; it does not fail tests.
- `prettier` is not installed in the repository, so a direct
  `pnpm exec prettier --check ...` command reports `Command "prettier" not
  found`. The established ESLint, typecheck, build, unit, integration, load,
  and packaging checks all pass.
- The Prisma batch test's type bridge is isolated to the integration harness;
  real Prisma 7 batch execution and commit/rollback behavior pass. No runtime
  transaction or invalidation concern remains.
