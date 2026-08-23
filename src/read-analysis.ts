import type { AnalysisContext, CacheScope, IndexedModel } from './schema';
import { globalModelTag, normalizeTags, scopeModelTag, scopeRootTag } from './tag-format';
import { resolveDirectModelScopes, serializeScope } from './scope-resolution';
import type { CacheBypassReason, ReadAnalysis, ReadDependency } from './types';

const SAME_MODEL_WRAPPERS = new Set([
    'where',
    'having',
    'select',
    'include',
    'orderBy',
    '_count',
    'AND',
    'OR',
    'NOT',
    'some',
    'every',
    'none',
    'is',
    'isNot',
]);

const SCALAR_OPERATORS = new Set([
    'equals',
    'in',
    'notIn',
    'lt',
    'lte',
    'gt',
    'gte',
    'contains',
    'startsWith',
    'endsWith',
    'mode',
    'not',
    'has',
    'hasEvery',
    'hasSome',
    'isEmpty',
]);

interface DependencyState {
    context: AnalysisContext;
    dependencies: Map<string, Map<string, CacheScope>>;
    explicitTags: string[];
    bypassReason?: CacheBypassReason;
    visited: WeakSet<object>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key));
}

function isValidScope(value: unknown): value is CacheScope {
    return (
        isRecord(value) &&
        hasExactKeys(value, ['namespace', 'id']) &&
        typeof value.namespace === 'string' &&
        value.namespace.trim() !== '' &&
        typeof value.id === 'string' &&
        value.id.trim() !== ''
    );
}

function parseCustomDependency(value: unknown): ReadDependency | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (hasExactKeys(value, ['tag'])) {
        return typeof value.tag === 'string' && value.tag.trim() !== ''
            ? { tag: value.tag }
            : undefined;
    }
    if (
        !hasExactKeys(value, ['model']) &&
        !hasExactKeys(value, ['model', 'scope'])
    ) {
        return undefined;
    }
    if (typeof value.model !== 'string' || value.model.trim() === '') {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'scope') || value.scope === undefined) {
        return { model: value.model };
    }
    return isValidScope(value.scope)
        ? { model: value.model, scope: value.scope }
        : undefined;
}

function addBypass(state: DependencyState, reason: CacheBypassReason): void {
    state.bypassReason ??= reason;
}

function addDependency(state: DependencyState, model: string, scopes: readonly CacheScope[]): void {
    const indexed = state.context.models[model];
    if (!indexed) {
        addBypass(state, 'model-scope-unconfigured');
        return;
    }
    const existing = state.dependencies.get(model) ?? new Map<string, CacheScope>();
    for (const scope of scopes) {
        existing.set(serializeScope(scope), scope);
    }
    state.dependencies.set(model, existing);
}

function directScopes(
    model: string,
    value: unknown,
    context: AnalysisContext,
): CacheScope[] {
    return resolveDirectModelScopes({ model, values: [value], context });
}

function relationScopes(
    source: IndexedModel,
    targetModel: string,
    target: IndexedModel,
    sourceScopes: readonly CacheScope[],
    relationValue: unknown,
    state: DependencyState,
): CacheScope[] {
    if (target.scope.kind !== 'tenant') {
        return [];
    }

    const nestedScopes = directScopes(
        targetModel,
        relationValue,
        state.context,
    );
    if (source.scope.kind === 'tenant' && source.scope.namespace === target.scope.namespace) {
        return [...sourceScopes, ...nestedScopes];
    }
    if (nestedScopes.length === 0) {
        addBypass(state, 'cross-namespace-scope-unknown');
    }
    return nestedScopes;
}

function visitRelation(
    sourceModel: string,
    relationName: string,
    relationValue: unknown,
    sourceScopes: readonly CacheScope[],
    allowBoolean: boolean,
    state: DependencyState,
): void {
    const source = state.context.models[sourceModel];
    const relation = source?.relations[relationName];
    if (!source || !relation) {
        addBypass(state, 'relation-field-unknown');
        return;
    }
    const targetModel = relation.target;
    const target = state.context.models[targetModel];
    if (!target) {
        addBypass(state, 'model-scope-unconfigured');
        return;
    }
    if (typeof relationValue === 'boolean') {
        if (!allowBoolean) {
            addBypass(state, 'query-shape-unsupported');
            return;
        }
    } else if (!isRecord(relationValue)) {
        addBypass(state, 'query-shape-unsupported');
        return;
    }
    const scopes = relationScopes(source, targetModel, target, sourceScopes, relationValue, state);
    if (target.scope.kind === 'unconfigured') {
        addBypass(state, 'model-scope-unconfigured');
    }
    addDependency(state, targetModel, scopes);
    visit(targetModel, relationValue, scopes, state);
}

