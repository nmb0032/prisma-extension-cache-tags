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

    test('normalizes tag ordering, whitespace, and limits before generating the key', async () => {
        const limitedConfig = { ...config, maxTagsPerQuery: 2 };
        const args = { where: { tenantId: 't1' } };
        const normalized = await generateCacheKey('Widget', 'findMany', args, ['alpha', 'beta'], limitedConfig, redis);
        const unnormalized = await generateCacheKey(
            'Widget',
            'findMany',
            args,
            [' beta ', 'ignored', 'alpha'],
            limitedConfig,
            redis,
        );

        expect(unnormalized).toBe(normalized);
    });

    test('ignore the cache property when computing a fingerprint', () => {
        const withCache = computeFingerprint('Widget', 'findMany', { where: { a: 1 }, cache: { ttlSeconds: 5 } }, [], config);
        const without = computeFingerprint('Widget', 'findMany', { where: { a: 1 } }, [], config);
        expect(withCache).toBe(without);
    });
});
