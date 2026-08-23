import { CACHE_SCHEMA_FORMAT_VERSION, type CacheModelConfigs, type CacheSchemaDescriptor } from '../../src/schema';

export const cacheSchema = {
    formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
    models: {
        Widget: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                tenantId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                name: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                description: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                parts: {
                    kind: 'relation',
                    target: 'Part',
                    isList: true,
                    relationName: 'PartToWidget',
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Part: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                tenantId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                label: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                description: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                widgetId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                widget: {
                    kind: 'relation',
                    target: 'Widget',
                    isList: false,
                    relationName: 'PartToWidget',
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        WorkOrder: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                equipment: {
                    kind: 'relation',
                    target: 'Equipment',
                    isList: true,
                    relationName: 'EquipmentToWorkOrder',
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
        Equipment: {
            fields: {
                id: { kind: 'scalar', type: 'String', isId: true, isUnique: true },
                organizationId: { kind: 'scalar', type: 'String', isId: false, isUnique: false },
                workOrders: {
                    kind: 'relation',
                    target: 'WorkOrder',
                    isList: true,
                    relationName: 'EquipmentToWorkOrder',
                },
            },
            primaryKey: ['id'],
            uniqueKeys: [['id']],
        },
    },
} as const satisfies CacheSchemaDescriptor;

export const cacheModels = {
    Widget: { tenant: { field: 'tenantId', namespace: 'tenant' } },
    Part: { tenant: { field: 'tenantId', namespace: 'tenant' } },
    WorkOrder: { tenant: { field: 'organizationId', namespace: 'organization' } },
    Equipment: { tenant: { field: 'organizationId', namespace: 'organization' } },
} as const satisfies CacheModelConfigs<typeof cacheSchema>;
