import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);
const dependentClients: Array<{ $disconnect(): Promise<void> }> = [];

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
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

    test('custom keys isolate model, operation, and argument identities', async () => {
        const first = await prisma.widget.create({ data: { tenantId: 't1', name: 'first' } });
        const second = await prisma.widget.create({ data: { tenantId: 't1', name: 'second' } });
        const part = await prisma.part.create({
            data: { tenantId: 't1', label: 'part', widgetId: first.id },
        });
        counter.reset();
        const cache = { key: 'shared-query', tags: ['shared'], inferTags: false };

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
        const precise = createCachedClient(redis, counter, { tenantPrecision: true });
        dependentClients.push(precise);
        await precise.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await precise.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + cache hit (0)
        expect(counter.byModel.Widget).toBe(2);
    });

    test('a write to a different tenant invalidates under the safe default', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + invalidated read (1)
        expect(counter.byModel.Widget).toBe(3);
    });

    test('update and delete by ID invalidate the returned record tenant only', async () => {
        const precise = createCachedClient(redis, counter, { tenantPrecision: true });
        dependentClients.push(precise);
        const first = await precise.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        await precise.widget.create({ data: { tenantId: 't2', name: 'other' } });
        counter.reset();

        await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });

        await precise.widget.update({
            where: { id: first.id },
            data: { name: 'renamed' },
        });

        const afterUpdate = await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const otherAfterUpdate = await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });
        expect(afterUpdate[0]?.name).toBe('renamed');
        expect(otherAfterUpdate).toHaveLength(1);

        await precise.widget.delete({ where: { id: first.id } });

        const afterDelete = await precise.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const otherAfterDelete = await precise.widget.findMany({ where: { tenantId: 't2' }, cache: { ttlSeconds: 60 } });
        expect(afterDelete).toEqual([]);
        expect(otherAfterDelete).toHaveLength(1);
        expect(counter.byModel.Widget).toBe(6);
    });

    test('a tenant-precise write invalidates every resolved tenant beyond the cached-read tag limit', async () => {
        const precise = createCachedClient(redis, counter, {
            tenantPrecision: true,
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

    test('dependency tags invalidate across models', async () => {
        const dependent = createCachedClient(redis, counter, { dependencyTags: { Part: ['Widget'] } });
        dependentClients.push(dependent);
        const widget = await dependent.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await dependent.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await dependent.part.create({ data: { tenantId: 't1', label: 'p1', widgetId: widget.id } });
        await dependent.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        expect(counter.byModel.Widget).toBe(2); // the Part write forced a Widget re-read
    });

    test('findUnique caches per entity', async () => {
        const widget = await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findUnique({ where: { id: widget.id }, cache: { ttlSeconds: 60 } });
        await prisma.widget.findUnique({ where: { id: widget.id }, cache: { ttlSeconds: 60 } });

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
