import type { RedisAdapter } from '../types';

/** Structural type for the `redis` (node-redis) client. Avoids a runtime import. */
export interface NodeRedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number; NX?: boolean; PX?: number }): Promise<string | null>;
    del(key: string): Promise<number>;
    incrBy(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<boolean | number>;
    mGet(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export function createNodeRedisAdapter(client: NodeRedisClientLike): RedisAdapter {
    return {
        async get<T>(key: string): Promise<T | null> {
            const raw = await client.get(key);
            return raw === null ? null : (JSON.parse(raw) as T);
        },
        async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
            const payload = JSON.stringify(value);
            await (ttlSeconds ? client.set(key, payload, { EX: ttlSeconds }) : client.set(key, payload));
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
            return keys.length === 0 ? [] : client.mGet(keys);
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
}
