import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestPrismaClient } from '../fixture/client';
import { BenchmarkMetrics } from '../load/benchmark-metrics';
import { createBenchmarkFixture } from '../load/benchmark-fixture';
import { runColdKeyContention } from '../load/contention-benchmark';
import { runColdSharedListQuery, runModelWorkload, warmBenchmarkCache } from '../load/model-workload';
import { runReadOnlyComparison } from '../load/read-comparison';
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
            const overlappingKey = `${fixture.keyPrefix}-other-run:test`;
            await fixture.redis.set(overlappingKey, 'keep');

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
            expect(await fixture.redis.get(overlappingKey)).toBe('keep');
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

    test('cleans partial rows and keys when seeding fails', async () => {
        const runId = `failed-${randomUUID()}`;
        const keyPrefix = `prismaCacheTags:benchmark:${runId}`;
        const tenantIds = [0, 1].map((index) => `benchmark:${runId}:tenant:${index}`);
        const partialKey = `${keyPrefix}:partial`;
        const prisma = createTestPrismaClient();
        let widgetsPerTenantReads = 0;
        const failingProfile: BenchmarkProfile = {
            name: 'quick',
            tenants: 2,
            get widgetsPerTenant() {
                widgetsPerTenantReads += 1;
                if (widgetsPerTenantReads === 4) {
                    throw new Error('forced seed failure');
                }
                return 2;
            },
            partsPerWidget: 1,
            concurrency: 2,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 1,
        };

        await unrelatedRedis.set(partialKey, 'remove');

        try {
            await expect(createBenchmarkFixture(failingProfile, new BenchmarkMetrics(), { runId })).rejects.toThrow(
                'forced seed failure',
            );
            expect(
                await prisma.widget.count({
                    where: { tenantId: { in: tenantIds } },
                }),
            ).toBe(0);
            expect(
                await prisma.part.count({
                    where: { tenantId: { in: tenantIds } },
                }),
            ).toBe(0);
            expect(await unrelatedRedis.get(partialKey)).toBeNull();
            expect(await unrelatedRedis.get(unrelatedKey)).toBe('keep');
        } finally {
            await prisma.$disconnect();
            await unrelatedRedis.del(partialKey);
        }
    });

    test('warms cached reads and runs a fresh concurrent read/write workload', async () => {
        const metrics = new BenchmarkMetrics();
        const workloadProfile: BenchmarkProfile = {
            ...profile,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 0.5,
        };
        const fixture = await createBenchmarkFixture(workloadProfile, metrics, { runId: `workload-${randomUUID()}` });

        try {
            const coldListProbe = await runColdSharedListQuery(fixture);
            expect(coldListProbe.resultCount).toBe(2);
            expect(coldListProbe.databaseQueries).toBe(1);

            await warmBenchmarkCache(fixture, workloadProfile);
            const firstPassHits = metrics.summarize(1).cacheHits;
            const firstPassQueries = fixture.queryCounters.reduce((total, counter) => total + counter.total, 0);
            const firstPassPartQueries = fixture.queryCounters.reduce(
                (total, counter) => total + (counter.byModel.Part ?? 0),
                0,
            );
            expect(firstPassPartQueries).toBeGreaterThan(0);

            await warmBenchmarkCache(fixture, workloadProfile);
            const secondPassHits = metrics.summarize(1).cacheHits;
            const secondPassQueries = fixture.queryCounters.reduce((total, counter) => total + counter.total, 0);

            expect(secondPassHits).toBeGreaterThan(firstPassHits);
            expect(secondPassQueries).toBe(firstPassQueries);

            await runModelWorkload(fixture, workloadProfile, metrics, {
                now: () => 0,
                random: () => 0.25,
                maxOperationsPerWorker: 1,
            });
            await runModelWorkload(fixture, { ...workloadProfile, readRatio: 0 }, metrics, {
                now: () => 0,
                random: () => 0,
                maxOperationsPerWorker: 1,
            });

            const summary = metrics.summarize(1);
            expect(summary.errors).toBe(0);
            expect(summary.freshnessFailures).toBe(0);
            expect(summary.cacheHits).toBeGreaterThan(0);
            expect(summary.databaseQueries).toBeGreaterThan(0);
            expect(summary.reads).toBeGreaterThan(0);
            expect(summary.writes).toBeGreaterThan(0);
        } finally {
            try {
                await fixture.cleanup();
            } finally {
                await fixture.disconnect();
            }
        }
    });

    test('compares raw A, cold, warm, and raw B reads with isolated cache namespace cleanup', async () => {
        const metrics = new BenchmarkMetrics();
        const comparisonProfile: BenchmarkProfile = {
            ...profile,
            widgetsPerTenant: 2,
            partsPerWidget: 1,
        };
        const fixture = await createBenchmarkFixture(comparisonProfile, metrics, { runId: `comparison-${randomUUID()}` });
        const staleKey = `${fixture.keyPrefix}:stale`;

        try {
            await fixture.redis.set(staleKey, 'remove');
            const comparison = await runReadOnlyComparison(fixture, metrics);

            expect(comparison.plan.some((operation) => operation.kind === 'widgetUnique')).toBe(true);
            expect(comparison.plan.some((operation) => operation.kind === 'partUnique')).toBe(true);
            expect(comparison.plan.some((operation) => operation.kind === 'widgetList')).toBe(true);
            expect(comparison.plan.some((operation) => operation.kind === 'partList')).toBe(true);

            const rawA = comparison.phases.rawA;
            const cold = comparison.phases.cold;
            const warm = comparison.phases.warm;
            const rawB = comparison.phases.rawB;
            expect(comparison.warmupReads).toBe(comparison.plan.length);
            expect(rawA.completedReads).toBe(comparison.plan.length);
            expect(cold.completedReads).toBe(comparison.plan.length);
            expect(warm.completedReads).toBe(comparison.plan.length);
            expect(rawB.completedReads).toBe(comparison.plan.length);
            expect(rawA.cacheHits + rawA.cacheMisses).toBe(0);
            expect(rawA.databaseQueries).toBe(comparison.plan.length);
            expect(cold.cacheMisses).toBe(comparison.plan.length);
            expect(cold.cacheHits).toBe(0);
            expect(cold.databaseQueries).toBe(comparison.plan.length);
            expect(warm.cacheHits).toBe(comparison.plan.length);
            expect(warm.cacheMisses).toBe(0);
            expect(warm.databaseQueries).toBe(0);
            expect(rawB.cacheHits + rawB.cacheMisses).toBe(0);
            expect(rawB.databaseQueries).toBe(comparison.plan.length);
            expect(rawA.digest).toBe(cold.digest);
            expect(cold.digest).toBe(warm.digest);
            expect(warm.digest).toBe(rawB.digest);
            expect(comparison.rawDriftPercent).toBeGreaterThanOrEqual(0);
            expect(typeof comparison.stableRawBaseline).toBe('boolean');
            expect(await fixture.redis.get(staleKey)).toBeNull();
            expect(await fixture.redis.get(unrelatedKey)).toBe('keep');
        } finally {
            try {
                await fixture.cleanup();
            } finally {
                await fixture.disconnect();
            }
        }
    });

    test('serves 32 simultaneous cold-key contenders with one database query per round', async () => {
        const contentionProfile: BenchmarkProfile = {
            ...profile,
            tenants: 1,
            widgetsPerTenant: 2,
            partsPerWidget: 0,
            concurrency: 32,
        };
        const fixture = await createBenchmarkFixture(contentionProfile, new BenchmarkMetrics(), {
            runId: `contention-${randomUUID()}`,
        });

        try {
            const result = await runColdKeyContention(fixture, 32);

            expect(result.rounds).toBe(10);
            expect(result.contenders).toBe(32);
            expect(result.databaseQueriesPerRound).toEqual(Array.from({ length: 10 }, () => 1));
            expect(result.winner.p50Ms).toBeGreaterThan(0);
            expect(result.losers.p50Ms).toBeGreaterThan(0);
        } finally {
            try {
                await fixture.cleanup();
            } finally {
                await fixture.disconnect();
            }
        }
    });
});
