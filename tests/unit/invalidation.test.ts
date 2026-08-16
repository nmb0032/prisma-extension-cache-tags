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
