import type { GeneratorOptions } from '@prisma/generator-helper';
import { CACHE_SCHEMA_FORMAT_VERSION, type CacheFieldDescriptor, type CacheSchemaDescriptor } from '../schema';

type Datamodel = GeneratorOptions['dmmf']['datamodel'];
type DatamodelModel = Datamodel['models'][number];
type DatamodelField = DatamodelModel['fields'][number];

function mappedName(value: string | null | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
    const leftValue = left.join('\u0000');
    const rightValue = right.join('\u0000');
    return compareStrings(leftValue, rightValue);
}

function normalizedKey(fields: readonly string[]): string[] {
    return [...fields].sort(compareStrings);
}

function uniqueKeys(model: DatamodelModel, primaryKey: readonly string[]): string[][] {
    const keys: string[][] = [];

    if (primaryKey.length > 0) {
        keys.push([...primaryKey]);
    }

    for (const field of model.fields) {
        if (field.isUnique && !field.isId) {
            keys.push([field.name]);
        }
    }

    for (const fields of model.uniqueFields) {
        keys.push(normalizedKey(fields));
    }
    for (const index of model.uniqueIndexes) {
        keys.push(normalizedKey(index.fields));
    }

    const deduplicated = new Map<string, string[]>();
    for (const key of keys) {
        const normalized = normalizedKey(key);
        deduplicated.set(normalized.join('\u0000'), normalized);
    }

    return [...deduplicated.values()].sort(compareKeys);
}

function compoundUniqueKeys(model: DatamodelModel, primaryKey: readonly string[]) {
    const keys: { name: string; fields: string[] }[] = [];
    if (primaryKey.length > 1) {
        keys.push({
            name: model.primaryKey?.name ?? primaryKey.join('_'),
            fields: [...primaryKey],
        });
    }
    for (const fields of model.uniqueFields) {
        if (fields.length > 1) {
            keys.push({ name: fields.join('_'), fields: [...fields] });
        }
    }
    for (const index of model.uniqueIndexes) {
        if (index.fields.length > 1) {
            keys.push({
                name: index.name ?? index.fields.join('_'),
                fields: [...index.fields],
            });
        }
    }

    const deduplicated = new Map<string, { name: string; fields: string[] }>();
    for (const key of keys) {
        deduplicated.set(key.name, key);
    }
    return [...deduplicated.values()].sort((left, right) => compareStrings(left.name, right.name));
}

function fieldDescriptor(field: DatamodelField): CacheFieldDescriptor {
    const dbName = mappedName(field.dbName);
    if (field.kind === 'object') {
        if (!field.relationName) {
            throw new Error(`Relation field "${field.name}" is missing a relation name`);
        }
        return {
            kind: 'relation',
            target: field.type,
            isList: field.isList,
            relationName: field.relationName,
            ...(dbName === undefined ? {} : { dbName }),
        };
    }

    return {
        kind: 'scalar',
        type: field.type,
        isId: field.isId,
        isUnique: field.isUnique,
        ...(dbName === undefined ? {} : { dbName }),
    };
}

function modelDescriptor(model: DatamodelModel) {
    const primaryKey = model.primaryKey?.fields
        ? [...model.primaryKey.fields]
        : model.fields.filter((field) => field.isId).map((field) => field.name);
    const fields = Object.fromEntries(
        [...model.fields]
            .sort((left, right) => compareStrings(left.name, right.name))
            .map((field) => [field.name, fieldDescriptor(field)]),
    );
    const dbName = mappedName(model.dbName);

    return {
        fields,
        primaryKey,
        uniqueKeys: uniqueKeys(model, primaryKey),
        ...(compoundUniqueKeys(model, primaryKey).length > 0
            ? { compoundUniqueKeys: compoundUniqueKeys(model, primaryKey) }
            : {}),
        ...(dbName === undefined ? {} : { dbName }),
    };
}

export function buildCacheSchemaDescriptor(datamodel: Datamodel): CacheSchemaDescriptor {
    return {
        formatVersion: CACHE_SCHEMA_FORMAT_VERSION,
        models: Object.fromEntries(
            [...datamodel.models]
                .sort((left, right) => compareStrings(left.name, right.name))
                .map((model) => [model.name, modelDescriptor(model)]),
        ),
    };
}
