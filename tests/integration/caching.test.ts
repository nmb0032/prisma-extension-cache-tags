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

    test('a write to a different tenant does not invalidate', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        await prisma.widget.create({ data: { tenantId: 't2', name: 'other' } });
        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // read (1) + create (1) + cache hit (0)
        expect(counter.byModel.Widget).toBe(2);
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
