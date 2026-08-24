# Query-aware tagging final fix report

## Summary

All three Important findings were fixed in commit `d6e2fff`:

- Runtime logging is bounded and excludes tenant scopes/IDs, tag strings, cache keys, query arguments, returned values, and raw errors.
- `maxTagsPerQuery` is applied after inferred, replacement, and explicit tags are normalized together; over-limit reads bypass without truncation or Redis population.
- Schema descriptors are validated at initialization for non-empty identifiers, valid relation targets, scalar key references, duplicate key components, and compound-key metadata.

## Finding 1: Observability privacy

### Code

- `src/extension.ts`: removed cache keys, tenant scopes, tag arrays, raw errors, and result data from identity, read, lock, script, write, and transaction log payloads. Debug logs retain only model/operation/path and bounded dependency/tag counts; warnings retain bounded reasons and fallback model names.
- `src/invalidation.ts`: removed tag/version/error payloads; invalidation logs now contain only path, reason, and tag count.
- `src/locks.ts`: removed lock keys and error text from lock logs.

### Tests

- `tests/unit/extension.test.ts` now exercises identity-mismatch and debug-hit logging with secret tenant/tag values, asserts those values never occur in serialized logger calls, and asserts bounded metadata remains.
- Existing extension, invalidation, and lock logger assertions were updated to the bounded payload contract.

### TDD evidence

- RED: the initial focused run reported 23 failures, including logger payloads containing `expectedTenantScope`, `observedTenantScope`, cache keys, and raw errors.
- GREEN: focused tests passed after the logging changes; the final unit suite passed all 291 tests.

## Finding 2: Complete read tag cap

### Code

- `src/extension.ts` now computes normalized tags after inferred/replacement and explicit tags are merged, then marks the read non-cacheable with `dependency-tag-limit` when the complete subscription exceeds the configured limit.
- The prepared key still uses the resolved tenant scope, including when `mergeTags: false`; tags are never truncated.
- `readThroughCache` bypasses before Redis lookup/population for over-limit reads.

### Tests

- `tests/unit/extension.test.ts` covers merged explicit-tag overflow and replacement-only overflow.
- Both cases assert Prisma is called, no Redis lookup occurs, no Redis cache entry is populated, and replacement-only overflow retains the resolved tenant scope.

### TDD evidence

- RED: both new overflow tests initially observed one Redis lookup instead of zero.
- GREEN: both pass in the final focused and full unit runs.

## Finding 3: Descriptor validation

### Code

- `src/schema.ts` rejects empty model and field names, empty scalar types, empty relation targets/names, unknown relation targets, empty/missing/non-scalar primary and unique key references, empty keys, duplicate key components, and malformed/duplicate compound metadata.
- Optional `dbName` mappings remain accepted for diagnostics.
- Relation names are required because generated fixtures and the generator require Prisma DMMF relation names; all checked generated fixtures emit non-empty names.

### Tests

- `tests/unit/schema.test.ts` adds focused rejection cases for every category above, including empty identifiers, key references, duplicate components, and compound key shape/field/name failures.
- Existing valid mapped-name and relation indexing tests remain passing.

### TDD evidence

- RED: the initial schema-focused run reported 17 new validation failures.
- GREEN: all schema tests pass, including valid descriptor/configuration cases.

## Validation

Commands run from the requested worktree:

```text
pnpm exec vitest run --project unit tests/unit/schema.test.ts tests/unit/extension.test.ts tests/unit/locks.test.ts
Test Files 3 passed; Tests 79 passed

pnpm run test:unit
Test Files 33 passed; Tests 291 passed

pnpm run typecheck
tsc --noEmit  (passed)

pnpm run lint
eslint .  (passed)

pnpm run build
tsup  (CJS, ESM, and DTS builds succeeded)

pnpm run test:e2e
PASS: package installs and resolves under both CJS and ESM.

TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags' \
TEST_REDIS_URL='redis://localhost:6380' pnpm run test:integration
Test Files 7 passed; Tests 74 passed

git diff --check
(passed with no output)
```

The first integration invocation without `TEST_DATABASE_URL` failed during Prisma config loading because that environment variable is required by `prisma.config.ts`. It was rerun with the already-running local Postgres/Redis service URLs above and passed.

## Files changed

- `.superpowers/sdd/2026-08-23-query-aware-tagging/final-fix-report.md`
- `src/extension.ts`
- `src/invalidation.ts`
- `src/locks.ts`
- `src/schema.ts`
- `tests/unit/extension.test.ts`
- `tests/unit/invalidation.test.ts`
- `tests/unit/locks.test.ts`
- `tests/unit/schema.test.ts`

## Self-review

- Audited every `logger.debug/info/warn/error` call in runtime `src/**/*.ts`; no runtime logger payload contains `cacheKey`, tag arrays/strings, tenant scopes/IDs, query args, returned values, or raw error objects/messages.
- Confirmed over-limit reads bypass before `mgetString` and `setString`.
- Confirmed validation still accepts mapped names and valid generated relation descriptors.
- Confirmed no unrelated source files changed and no commit attribution trailers were added.

## Concerns

- Integration tests require explicit `TEST_DATABASE_URL` in this checkout because Prisma config resolves it eagerly; service-backed rerun passed.
- No remaining known correctness or privacy concerns.

## Human-authorized privacy follow-up

### Code

- `src/extension.ts` now logs canonicalization failures with only `{ model, operation, reason: 'canonicalization' }`; input-controlled path and `CanonicalizationError.reason` are excluded.
- Cache bypass behavior, bounded canonicalization metric events, and non-canonicalization exception classification are unchanged.

### TDD evidence

- RED: `pnpm exec vitest run --project unit tests/unit/extension.test.ts -t "without logging input-controlled details"` failed because the logger received `path: "$.where['password-secret-property']"` and `reason: "toJSON() failed: distinctive-toJSON-secret"`.
- GREEN: the same regression passed after the surgical logging change. The test uses a throwing `toJSON()`, a distinctive secret, and a sensitive dynamic property name; it verifies logger calls/messages, metric events, and serialized payloads contain neither input-derived path nor value while bounded metadata remains.

### Validation

```text
pnpm exec vitest run --project unit tests/unit/extension.test.ts tests/unit/canonical.test.ts
Test Files 2 passed; Tests 52 passed

pnpm run test:unit
Test Files 33 passed; Tests 291 passed

pnpm run typecheck
tsc --noEmit (passed)

pnpm run lint
eslint . (passed)

pnpm run build
tsup (CJS, ESM, and DTS builds succeeded)

git diff --check
(passed with no output)
```