function visitScalar(value: unknown, model: string, state: DependencyState): void {
    if (value && typeof value === 'object') {
        if (state.visited.has(value)) {
            return;
        }
        state.visited.add(value);
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            visitScalar(child, model, state);
        }
        return;
    }
    if (!value || typeof value !== 'object') {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (SCALAR_OPERATORS.has(key)) {
            visitScalar(child, model, state);
        } else {
            addBypass(state, 'query-shape-unsupported');
        }
    }
}

function visit(
    model: string,
    value: unknown,
    scopes: readonly CacheScope[],
    state: DependencyState,
    allowRelationBooleans = false,
): void {
    if (state.bypassReason === 'model-scope-unconfigured') {
        return;
    }
    if (value && typeof value === 'object') {
        if (state.visited.has(value)) {
            return;
        }
        state.visited.add(value);
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            visit(model, child, scopes, state);
        }
        return;
    }
    if (!value || typeof value !== 'object') {
        return;
    }

    const indexed = state.context.models[model];
    if (!indexed) {
        addBypass(state, 'model-scope-unconfigured');
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const relation = indexed.relations[key];
        if (relation) {
            if (child === false) {
                if (allowRelationBooleans) {
                    continue;
                }
            }
            visitRelation(model, key, child, scopes, allowRelationBooleans, state);
            continue;
        }
        if (indexed.descriptor.fields[key]?.kind === 'scalar') {
            visitScalar(child, model, state);
            continue;
        }
        if (SAME_MODEL_WRAPPERS.has(key)) {
            visit(model, child, scopes, state, key === 'select' || key === 'include' || key === '_count');
            continue;
        }
        if (key === 'skip' || key === 'take' || key === 'cursor' || key === 'distinct' || key === 'cache') {
            continue;
        }
        if (SCALAR_OPERATORS.has(key)) {
            visit(model, child, scopes, state);
            continue;
        }
        addBypass(state, 'relation-field-unknown');
    }
}

function resolveCustomDependencies(
    model: string,
    operation: string,
    args: unknown,
    primaryScopes: readonly CacheScope[],
    state: DependencyState,
): void {
    const resolver = state.context.models[model]?.readDependencies;
    if (!resolver) {
        return;
    }
    let dependencies: readonly ReadDependency[];
    try {
        dependencies = resolver({
            model,
            operation,
            args,
            scopes: primaryScopes,
            schema: state.context.schema,
        });
    } catch {
        addBypass(state, 'query-shape-unsupported');
        return;
    }

    if (!Array.isArray(dependencies)) {
        addBypass(state, 'query-shape-unsupported');
        return;
    }
    for (const dependency of dependencies) {
        let parsed: ReadDependency | undefined;
        try {
            parsed = parseCustomDependency(dependency);
        } catch {
            addBypass(state, 'query-shape-unsupported');
            continue;
        }
        if (!parsed) {
            addBypass(state, 'query-shape-unsupported');
            continue;
        }
        if ('tag' in parsed) {
            state.explicitTags.push(parsed.tag);
            continue;
        }
        const dependencyModel = parsed.model;
        const dependencyScope = parsed.scope;
        const target = state.context.models[dependencyModel];
        if (!target) {
            addBypass(state, 'model-scope-unconfigured');
            continue;
        }
        if (target.scope.kind === 'global') {
            if (dependencyScope) {
                addBypass(state, 'cross-namespace-scope-unknown');
            }
            addDependency(state, dependencyModel, []);
            continue;
        }
        if (target.scope.kind === 'unconfigured') {
            addBypass(state, 'model-scope-unconfigured');
            continue;
        }
        const targetNamespace = target.scope.namespace;
        if (dependencyScope && dependencyScope.namespace !== targetNamespace) {
            addBypass(state, 'cross-namespace-scope-unknown');
            continue;
        }
        const dependencyScopes = dependencyScope
            ? [dependencyScope]
            : primaryScopes.filter((scope) => scope.namespace === targetNamespace);
        if (dependencyScopes.length === 0) {
            addBypass(state, 'cross-namespace-scope-unknown');
        }
        addDependency(state, dependencyModel, dependencyScopes);
    }
}

