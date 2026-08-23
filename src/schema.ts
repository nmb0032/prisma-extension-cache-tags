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
    | { tenant: false }
    | { tenant: { field: string; namespace: string } };

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
}

export interface AnalysisContext {
    schema: CacheSchemaDescriptor;
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
            Object.prototype.hasOwnProperty.call(descriptor, 'dbName') &&
            descriptor.dbName !== null &&
            typeof descriptor.dbName !== 'string'
        ) {
            throw new Error(`Cache model "${modelName}" has an invalid dbName`);
        }

        for (const [fieldName, field] of Object.entries(descriptor.fields)) {
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
            } else if (field.kind === 'relation') {
                if (
                    typeof field.target !== 'string' ||
                    typeof field.isList !== 'boolean' ||
                    typeof field.relationName !== 'string'
                ) {
                    throw new Error(`${modelName} relation "${fieldName}" has an invalid descriptor`);
                }
            } else {
                throw new Error(`${modelName} field "${fieldName}" has an invalid descriptor`);
            }
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
): AnalysisContext {
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

        models[modelName] = { descriptor, relations, scope };
    }

    return { schema, models };
}
