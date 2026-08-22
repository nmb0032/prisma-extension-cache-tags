import { describe, expect, test, vi } from 'vitest';
import {
    BENCHMARK_PART_DESCRIPTION,
    BENCHMARK_WIDGET_DESCRIPTION,
    deleteRedisNamespace,
    validateBenchmarkKeyPrefix,
} from '../../tests/load/benchmark-fixture';
import type { createTestRedisClient } from '../../tests/support/service-preflight';

describe('benchmark fixture Redis namespaces', () => {
    test('provides deterministic production-sized descriptions for both fixture models', () => {
        expect(BENCHMARK_WIDGET_DESCRIPTION).toHaveLength(512);
        expect(BENCHMARK_PART_DESCRIPTION).toHaveLength(256);
        expect(BENCHMARK_WIDGET_DESCRIPTION).toBe('widget benchmark payload '.repeat(22).slice(0, 512));
        expect(BENCHMARK_PART_DESCRIPTION).toBe('part benchmark payload '.repeat(16).slice(0, 256));
    });

    test.each([
        '',
        'prismaCacheTags:benchmark:',
        'prismaCacheTags:benchmark:run*',
        'prismaCacheTags:benchmark:run?x',
        'prismaCacheTags:benchmark:run[0]',
        'prismaCacheTags:benchmark:run\\x',
        'prismaCacheTags:benchmark:run:other',
        'prismaCacheTags:other:run',
        'prismaCacheTags:benchmark:run space',
    ])('rejects unsafe key prefix %j', (keyPrefix) => {
        expect(() => validateBenchmarkKeyPrefix(keyPrefix)).toThrow();
    });

    test.each(['prismaCacheTags:benchmark:run-123', 'prismaCacheTags:benchmark:run_123'])(
        'accepts safe key prefix %j',
        (keyPrefix) => {
            expect(() => validateBenchmarkKeyPrefix(keyPrefix)).not.toThrow();
        },
    );

    test('rejects an unsafe prefix before scanning Redis', async () => {
        const scanIterator = vi.fn();
        const redis = { scanIterator } as unknown as ReturnType<typeof createTestRedisClient>;

        await expect(deleteRedisNamespace(redis, 'prismaCacheTags:benchmark:run*')).rejects.toThrow();
        expect(scanIterator).not.toHaveBeenCalled();
    });
});
