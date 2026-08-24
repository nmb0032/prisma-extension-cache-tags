import type { ReadDependencyResolver } from './types';

export const CACHE_SCHEMA_FORMAT_VERSION = 1 as const;

export type CacheFieldDescriptor =
    | {
          kind: 'scalar';
          type: string;
          isId: boolean;
          isUnique: boolean;
          dbName?: string | null;
      }
    | {
          kind: 'relation';
          target: string;
          isList: boolean;
          relationName: string;
          dbName?: string | null;
      };

export interface CacheModelDescriptor {
    fields: Record<string, CacheFieldDescriptor>;
    primaryKey: readonly string[];
    uniqueKeys: readonly (readonly string[])[];
    compoundUniqueKeys?: readonly {
        name: string;
        fields: readonly string[];
    }[];
    dbName?: string | null;
}

export interface CacheSchemaDescriptor {
    formatVersion: typeof CACHE_SCHEMA_FORMAT_VERSION;
    models: Record<string, CacheModelDescriptor>;
}

export interface CacheScope {
    namespace: string;
    id: string;
}

export type CacheModelScopeConfig =
    | { tenant: false; readDependencies?: ReadDependencyResolver }
    | { tenant: { field: string; namespace: string }; readDependencies?: ReadDependencyResolver };

export type CacheModelConfig = CacheModelScopeConfig;

export type CacheModelConfigs<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> =
    Partial<Record<keyof TSchema['models'] & string, CacheModelScopeConfig>>;

export interface IndexedModel {
    descriptor: CacheModelDescriptor;
    relations: Record<string, Extract<CacheFieldDescriptor, { kind: 'relation' }>>;
    scope:
        | { kind: 'global' }
        | { kind: 'tenant'; field: string; namespace: string }
        | { kind: 'unconfigured' };
    readDependencies?: ReadDependencyResolver;
}

