import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeConfig } from './config';
import { getTagVersionKey } from './keys';
import type { CacheTagsConfig, NormalizedCacheConfig, RedisAdapter } from './types';

type InvalidationContext = {
    tags: Set<string>;
};

const invalidationStorage = new AsyncLocalStorage<InvalidationContext>();

export function getActiveInvalidationContext(): InvalidationContext | undefined {
    return invalidationStorage.getStore();
}

export async function runWithInvalidationContext<T>(callback: () => Promise<T>, flush: (tags: string[]) => Promise<void>): Promise<T> {
    const context: InvalidationContext = { tags: new Set<string>() };

    return invalidationStorage.run(context, async () => {
        const result = await callback();
        await flush(Array.from(context.tags));
        return result;
    });
}

export async function bumpTagVersions(tags: string[], config: NormalizedCacheConfig, redisAdapter: RedisAdapter): Promise<void> {
    if (tags.length === 0) {
        return;
    }

    const versionTtlSeconds = Math.min(config.maxTtlSeconds * 10, 3600);
    const uniqueTags = Array.from(new Set(tags));

    await Promise.all(
        uniqueTags.map(async (tag) => {
            const key = getTagVersionKey(tag, config);
            const version = await redisAdapter.increment(key, 1);
            await redisAdapter.expire(key, versionTtlSeconds);
            config.logger.debug({ tag, key, version, ttl: versionTtlSeconds }, 'Bumped cache tag version');
        }),
    );
}

export async function publishInvalidation(tags: string[], config: NormalizedCacheConfig, redisAdapter: RedisAdapter): Promise<void> {
    const activeContext = getActiveInvalidationContext();
    if (activeContext) {
        for (const tag of tags) {
            activeContext.tags.add(tag);
        }
        return;
    }

    await bumpTagVersions(tags, config, redisAdapter);
}

export async function withCacheInvalidation<T>(
    fn: () => Promise<T>,
    redisAdapter: RedisAdapter,
    config?: CacheTagsConfig,
): Promise<T> {
    const normalized = normalizeConfig(config);

    return runWithInvalidationContext(fn, async (tags) => {
        try {
            await bumpTagVersions(tags, normalized, redisAdapter);
        } catch (error) {
            normalized.logger.error({ tags, error: (error as Error).message }, 'Deferred cache invalidation failed');
        }
    });
}
