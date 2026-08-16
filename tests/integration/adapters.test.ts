import { createClient } from 'redis';
import IoRedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createIoRedisAdapter } from '../../src/adapters/ioredis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import type { RedisAdapter } from '../../src/types';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

const nodeRedisClient = createClient({ url: REDIS_URL });
const ioRedisClient = new IoRedis(REDIS_URL);

await nodeRedisClient.connect();

const cases: Array<[string, RedisAdapter]> = [
    ['node-redis', createNodeRedisAdapter(nodeRedisClient)],
    ['ioredis', createIoRedisAdapter(ioRedisClient)],
];

afterAll(async () => {
    await nodeRedisClient.flushDb();
    await nodeRedisClient.quit();
    ioRedisClient.disconnect();
});

beforeEach(async () => {
    await nodeRedisClient.flushDb();
});

describe.each(cases)('%s adapter', (_name, adapter) => {
    test('set and get round-trip a structured value', async () => {
        await adapter.set('k1', { a: 1, b: ['x'] }, 60);
        expect(await adapter.get('k1')).toEqual({ a: 1, b: ['x'] });
    });

    test('get returns null for a missing key', async () => {
        expect(await adapter.get('nope')).toBeNull();
    });

    test('delete removes a key', async () => {
        await adapter.set('k1', { a: 1 }, 60);
        await adapter.delete('k1');
        expect(await adapter.get('k1')).toBeNull();
    });

    test('increment starts at the amount and accumulates', async () => {
        expect(await adapter.increment('counter', 1)).toBe(1);
        expect(await adapter.increment('counter', 2)).toBe(3);
    });

    test('mgetString returns raw strings and nulls positionally', async () => {
        await adapter.increment('ver:a', 5);
        expect(await adapter.mgetString(['ver:a', 'ver:missing'])).toEqual(['5', null]);
    });

    test('mgetString returns an empty array for no keys', async () => {
        expect(await adapter.mgetString([])).toEqual([]);
    });

    test('setIfNotExists succeeds once then refuses', async () => {
        expect(await adapter.setIfNotExists!('lock', 'token-1', 5000)).toBe(true);
        expect(await adapter.setIfNotExists!('lock', 'token-2', 5000)).toBe(false);
    });

    test('deleteIfValue only deletes on a token match', async () => {
        await adapter.setIfNotExists!('lock', 'token-1', 5000);

        expect(await adapter.deleteIfValue!('lock', 'wrong')).toBe(false);
        expect(await adapter.deleteIfValue!('lock', 'token-1')).toBe(true);
        expect(await adapter.setIfNotExists!('lock', 'token-3', 5000)).toBe(true);
    });

    test('expire sets a ttl that redis reports', async () => {
        await adapter.set('k1', { a: 1 });
        await adapter.expire('k1', 100);
        expect(await nodeRedisClient.ttl('k1')).toBeGreaterThan(0);
    });
});
