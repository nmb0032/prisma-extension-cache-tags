import { describe, expect, test } from 'vitest';
import {
    buildZipfianIdentitySet,
    buildListHeavyPlan,
    buildZipfianPlan,
    calculateHotIdentityShare,
    createZipfianSampler,
    createZipfianWorkerStreams,
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

    test('uses one seeded Zipfian distribution across all query identities and all five kinds', () => {
        const profile = createRealisticWorkloadProfile('zipfian', { operations: 5_000 });
        const first = buildZipfianPlan(corpus, profile, 'fixed-seed');
        const second = buildZipfianPlan(corpus, profile, 'fixed-seed');
        const identities = buildZipfianIdentitySet(corpus, profile);
        const hotIdentityCount = Math.ceil(identities.length * 0.2);

        expect(ZIPFIAN_EXPONENT).toBe(1.1);
        expect(first).toEqual(second);
        expect(new Set(first.map((operation) => operation.kind))).toEqual(
            new Set(['widgetUnique', 'partUnique', 'widgetList', 'partList', 'widgetAggregate']),
        );
        expect(calculateHotIdentityShare(first, identities.slice(0, hotIdentityCount))).toBeGreaterThanOrEqual(0.7);
        expect(calculateHotIdentityShare(first, identities.slice(0, hotIdentityCount))).toBeLessThanOrEqual(0.9);
    });

    test('keeps per-worker Zipfian streams deterministic and independent of scheduling order', () => {
        const profile = createRealisticWorkloadProfile('zipfian');
        const sequential = createZipfianWorkerStreams(corpus, profile, 2, 'worker-seed');
        const sequentialFirst = Array.from({ length: 12 }, () => sequential[0]!.next());
        const sequentialSecond = Array.from({ length: 12 }, () => sequential[1]!.next());

        const interleaved = createZipfianWorkerStreams(corpus, profile, 2, 'worker-seed');
        const interleavedResults = [[], []] as [typeof sequentialFirst, typeof sequentialSecond];
        for (let index = 0; index < 12; index += 1) {
            interleavedResults[0].push(interleaved[0]!.next());
            interleavedResults[1].push(interleaved[1]!.next());
        }

        expect(interleavedResults).toEqual([sequentialFirst, sequentialSecond]);
        expect(sequential[0]!.sampler).toBe(sequential[1]!.sampler);
    });

    test('precomputes and reuses a Zipfian CDF for every sample', () => {
        const sampler = createZipfianSampler(128, ZIPFIAN_EXPONENT, 0.8);
        const cdf = sampler.cdf;

        for (let index = 0; index < 100; index += 1) {
            sampler.sample(() => index / 100);
        }

        expect(cdf).toHaveLength(128);
        expect(cdf[cdf.length - 1]).toBeCloseTo(1);
        expect(sampler.cdf).toBe(cdf);
    });

    test('produces repeatable pseudo-random values for a seed', () => {
        const first = createSeededPrng('fixed-seed');
        const second = createSeededPrng('fixed-seed');

        expect(Array.from({ length: 5 }, () => first())).toEqual(
            Array.from({ length: 5 }, () => second()),
        );
    });
});
