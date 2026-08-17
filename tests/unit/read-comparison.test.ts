import { describe, expect, test } from 'vitest';
import { BenchmarkMetrics } from '../../tests/load/benchmark-metrics';
import type { BenchmarkFixture } from '../../tests/load/benchmark-fixture';
import {
    assertReadComparisonEquivalent,
    buildReadComparisonPlan,
    createReadComparisonDigest,
    runReadOnlyComparison,
    type ReadComparisonOperation,
} from '../../tests/load/read-comparison';
import type { ReadComparisonMode } from '../../tests/load/read-comparison-report';

describe('read-only cache comparison planning', () => {
    test('builds a deterministic plan covering unique and list reads for both models', () => {
        const corpus = {
            tenantIds: ['tenant-0', 'tenant-1'],
            widgets: [
                { id: 'widget-0', tenantId: 'tenant-0', initialName: 'widget-0', workerIndex: 0 },
                { id: 'widget-1', tenantId: 'tenant-1', initialName: 'widget-1', workerIndex: 1 },
            ],
            parts: [
                { id: 'part-0', tenantId: 'tenant-0', label: 'part-0', widgetId: 'widget-0' },
                { id: 'part-1', tenantId: 'tenant-1', label: 'part-1', widgetId: 'widget-1' },
            ],
        };

        const plan = buildReadComparisonPlan(corpus);

        expect(plan).toEqual<ReadComparisonOperation[]>([
            { kind: 'widgetUnique', widgetId: 'widget-0' },
            { kind: 'widgetUnique', widgetId: 'widget-1' },
            { kind: 'partUnique', partId: 'part-0' },
            { kind: 'partUnique', partId: 'part-1' },
            { kind: 'widgetList', tenantId: 'tenant-0' },
            { kind: 'widgetList', tenantId: 'tenant-1' },
            { kind: 'partList', tenantId: 'tenant-0' },
            { kind: 'partList', tenantId: 'tenant-1' },
        ]);
        expect(buildReadComparisonPlan(corpus)).toEqual(plan);
    });

    test('fails when a cold or warm digest differs from the raw digest', () => {
        const rawDigest = createReadComparisonDigest([{ id: 'widget-0', name: 'raw' }]);
        const coldDigest = createReadComparisonDigest([{ id: 'widget-0', name: 'different' }]);

        expect(() => assertReadComparisonEquivalent(rawDigest, coldDigest, 'cold')).toThrow(
            'Read comparison result mismatch in cold phase',
        );
    });

    test('connects every comparison client before the first timed read', async () => {
        const events: string[] = [];
        const metrics = new BenchmarkMetrics();
        const fixture = createFakeComparisonFixture({ clientCount: 2, events, metrics });

        await runReadOnlyComparison(fixture, metrics);

        const connectionIndexes = events.flatMap((event, index) => (event.startsWith('connect:') ? [index] : []));
        const firstReadIndex = events.findIndex((event) => event.startsWith('read:'));
        expect(connectionIndexes).toHaveLength(2);
        expect(firstReadIndex).toBeGreaterThanOrEqual(0);
        expect(Math.max(...connectionIndexes)).toBeLessThan(firstReadIndex);
    });

    test.each(['raw', 'cold', 'warm'] as const)(
        'fails when the %s phase violates its finite-plan cache invariant',
        async (invalidMode) => {
            const metrics = new BenchmarkMetrics();
            const fixture = createFakeComparisonFixture({ invalidMode, metrics });
            const expectedReads = buildReadComparisonPlan(fixture.readCorpus).length;

            await expect(runReadOnlyComparison(fixture, metrics)).rejects.toThrow(
                new RegExp(`Read comparison ${invalidMode} phase invariant failed: expected .*${expectedReads}.*observed`),
            );
        },
    );
});

interface FakeComparisonFixtureOptions {
    clientCount?: number;
    events?: string[];
    invalidMode?: ReadComparisonMode;
    metrics?: BenchmarkMetrics;
}

