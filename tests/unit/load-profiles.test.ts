import { describe, expect, test } from 'vitest';
import {
    BENCHMARK_PROFILES,
    parseBenchmarkArgs,
    selectOperation,
} from '../../tests/load/profiles';

describe('benchmark profiles', () => {
    test('defines the quick and stress profiles with the fixed benchmark values', () => {
        expect(BENCHMARK_PROFILES).toEqual({
            quick: {
                name: 'quick',
                tenants: 4,
                widgetsPerTenant: 100,
                partsPerWidget: 2,
                concurrency: 8,
                warmupMs: 3_000,
                durationMs: 10_000,
                readRatio: 0.9,
            },
            stress: {
                name: 'stress',
                tenants: 20,
                widgetsPerTenant: 500,
                partsPerWidget: 2,
                concurrency: 32,
                warmupMs: 15_000,
                durationMs: 60_000,
                readRatio: 0.9,
            },
        });
    });

    test('defaults to the quick profile without preserving data', () => {
        expect(parseBenchmarkArgs([])).toEqual({ profile: BENCHMARK_PROFILES.quick, preserve: false });
    });

    test('parses a separate stress profile value and preserve flag', () => {
        expect(parseBenchmarkArgs(['--profile', 'stress', '--preserve'])).toEqual({
            profile: BENCHMARK_PROFILES.stress,
            preserve: true,
        });
    });

    test('parses an equals-form stress profile value', () => {
        expect(parseBenchmarkArgs(['--profile=stress'])).toEqual({
            profile: BENCHMARK_PROFILES.stress,
            preserve: false,
        });
    });

    test('rejects a profile flag without a value', () => {
        expect(() => parseBenchmarkArgs(['--profile'])).toThrow(/--profile/);
    });

    test('rejects an empty profile value', () => {
        expect(() => parseBenchmarkArgs(['--profile='])).toThrow(/--profile=/);
    });

    test('rejects unsupported profile names', () => {
        expect(() => parseBenchmarkArgs(['--profile', 'large'])).toThrow('Unknown benchmark profile: large');
    });

    test('rejects unknown arguments', () => {
        expect(() => parseBenchmarkArgs(['--verbose'])).toThrow('--verbose');
    });

    test('selects reads below the read ratio and writes at its boundary', () => {
        expect(selectOperation(0.8999)).toBe('read');
        expect(selectOperation(0.9)).toBe('write');
    });

    test('rejects samples outside the unit interval', () => {
        expect(() => selectOperation(-0.01)).toThrow('sample must be between 0 and 1');
        expect(() => selectOperation(1.01)).toThrow('sample must be between 0 and 1');
    });

    test('rejects non-finite samples', () => {
        expect(() => selectOperation(Number.NaN)).toThrow('sample must be between 0 and 1');
        expect(() => selectOperation(Number.POSITIVE_INFINITY)).toThrow('sample must be between 0 and 1');
    });
});
