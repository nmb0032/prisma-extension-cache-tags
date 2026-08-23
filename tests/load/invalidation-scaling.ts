import { createClient } from 'redis';
import { createNodeRedisAdapter } from '../../src/adapters/node-redis';
import { normalizeConfig } from '../../src/extension';
import { bumpTagVersions } from '../../src/invalidation';
import {
    closeTestRedisClient,
    createTestRedisClient,
    formatServiceUnavailable,
    logError,
    TEST_REDIS_URL,
} from '../support/service-preflight';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

const REDIS_URL = TEST_REDIS_URL;
const KEYSPACE_SIZES = [1_000, 10_000, 100_000];
const INVALIDATIONS_PER_SIZE = 200;
type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;
type InvalidationCommand = 'evalsha' | 'incr' | 'incrby';

async function seedKeyspace(client: RedisClient, count: number): Promise<void> {
    const batchSize = 1_000;
    for (let start = 0; start < count; start += batchSize) {
        const pipeline = client.multi();
        for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
            pipeline.set(`prismaCacheTags:v2:qry:Widget:findMany:${index}`, '"cached"');
        }
        await pipeline.exec();
    }
}

function percentile(sorted: number[], p: number): number {
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
}

function parseCommandCalls(info: string, command: string): number {
    const line = info.split('\n').find((entry) => entry.startsWith(`cmdstat_${command}:`));
    const calls = line?.match(/calls=(\d+)/)?.[1];
    return Number(calls ?? 0);
}

async function getInvalidationCalls(
    client: RedisClient,
    commands: readonly InvalidationCommand[],
): Promise<Record<InvalidationCommand, number>> {
    const info = await client.sendCommand(['INFO', 'commandstats']);
    const text = String(info);
    return Object.fromEntries(commands.map((command) => [command, parseCommandCalls(text, command)])) as Record<
        InvalidationCommand,
        number
    >;
}

async function main(): Promise<void> {
    const client = createTestRedisClient(REDIS_URL);
    let connected = false;

    try {
        try {
            await client.connect();
            await client.ping();
        } catch (error) {
            console.error(formatServiceUnavailable('Redis', REDIS_URL, 'TEST_REDIS_URL'));
            throw error;
        }
        connected = true;

        const config = normalizeConfig({ schema: cacheSchema, models: cacheModels });
        const adapter = createNodeRedisAdapter(client);
        const results: Array<{ keyspace: number; p50: number; p99: number }> = [];
        const logicalIncrementCalls: number[] = [];
        const optimizedIncrementCalls: number[] = [];
        const fallbackIncrementCalls: number[] = [];

        for (const size of KEYSPACE_SIZES) {
            await client.flushDb();
            await seedKeyspace(client, size);

            const callsBefore = await getInvalidationCalls(client, ['evalsha', 'incr', 'incrby']);
            const durations: number[] = [];
            for (let index = 0; index < INVALIDATIONS_PER_SIZE; index += 1) {
                const startedAt = process.hrtime.bigint();
                await bumpTagVersions([`tenant:t${index}:model:Widget`], config, adapter);
                durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
            }

            const callsAfter = await getInvalidationCalls(client, ['evalsha', 'incr', 'incrby']);
            const incrCalls = callsAfter.incr - callsBefore.incr;
            const incrbyCalls = callsAfter.incrby - callsBefore.incrby;
            logicalIncrementCalls.push(incrCalls + incrbyCalls);
            optimizedIncrementCalls.push(incrCalls);
            fallbackIncrementCalls.push(incrbyCalls);

            durations.sort((a, b) => a - b);
            results.push({ keyspace: size, p50: percentile(durations, 50), p99: percentile(durations, 99) });
        }

        console.table(
            results.map((row) => ({
                'cached keys': row.keyspace.toLocaleString(),
                'invalidate p50 (ms)': row.p50.toFixed(3),
                'invalidate p99 (ms)': row.p99.toFixed(3),
            })),
        );

        console.log(
            `Observed Redis logical increment calls per keyspace (INCR + INCRBY): ${logicalIncrementCalls.join(', ')}.`,
        );
        console.log(
            `Observed nested Redis INCR calls per keyspace: ${optimizedIncrementCalls.join(', ')}; ` +
                `fallback INCRBY calls: ${fallbackIncrementCalls.join(', ')}.`,
        );
        if (logicalIncrementCalls.some((calls) => calls !== INVALIDATIONS_PER_SIZE)) {
            throw new Error(
                `FAIL: expected exactly ${INVALIDATIONS_PER_SIZE} logical Redis INCR/INCRBY calls per keyspace, ` +
                    `observed ${logicalIncrementCalls.join(', ')}.`,
            );
        }

        const smallest = results[0]!;
        const largest = results[results.length - 1]!;
        const growth = largest.p50 / Math.max(smallest.p50, 0.0001);

        console.log(`\nKeyspace grew ${largest.keyspace / smallest.keyspace}x; p50 invalidation latency grew ${growth.toFixed(2)}x.`);

        // Invalidation is a single INCR; latency must not track keyspace size.
        if (growth > 2) {
            console.error('FAIL: invalidation latency scales with keyspace size. The generational-key property is broken.');
            process.exitCode = 1;
            return;
        }

        console.log('PASS: invalidation cost is independent of keyspace size.');
    } finally {
        if (connected) {
            try {
                await client.flushDb();
            } finally {
                await client.quit();
            }
        } else {
            await closeTestRedisClient(client);
        }
    }
}

void main().catch((error: unknown) => {
    logError(error);
    process.exitCode = 1;
});
