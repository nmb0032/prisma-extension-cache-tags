import { describe, expect, test } from 'vitest';
import { noopLogger, noopMetrics } from '../../src/observability';
import { normalizeTags, resolveCacheTags } from '../../src/tags';
import type { NormalizedCacheConfig } from '../../src/types';

function makeConfig(overrides: Partial<NormalizedCacheConfig> = {}): NormalizedCacheConfig {
    return {
        enabled: true,
        defaultTtlSeconds: 30,
        maxTtlSeconds: 300,
        keyPrefix: 'prismaCacheTags:v1',
        cacheNull: true,
        cacheEmpty: true,
        schemaVersion: 1,
        maxTagsPerQuery: 30,
        stampede: { waitMs: 1500, pollMs: 50, lockTtlMs: 5000 },
        dependencyTags: {},
        inferTags: true,
        tenantKeys: [],
        tenantPrecision: false,
        entityKeys: ['id'],
        logger: noopLogger,
        metrics: noopMetrics,
        ...overrides,
    };
}

function overlappingTags(left: string[], right: string[]): string[] {
    return left.filter((tag) => right.includes(tag));
}

describe('normalizeTags', () => {
    test('dedupes, trims, drops empties, and sorts', () => {
        expect(normalizeTags(['  b ', 'a', 'b', '', '   '], 30)).toEqual(['a', 'b']);
    });

    test('truncates to maxTags', () => {
        expect(normalizeTags(['d', 'c', 'b', 'a'], 2)).toEqual(['a', 'b']);
    });

    test('returns an empty array for undefined', () => {
        expect(normalizeTags(undefined, 30)).toEqual([]);
    });
});

