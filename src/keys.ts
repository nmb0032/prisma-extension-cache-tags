import hash from 'hash-object';
import { normalizeTags } from './tags';
import type { NormalizedCacheConfig, RedisAdapter } from './types';

export function removeCacheFromArgs(args: unknown): unknown {
    if (args && typeof args === 'object' && 'cache' in args) {
        const { cache: _cache, ...rest } = args as { cache?: unknown } & Record<string, unknown>;
        return rest;
    }

    return args;
}

export function getTagVersionKey(tag: string, config: NormalizedCacheConfig): string {
    return `${config.keyPrefix}:tagver:${tag}`;
}

export function getCacheLockKey(cacheKey: string, config: NormalizedCacheConfig): string {
    return `${config.keyPrefix}:lock:${hash({ cacheKey })}`;
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
        version: values[index] ? Number(values[index]) || 0 : 0,
    }));
}

export async function generateCacheKey(
    model: string,
    operation: string,
    args: unknown,
    tags: string[],
    config: NormalizedCacheConfig,
    redisAdapter: RedisAdapter,
): Promise<string> {
    const normalizedTags = normalizeTags(tags, config.maxTagsPerQuery);
    const payload = {
        model,
        operation,
        args: removeCacheFromArgs(args),
        schemaVersion: config.schemaVersion,
        tagVersions: await getTagVersions(normalizedTags, config, redisAdapter),
    };

    return `${config.keyPrefix}:qry:${model}:${operation}:${hash(payload)}`;
}
