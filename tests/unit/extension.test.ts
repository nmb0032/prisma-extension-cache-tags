import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleWrite, normalizeConfig, readThroughCache } from '../../src/extension';
import { getTagVersionKey } from '../../src/keys';
import { createFakeRedis, type FakeRedis } from './fake-redis';

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

describe('normalizeConfig', () => {
    test('applies generic defaults with no KitCompass model graph', () => {
        const config = normalizeConfig();

        expect(config.dependencyTags).toEqual({});
        expect(config.tenantKeys).toEqual([]);
        expect(config.entityKeys).toEqual(['id']);
        expect(config.keyPrefix).toBe('prismaCacheTags:v1');
        expect(config.enabled).toBe(true);
    });

    test('merges nested stampede options rather than replacing them', () => {
        const config = normalizeConfig({ stampede: { waitMs: 99 } });

        expect(config.stampede.waitMs).toBe(99);
        expect(config.stampede.pollMs).toBe(50);
        expect(config.stampede.lockTtlMs).toBe(5000);
    });
});

describe('readThroughCache', () => {
    test('misses, calls the query, and populates the cache', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.set).toBe(1);
    });

    test('serves the second identical read from cache without calling the query', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        const second = await readThroughCache(params);

        expect(second).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('clamps the TTL to maxTtlSeconds', async () => {
        const config = normalizeConfig({ maxTtlSeconds: 10 });
        const set = vi.spyOn(redis, 'set');

        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([]),
            cacheOptions: { ttlSeconds: 9999 },
            config,
            redisAdapter: redis,
        });

        expect(set).toHaveBeenCalledWith(expect.any(String), expect.anything(), 10);
    });

    test('falls back to the query when the cache read throws', async () => {
        const config = normalizeConfig();
        vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('does not cache empty results when cacheEmpty is false', async () => {
        const config = normalizeConfig({ cacheEmpty: false });

        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([]),
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(redis.callCounts.set ?? 0).toBe(0);
    });

    test('reports hit and miss to the metrics sink', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ metrics: { onCacheEvent } });
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query: vi.fn().mockResolvedValue([{ id: 'w1' }]),
            cacheOptions: {},
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        await readThroughCache(params);

        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss' });
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'hit' });
    });
});

describe('handleWrite', () => {
    test('runs the write then bumps the resolved tag versions', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const query = vi.fn().mockResolvedValue({ id: 'w1' });

        const result = await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't1', id: 'w1' } },
            cleanedArgs: { where: { tenantId: 't1', id: 'w1' } },
            query,
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual({ id: 'w1' });
        expect(redis.store.get(getTagVersionKey('tenant:t1:model:Widget', config))).toBe('1');
    });

    test('a write invalidates a previously cached read of the same tenant and model', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        expect(readQuery).toHaveBeenCalledTimes(1);

        await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't1', id: 'w1' } },
            cleanedArgs: { where: { tenantId: 't1', id: 'w1' } },
            query: vi.fn().mockResolvedValue({ id: 'w1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        await readThroughCache(readParams);

        // The tag version bump changed the key, so the read had to hit the database again.
        expect(readQuery).toHaveBeenCalledTimes(2);
    });

    test('a write to an unrelated tenant does not invalidate', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { tenantId: 't2', id: 'w2' } },
            cleanedArgs: { where: { tenantId: 't2', id: 'w2' } },
            query: vi.fn().mockResolvedValue({ id: 'w2' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        await readThroughCache(readParams);

        expect(readQuery).toHaveBeenCalledTimes(1);
    });

    test('a dependency tag propagates invalidation across models', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'], dependencyTags: { Part: ['Widget'] } });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const readParams = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };

        await readThroughCache(readParams);
        await handleWrite({
            model: 'Part',
            operation: 'create',
            args: { data: { tenantId: 't1', label: 'p1' } },
            cleanedArgs: { data: { tenantId: 't1', label: 'p1' } },
            query: vi.fn().mockResolvedValue({ id: 'p1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        await readThroughCache(readParams);

        expect(readQuery).toHaveBeenCalledTimes(2);
    });
});
