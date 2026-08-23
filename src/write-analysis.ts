import { canonicalizePrismaValue } from './canonical';
import type { AnalysisContext, CacheScope, IndexedModel } from './schema';
import { resolveDirectModelScopes, resolveModelScopes, serializeScope } from './scope-resolution';
import { globalEntityTag, globalModelTag, normalizeTags, scopeEntityTag, scopeModelTag } from './tag-format';
import type { WriteAnalysis } from './types';

const MUTATION_OPERATIONS = new Set([
    'create',
    'update',
    'upsert',
    'delete',
    'createMany',
    'updateMany',
    'deleteMany',
    'connectOrCreate',
]);
const NOOP_RELATION_OPERATIONS = new Set(['connect', 'disconnect', 'set']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarString(value: unknown): string | undefined {
    return (typeof value === 'string'
        || typeof value === 'bigint'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value)))
        ? String(value)
        : undefined;
}

function hasOwn(value: unknown, key: string): boolean {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function directScopes(model: string, value: unknown, context: AnalysisContext): CacheScope[] {
    const indexed = context.models[model];
    if (!indexed || indexed.scope.kind !== 'tenant') {
        return [];
    }
    return resolveDirectModelScopes({ model, values: [value], context });
}

function valuesAsRecords(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.flatMap(valuesAsRecords);
    }
    return isRecord(value) ? [value] : [];
}

function identityCandidates(model: IndexedModel, record: Record<string, unknown>): Record<string, unknown>[] {
    const candidates = [record];
    for (const [key, value] of Object.entries(record)) {
        if (
            isRecord(value)
            && !model.relations[key]
            && model.descriptor.uniqueKeys.some((uniqueKey) =>
                uniqueKey.length > 1
                && uniqueKey.every((field) => Object.prototype.hasOwnProperty.call(value, field))
            )
        ) {
            candidates.push(value);
        }
    }
    return candidates;
}

function extractIdentity(model: IndexedModel, values: readonly unknown[]): string[] {
    if (model.descriptor.primaryKey.length === 0) {
        return [];
    }
    const identities = new Set<string>();
    for (const value of values) {
        for (const record of valuesAsRecords(value)) {
            for (const candidate of identityCandidates(model, record)) {
                if (!model.descriptor.primaryKey.every((field) => Object.prototype.hasOwnProperty.call(candidate, field))) {
                    continue;
                }
                const identityValues = model.descriptor.primaryKey.map((field) => candidate[field]);
                try {
                    if (identityValues.length === 1) {
                        const scalar = scalarString(identityValues[0]);
                        if (scalar !== undefined) {
                            identities.add(scalar);
                        }
                    } else {
                        if (!identityValues.every((identityValue) => scalarString(identityValue) !== undefined)) {
                            continue;
                        }
                        const identity: Record<string, unknown> = {};
                        model.descriptor.primaryKey.forEach((field, index) => {
                            identity[field] = identityValues[index];
                        });
                        identities.add(canonicalizePrismaValue(identity));
                    }
                } catch {
                    // An unsupported identity cannot safely produce an entity tag.
                }
            }
        }
    }
    return [...identities];
}

interface AnalysisState {
    context: AnalysisContext;
    changedModels: Set<string>;
    modelScopes: Map<string, Map<string, CacheScope>>;
    fallbackModels: Set<string>;
    identities: Map<string, Set<string>>;
    scopedIdentities: Map<string, Map<string, Set<string>>>;
}

function addScopes(state: AnalysisState, model: string, scopes: readonly CacheScope[]): void {
    const modelScopes = state.modelScopes.get(model) ?? new Map<string, CacheScope>();
    for (const scope of scopes) {
        modelScopes.set(serializeScope(scope), scope);
    }
    state.modelScopes.set(model, modelScopes);
}

function addIdentities(state: AnalysisState, model: string, identities: readonly string[]): void {
    const existing = state.identities.get(model) ?? new Set<string>();
    identities.forEach((identity) => existing.add(identity));
    state.identities.set(model, existing);
}

function addScopedIdentities(
    state: AnalysisState,
    model: string,
    values: readonly unknown[],
    fallbackScopes: readonly CacheScope[],
): void {
    const scoped = state.scopedIdentities.get(model) ?? new Map<string, Set<string>>();
    for (const record of values.flatMap(valuesAsRecords)) {
        const recordScopes = directScopes(model, record, state.context);
        const scopes = recordScopes.length > 0 ? recordScopes : fallbackScopes;
        const identities = extractIdentity(state.context.models[model]!, [record]);
        for (const scope of scopes) {
            const identitiesForScope = scoped.get(serializeScope(scope)) ?? new Set<string>();
            identities.forEach((identity) => identitiesForScope.add(identity));
            scoped.set(serializeScope(scope), identitiesForScope);
        }
    }
    state.scopedIdentities.set(model, scoped);
}

