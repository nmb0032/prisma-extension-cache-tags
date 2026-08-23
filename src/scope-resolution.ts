import type { AnalysisContext, CacheModelDescriptor, CacheScope } from './schema';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarString(value: unknown): string | undefined {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value);
    }
    return undefined;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
    const ownFields = Object.keys(value);
    return ownFields.length === fields.length && fields.every((field) => ownFields.includes(field));
}

function compoundFields(model: CacheModelDescriptor, wrapper: string): readonly string[] | undefined {
    const generated = model.compoundUniqueKeys?.find((key) => key.name === wrapper);
    if (generated) {
        return generated.fields;
    }
    return model.uniqueKeys.find(
        (uniqueKey) => uniqueKey.length > 1 && uniqueKey.join('_') === wrapper,
    );
}

function isCompoundScopePredicate(
    model: CacheModelDescriptor,
    tenantField: string,
    wrapper: string,
    value: unknown,
): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }
    const fields = compoundFields(model, wrapper);
    return fields !== undefined
        && fields.includes(tenantField)
        && hasExactFields(value, fields);
}

function addTenantValues(value: unknown, scope: { namespace: string }, output: CacheScope[]): void {
    const direct = scalarString(value);
    if (direct !== undefined) {
        output.push({ namespace: scope.namespace, id: direct });
        return;
    }
    if (!isRecord(value)) {
        return;
    }

    const equals = scalarString(value.equals);
    if (equals !== undefined) {
        output.push({ namespace: scope.namespace, id: equals });
    }
    if (Array.isArray(value.in)) {
        for (const item of value.in) {
            const id = scalarString(item);
            if (id !== undefined) {
                output.push({ namespace: scope.namespace, id });
            }
        }
    }
}

const PREDICATE_WRAPPERS = new Set([
    'where',
    'having',
    'AND',
    'OR',
    'NOT',
    'some',
    'every',
    'none',
    'is',
    'isNot',
]);

const PROJECTION_WRAPPERS = new Set([
    'select',
    'include',
    'orderBy',
    '_count',
]);

const IGNORED_QUERY_CONTEXTS = new Set([
    'distinct',
    'cursor',
    'skip',
    'take',
]);

function walkScopes(
    model: string,
    value: unknown,
    context: AnalysisContext,
    output: CacheScope[],
    visited: WeakSet<object>,
    followRelations: boolean,
    collectTenantEvidence: boolean,
): void {
    if (value && typeof value === 'object') {
        if (visited.has(value)) {
            return;
        }
        visited.add(value);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            walkScopes(model, item, context, output, visited, followRelations, collectTenantEvidence);
        }
        return;
    }
    if (!isRecord(value)) {
        return;
    }

    const indexed = context.models[model];
    if (!indexed) {
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        if (collectTenantEvidence && indexed.scope.kind === 'tenant' && key === indexed.scope.field) {
            addTenantValues(child, indexed.scope, output);
            continue;
        }

        const relation = indexed.relations[key];
        if (followRelations && relation) {
            walkScopes(relation.target, child, context, output, visited, true, collectTenantEvidence);
            continue;
        }

        if (
            collectTenantEvidence
            && indexed.scope.kind === 'tenant'
            && !relation
            && isCompoundScopePredicate(indexed.descriptor, indexed.scope.field, key, child)
        ) {
            walkScopes(model, child, context, output, visited, followRelations, true);
            continue;
        }

        if (IGNORED_QUERY_CONTEXTS.has(key)) {
            continue;
        }

        if (PREDICATE_WRAPPERS.has(key)) {
            walkScopes(model, child, context, output, visited, followRelations, true);
            continue;
        }

        if (PROJECTION_WRAPPERS.has(key)) {
            walkScopes(model, child, context, output, visited, followRelations, false);
        }
    }
}

function dedupeScopes(scopes: readonly CacheScope[]): CacheScope[] {
    const unique = new Map<string, CacheScope>();
    for (const scope of scopes) {
        unique.set(serializeScope(scope), scope);
    }
    return [...unique.values()].sort((left, right) => serializeScope(left).localeCompare(serializeScope(right)));
}

export function serializeScope(scope: CacheScope): string {
    return `${encodeURIComponent(scope.namespace)}:${encodeURIComponent(scope.id)}`;
}

export function resolveModelScopes(input: {
    model: string;
    values: readonly unknown[];
    context: AnalysisContext;
}): CacheScope[] {
    const scopes: CacheScope[] = [];
    const visited = new WeakSet<object>();
    for (const value of input.values) {
        walkScopes(input.model, value, input.context, scopes, visited, true, true);
    }
    return dedupeScopes(scopes);
}

export function resolveDirectModelScopes(input: {
    model: string;
    values: readonly unknown[];
    context: AnalysisContext;
}): CacheScope[] {
    const scopes: CacheScope[] = [];
    const visited = new WeakSet<object>();
    for (const value of input.values) {
        walkScopes(input.model, value, input.context, scopes, visited, false, true);
    }
    return dedupeScopes(scopes);
}