function baseAnalysis(
    model: string,
    args: unknown,
    context: AnalysisContext,
): { primaryScopes: CacheScope[]; result?: ReadAnalysis } {
    const indexed = context.models[model];
    if (!indexed || indexed.scope.kind === 'unconfigured') {
        return {
            primaryScopes: [],
            result: { cacheable: false, tags: [], tenantScope: [], dependencies: [model], bypassReason: 'model-scope-unconfigured' },
        };
    }
    if (indexed.scope.kind === 'global') {
        return { primaryScopes: [] };
    }
    const primaryScopes = resolveDirectModelScopes({ model, values: [args], context });
    if (primaryScopes.length === 0) {
        return {
            primaryScopes,
            result: {
                cacheable: false,
                tags: [],
                tenantScope: [],
                dependencies: [model],
                bypassReason: 'tenant-scope-missing',
            },
        };
    }
    return { primaryScopes };
}

export function analyzePrimaryScope(input: {
    model: string;
    args: unknown;
    context: AnalysisContext;
}): Pick<ReadAnalysis, 'cacheable' | 'tenantScope' | 'dependencies' | 'bypassReason'> {
    const { primaryScopes, result } = baseAnalysis(input.model, input.args, input.context);
    if (result) {
        const { cacheable, tenantScope, dependencies, bypassReason } = result;
        return { cacheable, tenantScope, dependencies, ...(bypassReason ? { bypassReason } : {}) };
    }
    return {
        cacheable: true,
        tenantScope: primaryScopes.map(serializeScope),
        dependencies: [input.model],
    };
}

export function analyzeReadTags(input: {
    model: string;
    operation: string;
    args: unknown;
    context: AnalysisContext;
    maxTagsPerQuery: number;
}): ReadAnalysis {
    const base = baseAnalysis(input.model, input.args, input.context);
    if (base.result) {
        return { ...base.result };
    }

    const state: DependencyState = {
        context: input.context,
        dependencies: new Map(),
        explicitTags: [],
        visited: new WeakSet<object>(),
    };
    const primary = input.context.models[input.model]!;
    const primaryScopes = base.primaryScopes;
    addDependency(state, input.model, primary.scope.kind === 'tenant' ? primaryScopes : []);
    visit(input.model, input.args, primaryScopes, state);
    resolveCustomDependencies(input.model, input.operation, input.args, primaryScopes, state);

    const tags: string[] = [...state.explicitTags];
    for (const [dependencyModel, scopes] of state.dependencies) {
        const dependency = input.context.models[dependencyModel];
        if (!dependency || dependency.scope.kind === 'unconfigured') {
            addBypass(state, 'model-scope-unconfigured');
            continue;
        }
        tags.push(globalModelTag(dependencyModel));
        if (dependency.scope.kind === 'tenant') {
            if (scopes.size === 0) {
                addBypass(state, 'cross-namespace-scope-unknown');
                continue;
            }
            for (const scope of scopes.values()) {
                tags.push(scopeRootTag(scope), scopeModelTag(scope, dependencyModel));
            }
        }
    }

    const normalizedTags = normalizeTags(tags);
    const dependencies = [...state.dependencies.keys()].sort();
    const analysis: ReadAnalysis = {
        cacheable: state.bypassReason === undefined,
        tags: normalizedTags,
        tenantScope: primaryScopes.map(serializeScope),
        dependencies,
        ...(state.bypassReason ? { bypassReason: state.bypassReason } : {}),
    };
    if (analysis.cacheable && normalizedTags.length > input.maxTagsPerQuery) {
        return { ...analysis, cacheable: false, bypassReason: 'dependency-tag-limit' };
    }
    return analysis;
}

export { resolveModelScopes, serializeScope } from './scope-resolution';
