import { describe, expect, test } from 'vitest';
import {
    deserializeCacheEnvelope,
    deserializeCachedValue,
    serializeCacheEnvelope,
    stableStringify,
} from '../../src/serialization';

describe('serialization', () => {
    test('round-trips Date, BigInt, Map, and undefined', () => {
        const value = {
            when: new Date('2026-01-02T03:04:05.000Z'),
            big: 10n ** 20n,
            map: new Map([['a', 1]]),
            missing: undefined,
        };

        const serialized = serializeCacheEnvelope(value, 'fp-1');
        const envelope = deserializeCacheEnvelope(serialized);
        const restored = deserializeCachedValue(envelope) as typeof value;

        expect(envelope.fingerprint).toBe('fp-1');
        expect(restored.when).toBeInstanceOf(Date);
        expect(restored.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
        expect(restored.big).toBe(10n ** 20n);
        expect(restored.map).toBeInstanceOf(Map);
        expect(restored.map.get('a')).toBe(1);
        expect('missing' in (restored as object)).toBe(true);
    });

    test('preserves the fingerprint independently of the value', () => {
        const serialized = serializeCacheEnvelope(null, 'fp-2');
        expect(deserializeCacheEnvelope(serialized).fingerprint).toBe('fp-2');
        expect(deserializeCachedValue(deserializeCacheEnvelope(serialized))).toBeNull();
    });

    test('stableStringify is deterministic for equal values', () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ a: 1, b: 2 }));
    });
});
