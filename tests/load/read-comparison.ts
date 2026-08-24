import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deleteRedisNamespace, type BenchmarkFixture, type BenchmarkReadCorpus } from './benchmark-fixture';
import { BenchmarkMetrics } from './benchmark-metrics';
import type { BenchmarkWorkloadName } from './profiles';
import {
    buildListHeavyPlan,
    buildZipfianPlan,
    createRealisticWorkloadProfile,
    type RealisticWorkloadOperation,
} from './realistic-workload';
import {
    calculateRawDriftPercent,
    createReadComparisonPhase,
    isStableRawBaseline,
    type ReadComparisonMode,
    type ReadComparisonPhase,
} from './read-comparison-report';
import {
    QueryKindMetrics,
    summarizeEventLoopDelta,
    type EventLoopSummary,
    type QueryKindSummary,
} from './query-kind-metrics';

const CACHE_TTL_SECONDS = 300;
const LIST_READ_TAKE = 25;

export type ReadComparisonOperation =
    | { kind: 'widgetUnique'; widgetId: string }
    | { kind: 'partUnique'; partId: string }
    | { kind: 'widgetList'; tenantId: string; take?: number }
    | { kind: 'partList'; tenantId: string; take?: number }
    | { kind: 'widgetAggregate'; tenantId: string };

export interface ReadOnlyComparison {
    plan: ReadComparisonOperation[];
    warmupReads: number;
    rawDriftPercent: number;
    stableRawBaseline: boolean;
    phases: {
        rawA: ReadComparisonPhase;
        cold: ReadComparisonPhase;
        warm: ReadComparisonPhase;
        rawB: ReadComparisonPhase;
    };
}

interface PhaseExecution {
    digest: string;
    summary: ReturnType<BenchmarkMetrics['summarize']>;
    queryKinds: QueryKindSummary[];
    eventLoop: EventLoopSummary;
}

export function buildReadComparisonPlan(
    corpus: BenchmarkReadCorpus,
    workload: BenchmarkWorkloadName = 'standard',
): ReadComparisonOperation[] {
    if (corpus.widgets.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one widget');
    }
    if (corpus.parts.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one part');
    }
    if (corpus.tenantIds.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }

    const standardPlan: ReadComparisonOperation[] = [
        ...corpus.widgets.map((widget) => ({ kind: 'widgetUnique' as const, widgetId: widget.id })),
        ...corpus.parts.map((part) => ({ kind: 'partUnique' as const, partId: part.id })),
        ...corpus.tenantIds.map((tenantId) => ({ kind: 'widgetList' as const, tenantId })),
        ...corpus.tenantIds.map((tenantId) => ({ kind: 'partList' as const, tenantId })),
        ...corpus.tenantIds.map((tenantId) => ({ kind: 'widgetAggregate' as const, tenantId })),
    ];

    if (workload === 'standard') {
        return standardPlan;
    }
    if (workload === 'list-heavy') {
        return buildListHeavyPlan(corpus, createRealisticWorkloadProfile('list-heavy')).map(toReadComparisonOperation);
    }
    return buildZipfianPlan(corpus, createRealisticWorkloadProfile('zipfian'), 'read-comparison').map(toReadComparisonOperation);
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
    mode: Exclude<ReadComparisonMode, 'rawA'>,
): void {
    if (expectedDigest !== observedDigest) {
        throw new Error(`Read comparison result mismatch in ${mode} phase`);
    }
}

