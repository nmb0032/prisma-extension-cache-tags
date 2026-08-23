import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GeneratorOptions } from '@prisma/generator-helper';
import { buildCacheSchemaDescriptor } from '../../src/generator/descriptor';
import { renderCacheSchemaModule, writeGeneratedCacheSchema } from '../../src/generator/render';

type Datamodel = GeneratorOptions['dmmf']['datamodel'];

const datamodelFixture = {
    models: [
        {
            name: 'WorkOrder',
            dbName: 'work_orders',
            fields: [
                {
                    name: 'equipment',
                    kind: 'object',
                    type: 'Equipment',
                    isList: true,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'EquipmentToWorkOrder',
                },
                {
                    name: 'code',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: false,
                    dbName: 'work_order_code',
                },
                {
                    name: 'id',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'labels',
                    kind: 'object',
                    type: 'Label',
                    isList: true,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'LabelToWorkOrder',
                },
                {
                    name: 'organizationId',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: false,
                    dbName: 'organization_id',
                },
            ],
            primaryKey: { name: null, fields: ['id'] },
            uniqueFields: [['organizationId', 'code']],
            uniqueIndexes: [],
        },
        {
            name: 'Label',
            fields: [
                {
                    name: 'code',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: false,
                },
                {
                    name: 'id',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: true,
                    isId: true,
                },
                {
                    name: 'workOrders',
                    kind: 'object',
                    type: 'WorkOrder',
                    isList: true,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'LabelToWorkOrder',
                },
            ],
            primaryKey: { name: null, fields: ['id'] },
            uniqueFields: [],
            uniqueIndexes: [],
        },
        {
            name: 'User',
            fields: [
                {
                    name: 'id',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'profile',
                    kind: 'object',
                    type: 'Profile',
                    isList: false,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'UserProfile',
                },
                {
                    name: 'manager',
                    kind: 'object',
                    type: 'User',
                    isList: false,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'UserHierarchy',
                },
                {
                    name: 'reports',
                    kind: 'object',
                    type: 'User',
                    isList: true,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'UserHierarchy',
                },
            ],
            primaryKey: { name: null, fields: ['id'] },
            uniqueFields: [],
            uniqueIndexes: [],
        },
        {
            name: 'Profile',
            fields: [
                {
                    name: 'id',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'user',
                    kind: 'object',
                    type: 'User',
                    isList: false,
                    isRequired: true,
                    isUnique: true,
                    isId: false,
                    relationName: 'UserProfile',
                },
            ],
            primaryKey: { name: null, fields: ['id'] },
            uniqueFields: [],
            uniqueIndexes: [],
        },
        {
            name: 'Equipment',
            fields: [
                {
                    name: 'id',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'workOrders',
                    kind: 'object',
                    type: 'WorkOrder',
                    isList: true,
                    isRequired: false,
                    isUnique: false,
                    isId: false,
                    relationName: 'EquipmentToWorkOrder',
                },
            ],
            primaryKey: { name: null, fields: ['id'] },
            uniqueFields: [],
            uniqueIndexes: [],
        },
        {
            name: 'Membership',
            fields: [
                {
                    name: 'userId',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'organizationId',
                    kind: 'scalar',
                    type: 'String',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: true,
                },
                {
                    name: 'user',
                    kind: 'object',
                    type: 'User',
                    isList: false,
                    isRequired: true,
                    isUnique: false,
                    isId: false,
                    relationName: 'MembershipToUser',
                },
            ],
            primaryKey: { name: 'MembershipKey', fields: ['organizationId', 'userId'] },
            uniqueFields: [['userId', 'organizationId']],
            uniqueIndexes: [],
        },
    ],
    enums: [],
    types: [],
} as unknown as Datamodel;

