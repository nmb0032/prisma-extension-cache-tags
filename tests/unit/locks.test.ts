import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getCacheLockKey } from '../../src/keys';
import { acquireCacheLock, releaseCacheLock, waitForCachedValue } from '../../src/locks';
import { noopLogger, noopMetrics } from '../../src/observability';
import type { NormalizedCacheConfig } from '../../src/types';
import { createAnalysisContext } from '../../src/schema';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';
import { createFakeRedis, type FakeRedis } from './fake-redis';

const config: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v2',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 200, pollMs: 10, lockTtlMs: 5000 },
    analysis: createAnalysisContext(cacheSchema, cacheModels),
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
    test('derives the lock key directly from the versioned cache key', async () => {
        const lock = await acquireCacheLock('key-1', undefined, config, redis);
        expect(lock?.key).toBe('key-1:lock');
    });

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

        expect(redis.store.has(getCacheLockKey('key-1'))).toBe(true);
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

    test('checks immediately when the value is already available', async () => {
        vi.useFakeTimers();
        try {
            const getCachedValue = vi.fn().mockResolvedValue('already-cached');
            await expect(waitForCachedValue('key-1', undefined, config, redis, getCachedValue)).resolves.toBe('already-cached');
            expect(getCachedValue).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('uses bounded exponential backoff instead of waiting for the default poll interval', async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const getCachedValue = vi.fn().mockImplementation(async () => {
                calls += 1;
                return calls >= 3 ? 'populated' : undefined;
            });
            const pending = waitForCachedValue('key-1', undefined, config, redis, getCachedValue);
            await vi.advanceTimersByTimeAsync(2);
            await vi.advanceTimersByTimeAsync(4);
            await expect(pending).resolves.toBe('populated');
            expect(getCachedValue).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
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