function markFallback(state: AnalysisState, model: string): void {
    state.fallbackModels.add(model);
}

function tenantChanged(model: IndexedModel, data: unknown): boolean {
    return model.scope.kind === 'tenant' && hasOwn(data, model.scope.field);
}

function collectScopes(model: string, values: readonly unknown[], state: AnalysisState): CacheScope[] {
    return values.flatMap((value) => directScopes(model, value, state.context));
}

function processEvidence(
    modelName: string,
    operation: string,
    args: Record<string, unknown>,
    result: unknown,
    state: AnalysisState,
): void {
    const model = state.context.models[modelName];
    if (!model) {
        state.changedModels.add(modelName);
        markFallback(state, modelName);
        return;
    }
    state.changedModels.add(modelName);

    const resultValues = [result];
    const where = args.where;
    const data = args.data;
    let oldScopes: CacheScope[] = [];
    let newScopes: CacheScope[] = [];
    let identities: string[] = [];

    switch (operation) {
        case 'create':
            newScopes = [...collectScopes(modelName, [data, result], state)];
            identities = extractIdentity(model, [data, result]);
            addScopedIdentities(state, modelName, [data, result], newScopes);
            if (model.scope.kind === 'tenant' && newScopes.length === 0) {
                markFallback(state, modelName);
            }
            break;
        case 'delete':
        case 'deleteMany':
            oldScopes = [...collectScopes(modelName, [where, result], state)];
            identities = extractIdentity(model, [where, result]);
            addScopedIdentities(state, modelName, [where, result], oldScopes);
            if (model.scope.kind === 'tenant' && oldScopes.length === 0) {
                markFallback(state, modelName);
            }
            break;
        case 'update':
        case 'updateMany': {
            const movesTenant = tenantChanged(model, data);
            oldScopes = collectScopes(modelName, [where], state);
            identities = extractIdentity(model, [where, data, result]);
            if (movesTenant) {
                newScopes = collectScopes(modelName, [data, result], state);
                addScopedIdentities(state, modelName, [where], oldScopes);
                addScopedIdentities(state, modelName, [data, result], newScopes);
            } else {
                // A returned tenant, or a tenant in the predicate, describes both states.
                newScopes = collectScopes(modelName, [result, where], state);
                addScopedIdentities(state, modelName, [where, result], newScopes);
            }
            if (oldScopes.length === 0 || newScopes.length === 0) {
                markFallback(state, modelName);
            }
            break;
        }
        case 'upsert': {
            const update = isRecord(args.update) ? args.update : undefined;
            const create = args.create;
            const movesTenant = tenantChanged(model, update);
            identities = extractIdentity(model, [where, create, update, result]);
            if (movesTenant) {
                oldScopes = collectScopes(modelName, [where], state);
                newScopes = collectScopes(modelName, [create, update, result], state);
                addScopedIdentities(state, modelName, [where], oldScopes);
                addScopedIdentities(state, modelName, [create, update, result], newScopes);
                if (oldScopes.length === 0 || newScopes.length === 0) {
                    markFallback(state, modelName);
                }
            } else {
                const created = collectScopes(modelName, [create], state);
                const returned = collectScopes(modelName, resultValues, state);
                const predicate = collectScopes(modelName, [where], state);
                const createBranchUnknown = model.scope.kind === 'tenant' && created.length === 0;
                if (returned.length > 0) {
                    newScopes = returned;
                    addScopedIdentities(state, modelName, [result], newScopes);
                } else if (predicate.length > 0) {
                    newScopes = [...predicate, ...created];
                    addScopedIdentities(state, modelName, [where], predicate);
                    addScopedIdentities(state, modelName, [create], created);
                } else {
                    // create.tenant only describes the create branch, never an existing row.
                    newScopes = created;
                    addScopedIdentities(state, modelName, [create], created);
                }
                if (createBranchUnknown) {
                    markFallback(state, modelName);
                }
            }
            break;
        }
        case 'createMany':
            newScopes = collectScopes(modelName, [data], state);
            identities = extractIdentity(model, [data, result]);
            addScopedIdentities(state, modelName, [data, result], []);
            const bulkRecords = valuesAsRecords(data);
            if (model.scope.kind === 'tenant' && (
                bulkRecords.length === 0
                || bulkRecords.some((record) => directScopes(modelName, record, state.context).length === 0)
            )) {
                markFallback(state, modelName);
            }
            break;
        default:
            oldScopes = collectScopes(modelName, [where], state);
            newScopes = collectScopes(modelName, [data, result], state);
            identities = extractIdentity(model, [where, data, result]);
            addScopedIdentities(state, modelName, [where, data, result], [...oldScopes, ...newScopes]);
            if (model.scope.kind === 'tenant' && oldScopes.length === 0 && newScopes.length === 0) {
                state.changedModels.add(modelName);
                markFallback(state, modelName);
            }
            break;
    }

    if (model.scope.kind === 'unconfigured') {
        markFallback(state, modelName);
    } else if (model.scope.kind === 'tenant') {
        addScopes(state, modelName, [...oldScopes, ...newScopes]);
    }
    addIdentities(state, modelName, identities);
}

