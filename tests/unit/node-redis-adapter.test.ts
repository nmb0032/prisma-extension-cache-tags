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
});
