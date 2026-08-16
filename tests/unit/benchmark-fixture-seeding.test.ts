import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createTestPrismaClient: vi.fn(),
    createTestRedisClient: vi.fn(),
    createCachedClient: vi.fn(),
    createQueryCounter: vi.fn(),
}));

vi.mock('../fixture/client', () => ({ createTestPrismaClient: mocks.createTestPrismaClient }));
vi.mock('../integration/helpers', () => ({
    createCachedClient: mocks.createCachedClient,
    createQueryCounter: mocks.createQueryCounter,
}));
vi.mock('../support/service-preflight', () => ({ createTestRedisClient: mocks.createTestRedisClient }));

import { BENCHMARK_MAX_CONNECTIONS_PER_CLIENT, createBenchmarkFixture } from '../../tests/load/benchmark-fixture';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import { BENCHMARK_PROFILES, type BenchmarkProfile } from '../../tests/load/profiles';

describe('benchmark fixture seeding', () => {
    test('waits for in-flight writes before cleaning up after a seed failure', async () => {
        mocks.createTestPrismaClient.mockReset();
        mocks.createTestRedisClient.mockReset();
        const events: string[] = [];
        let resolveFirstCreate!: (widget: { id: string; tenantId: string; name: string }) => void;
        const firstCreate = new Promise<{ id: string; tenantId: string; name: string }>((resolve) => {
            resolveFirstCreate = (widget) => {
                events.push('create-settled');
                resolve(widget);
            };
        });
        const deleteMany = vi.fn(async () => {
            events.push('cleanup');
            return { count: 1 };
        });
        const prisma = {
            widget: {
                create: vi.fn(() => {
                    events.push('create-started');
                    return firstCreate;
                }),
                deleteMany,
            },
            $disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const redis = {
            isOpen: true,
            connect: vi.fn().mockResolvedValue(undefined),
            scanIterator: vi.fn(async function* () {}),
            unlink: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(),
        };
        mocks.createTestPrismaClient.mockReturnValue(prisma);
        mocks.createTestRedisClient.mockReturnValue(redis);

        let partsPerWidgetReads = 0;
        const profile: BenchmarkProfile = {
            name: 'quick',
            tenants: 1,
            widgetsPerTenant: 2,
            get partsPerWidget() {
                partsPerWidgetReads += 1;
                if (partsPerWidgetReads === 2) {
                    throw new Error('forced in-flight seed failure');
                }
                return 0;
            },
            concurrency: 1,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 1,
        };

        const fixturePromise = createBenchmarkFixture(profile, new BenchmarkMetrics(), { runId: 'in-flight-failure' });

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(events).toEqual(['create-started']);

            resolveFirstCreate({ id: 'widget-1', tenantId: 'benchmark:in-flight-failure:tenant:0', name: 'widget-1' });
            await expect(fixturePromise).rejects.toThrow('forced in-flight seed failure');

            expect(events.indexOf('create-settled')).toBeLessThan(events.indexOf('cleanup'));
        } finally {
            resolveFirstCreate({ id: 'widget-1', tenantId: 'benchmark:in-flight-failure:tenant:0', name: 'widget-1' });
            await fixturePromise.catch(() => undefined);
        }
    });

    test('attempts strict Redis teardown after connection failure', async () => {
        const connectFailure = new Error('connect failure');
        const destroyFailure = new Error('destroy failure');
        const redis = {
            isOpen: false,
            connect: vi.fn().mockRejectedValue(connectFailure),
            quit: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(() => {
                throw destroyFailure;
            }),
        };
        mocks.createTestPrismaClient.mockReset();
        mocks.createTestRedisClient.mockReset().mockReturnValue(redis);

        const profile: BenchmarkProfile = {
            name: 'quick',
            tenants: 1,
            widgetsPerTenant: 1,
            partsPerWidget: 0,
            concurrency: 1,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 1,
        };

        await expect(createBenchmarkFixture(profile, new BenchmarkMetrics(), { runId: 'redis-teardown-failure' })).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof AggregateError &&
                error.errors.includes(connectFailure) &&
                error.errors.includes(destroyFailure),
        );
        expect(redis.destroy).toHaveBeenCalledTimes(1);
        expect(redis.quit).not.toHaveBeenCalled();
    });

    test('preserves partial fixture resources when seeding fails with preserve enabled', async () => {
        mocks.createTestPrismaClient.mockReset();
        mocks.createCachedClient.mockReset();
        mocks.createTestRedisClient.mockReset();

        const deleteMany = vi.fn();
        const prisma = {
            widget: {
                create: vi.fn(),
                deleteMany,
            },
            $disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const redis = {
            isOpen: true,
            connect: vi.fn().mockResolvedValue(undefined),
            scanIterator: vi.fn(async function* () {
                yield ['prismaCacheTags:benchmark:preserved-partial:retained'];
            }),
            unlink: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(),
        };
        mocks.createTestPrismaClient.mockReturnValue(prisma);
        mocks.createTestRedisClient.mockReturnValue(redis);

        const profile: BenchmarkProfile = {
            name: 'quick',
            tenants: 2,
            get widgetsPerTenant(): number {
                throw new Error('forced preserve seed failure');
            },
            partsPerWidget: 1,
            concurrency: 2,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 1,
        };

        await expect(
            createBenchmarkFixture(profile, new BenchmarkMetrics(), {
                runId: 'preserved-partial',
                preserve: true,
            }),
        ).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof Error &&
                error.message.includes('forced preserve seed failure') &&
                error.message.includes('Run ID: preserved-partial') &&
                error.message.includes('Tenant IDs: benchmark:preserved-partial:tenant:0, benchmark:preserved-partial:tenant:1') &&
                error.message.includes('Redis key prefix: prismaCacheTags:benchmark:preserved-partial') &&
                error.message.includes('retained because --preserve'),
        );
        expect(deleteMany).not.toHaveBeenCalled();
        expect(redis.scanIterator).not.toHaveBeenCalled();
        expect(redis.unlink).not.toHaveBeenCalled();
        expect(redis.quit).toHaveBeenCalledTimes(1);
    });

    test('aggregates direct Prisma and Redis disconnect failures', async () => {
        mocks.createTestPrismaClient.mockReset();
        mocks.createCachedClient.mockReset();
        mocks.createTestRedisClient.mockReset();

        const prisma = {
            widget: {
                create: vi.fn().mockResolvedValue({
                    id: 'widget-1',
                    tenantId: 'benchmark:disconnect-failure:tenant:0',
                    name: 'widget-1',
                    parts: [],
                }),
                deleteMany: vi.fn(),
            },
            $disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const clientDisconnectFailure = new Error('client disconnect failure');
        const cachedClient = {
            $disconnect: vi.fn().mockRejectedValue(clientDisconnectFailure),
        };
        const redisDisconnectFailure = new Error('redis disconnect failure');
        const redis = {
            isOpen: true,
            connect: vi.fn().mockResolvedValue(undefined),
            scanIterator: vi.fn(async function* () {}),
            unlink: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockRejectedValue(redisDisconnectFailure),
            destroy: vi.fn(),
        };
        mocks.createTestPrismaClient.mockReturnValue(prisma);
        mocks.createCachedClient.mockReturnValue(cachedClient);
        mocks.createTestRedisClient.mockReturnValue(redis);

        const profile: BenchmarkProfile = {
            name: 'quick',
            tenants: 1,
            widgetsPerTenant: 1,
            partsPerWidget: 0,
            concurrency: 1,
            warmupMs: 0,
            durationMs: 1,
            readRatio: 1,
        };

        const fixture = await createBenchmarkFixture(profile, new BenchmarkMetrics(), {
            runId: 'disconnect-failure',
        });

        await expect(fixture.disconnect()).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof AggregateError &&
                error.errors.includes(clientDisconnectFailure) &&
                error.errors.includes(redisDisconnectFailure),
        );
        expect(mocks.createTestPrismaClient).toHaveBeenCalledWith({ maxConnections: 1 });
        expect(mocks.createCachedClient).toHaveBeenCalledWith(
            redis,
            undefined,
            expect.objectContaining({
                keyPrefix: 'prismaCacheTags:benchmark:disconnect-failure',
            }),
            { maxConnections: 1 },
        );
        expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
        expect(cachedClient.$disconnect).toHaveBeenCalledTimes(1);
        expect(redis.quit).toHaveBeenCalledTimes(1);
        expect(redis.destroy).toHaveBeenCalledTimes(1);
    });

    test('constructs the stress client set within its one-connection budget', async () => {
        mocks.createTestPrismaClient.mockReset();
        mocks.createCachedClient.mockReset();
        mocks.createTestRedisClient.mockReset();

        const prisma = {
            widget: {
                create: vi.fn().mockResolvedValue({
                    id: 'widget-1',
                    tenantId: 'benchmark:stress-budget:tenant:0',
                    name: 'widget-1',
                    parts: [],
                }),
                deleteMany: vi.fn(),
            },
            $disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const clients = Array.from({ length: BENCHMARK_PROFILES.stress.concurrency }, () => ({
            widget: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
            $disconnect: vi.fn().mockResolvedValue(undefined),
        }));
        const redis = {
            isOpen: true,
            connect: vi.fn().mockResolvedValue(undefined),
            scanIterator: vi.fn(async function* () {}),
            unlink: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(),
        };
        mocks.createTestPrismaClient.mockReturnValue(prisma);
        mocks.createCachedClient.mockImplementation(() => clients.shift());
        mocks.createTestRedisClient.mockReturnValue(redis);

        const profile: BenchmarkProfile = {
            ...BENCHMARK_PROFILES.stress,
            tenants: 1,
            widgetsPerTenant: 1,
            partsPerWidget: 0,
        };
        const fixture = await createBenchmarkFixture(profile, new BenchmarkMetrics(), {
            runId: 'stress-budget',
        });

        try {
            expect(mocks.createTestPrismaClient).toHaveBeenCalledWith({
                maxConnections: BENCHMARK_MAX_CONNECTIONS_PER_CLIENT,
            });
            expect(mocks.createCachedClient).toHaveBeenCalledTimes(BENCHMARK_PROFILES.stress.concurrency);
            expect(
                mocks.createCachedClient.mock.calls.every(
                    (call) => call[3]?.maxConnections === BENCHMARK_MAX_CONNECTIONS_PER_CLIENT,
                ),
            ).toBe(true);
            expect(profile.concurrency * BENCHMARK_MAX_CONNECTIONS_PER_CLIENT).toBeLessThanOrEqual(profile.concurrency);
        } finally {
            await fixture.cleanup();
            await fixture.disconnect();
        }
    });
});
