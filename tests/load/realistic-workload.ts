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

export interface ZipfianSampler {
    readonly cdf: readonly number[];
    sample(random: () => number): number;
}

export interface ZipfianOperationStream {
    readonly sampler: ZipfianSampler;
    next(): RealisticWorkloadOperation;
}

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
const ZIPFIAN_SAMPLER_CACHE = new Map<string, ZipfianSampler>();

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

    const stream = createZipfianOperationStream(corpus, profile, seed);
    return Array.from({ length: profile.operations }, () => stream.next());
}

export function buildZipfianIdentitySet(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
): RealisticWorkloadOperation[] {
    if (profile.name !== 'zipfian') {
        throw new Error('buildZipfianIdentitySet requires the zipfian profile');
    }
    validateCorpus(corpus);

    const identityGroups: RealisticWorkloadOperation[][] = [
        corpus.widgets.map((widget) => ({ kind: 'widgetUnique' as const, widgetId: widget.id })),
        corpus.parts.map((part) => ({ kind: 'partUnique' as const, partId: part.id })),
        corpus.tenantIds.map((tenantId) => ({ kind: 'widgetList' as const, tenantId, take: profile.listTake })),
        corpus.tenantIds.map((tenantId) => ({ kind: 'partList' as const, tenantId, take: profile.listTake })),
        corpus.tenantIds.map((tenantId) => ({ kind: 'widgetAggregate' as const, tenantId })),
    ];
    const identities: RealisticWorkloadOperation[] = [];
    const seen = new Set<string>();
    const maxGroupLength = Math.max(...identityGroups.map((group) => group.length));

    for (let index = 0; index < maxGroupLength; index += 1) {
        for (const group of identityGroups) {
            const operation = group[index];
            if (operation === undefined) {
                continue;
            }
            const identity = getWorkloadOperationIdentity(operation);
            if (!seen.has(identity)) {
                seen.add(identity);
                identities.push(operation);
            }
        }
    }

    return identities;
}

export function createZipfianSampler(
    keyCount: number,
    exponent = ZIPFIAN_EXPONENT,
    hotKeyProbability = 0.8,
): ZipfianSampler {
    validateZipfianArguments(keyCount, exponent, hotKeyProbability);

    const weights = Array.from({ length: keyCount }, (_, rank) => (rank + 1) ** -exponent);
    const hotKeyCount = Math.max(1, Math.ceil(keyCount * 0.2));
    const hotWeight = weights.slice(0, hotKeyCount).reduce((total, weight) => total + weight, 0);
    const coldWeight = weights.slice(hotKeyCount).reduce((total, weight) => total + weight, 0);
    const cdf: number[] = [];
    let cumulative = 0;

    for (const [rank, weight] of weights.entries()) {
        const isHot = rank < hotKeyCount;
        const segmentProbability = isHot ? hotKeyProbability : 1 - hotKeyProbability;
        const segmentWeight = isHot ? hotWeight : coldWeight;
        cumulative += segmentWeight === 0 ? 0 : (segmentProbability * weight) / segmentWeight;
        cdf.push(cumulative);
    }
    cdf[cdf.length - 1] = 1;

    const frozenCdf = Object.freeze(cdf);
    return Object.freeze({
        cdf: frozenCdf,
        sample(random: () => number): number {
            const target = random();
            if (!Number.isFinite(target) || target < 0 || target > 1) {
                throw new Error('sample must be between 0 and 1');
            }
            if (target === 1) {
                return frozenCdf.length - 1;
            }

            let low = 0;
            let high = frozenCdf.length - 1;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (frozenCdf[middle]! > target) {
                    high = middle;
                } else {
                    low = middle + 1;
                }
            }
            return low;
        },
    });
}

export function createZipfianOperationStream(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
    seed: number | string,
    sampler?: ZipfianSampler,
): ZipfianOperationStream {
    const identities = buildZipfianIdentitySet(corpus, profile);
    const selectedSampler = sampler ?? getCachedZipfianSampler(profile, identities.length);
    return createZipfianOperationStreamFromIdentities(identities, selectedSampler, seed);
}

