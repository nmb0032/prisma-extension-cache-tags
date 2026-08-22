import { describe, expect, test } from 'vitest';
import { CanonicalizationError, canonicalizePrismaValue, hashCanonicalValue } from '../../src/canonical';

describe('canonical Prisma values', () => {
    test('is insensitive to object insertion order at every nesting level', () => {
        const first = {
            where: {
                b: 2,
                a: {
                    nested: [{ z: 3, y: 2 }, { b: 1, a: 0 }],
                },
            },
            select: { name: true, id: true },
        };
        const second = {
            select: { id: true, name: true },
            where: {
                a: {
                    nested: [{ y: 2, z: 3 }, { a: 0, b: 1 }],
                },
                b: 2,
            },
        };

        expect(canonicalizePrismaValue(first)).toBe(canonicalizePrismaValue(second));
        expect(hashCanonicalValue(first)).toBe(hashCanonicalValue(second));
    });

    test('distinguishes absent properties from explicit undefined and preserves arrays', () => {
        expect(canonicalizePrismaValue({ a: undefined })).not.toBe(canonicalizePrismaValue({}));
        expect(canonicalizePrismaValue([undefined])).not.toBe(canonicalizePrismaValue([]));
        expect(canonicalizePrismaValue([, 1])).not.toBe(canonicalizePrismaValue([undefined, 1]));
        expect(canonicalizePrismaValue([1, 2])).not.toBe(canonicalizePrismaValue([2, 1]));
    });

    test('encodes Prisma-relevant scalar and binary values deterministically', () => {
        const decimal = { toJSON: () => '12.3400' };
        expect(canonicalizePrismaValue(new Date('2026-08-22T00:00:00.000Z'))).toBe(
            canonicalizePrismaValue(new Date('2026-08-22T00:00:00.000Z')),
        );
        expect(canonicalizePrismaValue(42n)).toBe(canonicalizePrismaValue(42n));
        expect(canonicalizePrismaValue(decimal)).toBe(canonicalizePrismaValue({ toJSON: () => '12.3400' }));
        expect(canonicalizePrismaValue(Buffer.from([1, 2, 3]))).toBe(canonicalizePrismaValue(Buffer.from([1, 2, 3])));
        expect(canonicalizePrismaValue(Buffer.from([1, 2, 3]))).not.toBe(canonicalizePrismaValue(Uint8Array.from([1, 2, 3])));
        expect(canonicalizePrismaValue(Buffer.from([1, 2, 3]))).not.toBe(canonicalizePrismaValue(Buffer.from([1, 2, 4])));
    });

    test('sorts Map and Set entries by their canonical values', () => {
        const mapA = new Map<unknown, unknown>([
            ['b', { z: 2, a: 1 }],
            ['a', 3],
        ]);
        const mapB = new Map<unknown, unknown>([
            ['a', 3],
            ['b', { a: 1, z: 2 }],
        ]);
        const setA = new Set(['b', 'a']);
        const setB = new Set(['a', 'b']);

        expect(canonicalizePrismaValue(mapA)).toBe(canonicalizePrismaValue(mapB));
        expect(canonicalizePrismaValue(setA)).toBe(canonicalizePrismaValue(setB));
    });

    test('distinguishes special numbers and negative zero', () => {
        const values = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0];
        const encoded = values.map((value) => canonicalizePrismaValue(value));

        expect(new Set(encoded).size).toBe(values.length);
        expect(encoded).toEqual(values.map((value) => canonicalizePrismaValue(value)));
    });

    test('reports an actionable path for cycles', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        expect(() => canonicalizePrismaValue(cyclic)).toThrow(/cycle.*self/i);
        try {
            canonicalizePrismaValue(cyclic);
        } catch (error) {
            expect(error).toBeInstanceOf(CanonicalizationError);
            expect((error as CanonicalizationError).path).toBe('$.self');
            expect((error as CanonicalizationError).reason).toMatch(/cycle/i);
        }
    });

    test('rejects unsupported values with their argument path', () => {
        expect(() =>
            canonicalizePrismaValue({
                where: { value: () => 'unsupported' },
            }),
        ).toThrow('Cannot canonicalize value at $.where.value: function is unsupported');
        expect(() => canonicalizePrismaValue(Symbol('unsupported'))).toThrow(/symbol is unsupported/);
        expect(() => canonicalizePrismaValue(new WeakMap())).toThrow(/WeakMap is unsupported/);
    });

    test('produces a SHA-256 hexadecimal digest', () => {
        expect(hashCanonicalValue({ id: 42n })).toMatch(/^[a-f0-9]{64}$/);
    });

    test('reconstructs a deterministic reversed-order corpus', () => {
        for (let index = 0; index < 500; index += 1) {
            const entries = Array.from({ length: 5 }, (_, offset) => [
                `field-${(index + offset) % 7}`,
                {
                    index: index + offset,
                    nested: { alpha: offset, beta: index % 3 },
                },
            ] as const);
            const forward = Object.fromEntries(entries);
            const reversed = Object.fromEntries([...entries].reverse());

            expect(canonicalizePrismaValue(forward)).toBe(canonicalizePrismaValue(reversed));
        }
    });
});