function nestedResult(result: unknown, relationName: string): unknown {
    return isRecord(result) ? result[relationName] : undefined;
}

function visitNestedRelations(
    modelName: string,
    payload: unknown,
    result: unknown,
    state: AnalysisState,
): void {
    const model = state.context.models[modelName];
    if (!model || !isRecord(payload)) {
        return;
    }
    for (const [relationName, relation] of Object.entries(model.relations)) {
        const relationPayload = payload[relationName];
        if (!isRecord(relationPayload)) {
            continue;
        }
        for (const [operation, operationPayload] of Object.entries(relationPayload)) {
            if (!MUTATION_OPERATIONS.has(operation) || NOOP_RELATION_OPERATIONS.has(operation)) {
                continue;
            }
            const operationPayloads = Array.isArray(operationPayload) ? operationPayload : [operationPayload];
            for (const payloadValue of operationPayloads) {
                const childArgs: Record<string, unknown> =
                    operation === 'create' || operation === 'createMany'
                        ? { data: operation === 'createMany' && isRecord(payloadValue)
                            ? payloadValue.data
                            : payloadValue }
                        : operation === 'delete' || operation === 'deleteMany'
                            ? isRecord(payloadValue) && hasOwn(payloadValue, 'where')
                                ? payloadValue
                                : { where: payloadValue }
                        : isRecord(payloadValue)
                            ? payloadValue
                            : {};
                const evidenceOperation = operation === 'connectOrCreate' ? 'upsert' : operation;
                processEvidence(relation.target, evidenceOperation, childArgs, nestedResult(result, relationName), state);
                const childPayloads: unknown[] = [];
                if (operation === 'create' || operation === 'createMany') {
                    childPayloads.push(childArgs.data);
                } else {
                    childPayloads.push(childArgs.data, childArgs.create, childArgs.update);
                }
                for (const childPayload of childPayloads) {
                    visitNestedRelations(relation.target, childPayload, nestedResult(result, relationName), state);
                }
            }
        }
    }
}

export function analyzeWriteTags(input: {
    model: string;
    operation: string;
    args: unknown;
    result: unknown;
    context: AnalysisContext;
}): WriteAnalysis {
    const state: AnalysisState = {
        context: input.context,
        changedModels: new Set(),
        modelScopes: new Map(),
        fallbackModels: new Set(),
        identities: new Map(),
        scopedIdentities: new Map(),
    };
    const args = isRecord(input.args) ? input.args : {};
    processEvidence(input.model, input.operation, args, input.result, state);

    const model = state.context.models[input.model];
    if (model) {
        const nestedPayloads: unknown[] = [];
        if (input.operation === 'create' || input.operation === 'createMany') {
            nestedPayloads.push(args.data);
        } else if (input.operation === 'update') {
            nestedPayloads.push(args.data);
        } else if (input.operation === 'upsert') {
            nestedPayloads.push(args.create, args.update);
        } else if (input.operation === 'updateMany') {
            nestedPayloads.push(args.data);
        }
        for (const payload of nestedPayloads) {
            visitNestedRelations(input.model, payload, input.result, state);
        }
    }

    const tags: string[] = [];
    const allModels = [...state.changedModels].sort();
    for (const modelName of allModels) {
        const indexed = state.context.models[modelName];
        if (!indexed || indexed.scope.kind === 'unconfigured' || state.fallbackModels.has(modelName)) {
            tags.push(globalModelTag(modelName));
        }
        if (indexed?.scope.kind === 'global') {
            tags.push(globalModelTag(modelName));
        }
        const identities = state.identities.get(modelName) ?? new Set<string>();
        if (indexed?.scope.kind === 'global') {
            for (const identity of identities) {
                tags.push(globalEntityTag(modelName, identity));
            }
        }
        if (indexed?.scope.kind === 'tenant') {
            const scopedIdentities = state.scopedIdentities.get(modelName) ?? new Map();
            for (const [scopeKey, scope] of (state.modelScopes.get(modelName) ?? new Map())) {
                tags.push(scopeModelTag(scope, modelName));
                for (const identity of scopedIdentities.get(scopeKey) ?? []) {
                    tags.push(scopeEntityTag(scope, modelName, identity));
                }
            }
        }
    }

    return {
        tags: normalizeTags(tags),
        changedModels: allModels,
        tenantScope: [...new Set([...state.modelScopes.values()].flatMap((scopes) => [...scopes.keys()]))].sort(),
        globalFallbackModels: [...state.fallbackModels].sort(),
    };
}

export { resolveModelScopes, serializeScope };
