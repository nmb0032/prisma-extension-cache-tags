import type { BenchmarkReadCorpus } from './benchmark-fixture';
import type { QueryKind } from './query-kind-metrics';

export interface RealisticWorkloadProfile {
    name: 'list-heavy' | 'zipfian';
    operations: number;
    concurrency: number;
    listTake: number;
    hotKeyProbability: number;
}

export type RealisticWorkloadOperation =
    | { kind: 'widgetUnique'; widgetId: string }
    | { kind: 'partUnique'; partId: string }
    | { kind: 'widgetList'; tenantId: string; take?: number }
    | { kind: 'partList'; tenantId: string; take?: number }
    | { kind: 'widgetAggregate'; tenantId: string };

export const ZIPFIAN_EXPONENT = 1.1;
export const REALISTIC_WORKLOAD_PROFILES: Record<RealisticWorkloadProfile['name'], RealisticWorkloadProfile> = {
    'list-heavy': {
        name: 'list-heavy',
        operations: 256,
        concurrency: 8,
        listTake: 100,
        hotKeyProbability: 0,
    },
    zipfian: {
        name: 'zipfian',
        operations: 2_000,
        concurrency: 8,
        listTake: 100,
        hotKeyProbability: 0.8,
    },
};

export function createRealisticWorkloadProfile(
    name: RealisticWorkloadProfile['name'],
    overrides: Partial<Omit<RealisticWorkloadProfile, 'name'>> = {},
): RealisticWorkloadProfile {
    return {
        ...REALISTIC_WORKLOAD_PROFILES[name],
        ...overrides,
        name,
    };
}

export function buildListHeavyPlan(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
): RealisticWorkloadOperation[] {
    if (profile.name !== 'list-heavy') {
        throw new Error('buildListHeavyPlan requires the list-heavy profile');
    }
    if (corpus.widgets.length === 0 || corpus.parts.length === 0) {
        throw new Error('The benchmark read corpus must contain widgets and parts');
    }
    if (corpus.tenantIds.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }

    const plan: RealisticWorkloadOperation[] = [];
    for (let index = 0; index < profile.operations; index += 1) {
        const tenantId = corpus.tenantIds[index % corpus.tenantIds.length]!;
        switch (index % 10) {
            case 0:
                plan.push({ kind: 'widgetAggregate', tenantId });
                break;
            case 1:
            case 2:
            case 3:
                plan.push({ kind: 'widgetList', tenantId, take: profile.listTake });
                break;
            case 4:
            case 5:
            case 6:
                plan.push({ kind: 'partList', tenantId, take: profile.listTake });
                break;
            case 7:
                plan.push({ kind: 'widgetUnique', widgetId: corpus.widgets[index % corpus.widgets.length]!.id });
                break;
            default:
                plan.push({ kind: 'partUnique', partId: corpus.parts[index % corpus.parts.length]!.id });
                break;
        }
    }
    return plan;
}

export function buildZipfianPlan(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
    seed: number | string,
): RealisticWorkloadOperation[] {
    if (profile.name !== 'zipfian') {
        throw new Error('buildZipfianPlan requires the zipfian profile');
    }
    if (corpus.widgets.length === 0 || corpus.parts.length === 0) {
        throw new Error('The benchmark read corpus must contain widgets and parts');
    }
    if (corpus.tenantIds.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }

    const random = createSeededPrng(seed);
    const plan: RealisticWorkloadOperation[] = [];
    for (let index = 0; index < profile.operations; index += 1) {
        const rank = selectZipfianRank(random, corpus.widgets.length, ZIPFIAN_EXPONENT, profile.hotKeyProbability);
        if (index % 10 === 0) {
            const tenantId = corpus.tenantIds[rank % corpus.tenantIds.length]!;
            plan.push({ kind: 'widgetAggregate', tenantId });
        } else if (index % 10 === 1) {
            const tenantId = corpus.tenantIds[rank % corpus.tenantIds.length]!;
            plan.push({ kind: 'widgetList', tenantId, take: profile.listTake });
        } else if (index % 10 === 2) {
            const part = corpus.parts[rank % corpus.parts.length]!;
            plan.push({ kind: 'partUnique', partId: part.id });
        } else {
            plan.push({ kind: 'widgetUnique', widgetId: corpus.widgets[rank]!.id });
        }
    }
    return plan;
}

export function createSeededPrng(seed: number | string): () => number {
    let state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export function selectZipfianRank(
    random: () => number,
    keyCount: number,
    exponent = ZIPFIAN_EXPONENT,
    hotKeyProbability = 0.8,
): number {
    if (!Number.isInteger(keyCount) || keyCount < 1) {
        throw new Error('keyCount must be a positive integer');
    }
    if (!Number.isFinite(exponent) || exponent <= 0) {
        throw new Error('exponent must be greater than 0');
    }
    if (!Number.isFinite(hotKeyProbability) || hotKeyProbability < 0 || hotKeyProbability > 1) {
        throw new Error('hotKeyProbability must be between 0 and 1');
    }

    const hotKeyCount = Math.max(1, Math.ceil(keyCount * 0.2));
    const hot = random() < hotKeyProbability;
    const start = hot ? 0 : hotKeyCount;
    const end = hot ? hotKeyCount : keyCount;
    if (start >= end) {
        return keyCount - 1;
    }
    return start + weightedRank(random, start, end, exponent);
}

export function calculateHotKeyShare(
    plan: readonly { kind: string; widgetId?: string }[],
    hotKeyCount: number,
    hotKeyIds?: readonly string[],
): number {
    const widgetIds = plan
        .filter((operation): operation is { kind: 'widgetUnique'; widgetId: string } => operation.kind === 'widgetUnique' && operation.widgetId !== undefined)
        .map((operation) => operation.widgetId);
    if (widgetIds.length === 0) {
        return 0;
    }
    const hotIds = new Set(
        hotKeyIds ??
            [...new Set(widgetIds)]
                .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
                .slice(0, hotKeyCount),
    );
    return widgetIds.filter((id) => hotIds.has(id)).length / widgetIds.length;
}

export function queryKindOf(operation: RealisticWorkloadOperation): QueryKind {
    return operation.kind;
}

function weightedRank(random: () => number, start: number, end: number, exponent: number): number {
    const weights: number[] = [];
    let total = 0;
    for (let rank = start + 1; rank <= end; rank += 1) {
        const weight = rank ** -exponent;
        weights.push(weight);
        total += weight;
    }

    let target = random() * total;
    for (const [index, weight] of weights.entries()) {
        target -= weight;
        if (target <= 0) {
            return index;
        }
    }
    return Math.max(0, weights.length - 1);
}

function hashSeed(seed: string): number {
    let hash = 2_166_136_261;
    for (const character of seed) {
        hash ^= character.codePointAt(0)!;
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}
