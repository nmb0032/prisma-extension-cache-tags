import type { BenchmarkSummary } from './benchmark-metrics';
import { QUERY_KINDS, type EventLoopSummary, type QueryKindSummary } from './query-kind-metrics';

export type ReadComparisonMode = 'rawA' | 'cold' | 'warm' | 'rawB';

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
    speedupVsRaw: number | null;
    queryKinds: QueryKindSummary[];
    eventLoop: EventLoopSummary;
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
    'event-loop utilization': string;
    'event-loop active (ms)': string;
    'event-loop idle (ms)': string;
};

export type QueryKindReportRow = {
    mode: ReadComparisonMode;
    kind: QueryKindSummary['kind'];
    completed: number;
    'ops/sec': string;
    'p50 (ms)': string;
    'p95 (ms)': string;
    'p99 (ms)': string;
};

export function createReadComparisonPhase(
    mode: ReadComparisonMode,
    summary: BenchmarkSummary,
    digest: string,
    rawOperationsPerSecond: number | null,
    details: {
        queryKinds?: QueryKindSummary[];
        eventLoop?: EventLoopSummary;
    } = {},
): ReadComparisonPhase {
    if (rawOperationsPerSecond !== null && (!Number.isFinite(rawOperationsPerSecond) || rawOperationsPerSecond <= 0)) {
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
        speedupVsRaw: rawOperationsPerSecond === null ? null : summary.operationsPerSecond / rawOperationsPerSecond,
        queryKinds: details.queryKinds ?? QUERY_KINDS.map((kind) => ({
            kind,
            completed: 0,
            p50Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            operationsPerSecond: 0,
        })),
        eventLoop: details.eventLoop ?? { utilization: 0, activeMs: 0, idleMs: 0 },
    };
}

export function calculateRawDriftPercent(rawAOps: number, rawBOps: number): number {
    const midpoint = (rawAOps + rawBOps) / 2;
    return midpoint === 0 ? 0 : (Math.abs(rawAOps - rawBOps) / midpoint) * 100;
}

export function isStableRawBaseline(rawAOps: number, rawBOps: number): boolean {
    return calculateRawDriftPercent(rawAOps, rawBOps) <= 10;
}

export function buildReadComparisonReportRow(phase: ReadComparisonPhase): ReadComparisonReportRow {
    return {
        mode: phase.mode,
        'completed reads': phase.completedReads,
        'elapsed (ms)': phase.elapsedMs.toFixed(2),
        'ops/sec': phase.operationsPerSecond.toFixed(1),
        'speedup vs raw': phase.speedupVsRaw === null ? 'unstable' : `${phase.speedupVsRaw.toFixed(2)}x`,
        'p50 (ms)': phase.p50Ms.toFixed(2),
        'p95 (ms)': phase.p95Ms.toFixed(2),
        'p99 (ms)': phase.p99Ms.toFixed(2),
        'cache hits': phase.cacheHits,
        'cache misses': phase.cacheMisses,
        'cache hit rate': `${(phase.cacheHitRate * 100).toFixed(1)}%`,
        'database queries': phase.databaseQueries,
        'event-loop utilization': `${(phase.eventLoop.utilization * 100).toFixed(1)}%`,
        'event-loop active (ms)': phase.eventLoop.activeMs.toFixed(2),
        'event-loop idle (ms)': phase.eventLoop.idleMs.toFixed(2),
    };
}

export function buildReadComparisonKindReportRows(phase: ReadComparisonPhase): QueryKindReportRow[] {
    return phase.queryKinds.map((summary) => ({
        mode: phase.mode,
        kind: summary.kind,
        completed: summary.completed,
        'ops/sec': summary.operationsPerSecond.toFixed(1),
        'p50 (ms)': summary.p50Ms.toFixed(2),
        'p95 (ms)': summary.p95Ms.toFixed(2),
        'p99 (ms)': summary.p99Ms.toFixed(2),
    }));
}
