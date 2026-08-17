import type { BenchmarkSummary } from './benchmark-metrics';

export type ReadComparisonMode = 'raw' | 'cold' | 'warm';

export interface ReadComparisonPhase {
    mode: ReadComparisonMode;
    digest: string;
    completedReads: number;
    elapsedMs: number;
    operationsPerSecond: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    databaseQueries: number;
    speedupVsRaw: number;
}

export type ReadComparisonReportRow = {
    mode: ReadComparisonMode;
    'completed reads': number;
    'elapsed (ms)': string;
    'ops/sec': string;
    'speedup vs raw': string;
    'p50 (ms)': string;
    'p95 (ms)': string;
    'p99 (ms)': string;
    'cache hits': number;
    'cache misses': number;
    'cache hit rate': string;
    'database queries': number;
};

export function createReadComparisonPhase(
    mode: ReadComparisonMode,
    summary: BenchmarkSummary,
    digest: string,
    rawOperationsPerSecond: number,
): ReadComparisonPhase {
    if (!Number.isFinite(rawOperationsPerSecond) || rawOperationsPerSecond <= 0) {
        throw new Error('rawOperationsPerSecond must be greater than 0');
    }

    return {
        mode,
        digest,
        completedReads: summary.reads,
        elapsedMs: summary.elapsedMs,
        operationsPerSecond: summary.operationsPerSecond,
        p50Ms: summary.p50Ms,
        p95Ms: summary.p95Ms,
        p99Ms: summary.p99Ms,
        cacheHits: summary.cacheHits,
        cacheMisses: summary.cacheMisses,
        cacheHitRate: summary.cacheHitRate,
        databaseQueries: summary.databaseQueries,
        speedupVsRaw: mode === 'raw' ? 1 : summary.operationsPerSecond / rawOperationsPerSecond,
    };
}

export function buildReadComparisonReportRow(phase: ReadComparisonPhase): ReadComparisonReportRow {
    return {
        mode: phase.mode,
        'completed reads': phase.completedReads,
        'elapsed (ms)': phase.elapsedMs.toFixed(2),
        'ops/sec': phase.operationsPerSecond.toFixed(1),
        'speedup vs raw': `${phase.speedupVsRaw.toFixed(2)}x`,
        'p50 (ms)': phase.p50Ms.toFixed(2),
        'p95 (ms)': phase.p95Ms.toFixed(2),
        'p99 (ms)': phase.p99Ms.toFixed(2),
        'cache hits': phase.cacheHits,
        'cache misses': phase.cacheMisses,
        'cache hit rate': `${(phase.cacheHitRate * 100).toFixed(1)}%`,
        'database queries': phase.databaseQueries,
    };
}
