import { describe, expect, test } from 'vitest';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import { buildBenchmarkReportRow } from '../../tests/load/benchmark-report';

describe('benchmark reporting', () => {
    test('renders partial metrics, including fatal counters, as a report row', () => {
        const metrics = new BenchmarkMetrics();
        metrics.recordOperation('read', 12);
        metrics.recordError();
        metrics.recordFreshnessFailure();

        const row = buildBenchmarkReportRow('quick', metrics.summarize(1_000));

        expect(row).toEqual({
            profile: 'quick',
            completed: 1,
            reads: 1,
            writes: 0,
            'ops/sec': '1.0',
            'p50 (ms)': '12.00',
            'p95 (ms)': '12.00',
            'p99 (ms)': '12.00',
            'cache-event hit rate': '0.0%',
            'database queries': 0,
            errors: 1,
            'freshness failures': 1,
        });
    });
});