describe('buildCacheSchemaDescriptor', () => {
    test('converts relations and sorts models and fields deterministically', () => {
        const descriptor = buildCacheSchemaDescriptor(datamodelFixture);
        const workOrder = descriptor.models.WorkOrder!;
        const equipment = descriptor.models.Equipment!;
        const label = descriptor.models.Label!;
        const user = descriptor.models.User!;
        const profile = descriptor.models.Profile!;

        expect(Object.keys(descriptor.models)).toEqual(['Equipment', 'Label', 'Membership', 'Profile', 'User', 'WorkOrder']);
        expect(Object.keys(workOrder.fields)).toEqual([
            'code',
            'equipment',
            'id',
            'labels',
            'organizationId',
        ]);
        expect(workOrder.fields.equipment).toEqual({
            kind: 'relation',
            target: 'Equipment',
            isList: true,
            relationName: 'EquipmentToWorkOrder',
        });
        expect(equipment.fields.workOrders).toEqual({
            kind: 'relation',
            target: 'WorkOrder',
            isList: true,
            relationName: 'EquipmentToWorkOrder',
        });
        expect(workOrder.fields.labels).toEqual({
            kind: 'relation',
            target: 'Label',
            isList: true,
            relationName: 'LabelToWorkOrder',
        });
        expect(label.fields.workOrders).toEqual({
            kind: 'relation',
            target: 'WorkOrder',
            isList: true,
            relationName: 'LabelToWorkOrder',
        });
        expect(user.fields.profile).toEqual({
            kind: 'relation',
            target: 'Profile',
            isList: false,
            relationName: 'UserProfile',
        });
        expect(profile.fields.user).toEqual({
            kind: 'relation',
            target: 'User',
            isList: false,
            relationName: 'UserProfile',
        });
        expect(user.fields.manager).toEqual({
            kind: 'relation',
            target: 'User',
            isList: false,
            relationName: 'UserHierarchy',
        });
    });

    test('preserves key metadata and keeps mapped names out of descriptor keys', () => {
        const descriptor = buildCacheSchemaDescriptor(datamodelFixture);
        const workOrder = descriptor.models.WorkOrder!;
        const membership = descriptor.models.Membership!;

        expect(workOrder.primaryKey).toEqual(['id']);
        expect(membership.primaryKey).toEqual(['organizationId', 'userId']);
        expect(workOrder.uniqueKeys).toEqual([
            ['code', 'organizationId'],
            ['id'],
        ]);
        expect(membership.uniqueKeys).toEqual([
            ['organizationId', 'userId'],
        ]);
        expect(workOrder.dbName).toBe('work_orders');
        expect(workOrder.fields.code).toMatchObject({ dbName: 'work_order_code' });
        expect(workOrder.fields.organizationId).toMatchObject({ dbName: 'organization_id' });
        expect(Object.keys(descriptor.models)).not.toContain('work_orders');
        expect(Object.keys(workOrder.fields)).not.toContain('work_order_code');
        expect(workOrder.primaryKey).not.toContain('work_order_code');
    });
});

describe('renderCacheSchemaModule', () => {
    test('renders a typed literal descriptor', () => {
        const descriptor = buildCacheSchemaDescriptor(datamodelFixture);
        const rendered = renderCacheSchemaModule(descriptor);

        expect(rendered).toContain('export const cacheSchema =');
        expect(rendered).toContain('as const satisfies CacheSchemaDescriptor;');
        expect(rendered).toContain('"formatVersion": 1');
        expect(rendered.indexOf('"Equipment"')).toBeLessThan(rendered.indexOf('"WorkOrder"'));
    });

    test('writes the generated module to the configured output directory', async () => {
        const output = await mkdtemp(join(process.cwd(), '.cache-tags-generator-'));
        try {
            const descriptor = buildCacheSchemaDescriptor(datamodelFixture);
            await writeGeneratedCacheSchema(output, descriptor);

            expect(await readFile(join(output, 'index.ts'), 'utf8')).toBe(renderCacheSchemaModule(descriptor));
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });
});
