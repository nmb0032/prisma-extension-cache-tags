import { describe, expect, test, vi } from 'vitest';
import { createNodeRedisAdapter, type NodeRedisClientLike } from '../../src/adapters/node-redis';

describe('node-redis adapter', () => {
    test('returns raw strings and writes already-serialized payloads unchanged', async () => {
        const client: NodeRedisClientLike = {
            get: vi.fn().mockResolvedValue('{"identity":"id"}'),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            incrBy: vi.fn().mockResolvedValue(1),
            expire: vi.fn().mockResolvedValue(true),
            mGet: vi.fn().mockResolvedValue([]),
            eval: vi.fn().mockResolvedValue(1),
        };
        const adapter = createNodeRedisAdapter(client);

        expect(await adapter.getString('cache-key')).toBe('{"identity":"id"}');
        await adapter.setString('cache-key', '{"identity":"id"}', 60);

        expect(client.get).toHaveBeenCalledWith('cache-key');
        expect(client.set).toHaveBeenCalledWith('cache-key', '{"identity":"id"}', { EX: 60 });
    });

    test('preserves raw missing values and supports string primitives', async () => {
        const client: NodeRedisClientLike = {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            incrBy: vi.fn().mockResolvedValue(4),
            expire: vi.fn().mockResolvedValue(true),
            mGet: vi.fn().mockResolvedValue(['1', null]),
            eval: vi.fn().mockResolvedValue(0),
        };
        const adapter = createNodeRedisAdapter(client);

        expect(await adapter.getString('missing')).toBeNull();
        await adapter.setString('counter', '4');
        expect(await adapter.increment('counter', 4)).toBe(4);
        expect(await adapter.mgetString(['a', 'b'])).toEqual(['1', null]);
    });

    test('exposes optimized script primitives by default when script commands are available', () => {
        const client: NodeRedisClientLike = {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            incrBy: vi.fn(),
            expire: vi.fn(),
            mGet: vi.fn(),
            eval: vi.fn(),
            scriptLoad: vi.fn().mockResolvedValue('sha'),
            evalSha: vi.fn(),
        };

        expect(createNodeRedisAdapter(client).optimized).toBeDefined();
        expect(createNodeRedisAdapter(client, { optimized: false }).optimized).toBeUndefined();
    });

    test('retains fallback semantics when script commands are unavailable', () => {
        const client: NodeRedisClientLike = {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            incrBy: vi.fn(),
            expire: vi.fn(),
            mGet: vi.fn(),
            eval: vi.fn(),
        };

        expect(createNodeRedisAdapter(client).optimized).toBeUndefined();
    });

    test('does not expose multi-key scripts for cluster clients', () => {
        const client: NodeRedisClientLike = {
            isCluster: true,
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            incrBy: vi.fn(),
            expire: vi.fn(),
            mGet: vi.fn(),
            eval: vi.fn(),
            scriptLoad: vi.fn(),
            evalSha: vi.fn(),
        };

        expect(createNodeRedisAdapter(client).optimized).toBeUndefined();
    });

    test('reads Cluster tag versions with ordered per-key GETs instead of MGET', async () => {
        const values = new Map([
            ['tag:a', '7'],
            ['tag:b', null],
            ['tag:c', '9'],
        ]);
        const get = vi.fn(async (key: string) => values.get(key) ?? null);
        const mGet = vi.fn(() => {
            throw new Error('Cluster MGET must not be used');
        });
        const client: NodeRedisClientLike = {
            isCluster: true,
            get,
            set: vi.fn(),
            del: vi.fn(),
            incrBy: vi.fn(),
            expire: vi.fn(),
            mGet,
            eval: vi.fn(),
        };

        const adapter = createNodeRedisAdapter(client);

        await expect(adapter.mgetString(['tag:a', 'tag:b', 'tag:c'])).resolves.toEqual(['7', null, '9']);
        expect(get).toHaveBeenNthCalledWith(1, 'tag:a');
        expect(get).toHaveBeenNthCalledWith(2, 'tag:b');
        expect(get).toHaveBeenNthCalledWith(3, 'tag:c');
        expect(mGet).not.toHaveBeenCalled();
    });
});
