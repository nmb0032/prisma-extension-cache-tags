import { createAnalysisContext } from './schema';
import { noopLogger, noopMetrics } from './observability';
import type { CacheTagsConfig, NormalizedCacheConfig } from './types';
import type { CacheSchemaDescriptor } from './schema';

const DEFAULT_RUNTIME_CONFIG = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v3',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: {
        waitMs: 1500,
        pollMs: 50,
        lockTtlMs: 5000,
    },
} as const;

/**
 * Runtime defaults independent of a schema descriptor.
 *
 * @internal
 */
export const DEFAULT_CONFIG = DEFAULT_RUNTIME_CONFIG;

export function normalizeConfig<TSchema extends CacheSchemaDescriptor>(
    config: CacheTagsConfig<TSchema>,
): NormalizedCacheConfig<TSchema> {
    const analysis = createAnalysisContext(config.schema, config.models);
    const tenantKeys = Array.from(
        new Set(
            Object.values(config.models)
                .flatMap((model) => (model && model.tenant !== false ? [model.tenant.field] : [])),
        ),
    );

    return {
        ...DEFAULT_RUNTIME_CONFIG,
        ...config,
        stampede: {
            ...DEFAULT_RUNTIME_CONFIG.stampede,
            ...config.stampede,
        },
        analysis,
        // Legacy resolver scaffolding is intentionally internal and will be removed with src/tags.ts in Task 6.
        dependencyTags: {},
        inferTags: true,
        tenantKeys,
        tenantPrecision: false,
        entityKeys: ['id'],
        logger: config.logger ?? noopLogger,
        metrics: config.metrics ?? noopMetrics,
    };
}
