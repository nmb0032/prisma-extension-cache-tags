import { beforeEach, describe, expect, test, vi } from 'vitest';
import { invalidateScope } from '../../src';
import { normalizeConfig } from '../../src/config';
import { withCacheInvalidation } from '../../src/invalidation';
import { getTagVersionKey } from '../../src/keys';
import { scopeRootTag } from '../../src/tag-format';
import type { CacheTagsConfig } from '../../src/types';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';
import { createFakeRedis, type FakeRedis } from './fake-redis';

const publicConfig: CacheTagsConfig = { schema: cacheSchema, models: cacheModels };
const normalizedConfig = normalizeConfig(publicConfig);
const scope = { namespace: 'organization', id: 'org_1' };

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('invalidateScope', () => {
    test('bumps only the requested scope root', async () => {
        await invalidateScope(scope, redis, publicConfig);

        expect(redis.store.get(getTagVersionKey(scopeRootTag(scope), normalizedConfig))).toBe('1');
        expect([...redis.store.keys()]).toHaveLength(1);
    });

    test('deduplicates repeated scope invalidations in an active context', async () => {
        await withCacheInvalidation(
            async () => {
                await invalidateScope(scope, redis, publicConfig);
                await invalidateScope(scope, redis, publicConfig);

                expect(redis.store).toHaveProperty('size', 0);
            },
            redis,
            publicConfig,
        );

        expect(redis.store.get(getTagVersionKey(scopeRootTag(scope), normalizedConfig))).toBe('1');
        expect(redis.callCounts.increment).toBe(1);
    });

    test('does not include scope identity in invalidation logs', async () => {
        const debug = vi.fn();
        const config = { ...publicConfig, logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

        await invalidateScope(scope, redis, config);

        expect(JSON.stringify(debug.mock.calls)).not.toContain(scope.id);
    });

    test.each([
        [{ namespace: '', id: 'org_1' }, 'namespace'],
        [{ namespace: 'organization', id: '   ' }, 'id'],
    ] as const)('rejects an empty scope %s', async (invalidScope, component) => {
        await expect(invalidateScope(invalidScope, redis, publicConfig)).rejects.toThrow(
            `Scope ${component} must be a non-empty string`,
        );
        expect(redis.store).toHaveProperty('size', 0);
    });
});
