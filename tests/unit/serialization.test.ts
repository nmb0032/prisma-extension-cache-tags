import { describe, expect, test } from 'vitest';
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
});
