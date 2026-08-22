import { performance } from 'node:perf_hooks';
import { describe, expect, test, vi } from 'vitest';
import {
    calculateEventLoopSummary,
    diffRedisCommandstats,
    measureRedisCommandPhase,
    measureRedisCommandstats,
    parseRedisCommandstats,
    QueryKindMetrics,
} from '../../tests/load/query-kind-metrics';

describe('query-kind metrics', () => {
    test('keeps latency and throughput summaries independent for every query kind', () => {
        const metrics = new QueryKindMetrics();

        metrics.record('widgetUnique', 10);
        metrics.record('widgetUnique', 50);
        metrics.record('partUnique', 20);
        metrics.record('widgetAggregate', 5);

        expect(metrics.summarize(1_000)).toEqual([
            {
                kind: 'widgetUnique',
                completed: 2,
                p50Ms: 10,
                p95Ms: 50,
                p99Ms: 50,
                operationsPerSecond: 2,
            },
            {
                kind: 'partUnique',
                completed: 1,
                p50Ms: 20,
                p95Ms: 20,
                p99Ms: 20,
                operationsPerSecond: 1,
            },
            {
                kind: 'widgetList',
                completed: 0,
                p50Ms: 0,
                p95Ms: 0,
                p99Ms: 0,
                operationsPerSecond: 0,
            },
            {
                kind: 'partList',
                completed: 0,
                p50Ms: 0,
                p95Ms: 0,
                p99Ms: 0,
                operationsPerSecond: 0,
            },
            {
                kind: 'widgetAggregate',
                completed: 1,
                p50Ms: 5,
                p95Ms: 5,
                p99Ms: 5,
                operationsPerSecond: 1,
            },
        ]);
    });

    test('converts event-loop snapshots to elapsed milliseconds and utilization', () => {
        expect(
            calculateEventLoopSummary(
                { active: 1_000, idle: 500 },
                { active: 2_000, idle: 1_000 },
            ),
        ).toEqual({
            utilization: 2 / 3,
            activeMs: 1_000,
            idleMs: 500,
        });
    });

    test('parses required commandstats and treats missing entries as zero', () => {
        const before = parseRedisCommandstats(
            [
                '# Commandstats',
                'cmdstat_get:calls=10,usec=100,usec_per_call=10',
                'cmdstat_evalsha:calls=2,usec=50,usec_per_call=25',
                'cmdstat_incr:calls=7,usec=70,usec_per_call=10',
                'cmdstat_incrby:calls=4,usec=40,usec_per_call=10',
            ].join('\n'),
        );
        const after = parseRedisCommandstats(
            [
                '# Commandstats',
                'cmdstat_get:calls=15,usec=100,usec_per_call=6',
                'cmdstat_evalsha:calls=3,usec=50,usec_per_call=16',
                'cmdstat_set:calls=8,usec=40,usec_per_call=5',
                'cmdstat_incr:calls=12,usec=120,usec_per_call=10',
                'cmdstat_expire:calls=5,usec=40,usec_per_call=8',
            ].join('\n'),
        );

        expect(before).toEqual({
            get: 10,
            mget: 0,
            set: 0,
            eval: 0,
            evalsha: 2,
            incr: 7,
            incrby: 4,
            expire: 0,
        });
        expect(diffRedisCommandstats(before, after)).toEqual({
            get: 5,
            mget: 0,
            set: 8,
            eval: 0,
            evalsha: 1,
            incr: 5,
            incrby: -4,
            expire: 5,
        });
    });

    test('captures process-wide commandstats around an isolated phase', async () => {
        const responses = [
            'cmdstat_get:calls=10,usec=1',
            'cmdstat_get:calls=11,usec=1',
        ];
        const client = {
            sendCommand: async () => responses.shift() ?? '',
        };

        const measurement = await measureRedisCommandstats(client, async () => undefined);

        expect(measurement.delta.get).toBe(1);
        expect(measurement.delta.mget).toBe(0);
    });

    test('measures event-loop utilization only around the operation, excluding delayed INFO calls', async () => {
        const events: string[] = [];
        const eventLoopUtilization = vi.spyOn(performance, 'eventLoopUtilization').mockImplementation((start) => {
            if (start === undefined) {
                events.push('elu-start');
                return { active: 10, idle: 20, utilization: 1 / 3 };
            }

            events.push('elu-end');
            return { active: 4, idle: 6, utilization: 0.4 };
        });
        const responses = ['cmdstat_get:calls=10', 'cmdstat_get:calls=11'];
        const client = {
            sendCommand: async () => {
                events.push('info-start');
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                events.push('info-end');
                return responses.shift() ?? '';
            },
        };

        try {
            const measurement = await measureRedisCommandPhase(client, async () => {
                events.push('operation-start');
                await Promise.resolve();
                events.push('operation-end');
            });

            expect(measurement.eventLoop).toEqual({
                utilization: 0.4,
                activeMs: 4,
                idleMs: 6,
            });
        } finally {
            eventLoopUtilization.mockRestore();
        }

        expect(events).toEqual([
            'info-start',
            'info-end',
            'elu-start',
            'operation-start',
            'operation-end',
            'elu-end',
            'info-start',
            'info-end',
        ]);
    });
});
