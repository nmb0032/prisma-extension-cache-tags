import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { normalizeConfig } from '../../src/config';
import { buildVersionedCacheKey, createVersionToken, prepareCacheKey } from '../../src/keys';
import { acquireCacheLock, releaseCacheLock } from '../../src/locks';
import { analyzeReadTags } from '../../src/read-analysis';
import { createCachedClient, createQueryCounter, createRedis } from './helpers';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

const redis = await createRedis();
const counterA = createQueryCounter();
const counterB = createQueryCounter();
const fallbackCounterA = createQueryCounter();
const fallbackCounterB = createQueryCounter();

// Two separate extended clients = two separate processes, as far as any
// in-process coalescing map is concerned.
const podA = createCachedClient(redis, counterA);
const podB = createCachedClient(redis, counterB);
const fallbackPodA = createCachedClient(redis, fallbackCounterA, {}, {}, createNodeRedisAdapter(redis, { optimized: false }));
const fallbackPodB = createCachedClient(redis, fallbackCounterB, {}, {}, createNodeRedisAdapter(redis, { optimized: false }));

afterAll(async () => {
    try {
        await redis.flushDb();
    } finally {
        await Promise.allSettled([
            redis.quit(),
            podA.$disconnect(),
            podB.$disconnect(),
            fallbackPodA.$disconnect(),
            fallbackPodB.$disconnect(),
        ]);
    }
});

beforeEach(async () => {
    await redis.flushDb();
    await podA.widget.deleteMany();
    counterA.reset();
    counterB.reset();
    fallbackCounterA.reset();
    fallbackCounterB.reset();
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

    test('a waiter that times out runs its own database query and returns correct data', async () => {
        await podA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        counterA.reset();
        counterB.reset();

        const redisAdapter = createNodeRedisAdapter(redis);
        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const args = { where: { tenantId: 't1' } };
        const analysis = analyzeReadTags({
            model: 'Widget',
            operation: 'findMany',
            args,
            context: config.analysis,
            maxTagsPerQuery: config.maxTagsPerQuery,
        });
        const prepared = prepareCacheKey('Widget', 'findMany', args, analysis.tags, analysis.tenantScope, config);
        const versions = await redisAdapter.mgetString(prepared.tagVersionKeys);
        const cacheKey = buildVersionedCacheKey(prepared.baseKey, createVersionToken(versions));
        const ownerLock = await acquireCacheLock(cacheKey, { stampede: { waitMs: 10, pollMs: 1 } }, config, redisAdapter);
        expect(ownerLock).not.toBeNull();

        try {
            const result = await podB.widget.findMany({
                ...args,
                cache: { ttlSeconds: 60, stampede: { waitMs: 10, pollMs: 1 } },
            });

            expect(result).toHaveLength(1);
            expect(counterB.byModel.Widget).toBe(1);
        } finally {
            await releaseCacheLock(ownerLock!, redisAdapter, config);
        }
    });

    test('the command fallback preserves one-owner stampede protection', async () => {
        await fallbackPodA.widget.create({ data: { tenantId: 't1', name: 'w1' } });
        fallbackCounterA.reset();
        fallbackCounterB.reset();

        const [resultA, resultB] = await Promise.all([
            fallbackPodA.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
            fallbackPodB.widget.findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 60 } }),
        ]);

        expect(resultA).toEqual(resultB);
        expect((fallbackCounterA.byModel.Widget ?? 0) + (fallbackCounterB.byModel.Widget ?? 0)).toBe(1);
    });
});
