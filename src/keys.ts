import { createHash } from 'node:crypto';
import { CanonicalizationError, canonicalizePrismaValue } from './canonical';
import type { NormalizedCacheConfig, PreparedCacheKey, RedisAdapter } from './types';

export type { PreparedCacheKey } from './types';

export function getTagVersionKey(tag: string, config: NormalizedCacheConfig): string {
    return `${config.keyPrefix}:tagver:${tag}`;
}

export function getCacheLockKey(cacheKey: string): string {
    return `${cacheKey}:lock`;
}

export function createVersionToken(values: readonly (string | null)[]): string {
    return values.map((value) => value ?? '0').join('.');
}

export function buildVersionedCacheKey(baseKey: string, versionToken: string): string {
    return `${baseKey}:${versionToken}`;
}

export function prepareCacheKey(
    model: string,
    operation: string,
    cleanedArgs: unknown,
    normalizedTags: string[],
    tenantScope: string[],
    config: NormalizedCacheConfig,
    customKey?: string,
): PreparedCacheKey {
    const normalizedTenantScope = Array.from(new Set(tenantScope)).sort();
    const tags = Array.from(new Set(normalizedTags)).sort();
    const identityInput: {
        model: string;
        operation: string;
        args: unknown;
        schemaVersion: number;
        tags: string[];
        tenantScope: string[];
        customKey?: string;
    } = {
        model,
        operation,
        args: cleanedArgs,
        schemaVersion: config.schemaVersion,
        tags,
        tenantScope: normalizedTenantScope,
    };

    if (customKey !== undefined) {
        identityInput.customKey = customKey;
    }

    let identity: string;
    try {
        identity = canonicalizePrismaValue(identityInput);
    } catch (error) {
        if (!(error instanceof CanonicalizationError) || !error.path.startsWith('$.args')) {
            throw error;
        }

        throw new CanonicalizationError(`$${error.path.slice('$.args'.length)}`, error.reason);
    }
    const digest = createHash('sha256').update(identity).digest('hex');

    return {
        baseKey: `${config.keyPrefix}:qry:${model}:${operation}:${digest}`,
        tagVersionKeys: tags.map((tag) => getTagVersionKey(tag, config)),
        identity,
        tenantScope: normalizedTenantScope,
    };
}

export async function getTagVersions(
    tags: string[],
    config: NormalizedCacheConfig,
    redisAdapter: RedisAdapter,
): Promise<Array<{ tag: string; version: number }>> {
    if (tags.length === 0) {
        return [];
    }

    const values = await redisAdapter.mgetString(tags.map((tag) => getTagVersionKey(tag, config)));
    return tags.map((tag, index) => ({
        tag,
        version: values[index] === null || values[index] === undefined ? 0 : Number(values[index]) || 0,
    }));
}
