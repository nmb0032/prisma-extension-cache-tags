import { READ_OPERATIONS } from './types';
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

export function normalizeTags(tags: string[] | undefined, maxTags: number, requiredTag?: string): string[] {
    if (!tags || tags.length === 0) {
        return [];
    }

    const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
    const sortedTags = uniqueTags.sort();
    if (maxTags <= 0) {
        return [];
    }

    const retainedModelTag =
        (requiredTag && sortedTags.includes(requiredTag) ? requiredTag : undefined) ??
        sortedTags.find((tag) => tag.startsWith('global:model:'));

    if (!retainedModelTag || sortedTags.length <= maxTags) {
        return sortedTags.slice(0, maxTags);
    }

    return [retainedModelTag, ...sortedTags.filter((tag) => tag !== retainedModelTag).slice(0, maxTags - 1)];
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
        if (tenantIds.length === 0) {
            return resolver.map((dependencyModel) => createModelTag(dependencyModel));
        }

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
    includeGlobalModelFallback = false,
    additionalSources: unknown[] = [],
): ResolvedCacheTags {
    const explicitTags = options?.tags ?? [];
    const shouldInfer = options?.inferTags ?? config.inferTags;
    const shouldMerge = options?.mergeTags ?? true;
    const tenantKeys = new Set(config.tenantKeys);
    const entityKeys = new Set(config.entityKeys);
    const sources = additionalSources.length > 0 ? [args, ...additionalSources] : args;
    const tenantIds = shouldInfer && tenantKeys.size > 0 ? Array.from(collectStringValues(sources, tenantKeys)) : [];
    const entityIds = shouldInfer ? Array.from(collectStringValues(sources, entityKeys)) : [];
    const inferredTags: string[] = [];
    const isReadOperation =
        includeGlobalModelFallback || READ_OPERATIONS.includes(operation as (typeof READ_OPERATIONS)[number]);

    if (shouldInfer) {
        if (tenantIds.length > 0) {
            for (const tenantId of tenantIds) {
                inferredTags.push(`tenant:${tenantId}`, createModelTag(model, tenantId));
                for (const entityId of entityIds) {
                    inferredTags.push(createEntityTag(model, entityId, tenantId));
                }
            }
            if (!config.tenantPrecision || !isReadOperation) {
                inferredTags.push(createModelTag(model));
            }

            if (!config.tenantPrecision) {
                for (const entityId of entityIds) {
                    inferredTags.push(createEntityTag(model, entityId));
                }
            }
        } else {
            inferredTags.push(createModelTag(model));
            for (const entityId of entityIds) {
                inferredTags.push(createEntityTag(model, entityId));
            }
        }
    }

    if (includeDependencies) {
        inferredTags.push(...resolveDependencyTags(model, operation, tenantIds, entityIds, args, config));
    }

    const candidateTags = shouldMerge ? [...inferredTags, ...explicitTags] : explicitTags;
    const modelTag = createModelTag(model);
    const modelTagWasEmitted = shouldInfer && shouldMerge && inferredTags.includes(modelTag);

    return {
        tags: normalizeTags(candidateTags, config.maxTagsPerQuery, modelTagWasEmitted ? modelTag : undefined),
        tenantIds,
        entityIds,
    };
}
