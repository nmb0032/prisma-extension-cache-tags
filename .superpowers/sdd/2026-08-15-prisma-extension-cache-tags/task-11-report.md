# Task 11 report

## Implementation details

- Added `tests/integration/helpers.ts` with real node-redis setup, Prisma query counting, and cached-client construction.
- Added real Prisma/Postgres/Redis coverage for read-through caching, tenant/dependency invalidation, TTLs, implicit interactive transaction commit/rollback behavior, and distributed stampede protection.
- Verified extension ordering empirically. The cache extension is applied before the counting extension so cache hits do not increment the database counter.
- Updated the transaction interception in `src/extension.ts` to use a Prisma client extension and the dynamic client receiver. This preserves the implicit `$transaction` interception when another extension is layered afterward, while retaining a compatibility path for the existing unit-test fake client.
- Made integration cleanup resilient with `Promise.allSettled` and tracked dependent clients.
- Generated and pushed the Prisma 7.9.1 fixture schema against the local Postgres service.

## Exact files changed

- `src/extension.ts`
- `tests/integration/helpers.ts`
- `tests/integration/caching.test.ts`
- `tests/integration/transactions.test.ts`
- `tests/integration/stampede.test.ts`
- `.superpowers/sdd/2026-08-15-prisma-extension-cache-tags/task-11-report.md`

## TDD RED/GREEN evidence

1. RED: `COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run tests/integration/caching.test.ts`
   - 10 tests ran; 4 failed.
   - Cached reads incremented the counter twice (`expected 1, received 2`), proving the initial extension-order assumption was wrong.
2. GREEN after swapping the extension order: the caching file passed all 10 tests.
3. RED: `COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run tests/integration/transactions.test.ts`
   - 3 tests ran; rollback cache-count assertion failed (`expected 2, received 3`).
   - The failure exposed that the transaction wrapper was lost when an outer extension was applied.
4. GREEN after the transaction-wrapper fix: all 3 transaction tests passed.
5. GREEN for stampede coverage: both distributed-client tests passed, including the unchanged one-database-read assertion.

## Validation commands and outputs

- `docker compose ps`: Postgres and Redis were healthy.
- `TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec prisma generate`
  - Generated Prisma Client 7.9.1 to `tests/fixture/generated`.
- `TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec prisma db push`
  - Database was already in sync with the Prisma schema.
- `COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:integration`
  - 5 test files passed; 36 tests passed.
- `COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:unit`
  - 8 test files passed; 64 tests passed.
- `COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck`
  - Passed with no errors.
- `git diff --check`
  - Passed.

## Self-review

- Tests use the real Prisma 7.9.1 adapter-backed client, Postgres, Redis, and node-redis adapter.
- Transaction tests exercise implicit extended-client `$transaction`; they do not use `withCacheInvalidation`.
- The distributed stampede assertion remains `expect(totalReads).toBe(1)`.
- No unrelated production behavior was changed beyond making the required implicit transaction interception survive extension ordering.
- No branches were created or switched.
- No package manifests or generated fixture files were changed in the worktree.

## Concerns

- `pnpm lint` could not run because the repository's installed dependencies do not contain the `eslint` executable; no dependency was added.
- Vitest emits the existing Vite CommonJS/ESM config warning; it does not affect test results.
- Integration tests require the Docker Compose Postgres and Redis services.
