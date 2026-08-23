import { describe, expect, test } from 'vitest';
import { CACHE_SCHEMA_FORMAT_VERSION, createAnalysisContext } from '../../src/schema';

const schema = {
    formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
    models: {
        WorkOrder: {
            dbName: 'work_orders',
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true, dbName: 'id' },
                organizationId: {
                    kind: 'scalar',
                    type: 'String',
                    isId: false,
                    isUnique: false,
                    dbName: 'organization_id',
                },
                equipment: {
                    kind: 'relation',
                    target: 'Equipment',
                    isList: true,
                    relationName: 'EquipmentToWorkOrder',
                    dbName: null,
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Equipment: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
    },
} as const;

describe('createAnalysisContext', () => {
    test('indexes valid model scopes and relations', () => {
        const context = createAnalysisContext(schema, {
            WorkOrder: { tenant: { field: 'organizationId', namespace: 'organization' } },
            Equipment: { tenant: { field: 'organizationId', namespace: 'organization' } },
        });

        expect(context.models.WorkOrder!.scope).toEqual({
            kind: 'tenant',
            field: 'organizationId',
            namespace: 'organization',
        });
        expect(context.models.WorkOrder!.relations.equipment!.target).toBe('Equipment');
        expect(context.models.WorkOrder!.descriptor.dbName).toBe('work_orders');
        expect(context.models.WorkOrder!.descriptor.fields.organizationId!.dbName).toBe('organization_id');
    });

    test('marks false and missing scope configurations distinctly', () => {
        const context = createAnalysisContext(schema, { Equipment: { tenant: false } });

        expect(context.models.Equipment!.scope).toEqual({ kind: 'global' });
        expect(context.models.WorkOrder!.scope).toEqual({ kind: 'unconfigured' });
    });

    test('rejects a tenant field absent from the descriptor', () => {
        expect(() =>
            createAnalysisContext(schema, {
                WorkOrder: { tenant: { field: 'missing', namespace: 'organization' } },
            }),
        ).toThrow('WorkOrder tenant field "missing" is not a scalar field');
    });

    test('rejects an invalid format version', () => {
        expect(() =>
            createAnalysisContext(
                { ...schema, formatVersion: 2 } as never,
                {},
            ),
        ).toThrow('Unsupported cache schema format version');
    });

    test('rejects relations targeting unknown models', () => {
        expect(() =>
            createAnalysisContext(
                {
                    ...schema,
                    models: {
                        ...schema.models,
                        WorkOrder: {
                            ...schema.models.WorkOrder,
                            fields: {
                                ...schema.models.WorkOrder.fields,
                                equipment: {
                                    ...schema.models.WorkOrder.fields.equipment,
                                    target: 'Missing',
                                },
                            },
                        },
                    },
                } as never,
                {},
            ),
        ).toThrow('WorkOrder relation "equipment" targets unknown model "Missing"');
    });

    test('rejects unknown configured models', () => {
        expect(() =>
            createAnalysisContext(schema, {
                Missing: { tenant: false },
            } as never),
        ).toThrow('Configured model "Missing" does not exist in the schema');
    });

    test('rejects empty tenant namespaces', () => {
        expect(() =>
            createAnalysisContext(schema, {
                WorkOrder: { tenant: { field: 'organizationId', namespace: '  ' } },
            }),
        ).toThrow('WorkOrder tenant namespace must not be empty');
    });
});
