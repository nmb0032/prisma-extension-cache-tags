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

    return {
        ...DEFAULT_RUNTIME_CONFIG,
        ...config,
        stampede: {
            ...DEFAULT_RUNTIME_CONFIG.stampede,
            ...config.stampede,
        },
        analysis,
        logger: config.logger ?? noopLogger,
        metrics: config.metrics ?? noopMetrics,
    };
}
