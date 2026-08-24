import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeConfig } from './config';
import { getTagVersionKey } from './keys';
import { createOptimizedScriptObservation } from './optimized';
import type { CacheTagsConfig, NormalizedCacheConfig, RedisAdapter } from './types';
import type { CacheSchemaDescriptor } from './schema';

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

    const versionTtlSeconds = Math.max(config.maxTtlSeconds * 10, 3600);
    const uniqueTags = Array.from(new Set(tags));
    const optimized = redisAdapter.optimized;

    if (optimized) {
        const observation = createOptimizedScriptObservation(config.metrics);
        try {
            const versions = await optimized.bumpTagVersions(
                uniqueTags.map((tag) => getTagVersionKey(tag, config)),
                versionTtlSeconds,
                observation.callbacks,
            );
            if (versions.length !== uniqueTags.length) {
                throw new Error('Optimized invalidation returned an unexpected version count');
            }
            uniqueTags.forEach(() => {
                config.logger.debug(
                    { path: 'optimized', tagCount: uniqueTags.length },
                    'Bumped cache tag version',
                );
            });
            return;
        } catch {
            config.logger.warn(
                {
                    path: 'optimized',
                    reason: 'redis-script-failure',
                },
                'Optimized invalidation failed; using command fallback',
            );
        }
    }

    await Promise.all(
        uniqueTags.map(async (tag) => {
            const key = getTagVersionKey(tag, config);
            await redisAdapter.increment(key, 1);
            await redisAdapter.expire(key, versionTtlSeconds);
            config.logger.debug({ path: 'fallback', tagCount: uniqueTags.length }, 'Bumped cache tag version');
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

export async function withCacheInvalidation<T, TSchema extends CacheSchemaDescriptor>(
    fn: () => Promise<T>,
    redisAdapter: RedisAdapter,
    config: CacheTagsConfig<TSchema>,
): Promise<T> {
    const normalized = normalizeConfig(config);

    return runWithInvalidationContext(fn, async (tags) => {
        try {
            await bumpTagVersions(tags, normalized, redisAdapter);
        } catch (error) {
            normalized.logger.error(
                { path: 'deferred', reason: 'cache-invalidation-failed', tagCount: tags.length },
                'Deferred cache invalidation failed',
            );
        }
    });
}
