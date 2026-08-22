import { performance } from 'node:perf_hooks';
import { canonicalizePrismaValue } from '../../src/canonical';
import { deleteRedisNamespace, type BenchmarkFixture } from './benchmark-fixture';
import { summarizeEventLoopDelta, type EventLoopSummary } from './query-kind-metrics';
import { percentile } from './statistics';

export interface LatencySummary {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
}

export interface ContentionBenchmarkResult {
    rounds: number;
    contenders: number;
    databaseQueriesPerRound: number[];
    winner: LatencySummary;
    losers: LatencySummary;
    eventLoop: EventLoopSummary;
}

export async function runColdKeyContention(
    fixture: BenchmarkFixture,
    contenders = 32,
): Promise<ContentionBenchmarkResult> {
    if (!Number.isInteger(contenders) || contenders < 2) {
        throw new Error('contenders must be an integer greater than one');
    }
    if (fixture.clients.length < contenders) {
        throw new Error(`Cold-key contention requires ${contenders} independent clients; received ${fixture.clients.length}`);
    }

    const tenantId = fixture.tenantIds[0];
    if (tenantId === undefined) {
        throw new Error('Cold-key contention requires at least one tenant');
    }

    const rounds = fixture.profileName === 'stress' ? 30 : 10;
    const databaseQueriesPerRound: number[] = [];
    const winnerSamples: number[] = [];
    const loserSamples: number[] = [];
    const clients = fixture.clients.slice(0, contenders);
    await Promise.all(clients.map((client) => client.$connect()));
    let eventLoopActiveMs = 0;
    let eventLoopIdleMs = 0;

    for (let round = 0; round < rounds; round += 1) {
        await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
        for (const queryCounter of fixture.queryCounters) {
            queryCounter.reset();
        }

        let release!: () => void;
        const start = new Promise<void>((resolve) => {
            release = resolve;
        });
        const calls = clients.map(async (client) => {
            await start;
            const startedAt = performance.now();
            const result = await client.widget.findMany({
                where: { tenantId },
                cache: { ttlSeconds: 300 },
            });
            return { result, latencyMs: performance.now() - startedAt };
        });
        const eventLoopStart = performance.eventLoopUtilization();
        release();
        const samples = await Promise.all(calls);
        const eventLoopDelta = performance.eventLoopUtilization(eventLoopStart);
        eventLoopActiveMs += eventLoopDelta.active;
        eventLoopIdleMs += eventLoopDelta.idle;
        const expectedResult = canonicalizePrismaValue(samples[0]!.result);
        if (samples.some(({ result }) => canonicalizePrismaValue(result) !== expectedResult)) {
            throw new Error(`Cold-key contention returned unequal results in round ${round + 1}`);
        }

        const databaseQueries = fixture.queryCounters.reduce((total, counter) => total + counter.total, 0);
        databaseQueriesPerRound.push(databaseQueries);
        if (databaseQueries !== 1) {
            throw new Error(`Cold-key contention expected one database query in round ${round + 1}, observed ${databaseQueries}`);
        }

        const latencies = samples.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
        winnerSamples.push(latencies[0]!);
        loserSamples.push(...latencies.slice(1));
    }

    return {
        rounds,
        contenders,
        databaseQueriesPerRound,
        winner: summarizeLatencies(winnerSamples),
        losers: summarizeLatencies(loserSamples),
        eventLoop: summarizeEventLoopDelta({
            active: eventLoopActiveMs,
            idle: eventLoopIdleMs,
        }),
    };
}

function summarizeLatencies(samples: readonly number[]): LatencySummary {
    return {
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
    };
}
