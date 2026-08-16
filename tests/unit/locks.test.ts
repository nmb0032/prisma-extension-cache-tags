import { beforeEach, describe, expect, test, vi } from 'vitest';
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
    tenantPrecision: false,
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

    test('does not release a lock when conditional deletion is unavailable', async () => {
        const lock = await acquireCacheLock('key-1', undefined, config, redis);
        expect(lock).not.toBeNull();

        const withoutDeleteIfValue = { ...redis, deleteIfValue: undefined };
        await releaseCacheLock(lock!, withoutDeleteIfValue, config);

        expect(redis.store.get(lock!.key)).toBe(lock!.token);
        expect(redis.callCounts.delete ?? 0).toBe(0);
    });

    test('logs string lock-release rejections without throwing', async () => {
        const warn = vi.fn();
        const loggingConfig = {
            ...config,
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn,
                error: vi.fn(),
            },
        };
        const lock = { key: 'lock-key', token: 'lock-token' };
        vi.spyOn(redis, 'deleteIfValue').mockRejectedValueOnce('redis down');

        await expect(releaseCacheLock(lock, redis, loggingConfig)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith({ key: 'lock-key', error: 'redis down' }, 'Failed to release cache lock');
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
