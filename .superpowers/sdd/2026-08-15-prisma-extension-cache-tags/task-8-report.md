# Task 8 report: extension assembly

## Implementation

- Ported the verified source file
  `$KC/packages/database/src/lib/cache/prisma-cache-extension.ts` into
  `src/extension.ts`, after exporting
  `KC=/Users/nmb0032/Workspace/KitCompass` and checking that the source file
  existed.
- Switched the Prisma runtime import to `@prisma/client/extension`.
- Renamed the factory to `createCacheTagsExtension` and the extension name to
  `prisma-extension-cache-tags`.
- Re-exported `normalizeConfig` from `src/config.ts`, and exported the
  unit-test helpers `readThroughCache` and `handleWrite`.
- Removed KitCompass logger/telemetry dependencies. Cache logging now uses the
  injected normalized logger, and hit/miss reporting uses the injected metrics
  sink.
- Retained the Prisma `$transaction` monkey-patch with
  `AsyncLocalStorage` buffering and post-commit tag-version flushing. The
  transaction flush reports errors through the configured logger.
- Updated lock release to pass `(lock, redisAdapter, config)`.
- Updated the public configuration example in `src/types.ts` to use the new
  factory name.
- `src/config.ts` already contained the required generic `DEFAULT_CONFIG` and
  nested `normalizeConfig` merge from Task 6; it required no diff.

## Exact files changed

- `src/extension.ts`
- `src/types.ts`
- `tests/unit/extension.test.ts`
- `.superpowers/sdd/2026-08-15-prisma-extension-cache-tags/task-8-report.md`

## TDD evidence

### RED

Command:

```text
pnpm test:unit
```

Result:

```text
FAIL tests/unit/extension.test.ts
Error: Cannot find module '../../src/extension'
Test Files 1 failed | 7 passed (8)
Tests 44 passed (44)
```

The failure was the expected missing-production-module failure.

### GREEN

After implementing the extension and correcting one TypeScript argument cast
in the read bypass path:

```text
pnpm test:unit && pnpm typecheck
```

Result:

```text
Test Files 8 passed (8)
Tests 56 passed (56)
tsc --noEmit
```

The command exited successfully.

## Vocabulary check

Commands:

```text
if grep -rin "kitcompass\|@kitcompass" src/; then exit 1; else echo "No KitCompass vocabulary found in src/"; fi
if grep -RinE "kitcompass|@kitcompass|BlackoutDate|Equipment|Reservation|ReservationEquipment|ReservationParticipant|RSVP|Role|Template|Notification" src/; then exit 1; else echo "No host identifiers or source model names found in src/"; fi
```

Results:

```text
No KitCompass vocabulary found in src/
No host identifiers or source model names found in src/
```

## Self-review

- Generic defaults are sourced from `src/config.ts`: empty dependency graph,
  empty tenant keys, `['id']` entity keys, `prismaCacheTags:v1`, and caching
  enabled.
- Nested stampede options remain merged with defaults.
- Reads cache misses, clamp TTL, tolerate Redis read failures, honor
  `cacheEmpty`, and report hit/miss metrics.
- Writes query first and invalidate resolved tags, including tenant isolation
  and dependency propagation.
- Transaction invalidation remains deferred until commit.
- No host imports, host identifiers, or source model names remain under `src/`.
- The existing lint script could not run because `eslint` is not installed:
  `sh: eslint: command not found`. The test runner also emits its existing
  Vite CommonJS/ESM configuration warning.

## Commit

Conventional Commit subject:

```text
feat: assemble the cache-tags prisma extension
```

Commit: `9aa243a`

## Fix report — 2026-08-16

### Findings addressed

- Wrapped normal and custom cache-key generation, including Redis tag-version reads, in the existing fail-open path; failures now log, emit one miss event, and query with `cleanedArgs` without attempting cache population.
- Enclosed lock acquisition, post-acquire rechecks, and query population in one `try/finally`, so every returned acquired lock is released.
- Stripped `cache` before forwarding operations when global caching is disabled (and for model-less operations).
- Added one hit event for values returned by waiter and post-acquire recheck paths; normal cache hits remain single-event.
- Preserved the Task 2 transaction interception block unchanged.

### Changed files

- `src/extension.ts`
- `tests/unit/extension.test.ts`
- `.superpowers/sdd/2026-08-15-prisma-extension-cache-tags/task-8-report.md`

### Regression coverage

- Tag-version failures for generated and custom keys fall back with cleaned arguments and injected metrics/logger.
- Post-acquire cached hits release the lock and emit one hit event.
- Waiter-served cached hits emit one hit event.
- Globally disabled caching strips `cache` before the Prisma query.
- Normal cache hit/miss metrics remain exactly two events (one each).

### Verification commands and outputs

Focused extension tests:

```text
./node_modules/.bin/vitest run tests/unit/extension.test.ts

Test Files  1 passed (1)
Tests  17 passed (17)
```

Full unit suite:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm test:unit

Test Files  8 passed (8)
Tests  61 passed (61)
```

Typecheck:

```text
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm typecheck

> tsc --noEmit
```

Source vocabulary grep:

```text
if grep -rin "kitcompass\|@kitcompass" src/; then exit 1; else echo "No KitCompass vocabulary found in src/"; fi

No KitCompass vocabulary found in src/
```

All commands exited with status 0. Vitest emitted the existing Vite CommonJS/ESM configuration warning.
