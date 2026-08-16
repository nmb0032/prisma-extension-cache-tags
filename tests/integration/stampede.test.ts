import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';

const redis = await createRedis();
const counterA = createQueryCounter();
const counterB = createQueryCounter();

// Two separate extended clients = two separate processes, as far as any
// in-process coalescing map is concerned.
const podA = createCachedClient(redis, counterA);
const podB = createCachedClient(redis, counterB);

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
        await Promise.allSettled([redis.quit(), podA.$disconnect(), podB.$disconnect()]);
    }
});

beforeEach(async () => {
    await redis.flushDb();
    await podA.widget.deleteMany();
    counterA.reset();
    counterB.reset();
});

describe('distributed stampede protection', () => {
    test('concurrent identical misses across two clients cause one database read', async () => {
        await podA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counterA.reset();
        counterB.reset();

        const [resultA, resultB] = await Promise.all([
            podA.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
            podB.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
        ]);

        expect(resultA).toEqual(resultB);

        const totalReads = (counterA.byModel.Widget ?? 0) + (counterB.byModel.Widget ?? 0);
        expect(totalReads).toBe(1);
    });

    test('a waiter that times out still returns correct data', async () => {
        await podA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counterA.reset();
        counterB.reset();

        const [a, b] = await Promise.all([
            podA.widget.findMany({
                where: { tenantId: 't1' },
                cache: { ttlSeconds: 60, stampede: { waitMs: 1, pollMs: 1 } },
            }),
            podB.widget.findMany({
                where: { tenantId: 't1' },
                cache: { ttlSeconds: 60, stampede: { waitMs: 1, pollMs: 1 } },
            }),
        ]);

        // Correctness must never depend on winning the lock race.
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });
});