export interface AnalysisContext<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> {
    schema: TSchema;
    models: Record<string, IndexedModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSchema(schema: CacheSchemaDescriptor): void {
    if (!isRecord(schema) || schema.formatVersion !== CACHE_SCHEMA_FORMAT_VERSION) {
        throw new Error(
            `Unsupported cache schema format version: ${isRecord(schema) ? String(schema.formatVersion) : 'unknown'}`,
        );
    }

    if (!isRecord(schema.models)) {
        throw new Error('Cache schema models must be an object');
    }

    for (const [modelName, descriptor] of Object.entries(schema.models)) {
        if (modelName.trim() === '') {
            throw new Error('Cache schema model name must not be empty');
        }
        if (!isRecord(descriptor) || !isRecord(descriptor.fields)) {
            throw new Error(`Cache model "${modelName}" has an invalid descriptor`);
        }
        if (
            !Array.isArray(descriptor.primaryKey) ||
            !descriptor.primaryKey.every((fieldName) => typeof fieldName === 'string') ||
            !Array.isArray(descriptor.uniqueKeys) ||
            !descriptor.uniqueKeys.every(
                (key) => Array.isArray(key) && key.every((fieldName) => typeof fieldName === 'string'),
            )
        ) {
            throw new Error(`Cache model "${modelName}" has invalid key metadata`);
        }
        if (
            Object.prototype.hasOwnProperty.call(descriptor, 'compoundUniqueKeys')
            && (!Array.isArray(descriptor.compoundUniqueKeys)
                || !descriptor.compoundUniqueKeys.every(
                    (key) =>
                        isRecord(key)
                        && typeof key.name === 'string'
                        && Array.isArray(key.fields)
                        && key.fields.every((fieldName) => typeof fieldName === 'string'),
                ))
        ) {
            throw new Error(`Cache model "${modelName}" has invalid compound key metadata`);
        }
        if (
            Object.prototype.hasOwnProperty.call(descriptor, 'dbName') &&
            descriptor.dbName !== null &&
            typeof descriptor.dbName !== 'string'
        ) {
            throw new Error(`Cache model "${modelName}" has an invalid dbName`);
        }

        for (const [fieldName, field] of Object.entries(descriptor.fields)) {
            if (fieldName.trim() === '') {
                throw new Error(`${modelName} field name must not be empty`);
            }
            if (!isRecord(field)) {
                throw new Error(`${modelName} field "${fieldName}" has an invalid descriptor`);
            }
            if (
                Object.prototype.hasOwnProperty.call(field, 'dbName') &&
                field.dbName !== null &&
                typeof field.dbName !== 'string'
            ) {
                throw new Error(`${modelName} field "${fieldName}" has an invalid dbName`);
            }
            if (field.kind === 'scalar') {
                if (
                    typeof field.type !== 'string' ||
                    typeof field.isId !== 'boolean' ||
                    typeof field.isUnique !== 'boolean'
                ) {
                    throw new Error(`${modelName} field "${fieldName}" has an invalid scalar descriptor`);
                }
                if (field.type.trim() === '') {
                    throw new Error(`${modelName} scalar field "${fieldName}" type must not be empty`);
                }
            } else if (field.kind === 'relation') {
                if (
                    typeof field.target !== 'string' ||
                    typeof field.isList !== 'boolean' ||
                    typeof field.relationName !== 'string'
                ) {
                    throw new Error(`${modelName} relation "${fieldName}" has an invalid descriptor`);
                }
                if (field.target.trim() === '') {
                    throw new Error(`${modelName} relation "${fieldName}" target must not be empty`);
                }
                if (field.relationName.trim() === '') {
                    throw new Error(`${modelName} relation "${fieldName}" relationName must not be empty`);
                }
            } else {
                throw new Error(`${modelName} field "${fieldName}" has an invalid descriptor`);
            }
        }

        const validateKey = (key: unknown, label: string, index?: number): void => {
            const keyLabel = index === undefined ? label : `${label} at index ${index}`;
            if (!Array.isArray(key) || key.length === 0) {
                throw new Error(`${modelName} ${keyLabel} must contain at least one field`);
            }
            const seen = new Set<string>();
            for (const fieldName of key) {
                if (typeof fieldName !== 'string' || fieldName.trim() === '') {
                    throw new Error(`${modelName} ${keyLabel} field name must not be empty`);
                }
                if (seen.has(fieldName)) {
                    throw new Error(`${modelName} ${keyLabel} contains duplicate field "${fieldName}"`);
                }
                seen.add(fieldName);
                const field = descriptor.fields[fieldName];
                if (!field) {
                    throw new Error(`${modelName} ${keyLabel} field "${fieldName}" does not exist`);
                }
                if (field.kind !== 'scalar') {
                    throw new Error(`${modelName} ${keyLabel} field "${fieldName}" must be scalar`);
                }
            }
        };

        validateKey(descriptor.primaryKey, 'primary key');
        descriptor.uniqueKeys.forEach((key, index) => validateKey(key, 'unique key', index));

        if (descriptor.compoundUniqueKeys) {
            const names = new Set<string>();
            descriptor.compoundUniqueKeys.forEach((key) => {
                if (key.name.trim() === '') {
                    throw new Error(`${modelName} compound unique key name must not be empty`);
                }
                if (names.has(key.name)) {
                    throw new Error(`${modelName} compound unique key "${key.name}" is duplicated`);
                }
                names.add(key.name);
                if (key.fields.length < 2) {
                    throw new Error(
                        `${modelName} compound unique key "${key.name}" must contain at least two fields`,
                    );
                }
                validateKey(key.fields, `compound unique key "${key.name}"`);
            });
        }
    }

    for (const [modelName, descriptor] of Object.entries(schema.models)) {
        for (const [fieldName, field] of Object.entries(descriptor.fields)) {
            if (
                isRecord(field) &&
                field.kind === 'relation' &&
                !Object.prototype.hasOwnProperty.call(schema.models, field.target)
            ) {
                throw new Error(
                    `${modelName} relation "${fieldName}" targets unknown model "${String(field.target)}"`,
                );
            }
        }
    }
}

function validateConfigs<TSchema extends CacheSchemaDescriptor>(
    schema: TSchema,
    configs: CacheModelConfigs<TSchema>,
): void {
    if (!isRecord(configs)) {
        throw new Error('Cache model configurations must be an object');
    }

    for (const [modelName, config] of Object.entries(configs)) {
        if (!Object.prototype.hasOwnProperty.call(schema.models, modelName)) {
            throw new Error(`Configured model "${modelName}" does not exist in the schema`);
        }
        if (!isRecord(config) || !('tenant' in config)) {
            throw new Error(`Configured model "${modelName}" has an invalid scope configuration`);
        }
        if (config.tenant === false) {
            continue;
        }
        if (!isRecord(config.tenant)) {
            throw new Error(`Configured model "${modelName}" has an invalid tenant configuration`);
        }

        const fieldName = config.tenant.field;
        const descriptor = schema.models[modelName];
        const field = typeof fieldName === 'string' ? descriptor?.fields[fieldName] : undefined;
        if (!field || field.kind !== 'scalar') {
            throw new Error(`${modelName} tenant field "${String(fieldName)}" is not a scalar field`);
        }
        if (typeof config.tenant.namespace !== 'string' || config.tenant.namespace.trim() === '') {
            throw new Error(`${modelName} tenant namespace must not be empty`);
        }
    }
}

export function createAnalysisContext<TSchema extends CacheSchemaDescriptor>(
    schema: TSchema,
    configs: CacheModelConfigs<TSchema>,
): AnalysisContext<TSchema> {
    validateSchema(schema);
    validateConfigs(schema, configs);

    const models: Record<string, IndexedModel> = {};
    for (const [modelName, descriptor] of Object.entries(schema.models)) {
        const relations: Record<string, Extract<CacheFieldDescriptor, { kind: 'relation' }>> = {};
        for (const [fieldName, field] of Object.entries(descriptor.fields)) {
            if (field.kind === 'relation') {
                relations[fieldName] = field;
            }
        }

        const config = configs[modelName as keyof TSchema['models'] & string];
        let scope: IndexedModel['scope'];
        if (!config) {
            scope = { kind: 'unconfigured' };
        } else if (config.tenant === false) {
            scope = { kind: 'global' };
        } else {
            scope = {
                kind: 'tenant',
                field: config.tenant.field,
                namespace: config.tenant.namespace,
            };
        }

        models[modelName] = {
            descriptor,
            relations,
            scope,
            ...(config?.readDependencies ? { readDependencies: config.readDependencies } : {}),
        };
    }

    return { schema, models };
}
