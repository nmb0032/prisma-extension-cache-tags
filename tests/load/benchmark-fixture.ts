import { randomUUID } from 'node:crypto';
import { createTestPrismaClient } from '../fixture/client';
import { createCachedClient, createQueryCounter, type QueryCounter } from '../integration/helpers';
import { closeTestRedisClient, createTestRedisClient } from '../support/service-preflight';
import type { BenchmarkMetrics } from './benchmark-metrics';
import type { BenchmarkProfile } from './profiles';

const SEED_BATCH_SIZE = 100;

export interface BenchmarkWidget {
    id: string;
    tenantId: string;
    initialName: string;
    workerIndex: number;
}

export interface BenchmarkFixture {
    runId: string;
    keyPrefix: string;
    tenantIds: string[];
    widgetsByWorker: BenchmarkWidget[][];
    clients: ReturnType<typeof createCachedClient>[];
    queryCounters: QueryCounter[];
    redis: ReturnType<typeof createTestRedisClient>;
    cleanup(): Promise<void>;
    disconnect(): Promise<void>;
}

export async function deleteRedisNamespace(redis: ReturnType<typeof createTestRedisClient>, keyPrefix: string): Promise<void> {
    if (keyPrefix.length === 0 || !keyPrefix.includes(':benchmark:')) {
        throw new Error('keyPrefix must be a non-empty benchmark namespace');
    }

    let keys: string[] = [];
    for await (const page of redis.scanIterator({ MATCH: `${keyPrefix}:*`, COUNT: 100 })) {
        for (const key of page) {
            keys.push(key);
            if (keys.length === 100) {
                await redis.unlink(keys);
                keys = [];
            }
        }
    }

    if (keys.length > 0) {
        await redis.unlink(keys);
    }
}

export async function createBenchmarkFixture(
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    options: { preserve?: boolean; runId?: string } = {},
): Promise<BenchmarkFixture> {
    if (profile.concurrency < 1 || !Number.isInteger(profile.concurrency)) {
        throw new Error('Benchmark profile concurrency must be a positive integer');
    }

    const runId = options.runId ?? randomUUID();
    const keyPrefix = `prismaCacheTags:benchmark:${runId}`;
    const tenantIds = Array.from({ length: profile.tenants }, (_, index) => `benchmark:${runId}:tenant:${index}`);
    const redis = createTestRedisClient();
    let seedClient: ReturnType<typeof createTestPrismaClient> | undefined;

    try {
        await redis.connect();
        seedClient = createTestPrismaClient();
        const seededWidgets = await seedBenchmarkWidgets(seedClient, profile, runId, tenantIds);
        const queryCounters = Array.from({ length: profile.concurrency }, () => createQueryCounter());
        const clients = queryCounters.map((queryCounter) =>
            createCachedClient(redis, queryCounter, {
                keyPrefix,
                metrics: metrics.cacheMetrics,
                defaultTtlSeconds: 300,
                maxTtlSeconds: 300,
            }),
        );
        const widgetsByWorker = Array.from({ length: profile.concurrency }, () => [] as BenchmarkWidget[]);

        for (const [index, widget] of seededWidgets.entries()) {
            widgetsByWorker[index % profile.concurrency]!.push({
                ...widget,
                workerIndex: index % profile.concurrency,
            });
        }

        await seedClient.$disconnect();
        seedClient = undefined;

        let cleanupPromise: Promise<void> | undefined;
        const cleanup = async (): Promise<void> => {
            if (options.preserve) {
                return;
            }

            cleanupPromise ??= (async () => {
                await clients[0]!.widget.deleteMany({
                    where: { tenantId: { in: tenantIds } },
                });
                await deleteRedisNamespace(redis, keyPrefix);
            })();
            await cleanupPromise;
        };

        let disconnectPromise: Promise<void> | undefined;
        const disconnect = async (): Promise<void> => {
            disconnectPromise ??= (async () => {
                const results = await Promise.allSettled([
                    ...clients.map((client) => Promise.resolve().then(() => client.$disconnect())),
                    Promise.resolve().then(() => closeRedisClient(redis)),
                ]);
                const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
                if (failures.length > 0) {
                    throw new AggregateError(failures, 'Failed to disconnect benchmark fixture resources');
                }
            })();
            await disconnectPromise;
        };

        return {
            runId,
            keyPrefix,
            tenantIds,
            widgetsByWorker,
            clients,
            queryCounters,
            redis,
            cleanup,
            disconnect,
        };
    } catch (error) {
        await Promise.allSettled([seedClient?.$disconnect(), closeTestRedisClient(redis)]);
        throw error;
    }
}

async function seedBenchmarkWidgets(
    prisma: ReturnType<typeof createTestPrismaClient>,
    profile: BenchmarkProfile,
    runId: string,
    tenantIds: string[],
): Promise<Array<Omit<BenchmarkWidget, 'workerIndex'>>> {
    const widgets: Array<Omit<BenchmarkWidget, 'workerIndex'>> = [];

    for (const [tenantIndex, tenantId] of tenantIds.entries()) {
        for (let offset = 0; offset < profile.widgetsPerTenant; offset += SEED_BATCH_SIZE) {
            const batchSize = Math.min(SEED_BATCH_SIZE, profile.widgetsPerTenant - offset);
            const batch = await Promise.all(
                Array.from({ length: batchSize }, (_, batchIndex) => {
                    const widgetIndex = offset + batchIndex;
                    const initialName = `benchmark:${runId}:tenant:${tenantIndex}:widget:${widgetIndex}`;
                    const parts = Array.from({ length: profile.partsPerWidget }, (_, partIndex) => ({
                        tenantId,
                        label: `${initialName}:part:${partIndex}`,
                    }));

                    return prisma.widget.create({
                        data: {
                            tenantId,
                            name: initialName,
                            ...(parts.length > 0 ? { parts: { create: parts } } : {}),
                        },
                        select: {
                            id: true,
                            tenantId: true,
                            name: true,
                        },
                    });
                }),
            );

            for (const widget of batch) {
                widgets.push({
                    id: widget.id,
                    tenantId: widget.tenantId,
                    initialName: widget.name,
                });
            }
        }
    }

    return widgets;
}

async function closeRedisClient(redis: ReturnType<typeof createTestRedisClient>): Promise<void> {
    if (redis.isOpen) {
        await redis.quit();
    }
}
