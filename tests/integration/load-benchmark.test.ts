import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BenchmarkMetrics } from '../load/benchmark-metrics';
import { createBenchmarkFixture } from '../load/benchmark-fixture';
import type { BenchmarkProfile } from '../load/profiles';
import { closeTestRedisClient, createTestRedisClient } from '../support/service-preflight';

const unrelatedRedis = createTestRedisClient();
const unrelatedKey = `prismaCacheTags:unrelated:${randomUUID()}`;
const profile: BenchmarkProfile = {
    name: 'quick',
    tenants: 2,
    widgetsPerTenant: 2,
    partsPerWidget: 1,
    concurrency: 2,
    warmupMs: 0,
    durationMs: 1,
    readRatio: 1,
};

beforeAll(async () => {
    await unrelatedRedis.connect();
    await unrelatedRedis.set(unrelatedKey, 'keep');
});

afterAll(async () => {
    await closeTestRedisClient(unrelatedRedis);
});

describe('isolated model-backed benchmark fixture', () => {
    test('cleans benchmark rows and keys without touching unrelated Redis keys', async () => {
        const metrics = new BenchmarkMetrics();
        const fixture = await createBenchmarkFixture(profile, metrics, { runId: `cleanup-${randomUUID()}` });
        let cleaned = false;

        try {
            expect(fixture.widgetsByWorker.flat()).toHaveLength(4);
            expect(
                await fixture.clients[0]!.part.count({
                    where: { tenantId: { in: fixture.tenantIds } },
                }),
            ).toBe(4);

            await fixture.redis.set(`${fixture.keyPrefix}:test`, 'remove');
            expect(await fixture.redis.get(`${fixture.keyPrefix}:test`)).toBe('remove');

            await fixture.cleanup();
            cleaned = true;
            await fixture.cleanup();

            expect(
                await fixture.clients[0]!.part.count({
                    where: { tenantId: { in: fixture.tenantIds } },
                }),
            ).toBe(0);
            expect(
                await fixture.clients[0]!.widget.count({
                    where: { tenantId: { in: fixture.tenantIds } },
                }),
            ).toBe(0);

            const benchmarkKeys: string[] = [];
            for await (const page of fixture.redis.scanIterator({ MATCH: `${fixture.keyPrefix}:*`, COUNT: 100 })) {
                benchmarkKeys.push(...page);
            }

            expect(benchmarkKeys).toEqual([]);
            expect(await unrelatedRedis.get(unrelatedKey)).toBe('keep');
        } finally {
            try {
                if (!cleaned) {
                    await fixture.cleanup();
                }
            } finally {
                await fixture.disconnect();
            }
        }
    });
});
