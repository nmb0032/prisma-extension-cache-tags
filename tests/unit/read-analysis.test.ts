import { describe, expect, test } from 'vitest';
import { analyzePrimaryScope, analyzeReadTags } from '../../src/read-analysis';
import { CACHE_SCHEMA_FORMAT_VERSION, createAnalysisContext } from '../../src/schema';
import { resolveModelScopes } from '../../src/scope-resolution';

const schema = {
    formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
    models: {
        WorkOrder: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                equipmentIds: { kind: 'scalar', type: 'String[]', isId: false, isUnique: false },
                equipment: { kind: 'relation', target: 'Equipment', isList: true, relationName: 'EquipmentToWorkOrder' },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Equipment: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                manufacturer: { kind: 'relation', target: 'Manufacturer', isList: false, relationName: 'ManufacturerToEquipment' },
                workOrders: { kind: 'relation', target: 'WorkOrder', isList: true, relationName: 'EquipmentToWorkOrder' },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Manufacturer: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        AuditEvent: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        MaintenancePolicy: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
    },
} as const;

const modelConfigs = {
    WorkOrder: { tenant: { field: 'organizationId', namespace: 'organization' } },
    Equipment: { tenant: { field: 'organizationId', namespace: 'organization' } },
    Manufacturer: { tenant: { field: 'organizationId', namespace: 'organization' } },
    AuditEvent: { tenant: false },
    MaintenancePolicy: { tenant: { field: 'organizationId', namespace: 'organization' } },
} as const;

const context = createAnalysisContext(schema, modelConfigs);

describe('schema-aware read analysis', () => {
    test('subscribes included relations without broadening unrelated models', () => {
        const result = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: {
                where: { organizationId: 'org_1' },
                include: { equipment: { select: { manufacturer: true } } },
            },
            context,
            maxTagsPerQuery: 30,
        });

        expect(result.dependencies).toEqual(['Equipment', 'Manufacturer', 'WorkOrder']);
        expect(result.tags).toEqual(expect.arrayContaining([
            'scope:organization:org_1:root',
            'scope:organization:org_1:model:WorkOrder',
            'scope:organization:org_1:model:Equipment',
            'scope:organization:org_1:model:Manufacturer',
            'global:model:WorkOrder',
            'global:model:Equipment',
            'global:model:Manufacturer',
        ]));
    });

    test('does not treat scalar foreign-key-like fields as relations', () => {
        const result = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1', equipmentIds: { has: 'eq_1' } } },
            context,
            maxTagsPerQuery: 30,
        });

        expect(result.dependencies).toEqual(['WorkOrder']);
    });

    test('follows relation filters, ordering, counts, logical wrappers, and cycles', () => {
        const result = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: {
                where: {
                    organizationId: { in: ['org_1'] },
                    AND: [
                        { equipment: { some: { manufacturer: { is: { organizationId: 'org_1' } } } } },
                        { equipment: { every: { workOrders: { none: { organizationId: 'org_1' } } } } },
                    ],
                },
                orderBy: { equipment: { _count: 'desc' } },
                _count: { select: { equipment: true } },
            },
            context,
            maxTagsPerQuery: 30,
        });

        expect(result.cacheable).toBe(true);
        expect(result.dependencies).toEqual(['Equipment', 'Manufacturer', 'WorkOrder']);
        expect(resolveModelScopes({
            model: 'WorkOrder',
            values: [{ organizationId: 'wrong', equipment: { some: { organizationId: 'org_1' } } }],
            context,
        })).toEqual([{ namespace: 'organization', id: 'org_1' }, { namespace: 'organization', id: 'wrong' }]);
    });

    test('requires an independently proven scope across namespaces', () => {
        const crossNamespace = createAnalysisContext(schema, {
            ...modelConfigs,
            Equipment: { tenant: { field: 'organizationId', namespace: 'account' } },
        });
        expect(analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1' }, include: { equipment: true } },
            context: crossNamespace,
            maxTagsPerQuery: 30,
        })).toMatchObject({ cacheable: false, bypassReason: 'cross-namespace-scope-unknown' });
        const scoped = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: {
                where: { organizationId: 'org_1' },
                include: { equipment: { where: { organizationId: 'acct_1' } } },
            },
            context: crossNamespace,
            maxTagsPerQuery: 30,
        });
        expect(scoped.cacheable).toBe(true);
        expect(scoped.tags).toContain('scope:account:acct_1:model:Equipment');
    });

    test('merges custom dependencies with inferred scope', () => {
        const configured = createAnalysisContext(schema, {
            ...modelConfigs,
            WorkOrder: {
                tenant: { field: 'organizationId', namespace: 'organization' },
                readDependencies: () => [
                    { model: 'MaintenancePolicy' },
                    { tag: 'external:dispatch-board' },
                ],
            },
        });
        const result = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1' } },
            context: configured,
            maxTagsPerQuery: 30,
        });

        expect(result.dependencies).toEqual(['MaintenancePolicy', 'WorkOrder']);
        expect(result.tags).toContain('external:dispatch-board');
        expect(result.tags).toContain('scope:organization:org_1:model:MaintenancePolicy');
    });

    test('bypasses an unscoped primary model and missing tenant scope', () => {
        expect(analyzePrimaryScope({ model: 'AuditEvent', args: {}, context })).toMatchObject({
            cacheable: true,
            dependencies: ['AuditEvent'],
        });
        expect(analyzePrimaryScope({ model: 'WorkOrder', args: {}, context })).toMatchObject({
            cacheable: false,
            bypassReason: 'tenant-scope-missing',
        });
        expect(analyzePrimaryScope({ model: 'Missing', args: {}, context })).toMatchObject({
            cacheable: false,
            bypassReason: 'model-scope-unconfigured',
        });
    });

    test('bypasses unknown structural fields and tag overflows without truncating', () => {
        expect(analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1', unknownRelation: true } },
            context,
            maxTagsPerQuery: 30,
        })).toMatchObject({ cacheable: false, bypassReason: 'relation-field-unknown' });

        const result = analyzeReadTags({
            model: 'WorkOrder',
            operation: 'findMany',
            args: { where: { organizationId: 'org_1' } },
            context,
            maxTagsPerQuery: 1,
        });
        expect(result).toMatchObject({ cacheable: false, bypassReason: 'dependency-tag-limit' });
        expect(result.tags.length).toBeGreaterThan(1);
    });
});
