import type { Metrics } from '../../src/types';
import type { BenchmarkOperation } from './profiles';
import { operationsPerSecond, percentile } from './statistics';

export interface BenchmarkSummary {
    elapsedMs: number;
    completed: number;
    reads: number;
    writes: number;
    errors: number;
    freshnessFailures: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    databaseQueries: number;
    operationsPerSecond: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
}

export class BenchmarkMetrics {
    readonly cacheMetrics: Metrics;

    private durations: number[] = [];
    private reads = 0;
    private writes = 0;
    private errors = 0;
    private freshnessFailures = 0;
    private cacheHits = 0;
    private cacheMisses = 0;
    private databaseQueries = 0;

    constructor() {
        this.cacheMetrics = {
            onCacheEvent: ({ result }) => {
                if (result === 'hit') this.cacheHits += 1;
                else this.cacheMisses += 1;
            },
        };
    }

    recordOperation(operation: BenchmarkOperation, durationMs: number): void {
        if (!Number.isFinite(durationMs) || durationMs < 0) {
            throw new Error('durationMs must be non-negative');
        }

        if (operation === 'read') this.reads += 1;
        else this.writes += 1;
        this.durations.push(durationMs);
    }

    recordError(): void {
        this.errors += 1;
    }

    recordFreshnessFailure(): void {
        this.freshnessFailures += 1;
    }

    addDatabaseQueries(count: number): void {
        if (!Number.isFinite(count) || count < 0) {
            throw new Error('count must be non-negative');
        }

        this.databaseQueries += count;
    }

    reset(): void {
        this.durations = [];
        this.reads = 0;
        this.writes = 0;
        this.errors = 0;
        this.freshnessFailures = 0;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.databaseQueries = 0;
    }

    summarize(elapsedMs: number): BenchmarkSummary {
        const completed = this.reads + this.writes;
        const cacheEvents = this.cacheHits + this.cacheMisses;

        return {
            elapsedMs,
            completed,
            reads: this.reads,
            writes: this.writes,
            errors: this.errors,
            freshnessFailures: this.freshnessFailures,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            cacheHitRate: cacheEvents === 0 ? 0 : this.cacheHits / cacheEvents,
            databaseQueries: this.databaseQueries,
            operationsPerSecond: operationsPerSecond(completed, elapsedMs),
            p50Ms: percentile(this.durations, 0.5),
            p95Ms: percentile(this.durations, 0.95),
            p99Ms: percentile(this.durations, 0.99),
        };
    }
}
