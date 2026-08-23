export interface DependencyInvalidationProfile {
    tenants: number;
    modelsPerTenant: number;
    queriesPerModel: number;
    dependentModels: number;
}

export interface DependencyInvalidationComparison {
    totalEntries: number;
    legacyAffectedPerWrite: number;
    queryAwareAffectedPerWrite: number;
    reduction: number;
}

function assertNonNegativeInteger(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
}

/**
 * Compare the broad legacy union with model-and-tenant-aware subscriptions.
 *
 * The legacy estimate counts all subscriptions for the written model across
 * tenants plus every model in the written tenant, subtracting the one
 * overlapping written-model set. The query-aware estimate only counts the
 * primary model and its dependencies in that tenant.
 */
export function compareInvalidationFanout(profile: DependencyInvalidationProfile): DependencyInvalidationComparison {
    for (const [name, value] of Object.entries(profile)) {
        assertNonNegativeInteger(name, value);
    }

    const { tenants, modelsPerTenant, queriesPerModel, dependentModels } = profile;
    const totalEntries = tenants * modelsPerTenant * queriesPerModel;
    const queryAwareAffectedPerWrite = (dependentModels + 1) * queriesPerModel;
    const legacyAffectedPerWrite = (tenants + modelsPerTenant - 1) * queriesPerModel;

    return {
        totalEntries,
        legacyAffectedPerWrite,
        queryAwareAffectedPerWrite,
        reduction: legacyAffectedPerWrite / queryAwareAffectedPerWrite,
    };
}
