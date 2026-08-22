import type { RedisAdapter } from '../types';
import { createOptimizedRedisPrimitives } from '../optimized';

/** Structural type for the `redis` (node-redis) client. Avoids a runtime import. */
export interface NodeRedisClientLike {
    isCluster?: boolean;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number; NX?: boolean; PX?: number }): Promise<string | null>;
    del(key: string): Promise<number>;
    incrBy(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<boolean | number>;
    mGet(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    scriptLoad?(script: string): Promise<string>;
    evalSha?(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export interface NodeRedisAdapterOptions {
    optimized?: boolean;
}

function isClusterClient(client: NodeRedisClientLike): boolean {
    const constructorName = (client as { constructor?: { name?: string } }).constructor?.name;
    return Boolean(client.isCluster) || constructorName === 'RedisCluster' || constructorName === 'Cluster';
}

export function createNodeRedisAdapter(client: NodeRedisClientLike, options: NodeRedisAdapterOptions = {}): RedisAdapter {
    const clusterClient = isClusterClient(client);
    const adapter: RedisAdapter = {
        async getString(key: string): Promise<string | null> {
            return client.get(key);
        },
        async setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
            await (ttlSeconds ? client.set(key, value, { EX: ttlSeconds }) : client.set(key, value));
        },
        async delete(key: string): Promise<void> {
            await client.del(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            return client.incrBy(key, amount);
        },
        async expire(key: string, ttlSeconds: number): Promise<void> {
            await client.expire(key, ttlSeconds);
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            if (keys.length === 0) {
                return [];
            }
            return clusterClient ? Promise.all(keys.map((key) => client.get(key))) : client.mGet(keys);
        },
        async setIfNotExists(key: string, value: string, ttlMs: number): Promise<boolean> {
            const result = await client.set(key, value, { NX: true, PX: ttlMs });
            return result === 'OK';
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            const deleted = await client.eval(RELEASE_IF_VALUE, { keys: [key], arguments: [value] });
            return Number(deleted) === 1;
        },
    };

    if (options.optimized !== false && !clusterClient && client.scriptLoad && client.evalSha) {
        adapter.optimized = createOptimizedRedisPrimitives({
            load: (source) => client.scriptLoad!(source),
            evalSha: (sha, keys, args) => client.evalSha!(sha, { keys, arguments: args }),
        });
    }

    return adapter;
}
