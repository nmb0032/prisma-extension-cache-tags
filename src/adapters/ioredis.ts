import type { RedisAdapter } from '../types';
import { createOptimizedRedisPrimitives } from '../optimized';

/** Structural type for the `ioredis` client. Avoids a runtime import. */
export interface IoRedisClientLike {
    isCluster?: boolean;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<string | null>;
    del(key: string): Promise<number>;
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    mget(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
    script?(...args: any[]): Promise<unknown>;
    evalsha?(...args: any[]): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export interface IoRedisAdapterOptions {
    optimized?: boolean;
}

function isClusterClient(client: IoRedisClientLike): boolean {
    const constructorName = (client as { constructor?: { name?: string } }).constructor?.name;
    return Boolean(client.isCluster) || constructorName === 'Cluster' || constructorName === 'RedisCluster';
}

export function createIoRedisAdapter(client: IoRedisClientLike, options: IoRedisAdapterOptions = {}): RedisAdapter {
    const clusterClient = isClusterClient(client);
    const adapter: RedisAdapter = {
        async getString(key: string): Promise<string | null> {
            return client.get(key);
        },
        async setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
            if (ttlSeconds) {
                await client.set(key, value, 'EX', ttlSeconds);
                return;
            }
            await client.set(key, value);
        },
        async delete(key: string): Promise<void> {
            await client.del(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            return client.incrby(key, amount);
        },
        async expire(key: string, ttlSeconds: number): Promise<void> {
            await client.expire(key, ttlSeconds);
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            if (keys.length === 0) {
                return [];
            }
            return clusterClient ? Promise.all(keys.map((key) => client.get(key))) : client.mget(keys);
        },
        async setIfNotExists(key: string, value: string, ttlMs: number): Promise<boolean> {
            const result = await client.set(key, value, 'PX', ttlMs, 'NX');
            return result === 'OK';
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            const deleted = await client.eval(RELEASE_IF_VALUE, 1, key, value);
            return Number(deleted) === 1;
        },
    };

    if (options.optimized !== false && !clusterClient && client.script && client.evalsha) {
        adapter.optimized = createOptimizedRedisPrimitives({
            load: async (source) => String(await client.script!('LOAD', source)),
            evalSha: (sha, keys, args) => client.evalsha!(sha, keys.length, ...keys, ...args),
        });
    }

    return adapter;
}
