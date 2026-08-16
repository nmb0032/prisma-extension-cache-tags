export const createCacheTags = {
    /** All cached reads for a tenant: `tenant:<tenantId>` */
    forTenant(tenantId: string): string[] {
        return [`tenant:${tenantId}`];
    },
    /** All cached reads of a model within a tenant, or globally when tenantId is omitted */
    forModel(tenantId: string | undefined, model: string): string[] {
        return [tenantId ? `tenant:${tenantId}:model:${model}` : `global:model:${model}`];
    },
    /** A single record: `tenant:<tenantId>:<model>:<entityId>` */
    forEntity(tenantId: string | undefined, model: string, entityId: string): string[] {
        const normalizedModel = model.charAt(0).toLowerCase() + model.slice(1);
        return [tenantId ? `tenant:${tenantId}:${normalizedModel}:${entityId}` : `global:${normalizedModel}:${entityId}`];
    },
    /** Combine several tag lists into one deduped list */
    combine(...tagLists: string[][]): string[] {
        return Array.from(new Set(tagLists.flat()));
    },
};
