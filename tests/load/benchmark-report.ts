import type { BenchmarkSummary } from './benchmark-metrics';
import type { BenchmarkProfileName } from './profiles';

export type BenchmarkReportRow = {
    profile: BenchmarkProfileName;
    completed: number;
    reads: number;
    writes: number;
    'ops/sec': string;
    'p50 (ms)': string;
    'p95 (ms)': string;
    'p99 (ms)': string;
    'cache-event hit rate': string;
    'database queries': number;
    errors: number;
    'freshness failures': number;
};

export function buildBenchmarkReportRow(profile: BenchmarkProfileName, summary: BenchmarkSummary): BenchmarkReportRow {
    return {
        profile,
        completed: summary.completed,
        reads: summary.reads,
        writes: summary.writes,
        'ops/sec': summary.operationsPerSecond.toFixed(1),
        'p50 (ms)': summary.p50Ms.toFixed(2),
        'p95 (ms)': summary.p95Ms.toFixed(2),
        'p99 (ms)': summary.p99Ms.toFixed(2),
        'cache-event hit rate': `${(summary.cacheHitRate * 100).toFixed(1)}%`,
        'database queries': summary.databaseQueries,
        errors: summary.errors,
        'freshness failures': summary.freshnessFailures,
    };
}
