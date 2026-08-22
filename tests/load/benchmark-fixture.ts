import { randomUUID } from 'node:crypto';
import { createTestPrismaClient } from '../fixture/client';
import { createCachedClient, createQueryCounter, type QueryCounter } from '../integration/helpers';
import { createTestRedisClient } from '../support/service-preflight';
import type { BenchmarkMetrics } from './benchmark-metrics';
import type { BenchmarkProfile, BenchmarkProfileName } from './profiles';

const SEED_BATCH_SIZE = 100;
const BENCHMARK_KEY_PREFIX = 'prismaCacheTags:benchmark:';
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REDIS_GLOB_METACHARACTERS = /[*?\[\]\\]/;
export const BENCHMARK_MAX_CONNECTIONS_PER_CLIENT = 1;
export const BENCHMARK_WIDGET_DESCRIPTION = 'widget benchmark payload '.repeat(22).slice(0, 512);
export const BENCHMARK_PART_DESCRIPTION = 'part benchmark payload '.repeat(16).slice(0, 256);

export interface BenchmarkPart {
    id: string;
    tenantId: string;
    label: string;
    widgetId: string;
    description?: string;
}

export interface BenchmarkWidget {
    id: string;
    tenantId: string;
    initialName: string;
    workerIndex: number;
    description?: string;
}

export interface BenchmarkReadCorpus {
    tenantIds: string[];
    widgets: BenchmarkWidget[];
    parts: BenchmarkPart[];
}

export interface BenchmarkFixture {
    runId: string;
    keyPrefix: string;
    profileName: BenchmarkProfileName;
    tenantIds: string[];
    widgetsByWorker: BenchmarkWidget[][];
    readCorpus: BenchmarkReadCorpus;
    coldListProbeCompleted: boolean;
    clients: ReturnType<typeof createCachedClient>[];
    queryCounters: QueryCounter[];
    redis: ReturnType<typeof createTestRedisClient>;
    cleanup(): Promise<void>;
    disconnect(): Promise<void>;
}

export function validateBenchmarkKeyPrefix(keyPrefix: string): void {
    if (typeof keyPrefix !== 'string' || keyPrefix.length === 0) {
        throw new Error('keyPrefix must be a non-empty benchmark namespace');
    }

    if (REDIS_GLOB_METACHARACTERS.test(keyPrefix)) {
        throw new Error('keyPrefix must not contain Redis glob metacharacters');
    }

    if (!keyPrefix.startsWith(BENCHMARK_KEY_PREFIX)) {
        throw new Error(`keyPrefix must match ${BENCHMARK_KEY_PREFIX}<safe run id>`);
    }

    const runId = keyPrefix.slice(BENCHMARK_KEY_PREFIX.length);
    if (runId.length === 0 || SAFE_RUN_ID_PATTERN.exec(runId)?.[0] !== runId) {
        throw new Error(`keyPrefix must match ${BENCHMARK_KEY_PREFIX}<safe run id>`);
    }
}

