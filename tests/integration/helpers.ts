import { createClient } from 'redis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { createCacheTagsExtension } from '../../src/extension';
import type { CacheTagsConfig, RedisAdapter } from '../../src/types';
import { createTestPrismaClient, type TestPrismaClientOptions } from '../fixture/client';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

export async function createRedis() {
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    return client;
}

export interface QueryCounter {
    total: number;
    byModel: Record<string, number>;
    byQuery?: Record<string, number>;
    reset(): void;
}

export interface DetailedQueryCounter extends QueryCounter {
    byQuery: Record<string, number>;
    count(model: string, operation: string, args: unknown): number;
}

function stableQueryValue(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'bigint') {
        return `${value}n`;
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableQueryValue).join(',')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== 'cache')
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, child]) => `${key}:${stableQueryValue(child)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function queryCounterKey(model: string, operation: string, args: unknown): string {
    return `${model}:${operation}:${stableQueryValue(args)}`;
}

export function createQueryCounter(): DetailedQueryCounter {
    return {
        total: 0,
        byModel: {},
        byQuery: {},
        reset() {
            this.total = 0;
            this.byModel = {};
            this.byQuery = {};
        },
        count(model, operation, args) {
            return this.byQuery[queryCounterKey(model, operation, args)] ?? 0;
        },
    };
}

export function createCachedClient(
    redisClient: Awaited<ReturnType<typeof createRedis>>,
    counter: QueryCounter,
    config: Partial<CacheTagsConfig> & Record<string, unknown> = {},
    prismaOptions: TestPrismaClientOptions = {},
    redisAdapter: RedisAdapter = createNodeRedisAdapter(redisClient),
) {
    const base = createTestPrismaClient(prismaOptions);

    const cached = base.$extends(
        createCacheTagsExtension(redisAdapter, {
            schema: cacheSchema,
            models: cacheModels,
            ...config,
        } as CacheTagsConfig),
    );

    // Counting layer sits closest to the database, so it only sees queries the
    // cache layer actually let through.
    return cached.$extends({
        name: 'query-counter',
        query: {
            $allOperations({ model, operation, args, query }) {
                counter.total += 1;
                if (model) {
                    counter.byModel[model] = (counter.byModel[model] ?? 0) + 1;
                    const queryKey = queryCounterKey(model, operation, args);
                    counter.byQuery ??= {};
                    counter.byQuery[queryKey] = (counter.byQuery[queryKey] ?? 0) + 1;
                }
                return query(args);
            },
        },
    });
}
