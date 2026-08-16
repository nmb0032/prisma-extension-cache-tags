import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createCacheTagsExtension, handleWrite, normalizeConfig, readThroughCache } from '../../src/extension';
import { getTagVersionKey } from '../../src/keys';
import { acquireCacheLock, releaseCacheLock } from '../../src/locks';
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
        expect(config.tenantPrecision).toBe(false);
    });

    test('merges nested stampede options rather than replacing them', () => {
        const config = normalizeConfig({ stampede: { waitMs: 99 } });

        expect(config.stampede.waitMs).toBe(99);
        expect(config.stampede.pollMs).toBe(50);
        expect(config.stampede.lockTtlMs).toBe(5000);
    });

    test('allows tenant precision to be opted into explicitly', () => {
        expect(normalizeConfig({ tenantPrecision: true }).tenantPrecision).toBe(true);
    });
});

describe('createCacheTagsExtension', () => {
    test('strips cache args when caching is disabled globally', async () => {
        let operationHandler!: (params: Record<string, unknown>) => Promise<unknown>;
        const base = {
            $extends: vi.fn((definition: { query: { $allOperations: typeof operationHandler } }) => {
                operationHandler = definition.query.$allOperations;
                return { $transaction: vi.fn() };
            }),
        };
        const extension = createCacheTagsExtension(redis, { enabled: false });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const args = { where: { id: 'w1' }, cache: { ttlSeconds: 60 } };

        extension(base as never);
        const result = await operationHandler({ model: 'Widget', operation: 'findMany', args, query });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledWith({ where: { id: 'w1' } });
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

    test('releases the lock when the post-acquire recheck finds a cached value', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ stampede: { waitMs: 10, pollMs: 1 }, metrics: { onCacheEvent } });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        onCacheEvent.mockClear();
        redis.resetCallCounts();
        vi.spyOn(redis, 'get').mockImplementationOnce(async () => null);

        const result = await readThroughCache(params);

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.deleteIfValue).toBe(1);
        expect(Array.from(redis.store.keys()).filter((key) => key.includes(':lock:'))).toHaveLength(0);
        expect(onCacheEvent).toHaveBeenNthCalledWith(1, { model: 'Widget', operation: 'findMany', result: 'miss' });
        expect(onCacheEvent).toHaveBeenNthCalledWith(2, { model: 'Widget', operation: 'findMany', result: 'hit' });
    });

    test('reports a hit when a waiter receives the cached value', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ stampede: { waitMs: 20, pollMs: 1 }, metrics: { onCacheEvent } });
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        };

        await readThroughCache(params);
        onCacheEvent.mockClear();
        redis.resetCallCounts();
        const cacheKey = Array.from(redis.store.keys()).find((key) => key.includes(':qry:'));
        const ownerLock = await acquireCacheLock(cacheKey!, params.cacheOptions, config, redis);
        vi.spyOn(redis, 'get').mockImplementationOnce(async () => null);

        const result = await readThroughCache(params);
        await releaseCacheLock(ownerLock!, redis, config);

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(onCacheEvent).toHaveBeenNthCalledWith(1, { model: 'Widget', operation: 'findMany', result: 'miss' });
        expect(onCacheEvent).toHaveBeenNthCalledWith(2, { model: 'Widget', operation: 'findMany', result: 'hit' });
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

    test('falls back with cleaned args when tag version lookup throws', async () => {
        const warn = vi.fn();
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn,
                error: vi.fn(),
            },
            metrics: { onCacheEvent },
        });
        vi.spyOn(redis, 'mgetString').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const cleanedArgs = { where: { id: 'w1' } };

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: { ...cleanedArgs, cache: { ttlSeconds: 60 } },
            cleanedArgs,
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledWith(cleanedArgs);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ error: 'redis down' }),
            'Cache read failed; falling back to Prisma query',
        );
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss' });
    });

    test('falls back when a custom-key tag version lookup throws', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ metrics: { onCacheEvent } });
        vi.spyOn(redis, 'mgetString').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const cleanedArgs = { where: { id: 'w1' } };

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: { ...cleanedArgs, cache: { key: 'widgets' } },
            cleanedArgs,
            query,
            cacheOptions: { key: 'widgets' },
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledWith(cleanedArgs);
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss' });
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
        expect(onCacheEvent).toHaveBeenCalledTimes(2);
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

    test('update and delete by ID use the returned tenant identity', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1', tenantId: 't1', name: 'before' }]);
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
            args: { where: { id: 'w1' }, data: { name: 'after' } },
            cleanedArgs: { where: { id: 'w1' }, data: { name: 'after' } },
            query: vi.fn().mockResolvedValue({ id: 'w1', tenantId: 't1', name: 'after' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        await readThroughCache(readParams);
        expect(readQuery).toHaveBeenCalledTimes(2);

        await readThroughCache(readParams);
        readQuery.mockResolvedValue([]);

        await handleWrite({
            model: 'Widget',
            operation: 'delete',
            args: { where: { id: 'w1' } },
            cleanedArgs: { where: { id: 'w1' } },
            query: vi.fn().mockResolvedValue({ id: 'w1', tenantId: 't1', name: 'after' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        const afterDelete = await readThroughCache(readParams);
        expect(afterDelete).toEqual([]);
        expect(readQuery).toHaveBeenCalledTimes(3);
    });

    test('uses a model-wide fallback when a write cannot determine the tenant', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1', tenantId: 't1' }]);
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
            args: { where: { id: 'w1' }, data: { name: 'after' }, select: { id: true } },
            cleanedArgs: { where: { id: 'w1' }, data: { name: 'after' }, select: { id: true } },
            query: vi.fn().mockResolvedValue({ id: 'w1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        await readThroughCache(readParams);
        expect(readQuery).toHaveBeenCalledTimes(2);
    });

    test('a write to an unrelated tenant does not invalidate in precise mode', async () => {
        const config = normalizeConfig({ tenantKeys: ['tenantId'], tenantPrecision: true });
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

    test('a write to an unrelated tenant invalidates under the safe default', async () => {
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

        expect(readQuery).toHaveBeenCalledTimes(2);
    });

    test('warns when precise-mode write tenant identity is unavailable', async () => {
        const warn = vi.fn();
        const config = normalizeConfig({
            tenantKeys: ['tenantId'],
            tenantPrecision: true,
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn,
                error: vi.fn(),
            },
        });

        const result = await handleWrite({
            model: 'Widget',
            operation: 'update',
            args: { where: { id: 'w1' } },
            cleanedArgs: { where: { id: 'w1' } },
            query: vi.fn().mockResolvedValue({ id: 'w1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual({ id: 'w1' });
        expect(warn).toHaveBeenCalledWith(
            { model: 'Widget', operation: 'update' },
            'Tenant identity unavailable after write; invalidating the model-wide cache fallback',
        );
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