export async function runReadOnlyComparison(
    fixture: BenchmarkFixture,
    metrics: BenchmarkMetrics,
    workload: BenchmarkWorkloadName = 'standard',
): Promise<ReadOnlyComparison> {
    const plan = buildReadComparisonPlan(fixture.readCorpus, workload);
    await Promise.all(fixture.clients.map((client) => client.$connect()));
    const warmupReads = await executeReadComparisonWarmup(fixture, plan);
    const rawA = await executeReadComparisonPhase(fixture, plan, 'rawA', metrics);

    await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
    const cold = await executeReadComparisonPhase(fixture, plan, 'cold', metrics);
    const warm = await executeReadComparisonPhase(fixture, plan, 'warm', metrics);
    const rawB = await executeReadComparisonPhase(fixture, plan, 'rawB', metrics);

    assertReadComparisonEquivalent(rawA.digest, cold.digest, 'cold');
    assertReadComparisonEquivalent(rawA.digest, warm.digest, 'warm');
    assertReadComparisonEquivalent(rawA.digest, rawB.digest, 'rawB');

    const rawDriftPercent = calculateRawDriftPercent(rawA.summary.operationsPerSecond, rawB.summary.operationsPerSecond);
    const stableRawBaseline = isStableRawBaseline(rawA.summary.operationsPerSecond, rawB.summary.operationsPerSecond);
    const rawOperationsPerSecond = stableRawBaseline
        ? (rawA.summary.operationsPerSecond + rawB.summary.operationsPerSecond) / 2
        : null;
    const rawAPhase = createReadComparisonPhase('rawA', rawA.summary, rawA.digest, rawOperationsPerSecond, {
        queryKinds: rawA.queryKinds,
        eventLoop: rawA.eventLoop,
    });
    const coldPhase = createReadComparisonPhase('cold', cold.summary, cold.digest, rawOperationsPerSecond, {
        queryKinds: cold.queryKinds,
        eventLoop: cold.eventLoop,
    });
    const warmPhase = createReadComparisonPhase('warm', warm.summary, warm.digest, rawOperationsPerSecond, {
        queryKinds: warm.queryKinds,
        eventLoop: warm.eventLoop,
    });
    const rawBPhase = createReadComparisonPhase('rawB', rawB.summary, rawB.digest, rawOperationsPerSecond, {
        queryKinds: rawB.queryKinds,
        eventLoop: rawB.eventLoop,
    });

    return {
        plan,
        warmupReads,
        rawDriftPercent,
        stableRawBaseline,
        phases: {
            rawA: rawAPhase,
            cold: coldPhase,
            warm: warmPhase,
            rawB: rawBPhase,
        },
    };
}

async function executeReadComparisonWarmup(
    fixture: BenchmarkFixture,
    plan: readonly ReadComparisonOperation[],
): Promise<number> {
    if (fixture.clients.length === 0) {
        throw new Error('The benchmark requires at least one independent client for read comparison');
    }

    const workerResults = await Promise.allSettled(
        fixture.clients.map(async (client, workerIndex) => {
            let completed = 0;
            for (let index = workerIndex; index < plan.length; index += fixture.clients.length) {
                await executeReadComparisonOperation(client, plan[index]!, 'warmup', fixture.readCorpus);
                completed += 1;
            }
            return completed;
        }),
    );
    const failures = workerResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'warmup read comparison workers failed');
    }

    const completedReads = workerResults.reduce(
        (total, result) => total + (result.status === 'fulfilled' ? result.value : 0),
        0,
    );
    if (completedReads !== plan.length) {
        throw new Error(`warmup read comparison completed ${completedReads} of ${plan.length} reads`);
    }
    return completedReads;
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
    const eventLoopStart = performance.eventLoopUtilization();
    const queryKinds = new QueryKindMetrics();
    const workerResults = await Promise.allSettled(
        fixture.clients.map((client, workerIndex) =>
            runReadComparisonWorker(
                client,
                plan,
                mode,
                workerIndex,
                fixture.clients.length,
                metrics,
                queryKinds,
                fixture.readCorpus,
            ),
        ),
    );
    const elapsedMs = Math.max(0.001, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    const eventLoopDelta = performance.eventLoopUtilization(eventLoopStart);

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
    assertReadComparisonPhaseInvariants(mode, plan.length, countDistinctOperations(plan), summary);

    return {
        digest: createReadComparisonDigest(
            results.map(({ index, result }) => ({
                index,
                operation: plan[index],
                result,
            })),
        ),
        summary,
        queryKinds: queryKinds.summarize(elapsedMs),
        eventLoop: summarizeEventLoopDelta({
            active: eventLoopDelta.active,
            idle: eventLoopDelta.idle,
        }),
    };
}

