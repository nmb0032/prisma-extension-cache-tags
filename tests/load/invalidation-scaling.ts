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

const REDIS_URL = TEST_REDIS_URL;
const KEYSPACE_SIZES = [1_000, 10_000, 100_000];
const INVALIDATIONS_PER_SIZE = 200;
type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

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

async function getInvalidationCalls(client: RedisClient, command: 'evalsha' | 'incrby'): Promise<number> {
    const info = await client.sendCommand(['INFO', 'commandstats']);
    return parseCommandCalls(String(info), command);
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

        const config = normalizeConfig({ tenantKeys: ['tenantId'] });
        const adapter = createNodeRedisAdapter(client);
        const invalidationCommand = adapter.optimized ? 'evalsha' : 'incrby';
        const results: Array<{ keyspace: number; p50: number; p99: number }> = [];
        const incrementCalls: number[] = [];

        for (const size of KEYSPACE_SIZES) {
            await client.flushDb();
            await seedKeyspace(client, size);

            const callsBefore = await getInvalidationCalls(client, invalidationCommand);
            const durations: number[] = [];
            for (let index = 0; index < INVALIDATIONS_PER_SIZE; index += 1) {
                const startedAt = process.hrtime.bigint();
                await bumpTagVersions([`tenant:t${index}:model:Widget`], config, adapter);
                durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
            }

            const callsAfter = await getInvalidationCalls(client, invalidationCommand);
            incrementCalls.push(callsAfter - callsBefore);

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

        console.log(`Observed Redis ${invalidationCommand.toUpperCase()} calls per keyspace: ${incrementCalls.join(', ')}.`);
        if (incrementCalls.some((calls) => calls !== INVALIDATIONS_PER_SIZE)) {
            throw new Error(
                `FAIL: expected exactly ${INVALIDATIONS_PER_SIZE} Redis ${invalidationCommand.toUpperCase()} calls per keyspace, observed ${incrementCalls.join(', ')}.`,
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
