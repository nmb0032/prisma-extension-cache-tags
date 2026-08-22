import { performance } from 'node:perf_hooks';
import { percentile, operationsPerSecond } from './statistics';

export type QueryKind =
    | 'widgetUnique'
    | 'partUnique'
    | 'widgetList'
    | 'partList'
    | 'widgetAggregate';

export const QUERY_KINDS: readonly QueryKind[] = [
    'widgetUnique',
    'partUnique',
    'widgetList',
    'partList',
    'widgetAggregate',
];

export interface QueryKindSummary {
    kind: QueryKind;
    completed: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    operationsPerSecond: number;
}

export interface EventLoopSummary {
    utilization: number;
    activeMs: number;
    idleMs: number;
}

export interface EventLoopSnapshot {
    active: number;
    idle: number;
}

export type RedisCommandName = 'get' | 'mget' | 'set' | 'eval' | 'evalsha' | 'incrby' | 'expire';
export type RedisCommandCounts = Record<RedisCommandName, number>;
export interface RedisCommandstatsClient {
    sendCommand(command: string[]): Promise<unknown>;
}

export interface RedisCommandMeasurement {
    before: RedisCommandCounts;
    after: RedisCommandCounts;
    delta: RedisCommandCounts;
}

export interface RedisCommandPhaseMeasurement extends RedisCommandMeasurement {
    eventLoop: EventLoopSummary;
}

const REDIS_COMMANDS: readonly RedisCommandName[] = [
    'get',
    'mget',
    'set',
    'eval',
    'evalsha',
    'incrby',
    'expire',
];

export class QueryKindMetrics {
    private readonly samples = new Map<QueryKind, number[]>();

    constructor() {
        this.reset();
    }

    record(kind: QueryKind, durationMs: number): void {
        if (!Number.isFinite(durationMs) || durationMs < 0) {
            throw new Error('durationMs must be non-negative');
        }

        const samples = this.samples.get(kind);
        if (samples === undefined) {
            throw new Error(`Unknown query kind: ${kind}`);
        }
        samples.push(durationMs);
    }

    reset(): void {
        this.samples.clear();
        for (const kind of QUERY_KINDS) {
            this.samples.set(kind, []);
        }
    }

    summarize(elapsedMs: number): QueryKindSummary[] {
        if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
            throw new Error('elapsedMs must be greater than 0');
        }

        return QUERY_KINDS.map((kind) => {
            const samples = this.samples.get(kind)!;
            return {
                kind,
                completed: samples.length,
                p50Ms: percentile(samples, 0.5),
                p95Ms: percentile(samples, 0.95),
                p99Ms: percentile(samples, 0.99),
                operationsPerSecond: operationsPerSecond(samples.length, elapsedMs),
            };
        });
    }
}

export function calculateEventLoopSummary(
    start: EventLoopSnapshot,
    end: EventLoopSnapshot,
): EventLoopSummary {
    return summarizeEventLoopDelta({
        active: end.active - start.active,
        idle: end.idle - start.idle,
    });
}

export function summarizeEventLoopDelta(delta: EventLoopSnapshot): EventLoopSummary {
    if (!Number.isFinite(delta.active) || !Number.isFinite(delta.idle) || delta.active < 0 || delta.idle < 0) {
        throw new Error('event-loop active and idle times must be non-negative');
    }

    const totalMs = delta.active + delta.idle;
    return {
        utilization: totalMs === 0 ? 0 : delta.active / totalMs,
        activeMs: delta.active,
        idleMs: delta.idle,
    };
}

export function createEmptyRedisCommandstats(): RedisCommandCounts {
    return Object.fromEntries(REDIS_COMMANDS.map((command) => [command, 0])) as RedisCommandCounts;
}

export function parseRedisCommandstats(info: string): RedisCommandCounts {
    const counts = createEmptyRedisCommandstats();

    for (const line of info.split(/\r?\n/)) {
        const match = /^cmdstat_(get|mget|set|eval|evalsha|incrby|expire):(.+)$/.exec(line.trim());
        if (!match) {
            continue;
        }

        const command = match[1] as RedisCommandName;
        const calls = /(?:^|,)calls=(\d+)(?:,|$)/.exec(match[2] ?? '');
        if (calls !== null) {
            counts[command] = Number(calls[1]);
        }
    }

    return counts;
}

export function diffRedisCommandstats(
    before: RedisCommandCounts,
    after: RedisCommandCounts,
): RedisCommandCounts {
    return Object.fromEntries(
        REDIS_COMMANDS.map((command) => [command, after[command] - before[command]]),
    ) as RedisCommandCounts;
}

export async function captureRedisCommandstats(
    client: RedisCommandstatsClient,
): Promise<RedisCommandCounts> {
    const info = await client.sendCommand(['INFO', 'commandstats']);
    return parseRedisCommandstats(String(info));
}

export async function measureRedisCommandstats(
    client: RedisCommandstatsClient,
    operation: () => Promise<void>,
): Promise<RedisCommandMeasurement> {
    const before = await captureRedisCommandstats(client);
    await operation();
    const after = await captureRedisCommandstats(client);
    return { before, after, delta: diffRedisCommandstats(before, after) };
}

export async function measureRedisCommandPhase(
    client: RedisCommandstatsClient,
    operation: () => Promise<void>,
): Promise<RedisCommandPhaseMeasurement> {
    const eventLoopStart = performance.eventLoopUtilization();
    const before = await captureRedisCommandstats(client);
    await operation();
    const after = await captureRedisCommandstats(client);
    const eventLoopDelta = performance.eventLoopUtilization(eventLoopStart);
    return {
        before,
        after,
        delta: diffRedisCommandstats(before, after),
        eventLoop: summarizeEventLoopDelta({
            active: eventLoopDelta.active,
            idle: eventLoopDelta.idle,
        }),
    };
}