function createFakeComparisonFixture(options: FakeComparisonFixtureOptions = {}): BenchmarkFixture {
    const clientCount = options.clientCount ?? 1;
    const events = options.events ?? [];
    const metrics = options.metrics ?? new BenchmarkMetrics();
    const corpus = {
        tenantIds: ['tenant-0'],
        widgets: [{ id: 'widget-0', tenantId: 'tenant-0', initialName: 'widget-0', workerIndex: 0 }],
        parts: [{ id: 'part-0', tenantId: 'tenant-0', label: 'part-0', widgetId: 'widget-0' }],
    };
    const planLength = buildReadComparisonPlan(corpus).length;
    let enabledReadCount = 0;
    const queryCounters = Array.from({ length: clientCount }, () => ({
        total: 0,
        byModel: {} as Record<string, number>,
        reset() {
            this.total = 0;
            this.byModel = {};
        },
    }));

    const clients = queryCounters.map((queryCounter, clientIndex) => {
        const read = async (operation: ReadComparisonOperation, args: { cache?: { enabled?: boolean } }): Promise<unknown> => {
            events.push(`read:${clientIndex}`);
            const mode: ReadComparisonMode =
                args.cache?.enabled === false ? 'raw' : enabledReadCount++ < planLength ? 'cold' : 'warm';
            const shouldInvalidate = options.invalidMode === mode;

            if (mode === 'raw') {
                if (shouldInvalidate) {
                    metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findUnique', result: 'miss' });
                }
                queryCounter.total += 1;
            } else if (mode === 'cold') {
                if (shouldInvalidate) {
                    metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findUnique', result: 'hit' });
                } else {
                    metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findUnique', result: 'miss' });
                    queryCounter.total += 1;
                }
            } else if (shouldInvalidate) {
                metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findUnique', result: 'miss' });
                queryCounter.total += 1;
            } else {
                metrics.cacheMetrics.onCacheEvent({ model: 'Widget', operation: 'findUnique', result: 'hit' });
            }

            switch (operation.kind) {
                case 'widgetUnique':
                    return { id: operation.widgetId, tenantId: 'tenant-0', name: 'widget-0' };
                case 'partUnique':
                    return { id: operation.partId, tenantId: 'tenant-0', label: 'part-0', widgetId: 'widget-0' };
                case 'widgetList':
                    return [{ id: 'widget-0', tenantId: operation.tenantId, name: 'widget-0' }];
                case 'partList':
                    return [{ id: 'part-0', tenantId: operation.tenantId, label: 'part-0', widgetId: 'widget-0' }];
            }
        };

        return {
            $connect: async () => {
                events.push(`connect:${clientIndex}`);
            },
            $disconnect: async () => undefined,
            widget: {
                findUnique: (args: { cache?: { enabled?: boolean } }) =>
                    read({ kind: 'widgetUnique', widgetId: 'widget-0' }, args),
                findMany: (args: { cache?: { enabled?: boolean } }) => read({ kind: 'widgetList', tenantId: 'tenant-0' }, args),
            },
            part: {
                findUnique: (args: { cache?: { enabled?: boolean } }) => read({ kind: 'partUnique', partId: 'part-0' }, args),
                findMany: (args: { cache?: { enabled?: boolean } }) => read({ kind: 'partList', tenantId: 'tenant-0' }, args),
            },
        } as unknown as BenchmarkFixture['clients'][number];
    });

    return {
        runId: 'unit',
        keyPrefix: 'prismaCacheTags:benchmark:unit',
        tenantIds: corpus.tenantIds,
        widgetsByWorker: [corpus.widgets],
        readCorpus: corpus,
        coldListProbeCompleted: false,
        clients,
        queryCounters,
        redis: {
            async *scanIterator(): AsyncGenerator<string[]> {
                return;
            },
            unlink: async () => 0,
        } as unknown as BenchmarkFixture['redis'],
        cleanup: async () => undefined,
        disconnect: async () => undefined,
    };
}
