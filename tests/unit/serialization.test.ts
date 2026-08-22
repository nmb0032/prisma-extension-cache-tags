import { describe, expect, test } from 'vitest';
import { deserializeCacheEnvelope, deserializeCachedValue, serializeCacheEnvelope } from '../../src/serialization';

describe('serialization', () => {
    test('round-trips Date, BigInt, Map, and undefined', () => {
        const value = {
            when: new Date('2026-01-02T03:04:05.000Z'),
            big: 10n ** 20n,
            map: new Map([['a', 1]]),
            missing: undefined,
        };

        const serialized = serializeCacheEnvelope(value);
        const envelope = deserializeCacheEnvelope(serialized);
        const restored = deserializeCachedValue(envelope) as typeof value;

        expect(Object.keys(envelope)).toEqual(['value']);
        expect(restored.when).toBeInstanceOf(Date);
        expect(restored.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
        expect(restored.big).toBe(10n ** 20n);
        expect(restored.map).toBeInstanceOf(Map);
        expect(restored.map.get('a')).toBe(1);
        expect('missing' in (restored as object)).toBe(true);
    });

    test('round-trips null without a second query identity', () => {
        const serialized = serializeCacheEnvelope(null);
        expect(Object.keys(deserializeCacheEnvelope(serialized))).toEqual(['value']);
        expect(deserializeCachedValue(deserializeCacheEnvelope(serialized))).toBeNull();
    });
});
