import { describe, expect, test } from 'vitest';
import type { CachedEnvelopeV2 } from '../../src/types';
import { deserializeCacheEnvelope, matchesCacheIdentity, serializeCacheEnvelope } from '../../src/serialization';

describe('serialization', () => {
    test('round-trips one flat envelope with identity, tenant scope, and Prisma values', () => {
        const value = {
            date: new Date('2026-08-22T00:00:00.000Z'),
            bigint: 42n,
            nested: [undefined, Number.NaN, new Set(['a'])],
        };
        const envelope = {
            identity: 'canonical-query-identity',
            tenantScope: ['tenant-a'],
            value,
        };

        const payload = serializeCacheEnvelope(envelope);
        const restored = deserializeCacheEnvelope(payload);
        const restoredValue = restored.value as typeof value;

        expect(typeof payload).toBe('string');
        expect(restored).toEqual(envelope);
        expect(restoredValue.date).toBeInstanceOf(Date);
        expect(restoredValue.bigint).toBe(42n);
        expect(restoredValue.nested[2]).toBeInstanceOf(Set);
        expect(payload).not.toContain('fingerprint');
    });

    test('retains a sorted tenant scope and verifies exact identity and scope', () => {
        const envelope = {
            identity: 'identity',
            tenantScope: ['tenant-a', 'tenant-b'],
            value: null,
        };
        const prepared = {
            baseKey: 'prismaCacheTags:v2:qry:Widget:findMany:hash',
            tagVersionKeys: [],
            identity: 'identity',
            tenantScope: ['tenant-a', 'tenant-b'],
        };

        expect(matchesCacheIdentity(deserializeCacheEnvelope(serializeCacheEnvelope(envelope)), prepared)).toBe(true);
        expect(
            matchesCacheIdentity(
                { ...envelope, identity: 'other' },
                prepared,
            ),
        ).toBe(false);
        expect(
            matchesCacheIdentity(
                { ...envelope, tenantScope: ['tenant-b'] },
                prepared,
            ),
        ).toBe(false);
    });

    test.each([
        ['a malformed SuperJSON payload', 'not-superjson'],
        [
            'an envelope missing value',
            serializeCacheEnvelope({ identity: 'identity', tenantScope: [] } as unknown as CachedEnvelopeV2),
        ],
        [
            'an envelope with a non-string identity',
            serializeCacheEnvelope({ identity: 42, tenantScope: [], value: null } as unknown as CachedEnvelopeV2),
        ],
        [
            'an envelope with a non-string tenant scope entry',
            serializeCacheEnvelope({ identity: 'identity', tenantScope: ['tenant-a', 42], value: null } as unknown as CachedEnvelopeV2),
        ],
    ])('rejects %s at the deserialization boundary', (_description, payload) => {
        expect(() => deserializeCacheEnvelope(payload)).toThrow(/invalid cache envelope/i);
    });

    test('accepts an own value property containing undefined', () => {
        const envelope = {
            identity: 'identity',
            tenantScope: [],
            value: undefined,
        };
        const restored = deserializeCacheEnvelope(serializeCacheEnvelope(envelope));
        const prepared = {
            baseKey: 'prismaCacheTags:v2:qry:Widget:findMany:hash',
            tagVersionKeys: [],
            identity: 'identity',
            tenantScope: [],
        };

        expect(Object.prototype.hasOwnProperty.call(restored, 'value')).toBe(true);
        expect(restored.value).toBeUndefined();
        expect(matchesCacheIdentity(restored, prepared)).toBe(true);
    });

    test('does not treat an envelope without value as an identity match', () => {
        const prepared = {
            baseKey: 'prismaCacheTags:v2:qry:Widget:findMany:hash',
            tagVersionKeys: [],
            identity: 'identity',
            tenantScope: [],
        };

        expect(
            matchesCacheIdentity(
                { identity: 'identity', tenantScope: [] } as unknown as CachedEnvelopeV2,
                prepared,
            ),
        ).toBe(false);
    });
});