function assertReadComparisonPhaseInvariants(
    mode: ReadComparisonMode,
    expectedReads: number,
    expectedColdMisses: number,
    summary: ReturnType<BenchmarkMetrics['summarize']>,
): void {
    const expected = {
        completedReads: expectedReads,
        cacheHits: mode === 'warm' ? expectedReads : 0,
        cacheMisses: mode === 'cold' ? expectedColdMisses : 0,
        databaseQueries: mode === 'warm' ? 0 : mode === 'cold' ? expectedColdMisses : expectedReads,
    };
    const observed = {
        completedReads: summary.reads,
        cacheHits: summary.cacheHits,
        cacheMisses: summary.cacheMisses,
        databaseQueries: summary.databaseQueries,
    };

    const cacheCountsValid =
        mode === 'cold'
            ? observed.cacheHits + observed.cacheMisses >= expectedReads &&
              observed.cacheMisses >= expectedColdMisses &&
              observed.cacheHits >= expectedReads - expectedColdMisses
            : observed.cacheHits === expected.cacheHits && observed.cacheMisses === expected.cacheMisses;
    if (
        observed.completedReads !== expected.completedReads ||
        !cacheCountsValid ||
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
    queryKinds: QueryKindMetrics,
    readCorpus: BenchmarkReadCorpus,
): Promise<Array<{ index: number; result: unknown }>> {
    const results: Array<{ index: number; result: unknown }> = [];

    for (let index = workerIndex; index < plan.length; index += workerCount) {
        const operation = plan[index]!;
        const startedAt = process.hrtime.bigint();
        try {
            const result = await executeReadComparisonOperation(client, operation, mode, readCorpus);
            results.push({ index, result });
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            metrics.recordOperation('read', durationMs);
            queryKinds.record(operation.kind, durationMs);
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
    mode: ReadComparisonMode | 'warmup',
    readCorpus: BenchmarkReadCorpus,
): Promise<unknown> {
    const cache =
        mode === 'warmup' || mode === 'rawA' || mode === 'rawB'
            ? { enabled: false as const }
            : { ttlSeconds: CACHE_TTL_SECONDS };

    switch (operation.kind) {
        case 'widgetUnique': {
            const widget = readCorpus.widgets.find(({ id }) => id === operation.widgetId);
            if (widget === undefined) {
                throw new Error(`Unknown benchmark widget ${operation.widgetId}`);
            }
            return client.widget.findUnique({
                where: { id: operation.widgetId, tenantId: widget.tenantId },
                cache,
            });
        }
        case 'partUnique': {
            const part = readCorpus.parts.find(({ id }) => id === operation.partId);
            if (part === undefined) {
                throw new Error(`Unknown benchmark part ${operation.partId}`);
            }
            return client.part.findUnique({
                where: { id: operation.partId, tenantId: part.tenantId },
                cache,
            });
        }
        case 'widgetList':
            return client.widget.findMany({
                where: { tenantId: operation.tenantId },
                orderBy: { id: 'asc' },
                take: operation.take ?? LIST_READ_TAKE,
                cache,
            });
        case 'partList':
            return client.part.findMany({
                where: { tenantId: operation.tenantId },
                orderBy: { id: 'asc' },
                take: operation.take ?? LIST_READ_TAKE,
                cache,
            });
        case 'widgetAggregate':
            return client.widget.aggregate({
                where: { tenantId: operation.tenantId },
                _count: { _all: true },
                cache,
            });
    }
}

function toReadComparisonOperation(operation: RealisticWorkloadOperation): ReadComparisonOperation {
    switch (operation.kind) {
        case 'widgetUnique':
            return operation;
        case 'partUnique':
            return operation;
        case 'widgetList':
            return operation;
        case 'partList':
            return operation;
        case 'widgetAggregate':
            return operation;
    }
}

function countDistinctOperations(plan: readonly ReadComparisonOperation[]): number {
    return new Set(plan.map((operation) => canonicalize(operation))).size;
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
