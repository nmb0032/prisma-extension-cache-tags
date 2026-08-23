import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { Prisma } from '../fixture/generated/client';
import { normalizeConfig } from '../../src/config';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { getTagVersionKey } from '../../src/keys';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

const redis = await createRedis();
const counter = createQueryCounter();
const prisma = createCachedClient(redis, counter);
const redisAdapter = createNodeRedisAdapter(redis);
const fallbackCounter = createQueryCounter();
const fallbackPrisma = createCachedClient(redis, fallbackCounter, {}, {}, createNodeRedisAdapter(redis, { optimized: false }));
const tagVersionKey = getTagVersionKey('tenant:t1:model:Widget', normalizeConfig({ schema: cacheSchema, models: cacheModels }));

function asTransactionBatch(operations: Promise<unknown>[]): Prisma.PrismaPromise<unknown>[] {
    // Query extensions expose Promise at the type level, while Prisma executes these lazy values as a batch.
    return operations as unknown as Prisma.PrismaPromise<unknown>[];
}

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
        await Promise.allSettled([redis.quit(), prisma.$disconnect(), fallbackPrisma.$disconnect()]);
    }
});

beforeEach(async () => {
    await redis.flushDb();
    await prisma.part.deleteMany();
    await prisma.widget.deleteMany();
    counter.reset();
    fallbackCounter.reset();
});

describe('transaction-aware invalidation', () => {
    test('a committed transaction invalidates once, after commit', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        const tagVersionBeforeTransaction = Number((await redisAdapter.getString(tagVersionKey)) ?? 0);
        expect(tagVersionBeforeTransaction).toBeGreaterThan(0);

        await prisma.$transaction(async (tx) => {
            await tx.widget.create({ data: { tenantId: 't1', name: 'w2' } });
            expect(Number(await redisAdapter.getString(tagVersionKey))).toBe(tagVersionBeforeTransaction);

            await tx.widget.create({ data: { tenantId: 't1', name: 'w3' } });
            expect(Number(await redisAdapter.getString(tagVersionKey))).toBe(tagVersionBeforeTransaction);
        });

        expect(Number(await redisAdapter.getString(tagVersionKey))).toBe(tagVersionBeforeTransaction + 1);

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        expect(after).toHaveLength(3);
    });

    test('the command fallback defers invalidation until a transaction commits', async () => {
        await fallbackPrisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        fallbackCounter.reset();
        await fallbackPrisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const readsBefore = fallbackCounter.byModel.Widget ?? 0;

        await fallbackPrisma.$transaction(async (tx) => {
            await tx.widget.create({ data: { tenantId: 't1', name: 'w2' } });
        });
        await fallbackPrisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        expect(fallbackCounter.byModel.Widget).toBe(readsBefore + 2);
    });

    test('a committed batch transaction flushes one invalidation after all writes', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const tagVersionBeforeTransaction = Number((await redisAdapter.getString(tagVersionKey)) ?? 0);

        await prisma.$transaction(
            asTransactionBatch([
                prisma.widget.create({ data: { tenantId: 't1', name: 'w2' } }),
                prisma.widget.create({ data: { tenantId: 't1', name: 'w3' } }),
            ]),
        );

        expect(Number(await redisAdapter.getString(tagVersionKey))).toBe(tagVersionBeforeTransaction + 1);
        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        expect(after).toHaveLength(3);
    });

    test('a rolled-back transaction does NOT invalidate the cache', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const readsAfterFirst = counter.byModel.Widget ?? 0;

        await expect(
            prisma.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });

        // Cache still valid: the failed write must not have bumped any tag version.
        expect(after).toHaveLength(1);
        expect(counter.byModel.Widget).toBe(readsAfterFirst + 1); // +1 for the create attempt only
    });

    test('a failed batch transaction does not flush invalidation', async () => {
        await prisma.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counter.reset();

        await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        const tagVersionBeforeTransaction = Number((await redisAdapter.getString(tagVersionKey)) ?? 0);

        await expect(
            prisma.$transaction(
                asTransactionBatch([
                    prisma.widget.create({ data: { tenantId: 't1', name: 'doomed' } }),
                    prisma.widget.update({
                        where: { id: 'missing-widget' },
                        data: { name: 'still doomed' },
                    }),
                ]),
            ),
        ).rejects.toThrow();

        expect(Number(await redisAdapter.getString(tagVersionKey))).toBe(tagVersionBeforeTransaction);
        const after = await prisma.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } });
        expect(after).toHaveLength(1);
    });

    test('the database really did roll back', async () => {
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await prisma.widget.count()).toBe(0);
    });
});