describe('resolveCacheTags', () => {
    describe('safe default tag overlap', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });

        test('overlaps a tenant-less read with a tenant-ful write', () => {
            const read = resolveCacheTags('Widget', 'findMany', {}, undefined, config, false);
            const write = resolveCacheTags('Widget', 'create', { data: { tenantId: 't1', id: 'w1' } }, undefined, config, true);

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });

        test('overlaps a tenant-ful read with a tenant-less write', () => {
            const read = resolveCacheTags(
                'Widget',
                'findMany',
                { where: { tenantId: 't1' } },
                undefined,
                config,
                false,
            );
            const write = resolveCacheTags('Widget', 'update', { where: { id: 'w1' } }, undefined, config, true);

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });

        test('overlaps a tenant-ful read with a tenant-ful write for the same tenant', () => {
            const read = resolveCacheTags(
                'Widget',
                'findMany',
                { where: { tenantId: 't1' } },
                undefined,
                config,
                false,
            );
            const write = resolveCacheTags(
                'Widget',
                'update',
                { where: { tenantId: 't1', id: 'w1' } },
                undefined,
                config,
                true,
            );

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });

        test('overlaps a tenant-less read with a tenant-less write', () => {
            const read = resolveCacheTags('Widget', 'findMany', {}, undefined, config, false);
            const write = resolveCacheTags('Widget', 'updateMany', { where: { active: true } }, undefined, config, true);

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });

        test('retains overlap when maxTagsPerQuery is one', () => {
            const cappedConfig = { ...config, maxTagsPerQuery: 1 };
            const read = resolveCacheTags(
                'Widget',
                'findMany',
                { where: { tenantId: 't1' } },
                undefined,
                cappedConfig,
                false,
            );
            const write = resolveCacheTags(
                'Widget',
                'update',
                { where: { tenantId: 't1', id: 'w1' } },
                undefined,
                cappedConfig,
                true,
            );

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });
    });

    describe('tenant precision opt-in', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'], tenantPrecision: true });

        test('keeps different tenants disjoint', () => {
            const read = resolveCacheTags(
                'Widget',
                'findMany',
                { where: { tenantId: 't1' } },
                undefined,
                config,
                false,
            );
            const write = resolveCacheTags(
                'Widget',
                'update',
                { where: { tenantId: 't2', id: 'w1' } },
                undefined,
                config,
                true,
            );

            expect(overlappingTags(read.tags, write.tags)).toEqual([]);
        });

        test('keeps a tenant-ful write overlapping a tenant-less read', () => {
            const read = resolveCacheTags('Widget', 'findMany', {}, undefined, config, false);
            const write = resolveCacheTags(
                'Widget',
                'update',
                { where: { tenantId: 't1', id: 'w1' } },
                undefined,
                config,
                true,
            );

            expect(overlappingTags(read.tags, write.tags).length).toBeGreaterThan(0);
        });
    });

    test('falls back to the global namespace when no tenantKeys are configured', () => {
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, undefined, makeConfig(), false);

        expect(resolved.tags).toContain('global:model:Widget');
        expect(resolved.tenantIds).toEqual([]);
    });

    test('infers tenant, model, and entity tags when tenantKeys is configured', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findUnique', { where: { tenantId: 't1', id: 'w9' } }, undefined, config, false);

        expect(resolved.tenantIds).toEqual(['t1']);
        expect(resolved.entityIds).toEqual(['w9']);
        expect(resolved.tags).toEqual(
            expect.arrayContaining(['tenant:t1', 'tenant:t1:model:Widget', 'tenant:t1:widget:w9']),
        );
    });

    test('adds a global model fallback to tenant-scoped reads', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' } },
            undefined,
            config,
            false,
        );

        expect(resolved.tags).toContain('global:model:Widget');
    });

    test('extracts tenant ids from a nested relation filter', () => {
        const config = makeConfig({ tenantKeys: ['tenant'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenant: { id: 't7' } } }, undefined, config, false);

        expect(resolved.tenantIds).toEqual(['t7']);
    });

    test('extracts every value from an `in` filter', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: { in: ['t1', 't2'] } } }, undefined, config, false);

        expect(resolved.tenantIds.sort()).toEqual(['t1', 't2']);
    });

    test('merges explicit tags with inferred tags by default', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, { tags: ['custom:thing'] }, config, false);

        expect(resolved.tags).toContain('custom:thing');
        expect(resolved.tags).toContain('tenant:t1:model:Widget');
    });

    test('explicit tags replace inferred tags when mergeTags is false', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' } },
            { tags: ['only:this'], mergeTags: false },
            config,
            false,
        );

        expect(resolved.tags).toEqual(['only:this']);
    });

    test('explicit empty tags replace inferred tags when mergeTags is false', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' } },
            { tags: [], mergeTags: false },
            config,
            false,
        );

        expect(resolved.tags).toEqual([]);
    });

    test('skips inference entirely when inferTags is false', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'], inferTags: false });
        const resolved = resolveCacheTags('Widget', 'findMany', { where: { tenantId: 't1' } }, undefined, config, false);

        expect(resolved.tags).toEqual([]);
    });

    test('adds dependency model tags on writes when includeDependencies is true', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'], dependencyTags: { Widget: ['Part'] } });
        const resolved = resolveCacheTags('Widget', 'update', { where: { tenantId: 't1', id: 'w1' } }, undefined, config, true);

        expect(resolved.tags).toContain('tenant:t1:model:Part');
    });

    test('adds global dependency model tags when no tenant ids are inferred', () => {
        const config = makeConfig({ dependencyTags: { Widget: ['Part'] } });
        const resolved = resolveCacheTags('Widget', 'update', { where: { id: 'w1' } }, undefined, config, true);

        expect(resolved.tags).toContain('global:model:Part');
    });

    test('supports a dependency resolver function', () => {
        const config = makeConfig({
            tenantKeys: ['tenantId'],
            dependencyTags: {
                Widget: ({ tenantIds }) => tenantIds.map((tenantId) => `tenant:${tenantId}:custom`),
            },
        });
        const resolved = resolveCacheTags('Widget', 'update', { where: { tenantId: 't1' } }, undefined, config, true);

        expect(resolved.tags).toContain('tenant:t1:custom');
    });

    test('resolves dependencies when inferTags is false', () => {
        const config = makeConfig({
            inferTags: false,
            dependencyTags: {
                Widget: () => ['dependency:Widget'],
            },
        });
        const resolved = resolveCacheTags('Widget', 'update', { where: { id: 'w1' } }, undefined, config, true);

        expect(resolved.tags).toContain('dependency:Widget');
    });

    test('ignores pagination and projection keys when collecting ids', () => {
        const config = makeConfig({ tenantKeys: ['tenantId'] });
        const resolved = resolveCacheTags(
            'Widget',
            'findMany',
            { where: { tenantId: 't1' }, select: { id: true }, orderBy: { id: 'asc' }, take: 10 },
            undefined,
            config,
            false,
        );

        expect(resolved.entityIds).toEqual([]);
    });
});
