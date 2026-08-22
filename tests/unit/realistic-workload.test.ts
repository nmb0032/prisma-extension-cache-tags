import { describe, expect, test } from 'vitest';
import {
    buildListHeavyPlan,
    buildZipfianPlan,
    calculateHotKeyShare,
    createRealisticWorkloadProfile,
    createSeededPrng,
    ZIPFIAN_EXPONENT,
} from '../../tests/load/realistic-workload';

const corpus = {
    tenantIds: ['tenant-0', 'tenant-1', 'tenant-2', 'tenant-3'],
    widgets: Array.from({ length: 100 }, (_, index) => ({
        id: `widget-${index}`,
        tenantId: `tenant-${index % 4}`,
        initialName: `widget-${index}`,
        workerIndex: index % 4,
    })),
    parts: Array.from({ length: 100 }, (_, index) => ({
        id: `part-${index}`,
        tenantId: `tenant-${index % 4}`,
        label: `part-${index}`,
        widgetId: `widget-${index}`,
    })),
};

describe('realistic benchmark workloads', () => {
    test('generates a deterministic list-heavy plan with at least 70% list or aggregate reads', () => {
        const profile = createRealisticWorkloadProfile('list-heavy', { operations: 100 });
        const first = buildListHeavyPlan(corpus, profile);
        const second = buildListHeavyPlan(corpus, profile);
        const listReads = first.filter((operation) => operation.kind.endsWith('List') || operation.kind === 'widgetAggregate');

        expect(first).toEqual(second);
        expect(first).toHaveLength(100);
        expect(listReads.length / first.length).toBeGreaterThanOrEqual(0.7);
        expect(
            first
                .filter(
                    (operation): operation is Extract<typeof operation, { kind: 'widgetList' | 'partList' }> =>
                        operation.kind.endsWith('List'),
                )
                .every((operation) => operation.take === 100),
        ).toBe(true);
    });

    test('uses a seeded Zipfian selector with exponent 1.1 and approximately 80% hot-key traffic', () => {
        const profile = createRealisticWorkloadProfile('zipfian', { operations: 2_000 });
        const first = buildZipfianPlan(corpus, profile, 'fixed-seed');
        const second = buildZipfianPlan(corpus, profile, 'fixed-seed');
        const hotKeyCount = Math.ceil(corpus.widgets.length * 0.2);

        expect(ZIPFIAN_EXPONENT).toBe(1.1);
        expect(first).toEqual(second);
        expect(calculateHotKeyShare(first, hotKeyCount)).toBeCloseTo(0.8, 1);
    });

    test('produces repeatable pseudo-random values for a seed', () => {
        const first = createSeededPrng('fixed-seed');
        const second = createSeededPrng('fixed-seed');

        expect(Array.from({ length: 5 }, () => first())).toEqual(
            Array.from({ length: 5 }, () => second()),
        );
    });
});
