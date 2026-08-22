import { describe, expect, test } from 'vitest';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import {
    buildReadComparisonReportRow,
    calculateRawDriftPercent,
    createReadComparisonPhase,
    isStableRawBaseline,
} from '../../tests/load/read-comparison-report';

describe('read-only cache comparison reporting', () => {
    test('calculates symmetric raw drift and applies the ten-percent stability boundary', () => {
        expect(calculateRawDriftPercent(10_000, 11_000)).toBeCloseTo(9.5238, 3);
        expect(isStableRawBaseline(10_000, 11_000)).toBe(true);
        expect(isStableRawBaseline(10_000, 12_000)).toBe(false);
    });

    test('calculates phase statistics and speedup relative to raw throughput', () => {
        const metrics = new BenchmarkMetrics();
        metrics.recordOperation('read', 10);
        metrics.recordOperation('read', 30);
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        metrics.addDatabaseQueries(2);

        const phase = createReadComparisonPhase('warm', metrics.summarize(1_000), 'warm-digest', 4);

        expect(phase).toEqual({
            mode: 'warm',
            digest: 'warm-digest',
            completedReads: 2,
            elapsedMs: 1_000,
            operationsPerSecond: 2,
            p50Ms: 10,
            p95Ms: 30,
            p99Ms: 30,
            cacheHits: 1,
            cacheMisses: 1,
            cacheHitRate: 0.5,
            databaseQueries: 2,
            speedupVsRaw: 0.5,
        });
    });

    test('renders a raw sample relative to the stable mean baseline', () => {
        const metrics = new BenchmarkMetrics();
        metrics.recordOperation('read', 12);
        const row = buildReadComparisonReportRow(
            createReadComparisonPhase('rawA', metrics.summarize(1_000), 'raw-a-digest', 1),
        );

        expect(row).toEqual({
            mode: 'rawA',
            'completed reads': 1,
            'elapsed (ms)': '1000.00',
            'ops/sec': '1.0',
            'speedup vs raw': '1.00x',
            'p50 (ms)': '12.00',
            'p95 (ms)': '12.00',
            'p99 (ms)': '12.00',
            'cache hits': 0,
            'cache misses': 0,
            'cache hit rate': '0.0%',
            'database queries': 0,
        });
    });

    test('renders comparative speedup as unstable when raw drift exceeds ten percent', () => {
        const metrics = new BenchmarkMetrics();
        metrics.recordOperation('read', 12);

        const row = buildReadComparisonReportRow(
            createReadComparisonPhase('cold', metrics.summarize(1_000), 'cold-digest', null),
        );

        expect(row['speedup vs raw']).toBe('unstable');
    });
});
