import { describe, expect, test } from 'vitest';
import { canonicalizePrismaValue } from '../../src/canonical';
import { analyzeWriteTags } from '../../src/write-analysis';
import { CACHE_SCHEMA_FORMAT_VERSION, createAnalysisContext } from '../../src/schema';
import { scopeEntityTag } from '../../src/tag-format';

const schema = {
    formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
    models: {
        Equipment: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                serial: { kind: 'scalar', type: 'String', isId: false, isUnique: true },
                workOrders: { kind: 'relation', target: 'WorkOrder', isList: true, relationName: 'EquipmentToWorkOrder' },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id'], ['serial']],
        },
        WorkOrder: {
            fields: {
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                number: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                siteId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                equipment: { kind: 'relation', target: 'Equipment', isList: false, relationName: 'EquipmentToWorkOrder' },
            },
            primaryKey: ['organizationId', 'number'],
            uniqueKeys: [['organizationId', 'number']],
        },
        AuditEvent: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
    },
} as const;

const context = createAnalysisContext(schema, {
    Equipment: { tenant: { field: 'organizationId', namespace: 'organization' } },
    WorkOrder: { tenant: { field: 'organizationId', namespace: 'organization' } },
    AuditEvent: { tenant: false },
});

describe('narrow write publication analysis', () => {
    test('publishes model and entity tags without root or global tags', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: '123' },
                create: { id: '123', organizationId: 'org_1', name: 'Pump' },
                update: { name: 'Pump' },
            },
            result: { id: '123', organizationId: 'org_1', name: 'Pump' },
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_1:entity:Equipment:123',
            'scope:organization:org_1:model:Equipment',
        ]);
        expect(result.tags.some((tag) => tag.endsWith(':root'))).toBe(false);
        expect(result.tags.some((tag) => tag.startsWith('global:'))).toBe(false);
        expect(result.changedModels).toEqual(['Equipment']);
        expect(result.tenantScope).toEqual(['organization:org_1']);
        expect(result.globalFallbackModels).toEqual([]);
    });

    test('publishes create, delete, and global model writes with the correct evidence', () => {
        expect(analyzeWriteTags({
            model: 'Equipment',
            operation: 'create',
            args: { data: { id: 'new', organizationId: 'org_1' } },
            result: { id: 'new', organizationId: 'org_1' },
            context,
        }).tags).toEqual([
            'scope:organization:org_1:entity:Equipment:new',
            'scope:organization:org_1:model:Equipment',
        ]);

        expect(analyzeWriteTags({
            model: 'Equipment',
            operation: 'delete',
            args: { where: { id: 'old', organizationId: 'org_1' } },
            result: { id: 'old', organizationId: 'org_1' },
            context,
        }).tags).toEqual([
            'scope:organization:org_1:entity:Equipment:old',
            'scope:organization:org_1:model:Equipment',
        ]);

        expect(analyzeWriteTags({
            model: 'AuditEvent',
            operation: 'create',
            args: { data: { id: 'audit_1' } },
            result: { id: 'audit_1' },
            context,
        }).tags).toEqual(['global:entity:AuditEvent:audit_1', 'global:model:AuditEvent']);
    });

    test('publishes all tenant scopes from bulk filters', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'updateMany',
            args: { where: { organizationId: { in: ['org_2', 'org_1'] } }, data: { serial: 'x' } },
            result: { count: 2 },
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_1:model:Equipment',
            'scope:organization:org_2:model:Equipment',
        ]);
        expect(result.tenantScope).toEqual(['organization:org_1', 'organization:org_2']);
    });

    test('publishes a global fallback when an old scope is unknowable', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'update',
            args: { where: { id: '123' }, data: { serial: 'x' } },
            result: { id: '123' },
            context,
        });

        expect(result.tags).toEqual(['global:model:Equipment']);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('handles tenant moves with separate old and new evidence', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'update',
            args: {
                where: { id: '123', organizationId: 'org_old' },
                data: { organizationId: 'org_new' },
            },
            result: { id: '123', organizationId: 'org_new' },
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_new:entity:Equipment:123',
            'scope:organization:org_new:model:Equipment',
            'scope:organization:org_old:entity:Equipment:123',
            'scope:organization:org_old:model:Equipment',
        ]);
        expect(result.tenantScope).toEqual(['organization:org_new', 'organization:org_old']);
        expect(result.globalFallbackModels).toEqual([]);
    });

    test('falls back for an unknown old scope during a tenant move', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'update',
            args: { where: { id: '123' }, data: { organizationId: 'org_new' } },
            result: { id: '123', organizationId: 'org_new' },
            context,
        });

        expect(result.tags).toEqual([
            'global:model:Equipment',
            'scope:organization:org_new:entity:Equipment:123',
            'scope:organization:org_new:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('does not use upsert create tenant as existing-row evidence', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: '123' },
                create: { id: '123', organizationId: 'org_create' },
                update: { organizationId: 'org_update' },
            },
            result: { id: '123', organizationId: 'org_update' },
            context,
        });

        expect(result.tags).toEqual([
            'global:model:Equipment',
            'scope:organization:org_create:entity:Equipment:123',
            'scope:organization:org_create:model:Equipment',
            'scope:organization:org_update:entity:Equipment:123',
            'scope:organization:org_update:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('uses returned tenant for both upsert states when update cannot move it', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: '123' },
                create: { id: '123', organizationId: 'org_create' },
                update: { serial: 'changed' },
            },
            result: { id: '123', organizationId: 'org_existing' },
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_existing:entity:Equipment:123',
            'scope:organization:org_existing:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual([]);
    });

    test('publishes possible create and existing upsert scopes without returned tenant', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: '123', organizationId: 'org_existing' },
                create: { id: '123', organizationId: 'org_create' },
                update: { serial: 'changed' },
            },
            result: undefined,
            context,
        });

        expect(result.globalFallbackModels).toEqual([]);
        expect(result.tags).toEqual([
            'scope:organization:org_create:entity:Equipment:123',
            'scope:organization:org_create:model:Equipment',
            'scope:organization:org_existing:entity:Equipment:123',
            'scope:organization:org_existing:model:Equipment',
        ]);
    });

    test('publishes composite identities using canonical identity encoding', () => {
        const identity = canonicalizePrismaValue({ organizationId: 'org_1', number: 'WO:7' });
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'create',
            args: { data: { organizationId: 'org_1', number: 'WO:7' } },
            result: { organizationId: 'org_1', number: 'WO:7' },
            context,
        });

        expect(result.tags).toContain(scopeEntityTag({ namespace: 'organization', id: 'org_1' }, 'WorkOrder', identity));
    });

    test('marks mutation-bearing nested writes changed without inheriting parent scope', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: { organizationId: 'org_1', number: 'WO:1' },
                data: {
                    equipment: {
                        create: { id: 'eq_1', organizationId: 'org_2' },
                        update: { where: { id: 'eq_2' }, data: { serial: 'changed' } },
                        connect: { id: 'eq_3' },
                    },
                },
            },
            result: { organizationId: 'org_1', number: 'WO:1' },
            context,
        });

        expect(result.changedModels).toEqual(['Equipment', 'WorkOrder']);
        expect(result.tags).toContain('scope:organization:org_1:model:WorkOrder');
        expect(result.tags).toContain('scope:organization:org_2:model:Equipment');
        expect(result.tags).toContain('global:model:Equipment');
        expect(result.tags).not.toContain('scope:organization:org_1:model:Equipment');
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('does not mark a related record changed for connect, disconnect, or set', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: { organizationId: 'org_1', number: 'WO:1' },
                data: { equipment: { connect: { id: 'eq_1' }, disconnect: { id: 'eq_2' }, set: [] } },
            },
            result: { organizationId: 'org_1', number: 'WO:1' },
            context,
        });

        expect(result.changedModels).toEqual(['WorkOrder']);
        expect(result.tags).not.toContain('global:model:Equipment');
    });

    test('marks every nested mutation form as changing the relation target', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: { organizationId: 'org_1', number: 'WO:1' },
                data: {
                    equipment: {
                        create: { id: 'create', organizationId: 'org_1' },
                        update: { where: { id: 'update', organizationId: 'org_1' }, data: { serial: 'u' } },
                        upsert: {
                            where: { id: 'upsert' },
                            create: { id: 'upsert', organizationId: 'org_1' },
                            update: { serial: 'upserted' },
                        },
                        delete: { id: 'delete', organizationId: 'org_1' },
                        createMany: { data: [{ id: 'many-create', organizationId: 'org_1' }] },
                        updateMany: { where: { organizationId: 'org_1' }, data: { serial: 'many-update' } },
                        deleteMany: { where: { organizationId: 'org_1' } },
                    },
                },
            },
            result: { organizationId: 'org_1', number: 'WO:1' },
            context,
        });

        expect(result.changedModels).toEqual(['Equipment', 'WorkOrder']);
        expect(result.tags).toContain('scope:organization:org_1:model:Equipment');
    });

    test('resolves scopes and identities from bulk create arrays', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'createMany',
            args: { data: [
                { id: 'eq_1', organizationId: 'org_1' },
                { id: 'eq_2', organizationId: 'org_2' },
            ] },
            result: { count: 2 },
            context,
        });

        expect(result.tenantScope).toEqual(['organization:org_1', 'organization:org_2']);
        expect(result.tags).toContain('scope:organization:org_1:entity:Equipment:eq_1');
        expect(result.tags).toContain('scope:organization:org_2:entity:Equipment:eq_2');
    });

    test('does not assign unknown bulk records to a known tenant scope', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'createMany',
            args: {
                data: [
                    { id: 'known', organizationId: 'org_1' },
                    { id: 'unknown' },
                ],
            },
            result: { count: 2 },
            context,
        });

        expect(result.tags).toEqual([
            'global:model:Equipment',
            'scope:organization:org_1:entity:Equipment:known',
            'scope:organization:org_1:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('keeps an upsert create branch conservative when its tenant is unknown', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: 'upserted', organizationId: 'org_existing' },
                create: { id: 'upserted', name: 'new' },
                update: { name: 'existing' },
            },
            result: undefined,
            context,
        });

        expect(result.tags).toEqual([
            'global:model:Equipment',
            'scope:organization:org_existing:entity:Equipment:upserted',
            'scope:organization:org_existing:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('falls back when an upsert create scope cannot prove the update branch', () => {
        const result = analyzeWriteTags({
            model: 'Equipment',
            operation: 'upsert',
            args: {
                where: { id: 'upserted' },
                create: { id: 'upserted', organizationId: 'org_create' },
                update: { serial: 'existing' },
            },
            result: undefined,
            context,
        });

        expect(result.tags).toEqual([
            'global:model:Equipment',
            'scope:organization:org_create:entity:Equipment:upserted',
            'scope:organization:org_create:model:Equipment',
        ]);
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('resolves logical and compound predicates without using relation tenants', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: {
                    AND: [
                        { OR: [{ organizationId_number: { organizationId: 'org_1', number: 'WO:1' } }] },
                        { equipment: { organizationId: 'org_relation' } },
                    ],
                },
                data: { number: 'WO:updated' },
            },
            result: undefined,
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_1:model:WorkOrder',
        ]);
        expect(result.tenantScope).toEqual(['organization:org_1']);
        expect(result.globalFallbackModels).toEqual([]);
    });

    test('does not treat arbitrary scalar objects as compound predicates', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: {
                    metadata: { organizationId: 'org_fake', number: 'WO:1' },
                },
                data: { number: 'WO:updated' },
            },
            result: undefined,
            context,
        });

        expect(result.tags).toEqual(['global:model:WorkOrder']);
        expect(result.tenantScope).toEqual([]);
        expect(result.globalFallbackModels).toEqual(['WorkOrder']);
    });

    test('treats connectOrCreate as a nested mutation with conservative fallback', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'update',
            args: {
                where: { organizationId: 'org_1', number: 'WO:1' },
                data: {
                    equipment: {
                        connectOrCreate: {
                            where: { id: 'equipment' },
                            create: { id: 'equipment', name: 'new' },
                        },
                    },
                },
            },
            result: { organizationId: 'org_1', number: 'WO:1' },
            context,
        });

        expect(result.changedModels).toEqual(['Equipment', 'WorkOrder']);
        expect(result.tags).toContain('global:model:Equipment');
        expect(result.tags).not.toContain('scope:organization:org_1:model:Equipment');
        expect(result.globalFallbackModels).toEqual(['Equipment']);
    });

    test('omits composite entity tags when any identity component is invalid', () => {
        const result = analyzeWriteTags({
            model: 'WorkOrder',
            operation: 'create',
            args: { data: { organizationId: 'org_1', number: undefined } },
            result: { organizationId: 'org_1', number: undefined },
            context,
        });

        expect(result.tags).toEqual([
            'scope:organization:org_1:model:WorkOrder',
        ]);
    });
});
