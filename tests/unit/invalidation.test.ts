import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    bumpTagVersions,
    getActiveInvalidationContext,
    publishInvalidation,
    runWithInvalidationContext,
    withCacheInvalidation,
} from '../../src/invalidation';
import { normalizeConfig } from '../../src/config';
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
    tenantPrecision: false,
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

    test('retains tag versions longer than a cache with a TTL above one hour', async () => {
        const longTtlConfig = { ...config, maxTtlSeconds: 7_200 };
        const expire = vi.spyOn(redis, 'expire');

        await bumpTagVersions(['tenant:t1'], longTtlConfig, redis);

        expect(expire).toHaveBeenCalledWith(getTagVersionKey('tenant:t1', longTtlConfig), 72_000);
        expect(72_000).toBeGreaterThanOrEqual(longTtlConfig.maxTtlSeconds);
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
    test('normalizes omitted and partial wrapper configuration', async () => {
        await withCacheInvalidation(
            async () => {
                await publishInvalidation(['default-config'], config, redis);
            },
            redis,
        );

        expect(redis.store.get(getTagVersionKey('default-config', normalizeConfig()))).toBe('1');

        const partialConfig = { keyPrefix: 'custom-prefix', maxTtlSeconds: 60 };
        const partialNormalized = normalizeConfig(partialConfig);
        await withCacheInvalidation(
            async () => {
                await publishInvalidation(['partial-config'], config, redis);
            },
            redis,
            partialConfig,
        );

        expect(redis.store.get(getTagVersionKey('partial-config', partialNormalized))).toBe('1');
    });

    test('logs deferred invalidation errors without rejecting the wrapper', async () => {
        const error = vi.fn();
        const wrapperConfig = normalizeConfig({
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error,
            },
        });
        vi.spyOn(redis, 'increment').mockRejectedValueOnce(new Error('redis down'));

        await expect(
            withCacheInvalidation(
                async () => {
                    await publishInvalidation(['failing-tag'], config, redis);
                    return 'completed';
                },
                redis,
                wrapperConfig,
            ),
        ).resolves.toBe('completed');

        expect(error).toHaveBeenCalledWith(
            { tags: ['failing-tag'], error: 'redis down' },
            'Deferred cache invalidation failed',
        );
    });

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
