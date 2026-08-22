/**
 * Prisma Redis Cache Extension
 *
 * Adds opt-in read-through caching to Prisma model reads and automatic tag
 * invalidation from model writes. Cache keys are generated from the Prisma
 * query shape plus tag version tokens, so invalidation does not require Redis
 * key scans.
 */
import { Prisma } from '@prisma/client/extension';
import hash from 'hash-object';
import { normalizeConfig } from './config';
import { bumpTagVersions, publishInvalidation, runWithInvalidationContext } from './invalidation';
import { generateCacheKey, getTagVersions } from './keys';
import { acquireCacheLock, releaseCacheLock, waitForCachedValue } from './locks';
import { deserializeCachedValue, deserializeCacheEnvelope, serializeCacheEnvelope } from './serialization';
import { resolveCacheTags } from './tags';
import {
    READ_OPERATIONS,
    WRITE_OPERATIONS,
    type CacheReadOptions,
    type CacheTagsConfig,
    type CacheWriteOptions,
    type ExtendedModel,
    type NormalizedCacheConfig,
    type ReadOperation,
    type RedisAdapter,
    type WriteOperation,
} from './types';

export { normalizeConfig };

function stripCacheFromArgs<TOptions>(args: unknown): { cleanedArgs: unknown; cacheOptions: TOptions | undefined } {
    if (args && typeof args === 'object' && 'cache' in args) {
        const argsWithCache = args as { cache?: TOptions } & Record<string, unknown>;
        const { cache, ...rest } = argsWithCache;
        return { cleanedArgs: rest, cacheOptions: cache };
    }

    return { cleanedArgs: args, cacheOptions: undefined };
}

function shouldCacheResult(result: unknown, config: NormalizedCacheConfig): boolean {
    if (result === null && !config.cacheNull) {
        return false;
    }

    if (Array.isArray(result) && result.length === 0 && !config.cacheEmpty) {
        return false;
    }

    return true;
}

function normalizeTtl(options: CacheReadOptions, config: NormalizedCacheConfig): number {
    const requestedTtl = options.ttlSeconds ?? config.defaultTtlSeconds;
    return Math.max(1, Math.min(requestedTtl, config.maxTtlSeconds));
}

async function generateCustomCacheKey(
    key: string,
    model: string,
    operation: string,
    cleanedArgs: unknown,
    tags: string[],
    config: NormalizedCacheConfig,
    redisAdapter: RedisAdapter,
): Promise<string> {
    return `${config.keyPrefix}:custom:${hash({
        key,
        model,
        operation,
        args: cleanedArgs,
        schemaVersion: config.schemaVersion,
        tagVersions: await getTagVersions(tags, config, redisAdapter),
    })}`;
}

async function tryGetCachedValue(
    cacheKey: string,
    redisAdapter: RedisAdapter,
): Promise<unknown | undefined> {
    const cachedSuperJson = await redisAdapter.get<ReturnType<typeof serializeCacheEnvelope>>(cacheKey);
    if (!cachedSuperJson) {
        return undefined;
    }

    const cached = deserializeCacheEnvelope(cachedSuperJson);
    return deserializeCachedValue(cached);
}

export async function readThroughCache(params: {
    model: string;
    operation: string;
    args: unknown;
    cleanedArgs: unknown;
    query: (args: unknown) => Promise<unknown>;
    cacheOptions: CacheReadOptions;
    config: NormalizedCacheConfig;
    redisAdapter: RedisAdapter;
}): Promise<unknown> {
    const { model, operation, args, cleanedArgs, query, cacheOptions, config, redisAdapter } = params;
    const ttlSeconds = normalizeTtl(cacheOptions, config);
    const resolvedTags = resolveCacheTags(model, operation, args, cacheOptions, config, false);
    let cacheKey: string;

    try {
        cacheKey = cacheOptions.key
            ? await generateCustomCacheKey(cacheOptions.key, model, operation, cleanedArgs, resolvedTags.tags, config, redisAdapter)
            : await generateCacheKey(model, operation, args, resolvedTags.tags, config, redisAdapter);
    } catch (error) {
        config.logger.warn(
            { model, operation, error: (error as Error).message },
            'Cache read failed; falling back to Prisma query',
        );
        config.metrics.onCacheEvent({ model, operation, result: 'miss' });
        return query(cleanedArgs);
    }

    const getCachedValue = () => tryGetCachedValue(cacheKey, redisAdapter);

    try {
        const cachedValue = await getCachedValue();
        if (cachedValue !== undefined) {
            if (cacheOptions.debug) {
                config.logger.debug({ model, operation, cacheKey, tags: resolvedTags.tags }, 'Cache hit');
            }
            config.metrics.onCacheEvent({ model, operation, result: 'hit' });
            return cachedValue;
        }
    } catch (error) {
        config.logger.warn(
            { model, operation, cacheKey, error: (error as Error).message },
            'Cache read failed; falling back to Prisma query',
        );
    }

    if (cacheOptions.debug) {
        config.logger.debug({ model, operation, cacheKey, tags: resolvedTags.tags }, 'Cache miss');
    }
    config.metrics.onCacheEvent({ model, operation, result: 'miss' });

    let lock = null;
    let shouldPopulateCache = !redisAdapter.setIfNotExists;
    try {
        if (redisAdapter.setIfNotExists) {
            try {
                lock = await acquireCacheLock(cacheKey, cacheOptions, config, redisAdapter);
                if (!lock) {
                    const waitedValue = await waitForCachedValue(cacheKey, cacheOptions, config, redisAdapter, getCachedValue);
                    if (waitedValue !== undefined) {
                        config.metrics.onCacheEvent({ model, operation, result: 'hit' });
                        return waitedValue;
                    }
                } else {
                    shouldPopulateCache = true;
                    const cachedAfterLock = await getCachedValue();
                    if (cachedAfterLock !== undefined) {
                        config.metrics.onCacheEvent({ model, operation, result: 'hit' });
                        return cachedAfterLock;
                    }
                }
            } catch (error) {
                config.logger.warn(
                    { model, operation, cacheKey, error: (error as Error).message },
                    'Cache lock handling failed; falling back to Prisma query',
                );
            }
        }

        const result = await query(cleanedArgs);

        if (shouldPopulateCache && shouldCacheResult(result, config)) {
            try {
                await redisAdapter.set(
                    cacheKey,
                    serializeCacheEnvelope(result),
                    ttlSeconds,
                );
                if (cacheOptions.debug) {
                    config.logger.debug({ model, operation, cacheKey, ttlSeconds, tags: resolvedTags.tags }, 'Cached query result');
                }
            } catch (error) {
                config.logger.warn(
                    { model, operation, cacheKey, error: (error as Error).message },
                    'Cache write failed; continuing without cache',
                );
            }
        }

        return result;
    } finally {
        if (lock) {
            await releaseCacheLock(lock, redisAdapter, config);
        }
    }
}

