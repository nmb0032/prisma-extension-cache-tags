import IoRedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createIoRedisAdapter } from '../../src/adapters/ioredis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { normalizeConfig } from '../../src/config';
import { readThroughCache } from '../../src/extension';
import { buildVersionedCacheKey, createVersionToken, prepareCacheKey } from '../../src/keys';
import { analyzeReadTags } from '../../src/read-analysis';
import { serializeCacheEnvelope } from '../../src/serialization';
import { REDIS_URL, createCachedClient, createQueryCounter, createRedis } from './helpers';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

const redis = await createRedis();
const ioRedis = new IoRedis(REDIS_URL);
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);
const dependentClients: Array<{ $disconnect(): Promise<void> }> = [];

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
        ioRedis.disconnect();
        await Promise.allSettled([redis.quit(), prisma.$disconnect(), ...dependentClients.map((client) => client.$disconnect())]);
    }
});

beforeEach(async () => {
    await redis.flushDb();
    await prisma.part.deleteMany();
    await prisma.widget.deleteMany();
    counter.reset();
});

describe('read-through caching', () => {
    test('keeps optimized, fallback, and minimal custom adapters behaviorally identical', async () => {
        const modes = [
            {
                name: 'node-redis optimized',
                adapter: createNodeRedisAdapter(redis),
            },
            {
                name: 'node-redis fallback',
                adapter: createNodeRedisAdapter(redis, { optimized: false }),
            },
            {
                name: 'custom fallback',
                adapter: {
                    ...createNodeRedisAdapter(redis, { optimized: false }),
                },
            },
            {
                name: 'ioredis optimized',
                adapter: createIoRedisAdapter(ioRedis),
            },
            {
                name: 'ioredis fallback',
                adapter: createIoRedisAdapter(ioRedis, { optimized: false }),
            },
        ] as const;
        const observations: Array<{ name: string; first: unknown; second: unknown; reads: number }> = [];
        const clients: Array<{ $disconnect(): Promise<void> }> = [];

        try {
            for (const mode of modes) {
                await redis.flushDb();
                await prisma.widget.deleteMany();
                const modeCounter = createQueryCounter();
                const client = createCachedClient(redis, modeCounter, {}, {}, mode.adapter);
                clients.push(client);
                await client.widget.create({ data: { tenantId: 'parity', name: mode.name } });
                modeCounter.reset();

                const first = await client.widget.findMany({ where: { tenantId: 'parity' }, cache: { ttlSeconds: 60 } });
                const second = await client.widget.findMany({ where: { tenantId: 'parity' }, cache: { ttlSeconds: 60 } });
                observations.push({ name: mode.name, first, second, reads: modeCounter.byModel.Widget ?? 0 });
            }
        } finally {
            await Promise.all(clients.map((client) => client.$disconnect()));
        }

        expect(observations).toHaveLength(5);
        expect(observations.map(({ first }) => first)).toEqual(observations.map(({ second }) => second));
        expect(observations.map(({ reads }) => reads)).toEqual([1, 1, 1, 1, 1]);
    });

    test('an uncached read hits the database every time', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' } });

        expect(counter.byModel.Widget).toBe(2);
    });

    test('a cached read hits the database once', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        const first = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const second = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(second).toEqual(first);
        expect(counter.byModel.Widget).toBe(1);
    });

    test('includes BigInt filter arguments and tenant evidence in a cache hit', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', sequence: 42n, name: 'bigint-filter' } });
        counter.reset();
        const args = {
            where: { tenantId: 't1', sequence: 42n },
            cache: { ttlSeconds: 60 },
        };

        const first = await prisma.widget.findMany(args);
        const second = await prisma.widget.findMany(args);

        expect(second).toEqual(first);
        expect(first).toHaveLength(1);
        expect(first[0]?.sequence).toBe(42n);
        expect(counter.byModel.Widget).toBe(1);
    });

    test('cached result values retain their BigInt types', async () => {
        const query = vi.fn().mockResolvedValue([{ id: 'w1', sequence: 42n }]);
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const params = {
            model: 'Widget',
            operation: 'findMany',
            args: { where: { tenantId: 't1' } },
            cleanedArgs: { where: { tenantId: 't1' } },
            query,
            cacheOptions: {},
            config,
            redisAdapter: createNodeRedisAdapter(redis),
        };

        const first = await readThroughCache(params);
        const second = await readThroughCache(params);

        expect(first).toEqual([{ id: 'w1', sequence: 42n }]);
        expect(second).toEqual(first);
        expect(typeof (second as Array<{ sequence: bigint }>)[0]?.sequence).toBe('bigint');
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('custom keys isolate model, operation, and argument identities', async () => {
        const first = await prisma.widget.create({ data: { tenantId: 't1', name: 'first' } });
        const second = await prisma.widget.create({ data: { tenantId: 't1', name: 'second' } });
        const part = await prisma.part.create({
            data: { tenantId: 't1', label: 'part', widgetId: first.id },
        });
        counter.reset();
        const cache = { key: 'shared-query', tags: ['shared'], mergeTags: false };

        const firstWidgets = await prisma.widget.findMany({ where: { name: 'first' }, cache });
        const secondWidgets = await prisma.widget.findMany({ where: { name: 'second' }, cache });
        const firstWidgetCount = await prisma.widget.count({ where: { name: 'first' }, cache });
        const parts = await prisma.part.findMany({ where: { label: 'part' }, cache });

        expect(firstWidgets.map((widget) => widget.id)).toEqual([first.id]);
        expect(secondWidgets.map((widget) => widget.id)).toEqual([second.id]);
        expect(firstWidgetCount).toBe(1);
        expect(parts.map((result) => result.id)).toEqual([part.id]);
        expect(counter.total).toBe(4);
    });

    test('semantically equal filters share one cache entry across independent clients', async () => {
        const counterA = createQueryCounter();
        const counterB = createQueryCounter();
        const podA = createCachedClient(redis, counterA);
        const podB = createCachedClient(redis, counterB);
        dependentClients.push(podA, podB);
        await podA.widget.create({ data: { tenantId: 't1', name: 'widget' } });
        counterA.reset();
        counterB.reset();
        const argsA = { where: { tenantId: 't1', name: 'widget' }, cache: { ttlSeconds: 60 } };
        const argsB = { where: { name: 'widget', tenantId: 't1' }, cache: { ttlSeconds: 60 } };

        await podA.widget.findMany(argsA);
        for (let index = 0; index < 20; index += 1) {
            await (index % 2 === 0 ? podB : podA).widget.findMany(index % 2 === 0 ? argsB : argsA);
        }

        expect(counterA.total + counterB.total).toBe(1);
    });

    test('v2 entries are ignored by the v3 namespace', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'fresh' } });
        await redis.set('prismaCacheTags:v2:qry:Widget:findMany:legacy', 'legacy-value');
        counter.reset();

        const result = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe('fresh');
        expect(counter.byModel.Widget).toBe(1);
    });

    test('rejects a valid foreign-tenant envelope stored under the expected v2 key', async () => {
        await prisma.widget.create({ data: { tenantId: 'tenant-a', name: 'fresh' } });
        counter.reset();

        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const cacheOptions = { ttlSeconds: 60 };
        const args = { where: { tenantId: 'tenant-a' } };
        const analysis = analyzeReadTags({ model: 'Widget', operation: 'findMany', args, context: config.analysis, maxTagsPerQuery: config.maxTagsPerQuery });
        const prepared = prepareCacheKey('Widget', 'findMany', args, analysis.tags, analysis.tenantScope, config);
        const adapter = createNodeRedisAdapter(redis);
        const versions = await adapter.mgetString(prepared.tagVersionKeys);
        const cacheKey = buildVersionedCacheKey(prepared.baseKey, createVersionToken(versions));
        await adapter.setString(
            cacheKey,
            serializeCacheEnvelope({
                identity: 'foreign-identity',
                tenantScope: ['tenant-b'],
                value: [{ id: 'foreign', tenantId: 'tenant-b', name: 'must-not-leak' }],
            }),
            60,
        );

        const result = await prisma.widget.findMany({ ...args, cache: cacheOptions });

        expect(result).toHaveLength(1);
        expect(result[0]?.tenantId).toBe('tenant-a');
        expect(result[0]?.name).toBe('fresh');
        expect(counter.byModel.Widget).toBe(1);
        expect(await adapter.getString(cacheKey)).toBeNull();
    });

    test('rejects a malformed envelope, deletes it, and executes Prisma', async () => {
        await prisma.widget.create({ data: { tenantId: 'tenant-a', name: 'fresh' } });
        counter.reset();

        const onCacheEvent = vi.fn();
        const config = normalizeConfig({
            schema: cacheSchema,
            models: cacheModels,
            metrics: { onCacheEvent },
        });
        const cacheOptions = { ttlSeconds: 60 };
        const args = { where: { tenantId: 'tenant-a' } };
        const analysis = analyzeReadTags({ model: 'Widget', operation: 'findMany', args, context: config.analysis, maxTagsPerQuery: config.maxTagsPerQuery });
        const prepared = prepareCacheKey('Widget', 'findMany', args, analysis.tags, analysis.tenantScope, config);
        const adapter = createNodeRedisAdapter(redis);
        const versions = await adapter.mgetString(prepared.tagVersionKeys);
        const cacheKey = buildVersionedCacheKey(prepared.baseKey, createVersionToken(versions));
        await adapter.setString(cacheKey, 'not-superjson', 60);
        const cachedPrisma = createCachedClient(redis, counter, { metrics: { onCacheEvent } });
        dependentClients.push(cachedPrisma);

        const result = await cachedPrisma.widget.findMany({ ...args, cache: cacheOptions });

        expect(result).toHaveLength(1);
        expect(result[0]?.tenantId).toBe('tenant-a');
        expect(result[0]?.name).toBe('fresh');
        expect(counter.byModel.Widget).toBe(1);
        expect(await adapter.getString(cacheKey)).toBeNull();
        expect(onCacheEvent).toHaveBeenCalledWith({
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'optimized',
            reason: 'invalid-envelope',
        });
        expect(onCacheEvent).not.toHaveBeenCalledWith(expect.objectContaining({ result: 'hit' }));
    });

    test('the cached result is structurally identical to the database result', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        const fresh = await prisma.widget.findMany({ where: { tenantId: 't1' } });
        const cachedMiss = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const cachedHit = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(cachedMiss).toEqual(fresh);
        expect(cachedHit).toEqual(fresh);
    });

    test('a write to the same tenant and model invalidates the cached read', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w2' } });

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(after).toHaveLength(2);
        expect(counter.byModel.Widget).toBe(3); // initial read + create + re-read
    });

    test('a write to a different tenant does not invalidate in precise mode', async () => {
        const precise = createCachedClient(redis, counter);
        dependentClients.push(precise);
        await precise.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await precise.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + cache hit (0)
        expect(counter.byModel.Widget).toBe(2);
    });

    test('a write to a different tenant does not invalidate the cached read', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + cache hit (0)
        expect(counter.byModel.Widget).toBe(2);
    });

    test('update and delete by ID invalidate the returned record tenant only', async () => {
        const precise = createCachedClient(redis, counter);
        dependentClients.push(precise);
        const first = await precise.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        await precise.widget.create({ data: { tenantId: 't2', name: 'other' } });
        counter.reset();

        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });

        await precise.widget.update({
            where: { id: first.id, tenantId: 't1' },
            data: { name: 'renamed' },
        });

        const afterUpdate = await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const otherAfterUpdate = await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });
        expect(afterUpdate[0]?.name).toBe('renamed');
        expect(otherAfterUpdate).toHaveLength(1);

        await precise.widget.delete({ where: { id: first.id, tenantId: 't1' } });

        const afterDelete = await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const otherAfterDelete = await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });
        expect(afterDelete).toEqual([]);
        expect(otherAfterDelete).toHaveLength(1);
        expect(counter.byModel.Widget).toBe(6);
    });

    test('a tenant-precise write invalidates every resolved tenant beyond the cached-read tag limit', async () => {
        const precise = createCachedClient(redis, counter, {
            maxTagsPerQuery: 5,
        });
        dependentClients.push(precise);
        const tenantIds = Array.from({ length: 20 }, (_, index) => `truncation:t${index}`);
        await precise.widget.createMany({
            data: tenantIds.map((tenantId) => ({ tenantId, name: 'initial' })),
        });

        await Promise.all(
            tenantIds.map((tenantId) =>
                precise.widget.findMany({
                    where: { tenantId },
                    cache: { ttlSeconds: 60 },
                }),
            ),
        );
        await precise.widget.updateMany({
            where: { tenantId: { in: tenantIds } },
            data: { name: 'updated' },
        });
        const refreshed = await Promise.all(
            tenantIds.map((tenantId) =>
                precise.widget.findMany({
                    where: { tenantId },
                    cache: { ttlSeconds: 60 },
                }),
            ),
        );

        expect(refreshed).toHaveLength(20);
        expect(refreshed.flat()).toHaveLength(20);
        expect(refreshed.flat().every((widget) => widget.name === 'updated')).toBe(true);
    });

    test('bypasses a broad over-cap read so an omitted-tail tenant/entity write cannot stay stale', async () => {
        const onCacheEvent = vi.fn();
        const precise = createCachedClient(redis, counter, {
            maxTagsPerQuery: 5,
            metrics: { onCacheEvent },
        });
        dependentClients.push(precise);
        const tenantIds = Array.from({ length: 20 }, (_, index) => `broad:t${index}`);
        const widgets = await Promise.all(
            tenantIds.map((tenantId) => precise.widget.create({ data: { tenantId, name: 'initial' } })),
        );
        const entityIds = widgets.map((widget) => widget.id);
        counter.reset();

        const args = {
            where: {
                tenantId: { in: tenantIds },
                id: { in: entityIds },
            },
            orderBy: { id: 'asc' as const },
            cache: { ttlSeconds: 60 },
        };
        const initial = await precise.widget.findMany(args);
        await precise.widget.update({
            where: { id: widgets[19]!.id },
            data: { name: 'updated-tail' },
        });
        const refreshed = await precise.widget.findMany(args);

        expect(initial).toHaveLength(20);
        expect(refreshed.find((widget) => widget.id === widgets[19]!.id)?.name).toBe('updated-tail');
        expect(counter.byModel.Widget).toBe(3); // broad read + write + broad re-read
        expect(onCacheEvent).toHaveBeenCalledTimes(2);
        expect(onCacheEvent).toHaveBeenNthCalledWith(1, {
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'bypass',
            reason: 'dependency-tag-limit',
            dependencyCount: 1,
        });
        expect(onCacheEvent).toHaveBeenNthCalledWith(2, {
            model: 'Widget',
            operation: 'findMany',
            result: 'bypass',
            path: 'bypass',
            reason: 'dependency-tag-limit',
            dependencyCount: 1,
        });
        expect(await redis.keys('prismaCacheTags:v3:qry:*')).toEqual([]);
    });

    test('dependency tags invalidate across models', async () => {
        const dependent = createCachedClient(redis, counter);
        dependentClients.push(dependent);
        const widget = await dependent.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await dependent.widget.findMany({
            where: { tenantId: 't1' },
            include: { parts: true },
            cache: { ttlSeconds: 60 },
        });
        await dependent.part.create({ data: { tenantId: 't1', label: 'p1', widgetId: widget.id } });
        await dependent.widget.findMany({
            where: { tenantId: 't1' },
            include: { parts: true },
            cache: { ttlSeconds: 60 },
        });
        expect(counter.byModel.Widget).toBe(2); // the Part write forced a Widget re-read
    });

    test('findUnique caches per entity', async () => {
        const widget = await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findUnique({
            where: { id: widget.id, tenantId: 't1' },
            cache: { ttlSeconds: 60 },
        });
        await prisma.widget.findUnique({
            where: { id: widget.id, tenantId: 't1' },
            cache: { ttlSeconds: 60 },
        });

        expect(counter.byModel.Widget).toBe(1);
    });

    test('count is cacheable', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        expect(await prisma.widget.count({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } })).toBe(1);
        expect(await prisma.widget.count({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } })).toBe(1);
        expect(counter.byModel.Widget).toBe(1);
    });

    test('cache: { enabled: false } bypasses the cache entirely', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { enabled: false } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { enabled: false } });

        expect(counter.byModel.Widget).toBe(2);
    });

    test('a ttl of 1 second expires', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 1 } });

        expect(counter.byModel.Widget).toBe(2);
    });
});