function createZipfianOperationStreamFromIdentities(
    identities: readonly RealisticWorkloadOperation[],
    sampler: ZipfianSampler,
    seed: number | string,
): ZipfianOperationStream {
    if (identities.length !== sampler.cdf.length) {
        throw new Error('Zipfian sampler size does not match the generated identity set');
    }
    const random = createSeededPrng(seed);

    return {
        sampler,
        next(): RealisticWorkloadOperation {
            return identities[sampler.sample(random)]!;
        },
    };
}

export function createZipfianWorkerStreams(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
    workerCount: number,
    seed: number | string,
): ZipfianOperationStream[] {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
        throw new Error('workerCount must be a positive integer');
    }

    const identities = buildZipfianIdentitySet(corpus, profile);
    const sampler = getCachedZipfianSampler(profile, identities.length);
    return Array.from({ length: workerCount }, (_, workerIndex) =>
        createZipfianOperationStreamFromIdentities(
            identities,
            sampler,
            `${String(seed)}:worker:${workerIndex}`,
        ),
    );
}

export function getZipfianHotIdentities(
    corpus: BenchmarkReadCorpus,
    profile: RealisticWorkloadProfile,
): RealisticWorkloadOperation[] {
    const identities = buildZipfianIdentitySet(corpus, profile);
    return identities.slice(0, Math.max(1, Math.ceil(identities.length * 0.2)));
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
    return getCachedZipfianSampler({ hotKeyProbability }, keyCount, exponent).sample(random);
}

export function getWorkloadOperationIdentity(operation: RealisticWorkloadOperation): string {
    switch (operation.kind) {
        case 'widgetUnique':
            return JSON.stringify([operation.kind, operation.widgetId]);
        case 'partUnique':
            return JSON.stringify([operation.kind, operation.partId]);
        case 'widgetList':
            return JSON.stringify([operation.kind, operation.tenantId, operation.take ?? null]);
        case 'partList':
            return JSON.stringify([operation.kind, operation.tenantId, operation.take ?? null]);
        case 'widgetAggregate':
            return JSON.stringify([operation.kind, operation.tenantId]);
    }
}

export function calculateHotIdentityShare(
    plan: readonly RealisticWorkloadOperation[],
    hotIdentities: readonly RealisticWorkloadOperation[],
): number {
    if (plan.length === 0 || hotIdentities.length === 0) {
        return 0;
    }
    const hotKeys = new Set(hotIdentities.map(getWorkloadOperationIdentity));
    return plan.filter((operation) => hotKeys.has(getWorkloadOperationIdentity(operation))).length / plan.length;
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

function validateCorpus(corpus: BenchmarkReadCorpus): void {
    if (corpus.widgets.length === 0 || corpus.parts.length === 0) {
        throw new Error('The benchmark read corpus must contain widgets and parts');
    }
    if (corpus.tenantIds.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }
}

function validateZipfianArguments(keyCount: number, exponent: number, hotKeyProbability: number): void {
    if (!Number.isInteger(keyCount) || keyCount < 1) {
        throw new Error('keyCount must be a positive integer');
    }
    if (!Number.isFinite(exponent) || exponent <= 0) {
        throw new Error('exponent must be greater than 0');
    }
    if (!Number.isFinite(hotKeyProbability) || hotKeyProbability < 0 || hotKeyProbability > 1) {
        throw new Error('hotKeyProbability must be between 0 and 1');
    }
}

function getCachedZipfianSampler(
    profile: Pick<RealisticWorkloadProfile, 'hotKeyProbability'>,
    keyCount: number,
    exponent = ZIPFIAN_EXPONENT,
): ZipfianSampler {
    const key = `${keyCount}:${exponent}:${profile.hotKeyProbability}`;
    const cached = ZIPFIAN_SAMPLER_CACHE.get(key);
    if (cached !== undefined) {
        return cached;
    }

    const sampler = createZipfianSampler(keyCount, exponent, profile.hotKeyProbability);
    ZIPFIAN_SAMPLER_CACHE.set(key, sampler);
    return sampler;
}

function hashSeed(seed: string): number {
    let hash = 2_166_136_261;
    for (const character of seed) {
        hash ^= character.codePointAt(0)!;
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}
