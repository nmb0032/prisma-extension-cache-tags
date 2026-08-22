import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeConfig } from './config';
import { getTagVersionKey } from './keys';
import { createOptimizedScriptObservation } from './optimized';
import type { CacheTagsConfig, NormalizedCacheConfig, RedisAdapter } from './types';

type InvalidationContext = {
    tags: Set<string>;
};

const invalidationStorage = new AsyncLocalStorage<InvalidationContext>();

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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
            uniqueTags.forEach((tag, index) => {
                const version = versions[index]!;
                config.logger.debug(
                    { tag, key: getTagVersionKey(tag, config), version, ttl: versionTtlSeconds },
                    'Bumped cache tag version',
                );
            });
            return;
        } catch (error) {
            const failure = observation.failureDetails();
            config.logger.warn(
                {
                    primitive: 'bumpTagVersions',
                    retry: failure?.retry ?? false,
                    error: errorMessage(failure?.error ?? error),
                    originalError: failure?.error ?? error,
                },
                'Optimized invalidation failed; using command fallback',
            );
        }
    }

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
