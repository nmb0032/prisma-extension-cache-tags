import { describe, expect, test, vi } from 'vitest';
import { createIoRedisAdapter, type IoRedisClientLike } from '../../src/adapters/ioredis';

describe('ioredis adapter', () => {
    test('returns raw strings and writes already-serialized payloads unchanged', async () => {
        const client: IoRedisClientLike = {
            get: vi.fn().mockResolvedValue('{"identity":"id"}'),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            incrby: vi.fn().mockResolvedValue(1),
            expire: vi.fn().mockResolvedValue(1),
            mget: vi.fn().mockResolvedValue([]),
            eval: vi.fn().mockResolvedValue(1),
        };
        const adapter = createIoRedisAdapter(client);

        expect(await adapter.getString('cache-key')).toBe('{"identity":"id"}');
        await adapter.setString('cache-key', '{"identity":"id"}', 60);

        expect(client.get).toHaveBeenCalledWith('cache-key');
        expect(client.set).toHaveBeenCalledWith('cache-key', '{"identity":"id"}', 'EX', 60);
    });

    test('preserves raw missing values and supports string primitives', async () => {
        const client: IoRedisClientLike = {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            incrby: vi.fn().mockResolvedValue(4),
            expire: vi.fn().mockResolvedValue(1),
            mget: vi.fn().mockResolvedValue(['1', null]),
            eval: vi.fn().mockResolvedValue(0),
        };
        const adapter = createIoRedisAdapter(client);

        expect(await adapter.getString('missing')).toBeNull();
        await adapter.setString('counter', '4');
        expect(await adapter.increment('counter', 4)).toBe(4);
        expect(await adapter.mgetString(['a', 'b'])).toEqual(['1', null]);
    });

    test('exposes optimized script primitives by default and supports explicit fallback mode', () => {
        const client: IoRedisClientLike = {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            incrby: vi.fn(),
            expire: vi.fn(),
            mget: vi.fn(),
            eval: vi.fn(),
            script: vi.fn().mockResolvedValue('sha'),
            evalsha: vi.fn(),
        };

        expect(createIoRedisAdapter(client).optimized).toBeDefined();
        expect(createIoRedisAdapter(client, { optimized: false }).optimized).toBeUndefined();
    });

    test('does not expose multi-key scripts for cluster clients', () => {
        const client: IoRedisClientLike = {
            isCluster: true,
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            incrby: vi.fn(),
            expire: vi.fn(),
            mget: vi.fn(),
            eval: vi.fn(),
            script: vi.fn(),
            evalsha: vi.fn(),
        };

        expect(createIoRedisAdapter(client).optimized).toBeUndefined();
    });

    test('reads Cluster tag versions with ordered per-key GETs instead of MGET', async () => {
        const values = new Map([
            ['tag:a', '7'],
            ['tag:b', null],
            ['tag:c', '9'],
        ]);
        const get = vi.fn(async (key: string) => values.get(key) ?? null);
        const mget = vi.fn(() => {
            throw new Error('Cluster MGET must not be used');
        });
        const client: IoRedisClientLike = {
            isCluster: true,
            get,
            set: vi.fn(),
            del: vi.fn(),
            incrby: vi.fn(),
            expire: vi.fn(),
            mget,
            eval: vi.fn(),
        };

        const adapter = createIoRedisAdapter(client);

        await expect(adapter.mgetString(['tag:a', 'tag:b', 'tag:c'])).resolves.toEqual(['7', null, '9']);
        expect(get).toHaveBeenNthCalledWith(1, 'tag:a');
        expect(get).toHaveBeenNthCalledWith(2, 'tag:b');
        expect(get).toHaveBeenNthCalledWith(3, 'tag:c');
        expect(mget).not.toHaveBeenCalled();
    });
});
