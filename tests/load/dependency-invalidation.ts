import {
    CACHE_SCHEMA_FORMAT_VERSION,
    createAnalysisContext,
    type CacheModelConfigs,
    type CacheSchemaDescriptor,
} from '../../src/schema';
import { analyzeReadTags } from '../../src/read-analysis';
import { analyzeWriteTags } from '../../src/write-analysis';
import {
    compareInvalidationFanout,
    type DependencyInvalidationProfile,
} from './dependency-invalidation-model';

const PROFILE: DependencyInvalidationProfile = {
    tenants: 100,
    modelsPerTenant: 20,
    queriesPerModel: 50,
    dependentModels: 2,
};
const TARGET_TENANT = 'synthetic-tenant-0';
const PRIMARY_MODEL = 'Model0';
const DEPENDENT_MODELS = ['Model1', 'Model2'] as const;
const REUSE_RATE = 0.1;

interface SyntheticSubscription {
    legacyTags: readonly string[];
    queryAwareTags: readonly string[];
}

function createBenchmarkContext() {
    const models: CacheSchemaDescriptor['models'] = {};
    for (let index = 0; index < PROFILE.modelsPerTenant; index += 1) {
        const modelName = `Model${index}`;
        models[modelName] = {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                tenantId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                ...(index === 0
                    ? {
                        dependentOne: {
                            kind: 'relation' as const,
                            target: DEPENDENT_MODELS[0],
                            isList: true,
                            relationName: 'Model0ToModel1',
                        },
                        dependentTwo: {
                            kind: 'relation' as const,
                            target: DEPENDENT_MODELS[1],
                            isList: true,
                            relationName: 'Model0ToModel2',
                        },
                    }
                    : {}),
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        };
    }

    const schema: CacheSchemaDescriptor = {
        formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
        models,
    };
    const configs: CacheModelConfigs = {};
    for (const modelName of Object.keys(models)) {
        configs[modelName] = { tenant: { field: 'tenantId', namespace: 'tenant' } };
    }
    return createAnalysisContext(schema, configs);
}

function analyzeRepresentativeReads(context: ReturnType<typeof createBenchmarkContext>, tenantId: string) {
    const where = { tenantId };
    const primaryOnly = analyzeReadTags({
        model: PRIMARY_MODEL,
        operation: 'findMany',
        args: { where },
        context,
        maxTagsPerQuery: 20,
    });
    const relationDependent = analyzeReadTags({
        model: PRIMARY_MODEL,
        operation: 'findMany',
        args: {
            where,
            include: {
                dependentOne: { select: { id: true } },
                dependentTwo: { select: { id: true } },
            },
        },
        context,
        maxTagsPerQuery: 20,
    });
    return { primaryOnly, relationDependent };
}

function tagsIntersect(subscriptionTags: readonly string[], publicationTags: readonly string[]): boolean {
    const publication = new Set(publicationTags);
    return subscriptionTags.some((tag) => publication.has(tag));
}

function countAffectedSubscriptions(
    subscriptions: readonly SyntheticSubscription[],
    publication: 'legacyTags' | 'queryAwareTags',
    publicationTags: readonly string[],
): number {
    return subscriptions.filter((subscription) => tagsIntersect(subscription[publication], publicationTags)).length;
}

