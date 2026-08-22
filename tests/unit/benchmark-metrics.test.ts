import { describe, expect, test } from 'vitest';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';

describe('benchmark metrics', () => {
    test('aggregates operations, cache events, queries, errors, and latency', () => {
        const metrics = new BenchmarkMetrics();

        metrics.recordOperation('read', 10);
        metrics.recordOperation('read', 20);
        metrics.recordOperation('write', 30);
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'miss', path: 'fallback' });
        metrics.addDatabaseQueries(4);
        metrics.recordError();
        metrics.recordFreshnessFailure();

        expect(metrics.summarize(1_000)).toEqual({
            elapsedMs: 1_000,
            completed: 3,
            reads: 2,
            writes: 1,
            errors: 1,
            freshnessFailures: 1,
            cacheHits: 1,
            cacheMisses: 2,
            cacheHitRate: 1 / 3,
            databaseQueries: 4,
            operationsPerSecond: 3,
            p50Ms: 20,
            p95Ms: 30,
            p99Ms: 30,
        });
    });

    test('reports a zero hit rate when no cache events occurred', () => {
        const metrics = new BenchmarkMetrics();

        expect(metrics.summarize(1_000).cacheHitRate).toBe(0);
    });

    test('rejects negative durations and query counts', () => {
        const metrics = new BenchmarkMetrics();

        expect(() => metrics.recordOperation('read', -1)).toThrow('durationMs must be non-negative');
        expect(() => metrics.addDatabaseQueries(-1)).toThrow('count must be non-negative');
    });

    test('resets all collected state while keeping the cache metrics object stable', () => {
        const metrics = new BenchmarkMetrics();
        const cacheMetrics = metrics.cacheMetrics;

        metrics.recordOperation('write', 25);
        metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'update', result: 'hit', path: 'fallback' });
        metrics.addDatabaseQueries(2);
        metrics.recordError();
        metrics.recordFreshnessFailure();
        metrics.reset();

        expect(metrics.cacheMetrics).toBe(cacheMetrics);
        expect(metrics.summarize(1_000)).toEqual({
            elapsedMs: 1_000,
            completed: 0,
            reads: 0,
            writes: 0,
            errors: 0,
            freshnessFailures: 0,
            cacheHits: 0,
            cacheMisses: 0,
            cacheHitRate: 0,
            databaseQueries: 0,
            operationsPerSecond: 0,
            p50Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
        });
    });

    test('summarizing does not reset collected state', () => {
        const metrics = new BenchmarkMetrics();
        metrics.recordOperation('read', 12);

        const firstSummary = metrics.summarize(1_000);
        const secondSummary = metrics.summarize(1_000);

        expect(secondSummary).toEqual(firstSummary);
    });
});
