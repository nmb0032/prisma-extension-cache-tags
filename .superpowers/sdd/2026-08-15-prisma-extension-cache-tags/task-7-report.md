# Task 7 Report: Distributed single-flight cache lock

Date: 2026-08-16

## Status

Implemented and verified the distributed single-flight lock module. The
implementation preserves the optional Redis lock operations and uses the
injected logger for both timeout and release-failure diagnostics.

## Implementation details

- Ported the verified lock implementation into `src/locks.ts`.
- Added `CacheLock` with `key` and `token`.
- Added `acquireCacheLock`, which uses optional `setIfNotExists` with the
  resolved lock TTL and returns `null` when conditional set is unavailable or
  refused.
- Added the required three-argument
  `releaseCacheLock(lock, redisAdapter, config)` contract. It uses optional
  value-matched deletion when available, falls back to `delete` otherwise, and
  reports release failures through `config.logger.warn`.
- Added `waitForCachedValue`, preserving polling, per-query stampede overrides,
  the configured deadline, and timeout logging through `config.logger.debug`.
- Removed the source module's KitCompass logger dependency and module-level
  logger.

## Exact files changed

- `src/locks.ts`
- `tests/unit/locks.test.ts`
- `.superpowers/sdd/2026-08-15-prisma-extension-cache-tags/task-7-report.md`

No package manifest or dependency changes were retained.

## TDD evidence

### RED

Wrote `tests/unit/locks.test.ts` from the task brief before adding production
code, then ran:

```text
pnpm test:unit
```

The expected failure occurred:

```text
FAIL  tests/unit/locks.test.ts
Error: Cannot find module '../../src/locks'
Test Files  1 failed | 6 passed (7)
Tests  36 passed (36)
Command exited with code 1
```

### GREEN

After porting and adapting `src/locks.ts`, ran:

```text
pnpm test:unit && pnpm typecheck
```

Result:

```text
Test Files  7 passed (7)
Tests  43 passed (43)
> prisma-extension-cache-tags@0.0.0 typecheck
> tsc --noEmit
Command exited with code 0
```

A fresh final verification used the same commands with
`COREPACK_ENABLE_PROJECT_SPEC=0` to prevent Corepack from rewriting the
manifest:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:unit &&
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck
```

It again reported 7 passing test files, 43 passing tests, and a clean
typecheck.

## Self-review

- Verified the source file existed in
  `$KC/packages/database/src/lib/cache/locks.ts` after exporting
  `KC=/Users/nmb0032/Workspace/KitCompass` before copying.
- Compared the port to the verified source. The only differences are removal
  of the KitCompass logger import/module logger, the required `config`
  parameter, and routing both log calls through `config.logger`.
- Confirmed `grep` finds no KitCompass identifiers in `src` and no model
  vocabulary in the new `src/locks.ts`.
- `git diff --check` completed without whitespace errors.
- The exact three-argument release signature is present for Task 8.

## Concerns

- Vitest emits the repository's existing warning about ESM syntax in
  `vitest.config.ts` under CommonJS; it does not fail tests.
- Corepack initially added a `packageManager` field when the first `pnpm`
  command ran. That unrelated manifest edit was reverted, and final
  verification disabled project-spec rewriting.
- The wall-clock timeout assertions are the exact tests required by the brief;
  they passed in both green runs.

Commit subject:

```text
feat: port distributed single-flight cache lock
```

## Fix Report: Ownership-safe lock release

Date: 2026-08-16

### Finding

`releaseCacheLock` could unconditionally call `delete(lock.key)` when the
adapter did not provide `deleteIfValue`, allowing a caller to delete a lock
owned by another caller.

### Fix

- `src/locks.ts`: return without deleting when `deleteIfValue` is unavailable.
  When it is available, release still uses the atomic token-matching
  operation, and its existing error logging through `config.logger.warn` is
  unchanged.
- `tests/unit/locks.test.ts`: added a focused regression test that removes
  `deleteIfValue`, releases a held lock, and verifies both that the token
  remains and that unconditional `delete` was not called.

### Verification

Covering test file:

```text
tests/unit/locks.test.ts
```

TDD regression check before the production fix:

```text
$ COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run tests/unit/locks.test.ts
Test Files  1 failed (1)
Tests  7 passed | 1 failed (8)
AssertionError: expected undefined to be <lock token>
```

Focused lock tests after the fix:

```text
$ COREPACK_ENABLE_PROJECT_SPEC=0 pnpm exec vitest run tests/unit/locks.test.ts
Test Files  1 passed (1)
Tests  8 passed (8)
```

Full unit coverage and typecheck:

```text
$ COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:unit && COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck
Test Files  7 passed (7)
Tests  44 passed (44)
> prisma-extension-cache-tags@0.0.0 typecheck
> tsc --noEmit
Command exited with code 0
```

Vitest emitted the repository's existing ESM/CommonJS configuration warning;
it did not affect the passing tests or typecheck.
