import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { invalidateScope } from '../../src';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { getTagVersionKey } from '../../src/keys';
import { globalModelTag } from '../../src/tag-format';
import { normalizeConfig } from '../../src/config';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const redisAdapter = createNodeRedisAdapter(redis);
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);
const cache = { ttlSeconds: 60 };
const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });

const widgetWithPartsT1 = {
    where: { tenantId: 't1' },
    include: { parts: true },
    cache,
} as const;
const widgetWithPartsT2 = {
    where: { tenantId: 't2' },
    include: { parts: true },
    cache,
} as const;
const plainWidgetT1 = { where: { tenantId: 't1' }, cache } as const;
const plainWidgetT2 = { where: { tenantId: 't2' }, cache } as const;
const partsT1 = { where: { tenantId: 't1' }, cache } as const;
const partsT2 = { where: { tenantId: 't2' }, cache } as const;

async function seed() {
    await prisma.widget.create({ data: { id: 'w1', tenantId: 't1', name: 'w1' } });
    await prisma.widget.create({ data: { id: 'w2', tenantId: 't2', name: 'w2' } });
    await prisma.part.create({ data: { id: 'p1', tenantId: 't1', label: 'p1', widgetId: 'w1' } });
    await prisma.part.create({ data: { id: 'p2', tenantId: 't2', label: 'p2', widgetId: 'w2' } });
    counter.reset();
}

async function readAll() {
    return Promise.all([
        prisma.widget.findMany(widgetWithPartsT1),
        prisma.widget.findMany(widgetWithPartsT2),
        prisma.widget.findMany(plainWidgetT1),
        prisma.widget.findMany(plainWidgetT2),
        prisma.part.findMany(partsT1),
        prisma.part.findMany(partsT2),
    ]);
}

async function tagVersions(): Promise<Record<string, string | null>> {
    const keys = await redis.keys(`${config.keyPrefix}:tagver:*`);
    const values = await redis.mGet(keys);
    return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null]));
}

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
        await Promise.allSettled([redis.quit(), prisma.$disconnect()]);
    }
});

beforeEach(async () => {
    await redis.flushDb();
    await prisma.part.deleteMany();
    await prisma.widget.deleteMany();
    counter.reset();
});

describe('query-aware dependency invalidation', () => {
    test('invalidates only the affected tenant relation and direct model reads', async () => {
        await seed();
        const initialReads = await readAll();
        counter.reset();
        const cachedReads = await readAll();
        expect(cachedReads).toEqual(initialReads);
        expect(counter.total).toBe(0);
        counter.reset();

        await prisma.part.update({
            where: { id: 'p1', tenantId: 't1' },
            data: { label: 'p1-updated' },
        });
        const [t1WithParts, t2WithParts, , , t1Parts] = await readAll();

        expect(t1WithParts[0]?.parts[0]?.label).toBe('p1-updated');
        expect(t1Parts[0]?.label).toBe('p1-updated');
        expect(t2WithParts[0]?.parts[0]?.label).toBe('p2');
        expect(counter.count('Widget', 'findMany', widgetWithPartsT1)).toBe(1);
        expect(counter.count('Part', 'findMany', partsT1)).toBe(1);
        expect(counter.count('Widget', 'findMany', widgetWithPartsT2)).toBe(0);
        expect(counter.count('Widget', 'findMany', plainWidgetT1)).toBe(0);
        expect(counter.count('Widget', 'findMany', plainWidgetT2)).toBe(0);
        expect(counter.count('Part', 'findMany', partsT2)).toBe(0);
    });

    test('a tenant-unresolved Part write uses global fallback across tenants', async () => {
        await seed();
        const initialReads = await Promise.all([
            prisma.widget.findMany(widgetWithPartsT1),
            prisma.widget.findMany(widgetWithPartsT2),
            prisma.part.findMany(partsT1),
            prisma.part.findMany(partsT2),
        ]);
        counter.reset();
        const cachedReads = await Promise.all([
            prisma.widget.findMany(widgetWithPartsT1),
            prisma.widget.findMany(widgetWithPartsT2),
            prisma.part.findMany(partsT1),
            prisma.part.findMany(partsT2),
        ]);
        expect(cachedReads).toEqual(initialReads);
        expect(counter.total).toBe(0);
        counter.reset();
        const globalPartVersionKey = getTagVersionKey(globalModelTag('Part'), config);
        const before = Number((await redisAdapter.getString(globalPartVersionKey)) ?? 0);

        const updated = await prisma.part.update({
            where: { id: 'p1' },
            data: { label: 'p1-fallback' },
            select: { id: true, label: true },
        });
        expect(updated).toEqual({ id: 'p1', label: 'p1-fallback' });
        expect(Number(await redisAdapter.getString(globalPartVersionKey))).toBe(before + 1);

        await Promise.all([
            prisma.widget.findMany(widgetWithPartsT1),
            prisma.widget.findMany(widgetWithPartsT2),
            prisma.part.findMany(partsT1),
            prisma.part.findMany(partsT2),
        ]);
        expect(counter.count('Widget', 'findMany', widgetWithPartsT1)).toBe(1);
        expect(counter.count('Widget', 'findMany', widgetWithPartsT2)).toBe(1);
        expect(counter.count('Part', 'findMany', partsT1)).toBe(1);
        expect(counter.count('Part', 'findMany', partsT2)).toBe(1);
    });

    test('explicit scope invalidation refreshes every read in one tenant only', async () => {
        await seed();
        const initialReads = await readAll();
        counter.reset();
        const cachedReads = await readAll();
        expect(cachedReads).toEqual(initialReads);
        expect(counter.total).toBe(0);
        counter.reset();

        await invalidateScope({ namespace: 'tenant', id: 't1' }, redisAdapter, {
            schema: cacheSchema,
            models: cacheModels,
        });
        await readAll();

        expect(counter.count('Widget', 'findMany', widgetWithPartsT1)).toBe(1);
        expect(counter.count('Widget', 'findMany', plainWidgetT1)).toBe(1);
        expect(counter.count('Part', 'findMany', partsT1)).toBe(1);
        expect(counter.count('Widget', 'findMany', widgetWithPartsT2)).toBe(0);
        expect(counter.count('Widget', 'findMany', plainWidgetT2)).toBe(0);
        expect(counter.count('Part', 'findMany', partsT2)).toBe(0);
    });

    test('a rolled-back dependency write leaves all generations untouched', async () => {
        await seed();
        await prisma.part.findMany(partsT1);
        await prisma.widget.findMany(widgetWithPartsT1);
        await prisma.part.update({ where: { id: 'p1', tenantId: 't1' }, data: { label: 'committed' } });
        await prisma.part.findMany(partsT1);
        await prisma.widget.findMany(widgetWithPartsT1);
        counter.reset();
        const before = await tagVersions();

        await expect(
            prisma.$transaction(async (tx) => {
                await tx.part.update({ where: { id: 'p1' }, data: { label: 'rolled-back' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await tagVersions()).toEqual(before);
        await prisma.part.findMany(partsT1);
        await prisma.widget.findMany(widgetWithPartsT1);
        expect(counter.count('Part', 'findMany', partsT1)).toBe(0);
        expect(counter.count('Widget', 'findMany', widgetWithPartsT1)).toBe(0);
    });
});
