import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createOptimizedRedisPrimitives } from '../../src/optimized';
import { buildVersionedCacheKey, getTagVersionKey, prepareCacheKey } from '../../src/keys';
import { createCacheTagsExtension, handleWrite, normalizeConfig, readThroughCache } from '../../src/extension';
import { acquireCacheLock, releaseCacheLock } from '../../src/locks';
import { serializeCacheEnvelope } from '../../src/serialization';
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
        expect(config.keyPrefix).toBe('prismaCacheTags:v2');
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

    test('bypasses only canonicalization errors and reports the exact argument path', async () => {
        let operationHandler!: (params: Record<string, unknown>) => Promise<unknown>;
        const error = vi.fn();
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
            metrics: { onCacheEvent },
        });
        const base = {
            $extends: vi.fn((definition: { query: { $allOperations: typeof operationHandler } }) => {
                operationHandler = definition.query.$allOperations;
                return { $transaction: vi.fn() };
            }),
        };
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);
        const args = { where: { value: () => 'unsupported' }, cache: { ttlSeconds: 60 } };

        createCacheTagsExtension(redis, config)(base as never);
        const result = await operationHandler({ model: 'Widget', operation: 'findMany', args, query });

        expect(result).toEqual([{ id: 'fresh' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.getString ?? 0).toBe(0);
        expect(redis.callCounts.setString ?? 0).toBe(0);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'bypass',
            reason: 'canonicalization',
        });
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'Widget', operation: 'findMany', path: '$.where.value' }),
            expect.stringContaining('canonicalization'),
        );
    });

    test('bypasses cyclic arguments without traversing them during tag resolution', async () => {
        let operationHandler!: (params: Record<string, unknown>) => Promise<unknown>;
        const onCacheEvent = vi.fn();
        const base = {
            $extends: vi.fn((definition: { query: { $allOperations: typeof operationHandler } }) => {
                operationHandler = definition.query.$allOperations;
                return { $transaction: vi.fn() };
            }),
        };
        const args: Record<string, unknown> = {};
        args.self = args;
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);
        const config = normalizeConfig({ metrics: { onCacheEvent } });

        createCacheTagsExtension(redis, config)(base as never);
        const result = await operationHandler({ model: 'Widget', operation: 'findMany', args: { ...args, cache: {} }, query });

        expect(result).toEqual([{ id: 'fresh' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'bypass',
            reason: 'canonicalization',
        });
    });
});

