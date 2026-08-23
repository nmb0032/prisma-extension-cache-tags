import { describe, expect, test } from 'vitest';
import { buildVersionedCacheKey, createVersionToken, getCacheLockKey, getTagVersionKey, prepareCacheKey } from '../../src/keys';
import { noopLogger, noopMetrics } from '../../src/observability';
import type { NormalizedCacheConfig } from '../../src/types';
import { createAnalysisContext } from '../../src/schema';
import { cacheModels, cacheSchema } from '../fixture/cache-schema';

const config: NormalizedCacheConfig = {
    enabled: true,
    defaultTtlSeconds: 30,
    maxTtlSeconds: 300,
    keyPrefix: 'prismaCacheTags:v2',
    cacheNull: true,
    cacheEmpty: true,
    schemaVersion: 1,
    maxTagsPerQuery: 30,
    stampede: { waitMs: 1500, pollMs: 50, lockTtlMs: 5000 },
    analysis: createAnalysisContext(cacheSchema, cacheModels),
    dependencyTags: {},
    inferTags: true,
    tenantKeys: [],
    tenantPrecision: false,
    entityKeys: ['id'],
    logger: noopLogger,
    metrics: noopMetrics,
};

describe('cache keys', () => {
    test('are deterministic for identical inputs and insensitive to insertion order', () => {
        const args = { where: { tenantId: 't1' } };
        const a = prepareCacheKey('Widget', 'findMany', args, ['tenant:t1'], ['t1'], config);
        const b = prepareCacheKey('Widget', 'findMany', { where: { tenantId: 't1' } }, ['tenant:t1'], ['t1'], config);
        expect(a.baseKey).toBe(b.baseKey);
        expect(a.identity).toBe(b.identity);
    });

    test('includes the complete canonical identity in the digest source', () => {
        const a = prepareCacheKey('Widget', 'findMany', { where: { tenantId: 't1' } }, [], ['t1'], config);
        const b = prepareCacheKey('Widget', 'findMany', { where: { tenantId: 't2' } }, [], ['t2'], config);
        expect(a.baseKey).not.toBe(b.baseKey);
        expect(a.identity).not.toBe(b.identity);
    });

    test('sorts and deduplicates tenant scope while retaining normalized tag keys', () => {
        const prepared = prepareCacheKey('Widget', 'findMany', {}, ['beta', 'alpha', 'beta'], ['tenant-b', 'tenant-a', 'tenant-a'], config);
        expect(prepared.tenantScope).toEqual(['tenant-a', 'tenant-b']);
        expect(prepared.tagVersionKeys).toEqual([
            getTagVersionKey('alpha', config),
            getTagVersionKey('beta', config),
        ]);
    });

    test('creates stable generation tokens and v2 versioned keys', () => {
        expect(createVersionToken([null, '2', '10'])).toBe('0.2.10');
        expect(buildVersionedCacheKey('prismaCacheTags:v2:qry:Widget:findMany:abc', '0.2.10')).toBe(
            'prismaCacheTags:v2:qry:Widget:findMany:abc:0.2.10',
        );
    });

    test('derives lock keys without a second hash', () => {
        expect(getCacheLockKey('prismaCacheTags:v2:qry:Widget:findMany:abc:0')).toBe(
            'prismaCacheTags:v2:qry:Widget:findMany:abc:0:lock',
        );
    });

    test('keeps custom keys isolated within model, operation, arguments, tags, and tenant scope', () => {
        const baseline = prepareCacheKey('Widget', 'findMany', { where: { id: 'w1' } }, ['tag:a'], ['tenant-a'], config, 'shared');
        const variants = [
            prepareCacheKey('Part', 'findMany', { where: { id: 'w1' } }, ['tag:a'], ['tenant-a'], config, 'shared'),
            prepareCacheKey('Widget', 'count', { where: { id: 'w1' } }, ['tag:a'], ['tenant-a'], config, 'shared'),
            prepareCacheKey('Widget', 'findMany', { where: { id: 'w2' } }, ['tag:a'], ['tenant-a'], config, 'shared'),
            prepareCacheKey('Widget', 'findMany', { where: { id: 'w1' } }, ['tag:b'], ['tenant-a'], config, 'shared'),
            prepareCacheKey('Widget', 'findMany', { where: { id: 'w1' } }, ['tag:a'], ['tenant-b'], config, 'shared'),
        ];

        for (const variant of variants) {
            expect(variant.baseKey).not.toBe(baseline.baseKey);
            expect(variant.identity).not.toBe(baseline.identity);
        }
    });
});
