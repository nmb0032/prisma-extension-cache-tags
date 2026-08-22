import { createClient } from 'redis';
import IoRedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createIoRedisAdapter } from '../../src/adapters/ioredis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { buildVersionedCacheKey, createVersionToken } from '../../src/keys';
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
        const payload = '{"a":1,"b":["x"]}';
        await adapter.setString('k1', payload, 60);
        expect(await adapter.getString('k1')).toBe(payload);
    });

    test('get returns null for a missing key', async () => {
        expect(await adapter.getString('nope')).toBeNull();
    });

    test('delete removes a key', async () => {
        await adapter.setString('k1', '{"a":1}', 60);
        await adapter.delete('k1');
        expect(await adapter.getString('k1')).toBeNull();
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
        await adapter.setString('k1', '{"a":1}');
        await adapter.expire('k1', 100);
        expect(await nodeRedisClient.ttl('k1')).toBeGreaterThan(0);
    });
});

describe.each(cases)('%s optimized primitives', (_name, adapter) => {
    test('uses zero tokens for missing tag versions in ordered key bytes', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();

        await expect(
            optimized!.lookupVersioned({
                baseKey: 'stage3:missing',
                tagVersionKeys: ['stage3:missing:a', 'stage3:missing:b'],
            }),
        ).resolves.toMatchObject({
            cacheKey: 'stage3:missing:0.0',
            value: null,
            lockAcquired: false,
        });
    });

    test('produces the same versioned key bytes as the command fallback', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();
        const fallback = createNodeRedisAdapter(nodeRedisClient, { optimized: false });
        const baseKey = 'stage3:parity';
        const versionKeys = ['stage3:parity:a', 'stage3:parity:b'];
        await nodeRedisClient.set(versionKeys[0]!, '2');
        await nodeRedisClient.set(versionKeys[1]!, '10');
        const fallbackKey = buildVersionedCacheKey(baseKey, createVersionToken(await fallback.mgetString(versionKeys)));

        await expect(optimized!.lookupVersioned({ baseKey, tagVersionKeys: versionKeys })).resolves.toMatchObject({
            cacheKey: fallbackKey,
            value: null,
            lockAcquired: false,
        });
    });

    test('reloads a flushed script and retries the lookup', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();

        await expect(optimized!.lookupVersioned({ baseKey: 'stage3:reload', tagVersionKeys: [] })).resolves.toMatchObject({
            cacheKey: 'stage3:reload:',
            value: null,
            lockAcquired: false,
        });
        await nodeRedisClient.sendCommand(['SCRIPT', 'FLUSH']);
        await expect(optimized!.lookupVersioned({ baseKey: 'stage3:reload', tagVersionKeys: [] })).resolves.toMatchObject({
            cacheKey: 'stage3:reload:',
            value: null,
            lockAcquired: false,
        });
    });

    test('selects generations, grants one owner, and serves the populated value', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();

        const tagKeys = ['stage3:tag:a', 'stage3:tag:b'];
        await expect(optimized!.bumpTagVersions(tagKeys, 3600)).resolves.toEqual([1, 1]);

        const owner = await optimized!.lookupVersioned({
            baseKey: 'stage3:query',
            tagVersionKeys: tagKeys,
            lockToken: 'owner-token',
            lockTtlMs: 5000,
        });
        expect(owner).toEqual({
            cacheKey: 'stage3:query:1.1',
            value: null,
            lockAcquired: true,
        });

        const contender = await optimized!.lookupVersioned({
            baseKey: 'stage3:query',
            tagVersionKeys: tagKeys,
            lockToken: 'contender-token',
            lockTtlMs: 5000,
        });
        expect(contender).toEqual({
            cacheKey: owner.cacheKey,
            value: null,
            lockAcquired: false,
        });

        const payload = '{"identity":"stage3","tenantScope":[],"value":{"fresh":true}}';
        await expect(
            optimized!.populateAndRelease({
                cacheKey: owner.cacheKey,
                lockToken: 'owner-token',
                value: payload,
                ttlSeconds: 60,
            }),
        ).resolves.toBe(true);
        await expect(adapter.getString(owner.cacheKey)).resolves.toBe(payload);

        await expect(
            optimized!.lookupVersioned({
                baseKey: 'stage3:query',
                tagVersionKeys: tagKeys,
                lockToken: 'new-token',
                lockTtlMs: 5000,
            }),
        ).resolves.toEqual({ cacheKey: owner.cacheKey, value: payload, lockAcquired: false });
    });

    test('prevents replaced owners from overwriting a generation', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();
        const owner = await optimized!.lookupVersioned({
            baseKey: 'stage3:ownership',
            tagVersionKeys: [],
            lockToken: 'old-owner',
            lockTtlMs: 5000,
        });
        await nodeRedisClient.set(`${owner.cacheKey}:lock`, 'replacement-owner');

        await expect(
            optimized!.populateAndRelease({
                cacheKey: owner.cacheKey,
                lockToken: 'old-owner',
                value: 'must-not-write',
                ttlSeconds: 60,
            }),
        ).resolves.toBe(false);
        await expect(adapter.getString(owner.cacheKey)).resolves.toBeNull();
        await nodeRedisClient.del(`${owner.cacheKey}:lock`);
    });

    test('atomically bumps unique tag keys and applies the retention TTL', async () => {
        const optimized = adapter.optimized;
        expect(optimized).toBeDefined();
        const keys = ['stage3:ttl:a', 'stage3:ttl:b'];

        await expect(optimized!.bumpTagVersions([...keys, keys[0]!], 3600)).resolves.toEqual([1, 1]);
        expect(await nodeRedisClient.ttl(keys[0]!)).toBeGreaterThan(3500);
        expect(await nodeRedisClient.ttl(keys[1]!)).toBeGreaterThan(3500);
    });
});
