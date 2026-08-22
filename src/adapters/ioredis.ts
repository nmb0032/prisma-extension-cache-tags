import type { RedisAdapter } from '../types';

/** Structural type for the `ioredis` client. Avoids a runtime import. */
export interface IoRedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<string | null>;
    del(key: string): Promise<number>;
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    mget(keys: string[]): Promise<Array<string | null>>;
    eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_IF_VALUE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export function createIoRedisAdapter(client: IoRedisClientLike): RedisAdapter {
    return {
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
            return keys.length === 0 ? [] : client.mget(keys);
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
}
