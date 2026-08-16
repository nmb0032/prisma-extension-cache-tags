import { describe, expect, test } from 'vitest';
import { operationsPerSecond, percentile } from '../../tests/load/statistics';

describe('benchmark statistics', () => {
    test('uses nearest-rank percentile selection on a numeric copy', () => {
        const samples = [4, 1, 3, 2];

        expect(percentile(samples, 0.5)).toBe(2);
        expect(percentile(samples, 0.95)).toBe(4);
        expect(samples).toEqual([4, 1, 3, 2]);
    });

    test('returns zero for an empty sample set', () => {
        expect(percentile([], 0.5)).toBe(0);
    });

    test('clamps the zero percentile to the first sample', () => {
        expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    });

    test('rejects percentiles outside the unit interval', () => {
        expect(() => percentile([1], 1.1)).toThrow('percentile must be between 0 and 1');
        expect(() => percentile([1], -0.1)).toThrow('percentile must be between 0 and 1');
    });

    test('rejects non-finite percentiles', () => {
        expect(() => percentile([1], Number.NaN)).toThrow('percentile must be between 0 and 1');
        expect(() => percentile([1], Number.POSITIVE_INFINITY)).toThrow('percentile must be between 0 and 1');
    });

    test('calculates completed operations per second', () => {
        expect(operationsPerSecond(250, 2_000)).toBe(125);
    });

    test('rejects a non-positive duration', () => {
        expect(() => operationsPerSecond(1, 0)).toThrow('durationMs must be greater than 0');
        expect(() => operationsPerSecond(1, -1)).toThrow('durationMs must be greater than 0');
    });
});
