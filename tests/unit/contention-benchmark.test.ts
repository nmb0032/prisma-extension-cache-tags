import { performance } from 'node:perf_hooks';
import { describe, expect, test, vi } from 'vitest';
import { runColdKeyContention } from '../../tests/load/contention-benchmark';
import type { BenchmarkFixture } from '../../tests/load/benchmark-fixture';

describe('contention benchmark measurement', () => {
    test('starts and ends ELU around contenders, excluding namespace cleanup', async () => {
        const events: string[] = [];
        let cached = false;
        const eventLoopUtilization = vi.spyOn(performance, 'eventLoopUtilization').mockImplementation((start) => {
            events.push(start === undefined ? 'elu-start' : 'elu-end');
            return start === undefined
                ? { active: 1, idle: 1, utilization: 0.5 }
                : { active: 3, idle: 2, utilization: 0.6 };
        });
        const queryCounters = Array.from({ length: 2 }, () => ({
            total: 0,
            byModel: {},
            reset() {
                this.total = 0;
            },
        }));
        const clients = Array.from({ length: 2 }, (_, clientIndex) => ({
            $connect: vi.fn(async () => undefined),
            widget: {
                findMany: vi.fn(async () => {
                    events.push(`contender-${clientIndex}`);
                    if (!cached) {
                        cached = true;
                        queryCounters[0]!.total += 1;
                    }
                    return [{ id: 'widget-0', tenantId: 'tenant-0', name: 'same' }];
                }),
            },
        }));
        const fixture = {
            profileName: 'quick',
            keyPrefix: 'prismaCacheTags:benchmark:elu',
            tenantIds: ['tenant-0'],
            clients,
            queryCounters,
            redis: {
                async *scanIterator() {
                    events.push('cleanup');
                    cached = false;
                },
                unlink: vi.fn(async () => 0),
            },
        } as unknown as BenchmarkFixture;

        try {
            const result = await runColdKeyContention(fixture, 2);

            expect(result.databaseQueriesPerRound).toEqual(Array.from({ length: 10 }, () => 1));
            expect(result.eventLoop).toEqual({
                utilization: 0.6,
                activeMs: 30,
                idleMs: 20,
            });
        } finally {
            eventLoopUtilization.mockRestore();
        }

        expect(events.slice(0, 4)).toEqual(['cleanup', 'elu-start', 'contender-0', 'contender-1']);
        expect(events.filter((event) => event === 'cleanup')).toHaveLength(10);
        expect(events.filter((event) => event === 'elu-start')).toHaveLength(10);
        expect(events.filter((event) => event === 'elu-end')).toHaveLength(10);
        const cleanupIndexes = events.flatMap((event, index) => (event === 'cleanup' ? [index] : []));
        const startIndexes = events.flatMap((event, index) => (event === 'elu-start' ? [index] : []));
        const endIndexes = events.flatMap((event, index) => (event === 'elu-end' ? [index] : []));
        for (let round = 0; round < 10; round += 1) {
            expect(cleanupIndexes[round]).toBeLessThan(startIndexes[round]!);
            expect(startIndexes[round]).toBeLessThan(endIndexes[round]!);
        }
    });
});
