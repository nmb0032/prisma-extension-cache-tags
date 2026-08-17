import { createHash } from 'node:crypto';
import { deleteRedisNamespace, type BenchmarkFixture, type BenchmarkReadCorpus } from './benchmark-fixture';
import { BenchmarkMetrics } from './benchmark-metrics';
import {
    createReadComparisonPhase,
    type ReadComparisonMode,
    type ReadComparisonPhase,
} from './read-comparison-report';

const CACHE_TTL_SECONDS = 300;
const LIST_READ_TAKE = 25;

export type ReadComparisonOperation =
    | { kind: 'widgetUnique'; widgetId: string }
    | { kind: 'partUnique'; partId: string }
    | { kind: 'widgetList'; tenantId: string }
    | { kind: 'partList'; tenantId: string };

export interface ReadOnlyComparison {
    plan: ReadComparisonOperation[];
    phases: {
        raw: ReadComparisonPhase;
        cold: ReadComparisonPhase;
        warm: ReadComparisonPhase;
    };
}

interface PhaseExecution {
    digest: string;
    summary: ReturnType<BenchmarkMetrics['summarize']>;
}

export function buildReadComparisonPlan(corpus: BenchmarkReadCorpus): ReadComparisonOperation[] {
    if (corpus.widgets.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one widget');
    }
    if (corpus.parts.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one part');
    }
    if (corpus.tenantIds.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }

    return [
        ...corpus.widgets.map((widget) => ({ kind: 'widgetUnique' as const, widgetId: widget.id })),
        ...corpus.parts.map((part) => ({ kind: 'partUnique' as const, partId: part.id })),
        ...corpus.tenantIds.map((tenantId) => ({ kind: 'widgetList' as const, tenantId })),
        ...corpus.tenantIds.map((tenantId) => ({ kind: 'partList' as const, tenantId })),
    ];
}

export function createReadComparisonDigest(results: readonly unknown[]): string {
    const digest = createHash('sha256');
    for (const result of results) {
        digest.update(canonicalize(result));
        digest.update('\n');
    }
    return digest.digest('hex');
}

export function assertReadComparisonEquivalent(
    expectedDigest: string,
    observedDigest: string,
    mode: Exclude<ReadComparisonMode, 'raw'>,
): void {
    if (expectedDigest !== observedDigest) {
        throw new Error(`Read comparison result mismatch in ${mode} phase`);
    }
}

export async function runReadOnlyComparison(
    fixture: BenchmarkFixture,
    metrics: BenchmarkMetrics,
): Promise<ReadOnlyComparison> {
    const plan = buildReadComparisonPlan(fixture.readCorpus);
    await Promise.all(fixture.clients.map((client) => client.$connect()));
    const raw = await executeReadComparisonPhase(fixture, plan, 'raw', metrics);

    await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
    const cold = await executeReadComparisonPhase(fixture, plan, 'cold', metrics);
    const warm = await executeReadComparisonPhase(fixture, plan, 'warm', metrics);

    assertReadComparisonEquivalent(raw.digest, cold.digest, 'cold');
    assertReadComparisonEquivalent(raw.digest, warm.digest, 'warm');

    const rawPhase = createReadComparisonPhase('raw', raw.summary, raw.digest, raw.summary.operationsPerSecond);
    const coldPhase = createReadComparisonPhase('cold', cold.summary, cold.digest, raw.summary.operationsPerSecond);
    const warmPhase = createReadComparisonPhase('warm', warm.summary, warm.digest, raw.summary.operationsPerSecond);

    return {
        plan,
        phases: {
            raw: rawPhase,
            cold: coldPhase,
            warm: warmPhase,
        },
    };
}