export async function deleteRedisNamespace(redis: ReturnType<typeof createTestRedisClient>, keyPrefix: string): Promise<void> {
    validateBenchmarkKeyPrefix(keyPrefix);

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
    const keyPrefix = `${BENCHMARK_KEY_PREFIX}${runId}`;
    validateBenchmarkKeyPrefix(keyPrefix);
    const tenantIds = Array.from({ length: profile.tenants }, (_, index) => `benchmark:${runId}:tenant:${index}`);
    const redis = createTestRedisClient();
    const clients: ReturnType<typeof createCachedClient>[] = [];
    let seedClient: ReturnType<typeof createTestPrismaClient> | undefined;

    try {
        await redis.connect();
        seedClient = createTestPrismaClient({ maxConnections: BENCHMARK_MAX_CONNECTIONS_PER_CLIENT });
        const seededWidgets = await seedBenchmarkWidgets(seedClient, profile, runId, tenantIds);
        const queryCounters = Array.from({ length: profile.concurrency }, () => createQueryCounter());
        for (const queryCounter of queryCounters) {
            clients.push(
                createCachedClient(redis, queryCounter, {
                    keyPrefix,
                    metrics: metrics.cacheMetrics,
                    defaultTtlSeconds: 300,
                    maxTtlSeconds: 300,
                }, {
                    maxConnections: BENCHMARK_MAX_CONNECTIONS_PER_CLIENT,
                }),
            );
        }
        const widgetsByWorker = Array.from({ length: profile.concurrency }, () => [] as BenchmarkWidget[]);

        for (const [index, widget] of seededWidgets.entries()) {
            const benchmarkWidget = {
                id: widget.id,
                tenantId: widget.tenantId,
                initialName: widget.initialName,
                workerIndex: index % profile.concurrency,
                description: widget.description,
            };
            widgetsByWorker[index % profile.concurrency]!.push({
                ...benchmarkWidget,
            });
        }

        await seedClient.$disconnect();
        seedClient = undefined;
        const readCorpus: BenchmarkReadCorpus = {
            tenantIds,
            widgets: widgetsByWorker.flat(),
            parts: seededWidgets.flatMap((widget) => widget.parts),
        };

        let cleanupPromise: Promise<void> | undefined;
        const cleanup = async (): Promise<void> => {
            if (options.preserve) {
                return;
            }

            cleanupPromise ??= cleanupBenchmarkResources(
                async () => {
                    await clients[0]!.widget.deleteMany({
                        where: { tenantId: { in: tenantIds } },
                    });
                },
                () => deleteRedisNamespace(redis, keyPrefix),
            );
            await cleanupPromise;
        };

        let disconnectPromise: Promise<void> | undefined;
        const disconnect = async (): Promise<void> => {
            disconnectPromise ??= (async () => {
                const results = await Promise.allSettled([
                    ...clients.map((client) => Promise.resolve().then(() => client.$disconnect())),
                    Promise.resolve().then(() => closeRedisClient(redis)),
                ]);
                const failures = results.flatMap((result) => (result.status === 'rejected' ? getFailureReasons(result.reason) : []));
                if (failures.length > 0) {
                    throw new AggregateError(failures, 'Failed to disconnect benchmark fixture resources');
                }
            })();
            await disconnectPromise;
        };

        return {
            runId,
            keyPrefix,
            profileName: profile.name,
            tenantIds,
            widgetsByWorker,
            readCorpus,
            coldListProbeCompleted: false,
            clients,
            queryCounters,
            redis,
            cleanup,
            disconnect,
        };
    } catch (error) {
        const cleanupFailures: unknown[] = [];
        if (!options.preserve) {
            try {
                await cleanupBenchmarkResources(
                    async () => {
                        if (clients[0] !== undefined) {
                            await clients[0].widget.deleteMany({
                                where: { tenantId: { in: tenantIds } },
                            });
                        } else {
                            await seedClient?.widget.deleteMany({
                                where: { tenantId: { in: tenantIds } },
                            });
                        }
                    },
                    async () => {
                        if (redis.isOpen) {
                            await deleteRedisNamespace(redis, keyPrefix);
                        }
                    },
                );
            } catch (cleanupError) {
                cleanupFailures.push(...getFailureReasons(cleanupError));
            }
        }

        const disconnectResults = await Promise.allSettled([
            ...(seedClient ? [Promise.resolve().then(() => seedClient!.$disconnect())] : []),
            ...clients.map((client) => Promise.resolve().then(() => client.$disconnect())),
            Promise.resolve().then(() => closeRedisClient(redis)),
        ]);
        const disconnectFailures = disconnectResults.flatMap((result) =>
            result.status === 'rejected' ? getFailureReasons(result.reason) : [],
        );
        const secondaryFailures = [...cleanupFailures, ...disconnectFailures];
        if (secondaryFailures.length === 0) {
            throw createFixtureFailure(error, { runId, keyPrefix, tenantIds, preserve: options.preserve === true });
        }

        throw new AggregateError(
            [
                error,
                ...secondaryFailures,
                createFixtureFailure(error, { runId, keyPrefix, tenantIds, preserve: options.preserve === true }),
            ],
            'Failed to create benchmark fixture',
        );
    }
}

function createFixtureFailure(
    error: unknown,
    resources: { runId: string; keyPrefix: string; tenantIds: string[]; preserve: boolean },
): Error {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const retentionMessage = resources.preserve
        ? 'Data was retained because --preserve was specified.'
        : 'Automatic cleanup was attempted; retained data may remain if cleanup failed.';

    return new Error(
        [
            originalMessage,
            `Run ID: ${resources.runId}`,
            `Tenant IDs: ${resources.tenantIds.join(', ')}`,
            `Redis key prefix: ${resources.keyPrefix}`,
            retentionMessage,
        ].join('\n'),
        { cause: error },
    );
}