describe('readThroughCache', () => {
    test('serves a verified optimized hit without issuing a second value read', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ metrics: { onCacheEvent } });
        const query = vi.fn().mockResolvedValue([{ id: 'database' }]);
        const preparedKey = prepareCacheKey('Widget', 'findMany', {}, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        const optimized = {
            lookupVersioned: vi.fn().mockResolvedValue({
                cacheKey,
                value: serializeCacheEnvelope({ identity: preparedKey.identity, tenantScope: [], value: [{ id: 'cached' }] }),
                lockAcquired: false,
            }),
            populateAndRelease: vi.fn(),
            bumpTagVersions: vi.fn(),
        };

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            preparedRead: {
                cleanedArgs: {},
                normalizedTags: [],
                tenantScope: [],
                preparedKey,
            },
            query,
            cacheOptions: {},
            config,
            redisAdapter: { ...redis, optimized },
        });

        expect(result).toEqual([{ id: 'cached' }]);
        expect(query).not.toHaveBeenCalled();
        expect(redis.callCounts.getString ?? 0).toBe(0);
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'hit', path: 'optimized' });
    });

    test('populates and releases an optimized cold owner atomically', async () => {
        const config = normalizeConfig();
        const query = vi.fn().mockResolvedValue([{ id: 'database' }]);
        const preparedKey = prepareCacheKey('Widget', 'findMany', {}, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        const optimized = {
            lookupVersioned: vi.fn().mockResolvedValue({ cacheKey, value: null, lockAcquired: true }),
            populateAndRelease: vi.fn().mockResolvedValue(true),
            bumpTagVersions: vi.fn(),
        };

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: {},
            cleanedArgs: {},
            preparedRead: {
                cleanedArgs: {},
                normalizedTags: [],
                tenantScope: [],
                preparedKey,
            },
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: { ...redis, optimized },
        });

        expect(result).toEqual([{ id: 'database' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(optimized.populateAndRelease).toHaveBeenCalledWith(
            expect.objectContaining({ cacheKey, ttlSeconds: 60, value: expect.any(String) }),
            expect.objectContaining({ onScriptEvent: expect.any(Function), onScriptFailure: expect.any(Function) }),
        );
        expect(redis.callCounts.deleteIfValue ?? 0).toBe(0);
    });

    test('returns the database result when an optimized owner loses population ownership', async () => {
        const config = normalizeConfig();
        const query = vi.fn().mockResolvedValue({ id: 'database' });
        const preparedKey = prepareCacheKey('Widget', 'findUnique', { where: { id: 'w1' } }, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        const optimized = {
            lookupVersioned: vi.fn().mockResolvedValue({ cacheKey, value: null, lockAcquired: true }),
            populateAndRelease: vi.fn().mockResolvedValue(false),
            bumpTagVersions: vi.fn(),
        };

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findUnique',
                args: { where: { id: 'w1' } },
                cleanedArgs: { where: { id: 'w1' } },
                preparedRead: {
                    cleanedArgs: { where: { id: 'w1' } },
                    normalizedTags: [],
                    tenantScope: [],
                    preparedKey,
                },
                query,
                cacheOptions: {},
                config,
                redisAdapter: { ...redis, optimized },
            }),
        ).resolves.toEqual({ id: 'database' });

        expect(query).toHaveBeenCalledTimes(1);
        expect(optimized.populateAndRelease).toHaveBeenCalledTimes(1);
    });

    test('emits one lookup failure for malformed optimized replies before using the command fallback', async () => {
        const warn = vi.fn();
        const onScriptEvent = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
            metrics: { onCacheEvent: vi.fn(), onScriptEvent },
        });
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('lookup-sha'),
            evalSha: vi.fn().mockResolvedValue(['malformed']),
        });
        const query = vi.fn().mockResolvedValue([{ id: 'database' }]);

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findMany',
                args: {},
                cleanedArgs: {},
                query,
                cacheOptions: {},
                config,
                redisAdapter: { ...redis, optimized },
            }),
        ).resolves.toEqual([{ id: 'database' }]);

        expect(query).toHaveBeenCalledTimes(1);
        expect(onScriptEvent).toHaveBeenCalledTimes(1);
        expect(onScriptEvent).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'failure',
            retry: false,
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ primitive: 'lookupVersioned', retry: false, error: 'Invalid versioned lookup response' }),
            'Redis cache script failed',
        );
    });

    test('emits one population failure for malformed optimized replies and releases the owner lock safely', async () => {
        const warn = vi.fn();
        const onScriptEvent = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
            metrics: { onCacheEvent: vi.fn(), onScriptEvent },
        });
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('script-sha'),
            evalSha: vi.fn().mockResolvedValueOnce(['query-key:', '', '0', '1']).mockResolvedValueOnce(2),
        });
        const query = vi.fn().mockResolvedValue({ id: 'database' });

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findUnique',
                args: { where: { id: 'w1' } },
                cleanedArgs: { where: { id: 'w1' } },
                query,
                cacheOptions: {},
                config,
                redisAdapter: { ...redis, optimized },
            }),
        ).resolves.toEqual({ id: 'database' });

        expect(query).toHaveBeenCalledTimes(1);
        expect(onScriptEvent).toHaveBeenCalledTimes(1);
        expect(onScriptEvent).toHaveBeenCalledWith({
            primitive: 'populateAndRelease',
            result: 'failure',
            retry: false,
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ primitive: 'populateAndRelease', retry: false, error: 'Invalid Redis script flag' }),
            'Redis cache script failed',
        );
        expect(redis.callCounts.deleteIfValue).toBe(1);
    });

    test('rejects an optimized malformed payload without repopulating that generation', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ metrics: { onCacheEvent } });
        const query = vi.fn().mockResolvedValue([{ id: 'database' }]);
        const preparedKey = prepareCacheKey('Widget', 'findMany', {}, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        const optimized = {
            lookupVersioned: vi.fn().mockResolvedValue({ cacheKey, value: 'malformed', lockAcquired: false }),
            populateAndRelease: vi.fn(),
            bumpTagVersions: vi.fn(),
        };

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findMany',
                args: {},
                cleanedArgs: {},
                preparedRead: {
                    cleanedArgs: {},
                    normalizedTags: [],
                    tenantScope: [],
                    preparedKey,
                },
                query,
                cacheOptions: {},
                config,
                redisAdapter: { ...redis, optimized },
            }),
        ).resolves.toEqual([{ id: 'database' }]);

        expect(optimized.populateAndRelease).not.toHaveBeenCalled();
        expect(redis.callCounts.delete).toBe(1);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'optimized',
            reason: 'invalid-envelope',
        });
    });

    test('falls back to command reads when the optimized lookup fails and records the script error', async () => {
        const warn = vi.fn();
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
            metrics: { onCacheEvent },
        });
        const query = vi.fn().mockResolvedValue([{ id: 'database' }]);
        const optimized = {
            lookupVersioned: vi.fn().mockRejectedValue(new Error('script unavailable')),
            populateAndRelease: vi.fn(),
            bumpTagVersions: vi.fn(),
        };

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findMany',
                args: {},
                cleanedArgs: {},
                query,
                cacheOptions: {},
                config,
                redisAdapter: { ...redis, optimized },
            }),
        ).resolves.toEqual([{ id: 'database' }]);

        expect(query).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ primitive: 'lookupVersioned', retry: false, error: 'script unavailable' }),
            'Redis cache script failed',
        );
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
    });

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
        expect(redis.callCounts.setString).toBe(1);
    });

    test('caches BigInt filter arguments instead of bypassing', async () => {
        const query = vi.fn().mockResolvedValue([{ id: 'w1' }]);
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { sequence: 42n } },
            cleanedArgs: { where: { sequence: 42n } },
            query,
            cacheOptions: {},
            config: normalizeConfig(),
            redisAdapter: redis,
        };

        await readThroughCache(params);
        await readThroughCache(params);

        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.setString).toBe(1);
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
        vi.spyOn(redis, 'getString').mockImplementationOnce(async () => null);

        const result = await readThroughCache(params);

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.deleteIfValue).toBe(1);
        expect(Array.from(redis.store.keys()).filter((key) => key.includes(':lock:'))).toHaveLength(0);
        expect(onCacheEvent).toHaveBeenNthCalledWith(1, { model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        expect(onCacheEvent).toHaveBeenNthCalledWith(2, { model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
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
        vi.spyOn(redis, 'getString').mockImplementationOnce(async () => null);

        const result = await readThroughCache(params);
        await releaseCacheLock(ownerLock!, redis, config);

        expect(result).toEqual([{ id: 'w1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(onCacheEvent).toHaveBeenNthCalledWith(1, { model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        expect(onCacheEvent).toHaveBeenNthCalledWith(2, { model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
    });

    test('clamps the TTL to maxTtlSeconds', async () => {
        const config = normalizeConfig({ maxTtlSeconds: 10 });
        const set = vi.spyOn(redis, 'setString');

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
        vi.spyOn(redis, 'getString').mockRejectedValueOnce(new Error('redis down'));
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
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
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
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
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

        expect(redis.callCounts.setString ?? 0).toBe(0);
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

        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
        expect(onCacheEvent).toHaveBeenCalledTimes(2);
    });

    test('rejects a foreign identity and tenant scope instead of returning its value', async () => {
        const onCacheEvent = vi.fn();
        const warn = vi.fn();
        const config = normalizeConfig({
            tenantKeys: ['tenantId'],
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
            metrics: { onCacheEvent },
        });
        const cleanedArgs = { where: { tenantId: 'tenant-a' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, ['tenant:tenant-a'], ['tenant-a'], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '0');
        await redis.setString(
            cacheKey,
            serializeCacheEnvelope({
                identity: 'foreign-identity',
                tenantScope: ['tenant-b'],
                value: [{ id: 'foreign' }],
            }),
        );
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: cleanedArgs,
            cleanedArgs,
            preparedRead: {
                cleanedArgs,
                normalizedTags: ['tenant:tenant-a'],
                tenantScope: ['tenant-a'],
                preparedKey,
            },
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'fresh' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.delete).toBe(1);
        expect(redis.store.has(cacheKey)).toBe(false);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'fallback',
            reason: 'identity-mismatch',
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'Widget',
                operation: 'findMany',
                cacheKey,
                expectedTenantScope: ['tenant-a'],
                observedTenantScope: ['tenant-b'],
            }),
            expect.stringContaining('identity mismatch'),
        );
    });

    test('queries Prisma when deleting a mismatched entry fails and logs the failure', async () => {
        const error = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
        });
        const cleanedArgs = { where: { tenantId: 'tenant-a' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, ['tenant:tenant-a'], ['tenant-a'], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '0');
        await redis.setString(
            cacheKey,
            serializeCacheEnvelope({
                identity: 'foreign-identity',
                tenantScope: ['tenant-b'],
                value: [{ id: 'foreign' }],
            }),
        );
        vi.spyOn(redis, 'delete').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);

        await expect(
            readThroughCache({
                model: 'Widget',
                operation: 'findMany',
                args: cleanedArgs,
                cleanedArgs,
                preparedRead: {
                    cleanedArgs,
                    normalizedTags: ['tenant:tenant-a'],
                    tenantScope: ['tenant-a'],
                    preparedKey,
                },
                query,
                cacheOptions: {},
                config,
                redisAdapter: redis,
            }),
        ).resolves.toEqual([{ id: 'fresh' }]);

        expect(query).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'Widget', operation: 'findMany', cacheKey, error: 'redis down' }),
            expect.stringContaining('identity mismatch'),
        );
    });

    test.each([
        ['malformed SuperJSON', 'not-superjson'],
        ['missing value', serializeCacheEnvelope({ identity: 'identity', tenantScope: [] } as never)],
        ['wrong identity type', serializeCacheEnvelope({ identity: 42, tenantScope: [], value: null } as never)],
        ['wrong tenant scope shape', serializeCacheEnvelope({ identity: 'identity', tenantScope: ['tenant-a', 42], value: null } as never)],
    ])('treats %s as an invalid envelope without serving it', async (_description, payload) => {
        const onCacheEvent = vi.fn();
        const debug = vi.fn();
        const config = normalizeConfig({
            logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            metrics: { onCacheEvent },
        });
        const cleanedArgs = { where: { id: 'w1' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        await redis.setString(cacheKey, payload);
        redis.resetCallCounts();
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: cleanedArgs,
            cleanedArgs,
            preparedRead: {
                cleanedArgs,
                normalizedTags: [],
                tenantScope: [],
                preparedKey,
            },
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'fresh' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.delete).toBe(1);
        expect(redis.store.has(cacheKey)).toBe(false);
        expect(redis.callCounts.setString ?? 0).toBe(0);
        expect(onCacheEvent).toHaveBeenCalledTimes(1);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'fallback',
            reason: 'invalid-envelope',
        });
        expect(onCacheEvent).not.toHaveBeenCalledWith(expect.objectContaining({ result: 'hit' }));
        expect(debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Cache hit'));
    });

    test('queries Prisma and reports an invalid-envelope bypass when deletion fails', async () => {
        const onCacheEvent = vi.fn();
        const error = vi.fn();
        const config = normalizeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
            metrics: { onCacheEvent },
        });
        const cleanedArgs = { where: { id: 'w1' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, [], [], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '');
        await redis.setString(cacheKey, 'not-superjson');
        redis.resetCallCounts();
        const deleteEntry = vi.spyOn(redis, 'delete').mockRejectedValueOnce(new Error('redis down'));
        const query = vi.fn().mockResolvedValue([{ id: 'fresh' }]);

        const result = await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: cleanedArgs,
            cleanedArgs,
            preparedRead: {
                cleanedArgs,
                normalizedTags: [],
                tenantScope: [],
                preparedKey,
            },
            query,
            cacheOptions: {},
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'fresh' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(deleteEntry).toHaveBeenCalledTimes(1);
        expect(redis.store.has(cacheKey)).toBe(true);
        expect(redis.callCounts.setString ?? 0).toBe(0);
        expect(onCacheEvent).toHaveBeenCalledTimes(1);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'fallback',
            reason: 'invalid-envelope',
        });
        expect(onCacheEvent).not.toHaveBeenCalledWith(expect.objectContaining({ result: 'hit' }));
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'Widget', operation: 'findMany', cacheKey, error: 'redis down' }),
            expect.stringContaining('Invalid cache envelope'),
        );
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