function buildSyntheticSubscriptions(
    context: ReturnType<typeof createBenchmarkContext>,
): { subscriptions: SyntheticSubscription[]; publicationTags: string[]; analyses: ReturnType<typeof analyzeRepresentativeReads> } {
    const subscriptions: SyntheticSubscription[] = [];
    const targetAnalyses = analyzeRepresentativeReads(context, TARGET_TENANT);
    for (let tenantIndex = 0; tenantIndex < PROFILE.tenants; tenantIndex += 1) {
        const tenantId = `synthetic-tenant-${tenantIndex}`;
        const analyses = tenantId === TARGET_TENANT ? targetAnalyses : analyzeRepresentativeReads(context, tenantId);
        for (let modelIndex = 0; modelIndex < PROFILE.modelsPerTenant; modelIndex += 1) {
            for (let queryIndex = 0; queryIndex < PROFILE.queriesPerModel; queryIndex += 1) {
                const representative =
                    modelIndex === 0
                        ? analyses.primaryOnly
                        : modelIndex === 1
                            ? analyses.relationDependent
                            : modelIndex === 2
                                ? analyses.relationDependent
                                : analyzeReadTags({
                                    model: `Model${modelIndex}`,
                                    operation: 'findMany',
                                    args: { where: { tenantId } },
                                    context,
                                    maxTagsPerQuery: 20,
                                });
                subscriptions.push({
                    legacyTags: [
                        ...(tenantIndex === 0 ? ['legacy:tenant:synthetic-tenant-0'] : []),
                        ...(modelIndex === 0 ? ['legacy:model:Model0'] : []),
                    ],
                    queryAwareTags: representative.tags,
                });
            }
        }
    }

    const publication = analyzeWriteTags({
        model: PRIMARY_MODEL,
        operation: 'update',
        args: { where: { id: 'synthetic-row', tenantId: TARGET_TENANT }, data: { tenantId: TARGET_TENANT } },
        result: { id: 'synthetic-row', tenantId: TARGET_TENANT },
        context,
    });
    return { subscriptions, publicationTags: publication.tags, analyses: targetAnalyses };
}

function estimateRefills(affected: number): number {
    return affected * (1 - REUSE_RATE);
}

function main(): void {
    const context = createBenchmarkContext();
    const comparison = compareInvalidationFanout(PROFILE);
    const { subscriptions, publicationTags, analyses } = buildSyntheticSubscriptions(context);
    const legacyPublicationTags = ['legacy:model:Model0', 'legacy:tenant:synthetic-tenant-0'];
    const legacyAffected = countAffectedSubscriptions(subscriptions, 'legacyTags', legacyPublicationTags);
    const queryAwareAffected = countAffectedSubscriptions(subscriptions, 'queryAwareTags', publicationTags);

    if (legacyAffected !== comparison.legacyAffectedPerWrite || queryAwareAffected !== comparison.queryAwareAffectedPerWrite) {
        throw new Error(
            `Synthetic intersection mismatch: expected ${comparison.legacyAffectedPerWrite}/${comparison.queryAwareAffectedPerWrite}, ` +
            `observed ${legacyAffected}/${queryAwareAffected}`,
        );
    }
    if (publicationTags.some((tag) => tag.endsWith(':root') || tag.startsWith('global:'))) {
        throw new Error('Normal tenant-scoped publication unexpectedly included root/global fallback tags');
    }
    if (!analyses.primaryOnly.cacheable || !analyses.relationDependent.cacheable) {
        throw new Error('Representative read analysis unexpectedly bypassed caching');
    }

    console.log('Dependency invalidation fanout benchmark (deterministic synthetic workload)');
    console.log(
        `Assumptions: ${PROFILE.tenants} tenants, ${PROFILE.modelsPerTenant} models/tenant, ` +
        `${PROFILE.queriesPerModel} queries/model, ${PROFILE.dependentModels} dependent models, ` +
        `${REUSE_RATE * 100}% cache reuse after a write.`,
    );
    console.table([{
        'total entries': comparison.totalEntries,
        'legacy affected/write': legacyAffected,
        'query-aware affected/write': queryAwareAffected,
        reduction: `${comparison.reduction.toFixed(2)}x`,
    }]);
    console.table([
        {
            subscription: 'primary-only',
            dependencies: analyses.primaryOnly.dependencies.length,
            tags: analyses.primaryOnly.tags.length,
        },
        {
            subscription: 'relation-dependent',
            dependencies: analyses.relationDependent.dependencies.length,
            tags: analyses.relationDependent.tags.length,
        },
        {
            publication: 'tenant-scoped Model0 write',
            tags: publicationTags.length,
            'root/global fallback tags': 0,
        },
    ]);
    console.table([{
        'affected subscriptions': 'legacy',
        count: legacyAffected,
        'estimated refills (10% reuse)': estimateRefills(legacyAffected),
    }, {
        'affected subscriptions': 'query-aware',
        count: queryAwareAffected,
        'estimated refills (10% reuse)': estimateRefills(queryAwareAffected),
    }]);
    console.log(`PASS: query-aware invalidation is approximately ${comparison.reduction.toFixed(2)}x lower fanout.`);
}

void main();