async function executeReadComparisonPhase(
    fixture: BenchmarkFixture,
    plan: readonly ReadComparisonOperation[],
    mode: ReadComparisonMode,
    metrics: BenchmarkMetrics,
): Promise<PhaseExecution> {
    if (fixture.clients.length === 0) {
        throw new Error('The benchmark requires at least one independent client for read comparison');
    }

    metrics.reset();
    for (const queryCounter of fixture.queryCounters) {
        queryCounter.reset();
    }

    const startedAt = process.hrtime.bigint();
    const workerResults = await Promise.allSettled(
        fixture.clients.map((client, workerIndex) =>
            runReadComparisonWorker(client, plan, mode, workerIndex, fixture.clients.length, metrics),
        ),
    );
    const elapsedMs = Math.max(0.001, Number(process.hrtime.bigint() - startedAt) / 1_000_000);

    const failures = workerResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, `${mode} read comparison workers failed`);
    }

    const results = workerResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    results.sort((left, right) => left.index - right.index);
    if (results.length !== plan.length) {
        throw new Error(`${mode} read comparison completed ${results.length} of ${plan.length} reads`);
    }

    const databaseQueries = fixture.queryCounters.reduce((total, counter) => total + counter.total, 0);
    metrics.addDatabaseQueries(databaseQueries);
    const summary = metrics.summarize(elapsedMs);
    assertReadComparisonPhaseInvariants(mode, plan.length, summary);

    return {
        digest: createReadComparisonDigest(
            results.map(({ index, result }) => ({
                index,
                operation: plan[index],
                result,
            })),
        ),
        summary,
    };
}

function assertReadComparisonPhaseInvariants(
    mode: ReadComparisonMode,
    expectedReads: number,
    summary: ReturnType<BenchmarkMetrics['summarize']>,
): void {
    const expected = {
        completedReads: expectedReads,
        cacheHits: mode === 'warm' ? expectedReads : 0,
        cacheMisses: mode === 'cold' ? expectedReads : 0,
        databaseQueries: mode === 'warm' ? 0 : expectedReads,
    };
    const observed = {
        completedReads: summary.reads,
        cacheHits: summary.cacheHits,
        cacheMisses: summary.cacheMisses,
        databaseQueries: summary.databaseQueries,
    };

    if (
        observed.completedReads !== expected.completedReads ||
        observed.cacheHits !== expected.cacheHits ||
        observed.cacheMisses !== expected.cacheMisses ||
        observed.databaseQueries !== expected.databaseQueries
    ) {
        throw new Error(
            `Read comparison ${mode} phase invariant failed: expected ${formatPhaseCounts(expected)}; observed ${formatPhaseCounts(observed)}`,
        );
    }
}

function formatPhaseCounts(counts: {
    completedReads: number;
    cacheHits: number;
    cacheMisses: number;
    databaseQueries: number;
}): string {
    return [
        `completed reads=${counts.completedReads}`,
        `cache hits=${counts.cacheHits}`,
        `cache misses=${counts.cacheMisses}`,
        `database queries=${counts.databaseQueries}`,
    ].join(', ');
}

async function runReadComparisonWorker(
    client: BenchmarkFixture['clients'][number],
    plan: readonly ReadComparisonOperation[],
    mode: ReadComparisonMode,
    workerIndex: number,
    workerCount: number,
    metrics: BenchmarkMetrics,
): Promise<Array<{ index: number; result: unknown }>> {
    const results: Array<{ index: number; result: unknown }> = [];

    for (let index = workerIndex; index < plan.length; index += workerCount) {
        const operation = plan[index]!;
        const startedAt = process.hrtime.bigint();
        try {
            const result = await executeReadComparisonOperation(client, operation, mode);
            results.push({ index, result });
            metrics.recordOperation('read', Number(process.hrtime.bigint() - startedAt) / 1_000_000);
        } catch (error) {
            metrics.recordError();
            throw error;
        }
    }

    return results;
}

async function executeReadComparisonOperation(
    client: BenchmarkFixture['clients'][number],
    operation: ReadComparisonOperation,
    mode: ReadComparisonMode,
): Promise<unknown> {
    const cache = mode === 'raw' ? { enabled: false as const } : { ttlSeconds: CACHE_TTL_SECONDS };

    switch (operation.kind) {
        case 'widgetUnique':
            return client.widget.findUnique({
                where: { id: operation.widgetId },
                cache,
            });
        case 'partUnique':
            return client.part.findUnique({
                where: { id: operation.partId },
                cache,
            });
        case 'widgetList':
            return client.widget.findMany({
                where: { tenantId: operation.tenantId },
                orderBy: { id: 'asc' },
                take: LIST_READ_TAKE,
                cache,
            });
        case 'partList':
            return client.part.findMany({
                where: { tenantId: operation.tenantId },
                orderBy: { id: 'asc' },
                take: LIST_READ_TAKE,
                cache,
            });
    }
}

function canonicalize(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'bigint') {
        return `${value.toString()}n`;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (value instanceof Date) {
        return `date:${JSON.stringify(value.toISOString())}`;
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(String(value));
}
