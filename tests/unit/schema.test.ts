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

    test.each([
        ['empty model name', { models: { '': schema.models.WorkOrder } }, 'model name must not be empty'],
        [
            'empty field name',
            {
                models: {
                    ...schema.models,
                    WorkOrder: { ...schema.models.WorkOrder, fields: { ...schema.models.WorkOrder.fields, '': schema.models.WorkOrder.fields.id } },
                },
            },
            'WorkOrder field name must not be empty',
        ],
        [
            'empty scalar type',
            {
                models: {
                    ...schema.models,
                    WorkOrder: {
                        ...schema.models.WorkOrder,
                        fields: { ...schema.models.WorkOrder.fields, id: { ...schema.models.WorkOrder.fields.id, type: ' ' } },
                    },
                },
            },
            'WorkOrder scalar field "id" type must not be empty',
        ],
        [
            'empty relation target',
            {
                models: {
                    ...schema.models,
                    WorkOrder: {
                        ...schema.models.WorkOrder,
                        fields: { ...schema.models.WorkOrder.fields, equipment: { ...schema.models.WorkOrder.fields.equipment, target: ' ' } },
                    },
                },
            },
            'WorkOrder relation "equipment" target must not be empty',
        ],
        [
            'empty relation name',
            {
                models: {
                    ...schema.models,
                    WorkOrder: {
                        ...schema.models.WorkOrder,
                        fields: { ...schema.models.WorkOrder.fields, equipment: { ...schema.models.WorkOrder.fields.equipment, relationName: '' } },
                    },
                },
            },
            'WorkOrder relation "equipment" relationName must not be empty',
        ],
    ])('rejects %s', (_description, override, message) => {
        expect(() => createAnalysisContext({ ...schema, ...override } as never, {})).toThrow(message);
    });

    test.each([
        ['an empty primary key', { primaryKey: [] }, 'primary key must contain at least one field'],
        ['an empty primary key component', { primaryKey: [''] }, 'primary key field name must not be empty'],
        ['a missing primary key field', { primaryKey: ['missing'] }, 'primary key field "missing" does not exist'],
        ['a relation in the primary key', { primaryKey: ['equipment'] }, 'primary key field "equipment" must be scalar'],
        ['a duplicate primary key component', { primaryKey: ['id', 'id'] }, 'primary key contains duplicate field "id"'],
    ])('rejects %s', (_description, keyOverride, message) => {
        const model = { ...schema.models.WorkOrder, ...keyOverride };
        expect(() =>
            createAnalysisContext({ ...schema, models: { ...schema.models, WorkOrder: model } } as never, {}),
        ).toThrow(message);
    });

    test.each([
        ['an empty unique key', { uniqueKeys: [[]] }, 'unique key at index 0 must contain at least one field'],
        ['an empty unique key component', { uniqueKeys: [['']] }, 'unique key at index 0 field name must not be empty'],
        ['a missing unique key field', { uniqueKeys: [['missing']] }, 'unique key at index 0 field "missing" does not exist'],
        ['a relation in a unique key', { uniqueKeys: [['equipment']] }, 'unique key at index 0 field "equipment" must be scalar'],
        ['a duplicate unique key component', { uniqueKeys: [['id', 'id']] }, 'unique key at index 0 contains duplicate field "id"'],
    ])('rejects %s', (_description, keyOverride, message) => {
        const model = { ...schema.models.WorkOrder, ...keyOverride };
        expect(() =>
            createAnalysisContext({ ...schema, models: { ...schema.models, WorkOrder: model } } as never, {}),
        ).toThrow(message);
    });

    test.each([
        [
            'an empty compound key name',
            { compoundUniqueKeys: [{ name: ' ', fields: ['organizationId', 'id'] }] },
            'compound unique key name must not be empty',
        ],
        [
            'a compound key with too few fields',
            { compoundUniqueKeys: [{ name: 'compound', fields: ['id'] }] },
            'compound unique key "compound" must contain at least two fields',
        ],
        [
            'a compound key with an unknown field',
            { compoundUniqueKeys: [{ name: 'compound', fields: ['organizationId', 'missing'] }] },
            'compound unique key "compound" field "missing" does not exist',
        ],
        [
            'a compound key with duplicate fields',
            { compoundUniqueKeys: [{ name: 'compound', fields: ['id', 'id'] }] },
            'compound unique key "compound" contains duplicate field "id"',
        ],
    ])('rejects %s', (_description, keyOverride, message) => {
        const model = { ...schema.models.WorkOrder, ...keyOverride };
        expect(() =>
            createAnalysisContext({ ...schema, models: { ...schema.models, WorkOrder: model } } as never, {}),
        ).toThrow(message);
    });
});