async function cleanupBenchmarkResources(deleteRows: () => Promise<void>, deleteRedis: () => Promise<void>): Promise<void> {
    const failures: unknown[] = [];

    try {
        await deleteRows();
    } catch (error) {
        failures.push(error);
    }

    try {
        await deleteRedis();
    } catch (error) {
        failures.push(error);
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to clean up benchmark fixture resources');
    }
}

function getFailureReasons(error: unknown): unknown[] {
    return error instanceof AggregateError ? error.errors : [error];
}

interface SeededBenchmarkWidget extends Omit<BenchmarkWidget, 'workerIndex'> {
    parts: BenchmarkPart[];
}

async function seedBenchmarkWidgets(
    prisma: ReturnType<typeof createTestPrismaClient>,
    profile: BenchmarkProfile,
    runId: string,
    tenantIds: string[],
): Promise<SeededBenchmarkWidget[]> {
    const widgets: SeededBenchmarkWidget[] = [];

    for (const [tenantIndex, tenantId] of tenantIds.entries()) {
        for (let offset = 0; offset < profile.widgetsPerTenant; offset += SEED_BATCH_SIZE) {
            const batchSize = Math.min(SEED_BATCH_SIZE, profile.widgetsPerTenant - offset);
            const pendingCreates: Array<Promise<{
                id: string;
                tenantId: string;
                name: string;
                description: string;
                parts: BenchmarkPart[];
            }>> = [];
            let preparationFailed = false;
            let preparationFailure: unknown;

            for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
                try {
                    const widgetIndex = offset + batchIndex;
                    const initialName = `benchmark:${runId}:tenant:${tenantIndex}:widget:${widgetIndex}`;
                    const parts = Array.from({ length: profile.partsPerWidget }, (_, partIndex) => ({
                        tenantId,
                        label: `${initialName}:part:${partIndex}`,
                        description: BENCHMARK_PART_DESCRIPTION,
                    }));

                    pendingCreates.push(
                        prisma.widget.create({
                            data: {
                                tenantId,
                                name: initialName,
                                description: BENCHMARK_WIDGET_DESCRIPTION,
                                ...(parts.length > 0 ? { parts: { create: parts } } : {}),
                            },
                            select: {
                                id: true,
                                tenantId: true,
                                name: true,
                                description: true,
                                parts: {
                                    select: {
                                        id: true,
                                        tenantId: true,
                                        label: true,
                                        description: true,
                                        widgetId: true,
                                    },
                                },
                            },
                        }),
                    );
                } catch (error) {
                    preparationFailed = true;
                    preparationFailure = error;
                    break;
                }
            }

            const results = await Promise.allSettled(pendingCreates);
            const failures: unknown[] = preparationFailed ? [preparationFailure] : [];
            const batch: Array<{
                id: string;
                tenantId: string;
                name: string;
                description: string;
                parts: BenchmarkPart[];
            }> = [];

            for (const result of results) {
                if (result.status === 'rejected') {
                    failures.push(result.reason);
                } else {
                    batch.push(result.value);
                }
            }

            if (failures.length > 0) {
                if (failures.length === 1) {
                    throw failures[0];
                }

                throw new AggregateError(failures, 'Failed to seed benchmark widgets');
            }

            for (const widget of batch) {
                widgets.push({
                    id: widget.id,
                    tenantId: widget.tenantId,
                    initialName: widget.name,
                    description: widget.description,
                    parts: widget.parts ?? [],
                });
            }
        }
    }

    return widgets;
}

async function closeRedisClient(redis: ReturnType<typeof createTestRedisClient>): Promise<void> {
    const failures: unknown[] = [];
    let shouldDestroy = !redis.isOpen;

    if (redis.isOpen) {
        try {
            await redis.quit();
        } catch (error) {
            failures.push(error);
            shouldDestroy = true;
        }
    }

    if (shouldDestroy) {
        try {
            redis.destroy();
        } catch (error) {
            failures.push(error);
        }
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close benchmark Redis client');
    }
}
