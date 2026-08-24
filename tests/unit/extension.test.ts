import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createOptimizedRedisPrimitives } from '../../src/optimized';
import { buildVersionedCacheKey, getTagVersionKey, prepareCacheKey } from '../../src/keys';
import { createCacheTagsExtension, handleWrite, normalizeConfig, prepareRead, readThroughCache } from '../../src/extension';
import { acquireCacheLock, releaseCacheLock } from '../../src/locks';
import { serializeCacheEnvelope } from '../../src/serialization';
import { createFakeRedis, type FakeRedis } from './fake-redis';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';
import type { NormalizedCacheConfig } from '../../src/types';

let redis: FakeRedis;

beforeEach(() => {
    redis = createFakeRedis();
});

function makeConfig(
    overrides: Partial<Omit<NormalizedCacheConfig, 'analysis' | 'stampede'>> & {
        stampede?: Partial<NormalizedCacheConfig['stampede']>;
    } = {},
): NormalizedCacheConfig {
    const base = normalizeConfig({
        schema: cacheSchema,
        models: {
            ...cacheModels,
            Widget: { tenant: false },
            Part: { tenant: false },
        },
    });
    const { stampede, ...overridesWithoutStampede } = overrides;
    return {
        ...base,
        ...overridesWithoutStampede,
        stampede: { ...base.stampede, ...stampede },
        analysis: base.analysis,
    };
}

describe('normalizeConfig', () => {
    test('applies v3 defaults and builds the analysis context', () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });

        expect(config.keyPrefix).toBe('prismaCacheTags:v3');
        expect(config.analysis.models.Widget!.scope).toEqual({
            kind: 'tenant',
            field: 'tenantId',
            namespace: 'tenant',
        });
        expect(config.enabled).toBe(true);
    });

    test('merges nested stampede options rather than replacing them', () => {
        const config = makeConfig({ stampede: { waitMs: 99 } });

        expect(config.stampede.waitMs).toBe(99);
        expect(config.stampede.pollMs).toBe(50);
        expect(config.stampede.lockTtlMs).toBe(5000);
    });

    test('rejects malformed schema and model descriptors synchronously', () => {
        expect(() => normalizeConfig({ schema: { formatVersion: 2, models: {} } as never, models: {} })).toThrow(
            'Unsupported cache schema format version',
        );
        expect(() => normalizeConfig({ schema: cacheSchema, models: { Missing: { tenant: false } } as never })).toThrow(
            'Configured model "Missing" does not exist in the schema',
        );
    });
});

