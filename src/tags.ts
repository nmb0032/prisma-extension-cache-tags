import type { CacheReadOptions, CacheWriteOptions, NormalizedCacheConfig, ResolvedCacheTags } from './types';

const IGNORED_KEYS = new Set(['select', 'include', 'orderBy', 'skip', 'take', 'cursor', 'distinct', 'cache']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addFilterValue(value: unknown, results: Set<string>): void {
    if (typeof value === 'string' || typeof value === 'number') {
        results.add(String(value));
        return;
    }

    if (!isRecord(value)) {
        return;
    }

    const { equals, in: inValue, id } = value as { equals?: unknown; in?: unknown; id?: unknown };

    if (typeof equals === 'string' || typeof equals === 'number') {
        results.add(String(equals));
    }

    // Relation-style filters: { tenant: { id: 't7' } }
    if (typeof id === 'string' || typeof id === 'number') {
        results.add(String(id));
    }

    if (Array.isArray(inValue)) {
        for (const item of inValue) {
            if (typeof item === 'string' || typeof item === 'number') {
                results.add(String(item));
            }
        }
    }
}

function collectStringValues(value: unknown, keys: Set<string>, results = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectStringValues(item, keys, results);
        }
        return results;
    }

    if (!isRecord(value)) {
        return results;
    }

    for (const [key, child] of Object.entries(value)) {
        if (IGNORED_KEYS.has(key)) {
            continue;
        }

        if (keys.has(key)) {
            addFilterValue(child, results);
        }

        collectStringValues(child, keys, results);
    }

    return results;
}

export function normalizeTags(tags: string[] | undefined, maxTags: number): string[] {
    if (!tags || tags.length === 0) {
        return [];
    }

    const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
    return uniqueTags.sort().slice(0, maxTags);
}

function createModelTag(model: string, tenantId?: string): string {
    return tenantId ? `tenant:${tenantId}:model:${model}` : `global:model:${model}`;
}

function createEntityTag(model: string, entityId: string, tenantId?: string): string {
    const normalizedModel = model.charAt(0).toLowerCase() + model.slice(1);
    return tenantId ? `tenant:${tenantId}:${normalizedModel}:${entityId}` : `global:${normalizedModel}:${entityId}`;
}

function resolveDependencyTags(
    model: string,
    operation: string,
    tenantIds: string[],
    entityIds: string[],
    args: unknown,
    config: NormalizedCacheConfig,
): string[] {
    const resolver = config.dependencyTags[model];
    if (!resolver) {
        return [];
    }

    if (Array.isArray(resolver)) {
        return tenantIds.flatMap((tenantId) =>
            resolver.map((dependencyModel) => createModelTag(dependencyModel, tenantId)),
        );
    }

    return resolver({ model, operation, tenantIds, entityIds, args });
}

export function resolveCacheTags(
    model: string,
    operation: string,
    args: unknown,
    options: CacheReadOptions | CacheWriteOptions | undefined,
    config: NormalizedCacheConfig,
    includeDependencies: boolean,
): ResolvedCacheTags {
    const explicitTags = options?.tags ?? [];
    const shouldInfer = options?.inferTags ?? config.inferTags;
    const shouldMerge = options?.mergeTags ?? true;
    const tenantKeys = new Set(config.tenantKeys);
    const entityKeys = new Set(config.entityKeys);
    const tenantIds = shouldInfer && tenantKeys.size > 0 ? Array.from(collectStringValues(args, tenantKeys)) : [];
    const entityIds = shouldInfer ? Array.from(collectStringValues(args, entityKeys)) : [];
    const inferredTags: string[] = [];

    if (shouldInfer) {
        if (tenantIds.length > 0) {
            for (const tenantId of tenantIds) {
                inferredTags.push(`tenant:${tenantId}`, createModelTag(model, tenantId));
                for (const entityId of entityIds) {
                    inferredTags.push(createEntityTag(model, entityId, tenantId));
                }
            }
        } else {
            inferredTags.push(createModelTag(model));
            for (const entityId of entityIds) {
                inferredTags.push(createEntityTag(model, entityId));
            }
        }

        if (includeDependencies) {
            inferredTags.push(...resolveDependencyTags(model, operation, tenantIds, entityIds, args, config));
        }
    }

    const candidateTags = shouldMerge ? [...inferredTags, ...explicitTags] : explicitTags.length > 0 ? explicitTags : inferredTags;

    return {
        tags: normalizeTags(candidateTags, config.maxTagsPerQuery),
        tenantIds,
        entityIds,
    };
}
