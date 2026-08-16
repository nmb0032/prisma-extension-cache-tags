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

import { createBenchmarkFixture } from '../../tests/load/benchmark-fixture';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import type { BenchmarkProfile } from '../../tests/load/profiles';

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
});
