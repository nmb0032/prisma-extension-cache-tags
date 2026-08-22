import { createClient } from 'redis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { createCacheTagsExtension } from '../../src/extension';
import type { CacheTagsConfig, RedisAdapter } from '../../src/types';
import { createTestPrismaClient, type TestPrismaClientOptions } from '../fixture/client';

export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

export async function createRedis() {
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    return client;
}

export interface QueryCounter {
    total: number;
    byModel: Record<string, number>;
    reset(): void;
}

export function createQueryCounter(): QueryCounter {
    return {
        total: 0,
        byModel: {},
        reset() {
            this.total = 0;
            this.byModel = {};
        },
    };
}

export function createCachedClient(
    redisClient: Awaited<ReturnType<typeof createRedis>>,
    counter: QueryCounter,
    config: CacheTagsConfig = {},
    prismaOptions: TestPrismaClientOptions = {},
    redisAdapter: RedisAdapter = createNodeRedisAdapter(redisClient),
) {
    const base = createTestPrismaClient(prismaOptions);

    const cached = base.$extends(
        createCacheTagsExtension(redisAdapter, {
            tenantKeys: ['tenantId'],
            ...config,
        }),
    );

    // Counting layer sits closest to the database, so it only sees queries the
    // cache layer actually let through.
    return cached.$extends({
        name: 'query-counter',
        query: {
            $allOperations({ model, args, query }) {
                counter.total += 1;
                if (model) {
                    counter.byModel[model] = (counter.byModel[model] ?? 0) + 1;
                }
                return query(args);
            },
        },
    });
}