export async function handleWrite(params: {
    model: string;
    operation: string;
    args: unknown;
    cleanedArgs: unknown;
    query: (args: unknown) => Promise<unknown>;
    cacheOptions: CacheWriteOptions | undefined;
    config: NormalizedCacheConfig;
    redisAdapter: RedisAdapter;
}): Promise<unknown> {
    const { model, operation, args, cleanedArgs, query, cacheOptions, config, redisAdapter } = params;
    const result = await query(cleanedArgs);
    const resolvedTags = resolveCacheTags(model, operation, args, cacheOptions, config, true, [result]);
    if (config.tenantPrecision && config.tenantKeys.length > 0 && resolvedTags.tenantIds.length === 0) {
        config.logger.warn(
            { model, operation },
            'Tenant identity unavailable after write; invalidating the model-wide cache fallback',
        );
    }

    if (resolvedTags.tags.length === 0) {
        config.logger.warn({ model, operation }, 'Write completed but no cache invalidation tags were resolved');
        return result;
    }

    try {
        await publishInvalidation(resolvedTags.tags, config, redisAdapter);
        if (cacheOptions?.debug) {
            config.logger.debug({ model, operation, tags: resolvedTags.tags }, 'Published cache invalidation');
        }
    } catch (error) {
        config.logger.error(
            { model, operation, tags: resolvedTags.tags, error: (error as Error).message },
            'Cache invalidation failed after write',
        );
    }

    return result;
}

/**
 * Create the Prisma cache extension.
 */
export function createCacheTagsExtension(redisAdapter: RedisAdapter, config?: CacheTagsConfig) {
    const finalConfig = normalizeConfig(config);

    return Prisma.defineExtension((client) => {
        const extendedClient = client.$extends({
            name: 'prisma-extension-cache-tags',
            model: {
                $allModels: {} as ExtendedModel,
            },
            query: {
                async $allOperations({ model, operation, args, query }) {
                    if (!finalConfig.enabled || !model) {
                        const { cleanedArgs } = stripCacheFromArgs<CacheReadOptions | CacheWriteOptions>(args);
                        return (query as (args: unknown) => Promise<unknown>)(cleanedArgs);
                    }

                    if (WRITE_OPERATIONS.includes(operation as WriteOperation)) {
                        const { cleanedArgs, cacheOptions } = stripCacheFromArgs<CacheWriteOptions>(args);
                        return handleWrite({
                            model,
                            operation,
                            args,
                            cleanedArgs,
                            query: query as (args: unknown) => Promise<unknown>,
                            cacheOptions,
                            config: finalConfig,
                            redisAdapter,
                        });
                    }

                    if (READ_OPERATIONS.includes(operation as ReadOperation)) {
                        const { cleanedArgs, cacheOptions } = stripCacheFromArgs<CacheReadOptions>(args);

                        if (!cacheOptions || cacheOptions.enabled === false) {
                            return (query as (args: unknown) => Promise<unknown>)(cleanedArgs);
                        }

                        return readThroughCache({
                            model,
                            operation,
                            args,
                            cleanedArgs,
                            query: query as (args: unknown) => Promise<unknown>,
                            cacheOptions,
                            config: finalConfig,
                            redisAdapter,
                        });
                    }

                    return query(args);
                },
            },
        });

        const originalTransaction = extendedClient.$transaction;
        const transactionHandler = (function (this: unknown, input: unknown, ...rest: unknown[]) {
            const transactionContext = this ?? extendedClient;
            const invokeOriginalTransaction = () =>
                (originalTransaction as (...args: unknown[]) => Promise<unknown>).apply(transactionContext, [input, ...rest]);

            return runWithInvalidationContext(invokeOriginalTransaction, async (tags) => {
                try {
                    await bumpTagVersions(tags, finalConfig, redisAdapter);
                } catch (error) {
                    finalConfig.logger.error(
                        { tags, error: (error as Error).message },
                        'Cache invalidation failed after transaction commit',
                    );
                }
            });
        }) as typeof extendedClient.$transaction;

        if (typeof extendedClient.$extends !== 'function') {
            const clientWithTransaction = extendedClient as typeof extendedClient & {
                $transaction: typeof extendedClient.$transaction;
            };
            clientWithTransaction.$transaction = transactionHandler;
            return clientWithTransaction;
        }

        const clientWithTransaction = extendedClient.$extends({
            client: {
                $transaction: transactionHandler,
            },
        });

        return clientWithTransaction as typeof extendedClient;
    });
}
