import { describe, expect, test, vi } from 'vitest';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import { runModelWorkload } from '../../tests/load/model-workload';
import type { BenchmarkFixture } from '../../tests/load/benchmark-fixture';
import type { BenchmarkProfile } from '../../tests/load/profiles';

function createClient(states: Map<string, { name: string }>) {
    return {
        widget: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
                const state = states.get(where.id)!;
                return {
                    id: where.id,
                    tenantId: 'tenant-0',
                    name: state.name,
                };
            }),
            findMany: vi.fn(async () => [
                {
                    id: 'widget-0',
                    tenantId: 'tenant-0',
                    name: states.get('widget-0')!.name,
                },
            ]),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
                const state = states.get(where.id)!;
                state.name = data.name;
                return {
                    id: where.id,
                    tenantId: 'tenant-0',
                    name: state.name,
                };
            }),
        },
        part: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
                id: where.id,
                tenantId: 'tenant-0',
                label: 'part-0',
                widgetId: 'widget-0',
            })),
            findMany: vi.fn(async () => [
                {
                    id: 'part-0',
                    tenantId: 'tenant-0',
                    label: 'part-0',
                    widgetId: 'widget-0',
                },
            ]),
        },
    };
}

function createFixture(
    clients: ReturnType<typeof createClient>[],
): BenchmarkFixture {
    const widget = { id: 'widget-0', tenantId: 'tenant-0', initialName: 'initial', workerIndex: 0 };
    const secondWidget = { id: 'widget-1', tenantId: 'tenant-0', initialName: 'initial-1', workerIndex: 1 };
    const part = { id: 'part-0', tenantId: 'tenant-0', label: 'part-0', widgetId: 'widget-0' };

    return {
        runId: 'model-workload-unit',
        keyPrefix: 'prismaCacheTags:benchmark:model-workload-unit',
        tenantIds: ['tenant-0'],
        widgetsByWorker: [[widget], [secondWidget]],
        coldListProbeCompleted: true,
        readCorpus: {
            tenantIds: ['tenant-0'],
            widgets: [widget, secondWidget],
            parts: [part],
        },
        clients: clients as unknown as BenchmarkFixture['clients'],
        queryCounters: [
            { total: 0, byModel: {}, reset: vi.fn() },
            { total: 0, byModel: {}, reset: vi.fn() },
        ],
        redis: {} as BenchmarkFixture['redis'],
        cleanup: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
    };
}

const baseProfile: BenchmarkProfile = {
    name: 'quick',
    tenants: 1,
    widgetsPerTenant: 2,
    partsPerWidget: 1,
    concurrency: 2,
    warmupMs: 0,
    durationMs: 1,
    readRatio: 1,
};

describe('model-backed workload', () => {
    test('uses the shared read corpus for cached Part and list reads', async () => {
        const states = new Map([
            ['widget-0', { name: 'initial' }],
            ['widget-1', { name: 'initial-1' }],
        ]);
        const clients = [createClient(states), createClient(states)];
        const fixture = createFixture(clients);
        const randomValues = [0, 0.25, 0, 0, 0.75, 0];
        let randomIndex = 0;

        await runModelWorkload(fixture, baseProfile, new BenchmarkMetrics(), {
            now: () => 0,
            random: () => randomValues[randomIndex++] ?? 0,
            maxOperationsPerWorker: 1,
        });

        expect(clients[1]!.part.findUnique).toHaveBeenCalledTimes(1);
        expect(clients[0]!.part.findMany).toHaveBeenCalledTimes(1);
    });

    test('reads every widget write back through a different client', async () => {
        const states = new Map([
            ['widget-0', { name: 'initial' }],
            ['widget-1', { name: 'initial-1' }],
        ]);
        const clients = [createClient(states), createClient(states)];
        const fixture = createFixture(clients);
        const writeProfile = { ...baseProfile, readRatio: 0 };

        await runModelWorkload(fixture, writeProfile, new BenchmarkMetrics(), {
            now: () => 0,
            random: () => 0,
            maxOperationsPerWorker: 1,
        });

        expect(clients[0]!.widget.update).toHaveBeenCalledTimes(1);
        expect(clients[1]!.widget.update).toHaveBeenCalledTimes(1);
        expect(clients[0]!.widget.findUnique).toHaveBeenCalledTimes(1);
        expect(clients[1]!.widget.findUnique).toHaveBeenCalledTimes(1);
    });

    test('routes measured widget list reads through the shared corpus', async () => {
        const states = new Map([
            ['widget-0', { name: 'initial' }],
            ['widget-1', { name: 'initial-1' }],
        ]);
        const clients = [createClient(states), createClient(states)];
        const fixture = createFixture(clients);
        const randomValues = [0, 0.5, 0, 0, 0.5, 0];
        let randomIndex = 0;

        await runModelWorkload(fixture, baseProfile, new BenchmarkMetrics(), {
            now: () => 0,
            random: () => randomValues[randomIndex++] ?? 0,
            maxOperationsPerWorker: 1,
        });

        expect(clients[1]!.widget.findMany).toHaveBeenCalledTimes(1);
        expect(clients[0]!.widget.findMany).toHaveBeenCalledTimes(1);
    });
});