describe('createCacheTagsExtension', () => {
    test('prepares relation-aware subscriptions while plain reads remain primary-only', () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const withEquipment = prepareRead(
            'WorkOrder',
            'findMany',
            { where: { organizationId: 'org_1' }, include: { equipment: true } },
            { where: { organizationId: 'org_1' }, include: { equipment: true } },
            { ttlSeconds: 60 },
            config,
        );
        const plain = prepareRead(
            'WorkOrder',
            'findMany',
            { where: { organizationId: 'org_1' } },
            { where: { organizationId: 'org_1' } },
            { ttlSeconds: 60 },
            config,
        );

        expect(withEquipment.normalizedTags).toEqual(expect.arrayContaining([
            'scope:organization:org_1:model:WorkOrder',
            'scope:organization:org_1:model:Equipment',
        ]));
        expect(plain.normalizedTags).not.toContain('scope:organization:org_1:model:Equipment');
    });

    test('publishes only scoped model and entity tags for a resolved Equipment write', async () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });

        await handleWrite({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: 'eq_1' },
                create: { id: 'eq_1', organizationId: 'org_1' },
                update: { name: 'Pump' },
            },
            cleanedArgs: {
                where: { id: 'eq_1' },
                create: { id: 'eq_1', organizationId: 'org_1' },
                update: { organizationId: 'org_1' },
            },
            query: vi.fn().mockResolvedValue({ id: 'eq_1', organizationId: 'org_1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        expect(redis.store.get(getTagVersionKey('scope:organization:org_1:model:Equipment', config))).toBe('1');
        expect(redis.store.get(getTagVersionKey('scope:organization:org_1:entity:Equipment:eq_1', config))).toBe('1');
        expect([...redis.store.keys()]).not.toContain(getTagVersionKey('global:model:Equipment', config));
        expect([...redis.store.keys()].some((key) => key.includes(':root'))).toBe(false);
    });

    test('publishes global fallback and warns once when write tenant scope is unresolved', async () => {
        const warn = vi.fn();
        const config = normalizeConfig({
            schema: cacheSchema,
            models: cacheModels,
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        });

        await handleWrite({
            model: 'Equipment',
            operation: 'update',
            args: { where: { id: 'eq_1' }, data: { name: 'Pump' } },
            cleanedArgs: { where: { id: 'eq_1' }, data: { name: 'Pump' } },
            query: vi.fn().mockResolvedValue({ id: 'eq_1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });

        expect(redis.store.get(getTagVersionKey('global:model:Equipment', config))).toBe('1');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            { model: 'Equipment', operation: 'update', fallbackModels: ['Equipment'] },
            'Tenant identity unavailable after write; invalidating the model-wide cache fallback',
        );
    });

    test('keeps tenant identities and tag strings out of identity and debug logs', async () => {
        const warn = vi.fn();
        const debug = vi.fn();
        const config = makeConfig({
            logger: { debug, info: vi.fn(), warn, error: vi.fn() },
        });
        const tenantArgs = { where: { tenantId: 'secret-tenant' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', tenantArgs, ['secret:tag'], ['tenant:secret-tenant'], config);
        const cacheKey = buildVersionedCacheKey(preparedKey.baseKey, '0');
        await redis.setString(
            cacheKey,
            serializeCacheEnvelope({ identity: 'foreign-identity', tenantScope: ['tenant:other-secret'], value: [{ secret: 'row' }] }),
        );

        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: tenantArgs,
            cleanedArgs: tenantArgs,
            preparedRead: {
                cleanedArgs: tenantArgs,
                normalizedTags: ['secret:tag'],
                tenantScope: ['tenant:secret-tenant'],
                preparedKey,
            },
            query: vi.fn().mockResolvedValue([{ id: 'fresh' }]),
            cacheOptions: { debug: true },
            config,
            redisAdapter: redis,
        });

        await redis.setString(
            cacheKey,
            serializeCacheEnvelope({
                identity: preparedKey.identity,
                tenantScope: ['tenant:secret-tenant'],
                value: [{ secret: 'row' }],
            }),
        );
        await readThroughCache({
            model: 'Widget',
            operation: 'findMany',
            args: tenantArgs,
            cleanedArgs: tenantArgs,
            preparedRead: {
                cleanedArgs: tenantArgs,
                normalizedTags: ['secret:tag'],
                tenantScope: ['tenant:secret-tenant'],
                preparedKey,
            },
            query: vi.fn().mockResolvedValue([{ id: 'fresh' }]),
            cacheOptions: { debug: true },
            config,
            redisAdapter: redis,
        });

        const calls = JSON.stringify([...warn.mock.calls, ...debug.mock.calls]);
        expect(calls).not.toContain('secret-tenant');
        expect(calls).not.toContain('other-secret');
        expect(calls).not.toContain('secret:tag');
        expect(calls).not.toContain('secret');
        expect(warn).toHaveBeenCalledWith(
            { model: 'Widget', operation: 'findMany', path: 'fallback', reason: 'identity-mismatch' },
            'Cache identity mismatch; bypassing cached value',
        );
        expect(debug).toHaveBeenCalledWith(
            { model: 'Widget', operation: 'findMany', path: 'fallback', tagCount: 1 },
            'Cache hit',
        );
    });

    test('bypasses unsupported reads with a bounded reason and dependency count', async () => {
        const onCacheEvent = vi.fn();
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels, metrics: { onCacheEvent } });
        const query = vi.fn().mockResolvedValue([]);
        const args = { where: { organizationId: 'org_1' }, include: { missingRelation: true } };

        await readThroughCache({
            model: 'WorkOrder',
            operation: 'findMany',
            args,
            cleanedArgs: args,
            query,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        });

        expect(query).toHaveBeenCalledWith(args);
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'WorkOrder',
            operation: 'findMany',
            result: 'bypass',
            path: 'bypass',
            reason: 'relation-field-unknown',
            dependencyCount: 1,
        });
    });

    test('merges explicit tags by default and replaces inferred tags without losing tenant identity', () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const args = { where: { organizationId: 'org_1' }, include: { equipment: true } };
        const merged = prepareRead('WorkOrder', 'findMany', args, args, { ttlSeconds: 60, tags: ['custom:read'] }, config);
        const replaced = prepareRead(
            'WorkOrder',
            'findMany',
            args,
            args,
            { ttlSeconds: 60, tags: ['custom:read'], mergeTags: false },
            config,
        );

        expect(merged.normalizedTags).toEqual(expect.arrayContaining([
            'custom:read',
            'scope:organization:org_1:model:Equipment',
        ]));
        expect(replaced.normalizedTags).toEqual(['custom:read']);
        expect(replaced.tenantScope).toEqual(['organization:org_1']);
    });

    test('bypasses merged explicit tag overflow without populating Redis', async () => {
        const unconstrained = makeConfig({ maxTagsPerQuery: 30 });
        const args = { where: { organizationId: 'org_1' }, include: { equipment: true } };
        const inferred = prepareRead('WorkOrder', 'findMany', args, args, { ttlSeconds: 60 }, unconstrained);
        const config = makeConfig({ maxTagsPerQuery: inferred.normalizedTags.length });
        const query = vi.fn().mockResolvedValue([{ id: 'wo_1' }]);

        const result = await readThroughCache({
            model: 'WorkOrder',
            operation: 'findMany',
            args,
            cleanedArgs: args,
            query,
            cacheOptions: { ttlSeconds: 60, tags: ['explicit:overflow'] },
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'wo_1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.mgetString ?? 0).toBe(0);
        expect(redis.callCounts.setString ?? 0).toBe(0);
        const prepared = prepareRead(
            'WorkOrder',
            'findMany',
            args,
            args,
            { ttlSeconds: 60, tags: ['explicit:overflow'] },
            config,
        );
        expect(prepared).toMatchObject({ cacheable: false, bypassReason: 'dependency-tag-limit' });
        expect(prepared.normalizedTags).toContain('explicit:overflow');
    });

    test('bypasses replacement-only tag overflow while retaining the resolved tenant scope', async () => {
        const config = makeConfig({ maxTagsPerQuery: 1 });
        const args = { where: { organizationId: 'org_1' } };
        const query = vi.fn().mockResolvedValue([{ id: 'wo_1' }]);

        const result = await readThroughCache({
            model: 'WorkOrder',
            operation: 'findMany',
            args,
            cleanedArgs: args,
            query,
            cacheOptions: { ttlSeconds: 60, tags: ['explicit:one', 'explicit:two'], mergeTags: false },
            config,
            redisAdapter: redis,
        });

        expect(result).toEqual([{ id: 'wo_1' }]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.mgetString ?? 0).toBe(0);
        expect(redis.callCounts.setString ?? 0).toBe(0);
        expect(
            prepareRead(
                'WorkOrder',
                'findMany',
                args,
                args,
                { ttlSeconds: 60, tags: ['explicit:one', 'explicit:two'], mergeTags: false },
                config,
            ),
        ).toMatchObject({
            cacheable: false,
            bypassReason: 'dependency-tag-limit',
            tenantScope: ['organization:org_1'],
            normalizedTags: ['explicit:one', 'explicit:two'],
        });
    });

    test('rejects normalized configs at the public boundary', () => {
        const normalized = normalizeConfig({ schema: cacheSchema, models: cacheModels });

        if (false) {
            // @ts-expect-error NormalizedCacheConfig is an internal runtime type.
            createCacheTagsExtension(redis, normalized);
        }
    });

    test('validates a public config even when it contains an analysis property', () => {
        const invalidConfig = {
            schema: { formatVersion: 2, models: {} },
            models: {},
            analysis: {},
        } as never;

        expect(() => createCacheTagsExtension(redis, invalidConfig)).toThrow(
            'Unsupported cache schema format version',
        );
    });

    test('strips cache args when caching is disabled globally', async () => {
        let operationHandler!: (params: Record<string, unknown>) => Promise<unknown>;
        const base = {
            $extends: vi.fn((definition: { query: { $allOperations: typeof operationHandler } }) => {
                operationHandler = definition.query.$allOperations;
                return { $transaction: vi.fn() };
            }),
        };
        const extension = createCacheTagsExtension(redis, { schema: cacheSchema, models: cacheModels, enabled: false });
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
        const config = makeConfig({
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

        createCacheTagsExtension(redis, {
            schema: cacheSchema,
            models: cacheModels,
            logger: config.logger,
            metrics: config.metrics,
        })(base as never);
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
        const config = makeConfig({ metrics: { onCacheEvent } });

        createCacheTagsExtension(redis, {
            schema: cacheSchema,
            models: cacheModels,
            metrics: config.metrics,
        })(base as never);
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
        const config = makeConfig({ metrics: { onCacheEvent } });
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
        const config = makeConfig();
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
        const config = makeConfig();
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
        const config = makeConfig({
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
            { path: 'lookupVersioned', reason: 'redis-script-failure' },
            'Redis cache script failed',
        );
    });

    test('emits one population failure for malformed optimized replies and releases the owner lock safely', async () => {
        const warn = vi.fn();
        const onScriptEvent = vi.fn();
        const config = makeConfig({
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
            { path: 'populateAndRelease', reason: 'redis-script-failure' },
            'Redis cache script failed',
        );
        expect(redis.callCounts.deleteIfValue).toBe(1);
    });

    test('rejects an optimized malformed payload without repopulating that generation', async () => {
        const onCacheEvent = vi.fn();
        const config = makeConfig({ metrics: { onCacheEvent } });
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
        const config = makeConfig({
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
            { path: 'lookupVersioned', reason: 'redis-script-failure' },
            'Redis cache script failed',
        );
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
    });

    test('misses, calls the query, and populates the cache', async () => {
        const config = makeConfig();
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
            args: { where: { id: 42n } },
            cleanedArgs: { where: { id: 42n } },
            query,
            cacheOptions: {},
            config: makeConfig(),
            redisAdapter: redis,
        };

        await readThroughCache(params);
        await readThroughCache(params);

        expect(query).toHaveBeenCalledTimes(1);
        expect(redis.callCounts.setString).toBe(1);
    });

    test('serves the second identical read from cache without calling the query', async () => {
        const config = makeConfig();
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
        const config = makeConfig({ stampede: { waitMs: 10, pollMs: 1 }, metrics: { onCacheEvent } });
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
        const config = makeConfig({ stampede: { waitMs: 20, pollMs: 1 }, metrics: { onCacheEvent } });
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
        const config = makeConfig({ maxTtlSeconds: 10 });
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
        const config = makeConfig();
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
        const config = makeConfig({
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
            { model: 'Widget', operation: 'findMany', path: 'fallback', reason: 'cache-read-failed' },
            'Cache read failed; falling back to Prisma query',
        );
        expect(onCacheEvent).toHaveBeenCalledWith({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
    });

    test('falls back when a custom-key tag version lookup throws', async () => {
        const onCacheEvent = vi.fn();
        const config = makeConfig({ metrics: { onCacheEvent } });
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
        const config = makeConfig({ cacheEmpty: false });

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
        const config = makeConfig({ metrics: { onCacheEvent } });
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
        const config = makeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
            metrics: { onCacheEvent },
        });
        const cleanedArgs = { where: { tenantId: 'tenant-a' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, ['scope:tenant:tenant-a:model:Widget'], ['tenant-a'], config);
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
                normalizedTags: ['scope:tenant:tenant-a:model:Widget'],
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
            { model: 'Widget', operation: 'findMany', path: 'fallback', reason: 'identity-mismatch' },
            expect.stringContaining('identity mismatch'),
        );
    });

    test('queries Prisma when deleting a mismatched entry fails and logs the failure', async () => {
        const error = vi.fn();
        const config = makeConfig({
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
        });
        const cleanedArgs = { where: { tenantId: 'tenant-a' } };
        const preparedKey = prepareCacheKey('Widget', 'findMany', cleanedArgs, ['scope:tenant:tenant-a:model:Widget'], ['tenant-a'], config);
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
                    normalizedTags: ['scope:tenant:tenant-a:model:Widget'],
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
            { model: 'Widget', operation: 'findMany', path: 'fallback', reason: 'identity-mismatch-delete-failed' },
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
        const config = makeConfig({
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
        const config = makeConfig({
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
            { model: 'Widget', operation: 'findMany', path: 'fallback', reason: 'invalid-envelope-delete-failed' },
            'Invalid cache envelope deletion failed',
        );
    });
});

describe('handleWrite', () => {
    test('runs the write then bumps resolved model and entity tags', async () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        await handleWrite({
            model: 'Equipment',
            operation: 'update',
            args: { where: { id: 'eq_1', organizationId: 'org_1' }, data: { name: 'Pump' } },
            cleanedArgs: { where: { id: 'eq_1', organizationId: 'org_1' }, data: { name: 'Pump' } },
            query: vi.fn().mockResolvedValue({ id: 'eq_1', organizationId: 'org_1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        expect(redis.store.get(getTagVersionKey('scope:organization:org_1:model:Equipment', config))).toBe('1');
        expect(redis.store.get(getTagVersionKey('scope:organization:org_1:entity:Equipment:eq_1', config))).toBe('1');
    });

    test('does not invalidate a relation-independent read after a related model write', async () => {
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const readQuery = vi.fn().mockResolvedValue([{ id: 'w1', organizationId: 'org_1' }]);
        const readParams = {
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1' } },
            cleanedArgs: { where: { organizationId: 'org_1' } },
            query: readQuery,
            cacheOptions: { ttlSeconds: 60 },
            config,
            redisAdapter: redis,
        };
        await readThroughCache(readParams);
        await handleWrite({
            model: 'Equipment',
            operation: 'create',
            args: { data: { id: 'eq_1', organizationId: 'org_1' } },
            cleanedArgs: { data: { id: 'eq_1', organizationId: 'org_1' } },
            query: vi.fn().mockResolvedValue({ id: 'eq_1', organizationId: 'org_1' }),
            cacheOptions: undefined,
            config,
            redisAdapter: redis,
        });
        await readThroughCache(readParams);
        expect(readQuery).toHaveBeenCalledTimes(1);
    });
});
