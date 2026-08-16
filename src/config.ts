import { noopLogger, noopMetrics } from './observability';
import type { CacheTagsConfig, NormalizedCacheConfig } from './types';

export const DEFAULT_CONFIG: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v1',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: {
        waitMs: 1500,
        pollMs: 50,
        lockTtlMs: 5000,
    },
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    tenantPrecision: false,
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};

export function normalizeConfig(config?: CacheTagsConfig): NormalizedCacheConfig {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        stampede: {
            ...DEFAULT_CONFIG.stampede,
            ...config?.stampede,
        },
        dependencyTags: {
            ...DEFAULT_CONFIG.dependencyTags,
            ...config?.dependencyTags,
        },
    };
}
