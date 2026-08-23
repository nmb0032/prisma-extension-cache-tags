/**
 * Prisma Redis Cache Extension
 *
 * Adds opt-in read-through caching to Prisma model reads and automatic tag
 * invalidation from model writes. Cache keys are generated from the Prisma
 * query shape plus tag version tokens, so invalidation does not require Redis
 * key scans.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client/extension';
import { CanonicalizationError } from './canonical';
import { normalizeConfig } from './config';
import { bumpTagVersions, publishInvalidation, runWithInvalidationContext } from './invalidation';
import { buildVersionedCacheKey, createVersionToken, getCacheLockKey, prepareCacheKey } from './keys';
import { acquireCacheLock, releaseCacheLock, resolveStampedeOptions, waitForCachedValue } from './locks';
import { createOptimizedScriptObservation } from './optimized';
import { deserializeCacheEnvelope, InvalidCacheEnvelopeError, matchesCacheIdentity, serializeCacheEnvelope } from './serialization';
import { resolveCacheTags } from './tags';
import {
    READ_OPERATIONS,
    WRITE_OPERATIONS,
    type CacheReadOptions,
    type CacheTagsConfig,
    type CacheWriteOptions,
    type ExtendedModel,
    type NormalizedCacheConfig,
    type PreparedCacheKey,
    type ReadOperation,
    type RedisAdapter,
    type WriteOperation,
} from './types';
import type { CacheSchemaDescriptor } from './schema';

export { normalizeConfig };

export interface PreparedRead {
    cleanedArgs: unknown;
    normalizedTags: string[];
    tenantScope: string[];
    preparedKey: PreparedCacheKey;
    cacheable?: boolean;
    bypassReason?: 'tenant-tag-limit';
}

interface CachedHit {
    value: unknown;
}

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

function prepareRead(
    model: string,
    operation: string,
    cleanedArgs: unknown,
    args: unknown,
    cacheOptions: CacheReadOptions,
    config: NormalizedCacheConfig,
): PreparedRead {
    const resolvedTags = resolveCacheTags(model, operation, args, cacheOptions, config, false);
    const preparedKey = prepareCacheKey(
        model,
        operation,
        cleanedArgs,
        resolvedTags.tags,
        resolvedTags.tenantIds,
        config,
        cacheOptions.key,
    );

    return {
        cleanedArgs,
        normalizedTags: resolvedTags.tags,
        tenantScope: preparedKey.tenantScope,
        preparedKey,
        cacheable: resolvedTags.cacheable,
        bypassReason: resolvedTags.bypassReason,
    };
}

async function validateCachedPayload(
    model: string,
    operation: string,
    cacheKey: string,
    payload: string,
    prepared: PreparedRead,
    redisAdapter: RedisAdapter,
    config: NormalizedCacheConfig,
    path: 'optimized' | 'fallback',
    onBypass: (reason: 'identity-mismatch' | 'invalid-envelope') => void,
): Promise<CachedHit | undefined> {
    let cached: ReturnType<typeof deserializeCacheEnvelope>;
    try {
        cached = deserializeCacheEnvelope(payload);
    } catch (error) {
        if (!(error instanceof InvalidCacheEnvelopeError)) {
            throw error;
        }

        onBypass('invalid-envelope');
        config.logger.warn(
            { model, operation, cacheKey, reason: 'invalid-envelope' },
            'Invalid cache envelope; bypassing cached value',
        );
        try {
            await redisAdapter.delete(cacheKey);
        } catch (deleteError) {
            config.logger.error(
                {
                    model,
                    operation,
                    cacheKey,
                    error: deleteError instanceof Error ? deleteError.message : String(deleteError),
                },
                'Invalid cache envelope deletion failed',
            );
        }
        config.metrics.onCacheEvent({
            model,
            operation,
            result: 'bypass',
            path,
            reason: 'invalid-envelope',
        });
        return undefined;
    }

    if (!matchesCacheIdentity(cached, prepared.preparedKey)) {
        onBypass('identity-mismatch');
        const observedTenantScope =
            cached && typeof cached === 'object' && Array.isArray(cached.tenantScope) ? cached.tenantScope : [];
        config.logger.warn(
            {
                model,
                operation,
                cacheKey,
                expectedTenantScope: prepared.tenantScope,
                observedTenantScope,
            },
            'Cache identity mismatch; bypassing cached value',
        );
        try {
            await redisAdapter.delete(cacheKey);
        } catch (error) {
            config.logger.error(
                {
                    model,
                    operation,
                    cacheKey,
                    error: error instanceof Error ? error.message : String(error),
                },
                'Cache identity mismatch deletion failed',
            );
        }
        config.metrics.onCacheEvent({
            model,
            operation,
            result: 'bypass',
            path,
            reason: 'identity-mismatch',
        });
        return undefined;
    }

    return { value: cached.value };
}

async function tryGetCachedValue(
    model: string,
    operation: string,
    cacheKey: string,
    prepared: PreparedRead,
    redisAdapter: RedisAdapter,
    config: NormalizedCacheConfig,
    path: 'optimized' | 'fallback',
    onBypass: (reason: 'identity-mismatch' | 'invalid-envelope') => void,
): Promise<CachedHit | undefined> {
    const payload = await redisAdapter.getString(cacheKey);
    if (payload === null) {
        return undefined;
    }

    return validateCachedPayload(model, operation, cacheKey, payload, prepared, redisAdapter, config, path, onBypass);
}

interface ReadThroughParams {
    model: string;
    operation: string;
    args: unknown;
    cleanedArgs: unknown;
    preparedRead?: PreparedRead;
    query: (args: unknown) => Promise<unknown>;
    cacheOptions: CacheReadOptions;
    config: NormalizedCacheConfig;
    redisAdapter: RedisAdapter;
}

type CacheBypassReason = 'identity-mismatch' | 'invalid-envelope';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function logScriptFailure(
    config: NormalizedCacheConfig,
    primitive: 'lookupVersioned' | 'populateAndRelease' | 'bumpTagVersions',
    error: unknown,
    retry = false,
): void {
    config.logger.warn(
        { primitive, retry, error: errorMessage(error), originalError: error },
        'Redis cache script failed',
    );
}

async function readThroughFallback(params: ReadThroughParams, preparedRead: PreparedRead, ttlSeconds: number): Promise<unknown> {
    const { model, operation, cleanedArgs, query, cacheOptions, config, redisAdapter } = params;
    let cacheKey: string;
    let bypassReason: CacheBypassReason | undefined;

    try {
        const versions = await redisAdapter.mgetString(preparedRead.preparedKey.tagVersionKeys);
        cacheKey = buildVersionedCacheKey(preparedRead.preparedKey.baseKey, createVersionToken(versions));
    } catch (error) {
        config.logger.warn({ model, operation, error: errorMessage(error) }, 'Cache read failed; falling back to Prisma query');
        config.metrics.onCacheEvent({ model, operation, result: 'miss', path: 'fallback' });
        return query(cleanedArgs);
    }

    const getCachedValue = () =>
        tryGetCachedValue(model, operation, cacheKey, preparedRead, redisAdapter, config, 'fallback', (reason) => {
            bypassReason ??= reason;
        });

    try {
        const cachedValue = await getCachedValue();
        if (cachedValue !== undefined) {
            if (cacheOptions.debug) {
                config.logger.debug({ model, operation, cacheKey, tags: preparedRead.normalizedTags }, 'Cache hit');
            }
            config.metrics.onCacheEvent({ model, operation, result: 'hit', path: 'fallback' });
            return cachedValue.value;
        }
    } catch (error) {
        config.logger.warn({ model, operation, cacheKey, error: errorMessage(error) }, 'Cache read failed; falling back to Prisma query');
    }

    if (!bypassReason) {
        if (cacheOptions.debug) {
            config.logger.debug({ model, operation, cacheKey, tags: preparedRead.normalizedTags }, 'Cache miss');
        }
        config.metrics.onCacheEvent({ model, operation, result: 'miss', path: 'fallback' });
    }

    if (bypassReason) {
        return query(cleanedArgs);
    }

    let lock = null;
    let shouldPopulateCache = !redisAdapter.setIfNotExists;
    try {
        if (redisAdapter.setIfNotExists) {
            try {
                lock = await acquireCacheLock(cacheKey, cacheOptions, config, redisAdapter);
                if (!lock) {
                    const waitedValue = await waitForCachedValue(
                        cacheKey,
                        cacheOptions,
                        config,
                        redisAdapter,
                        getCachedValue,
                        () => bypassReason !== undefined,
                    );
                    if (waitedValue !== undefined) {
                        config.metrics.onCacheEvent({ model, operation, result: 'hit', path: 'fallback' });
                        return waitedValue.value;
                    }
                } else {
                    shouldPopulateCache = true;
                    const cachedAfterLock = await getCachedValue();
                    if (cachedAfterLock !== undefined) {
                        config.metrics.onCacheEvent({ model, operation, result: 'hit', path: 'fallback' });
                        return cachedAfterLock.value;
                    }
                }
            } catch (error) {
                config.logger.warn(
                    { model, operation, cacheKey, error: errorMessage(error) },
                    'Cache lock handling failed; falling back to Prisma query',
                );
            }
        }

        const result = await query(cleanedArgs);

        if (shouldPopulateCache && !bypassReason && shouldCacheResult(result, config)) {
            try {
                await redisAdapter.setString(
                    cacheKey,
                    serializeCacheEnvelope({
                        identity: preparedRead.preparedKey.identity,
                        tenantScope: preparedRead.tenantScope,
                        value: result,
                    }),
                    ttlSeconds,
                );
                if (cacheOptions.debug) {
                    config.logger.debug(
                        { model, operation, cacheKey, ttlSeconds, tags: preparedRead.normalizedTags },
                        'Cached query result',
                    );
                }
            } catch (error) {
                config.logger.warn(
                    { model, operation, cacheKey, error: errorMessage(error) },
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

async function readThroughOptimized(params: ReadThroughParams, preparedRead: PreparedRead, ttlSeconds: number): Promise<unknown> {
    const { model, operation, cleanedArgs, query, cacheOptions, config, redisAdapter } = params;
    const optimized = redisAdapter.optimized!;
    let bypassReason: CacheBypassReason | undefined;
    const { lockTtlMs } = resolveStampedeOptions(cacheOptions, config);
    const lockToken = randomUUID();

    let lookup: { cacheKey: string; value: string | null; lockAcquired: boolean };
    const lookupObservation = createOptimizedScriptObservation(config.metrics);
    try {
        lookup = await optimized.lookupVersioned(
            {
                baseKey: preparedRead.preparedKey.baseKey,
                tagVersionKeys: preparedRead.preparedKey.tagVersionKeys,
                lockToken,
                lockTtlMs,
            },
            lookupObservation.callbacks,
        );
    } catch (error) {
        const failure = lookupObservation.failureDetails();
        logScriptFailure(config, 'lookupVersioned', failure?.error ?? error, failure?.retry ?? false);
        return readThroughFallback(params, preparedRead, ttlSeconds);
    }

    const getCachedValue = () =>
        tryGetCachedValue(
            model,
            operation,
            lookup.cacheKey,
            preparedRead,
            redisAdapter,
            config,
            'optimized',
            (reason) => {
                bypassReason ??= reason;
            },
        );

    if (lookup.value !== null) {
        const cachedValue = await validateCachedPayload(
            model,
            operation,
            lookup.cacheKey,
            lookup.value,
            preparedRead,
            redisAdapter,
            config,
            'optimized',
            (reason) => {
                bypassReason ??= reason;
            },
        );
        if (cachedValue !== undefined) {
            if (cacheOptions.debug) {
                config.logger.debug(
                    { model, operation, cacheKey: lookup.cacheKey, tags: preparedRead.normalizedTags },
                    'Cache hit',
                );
            }
            config.metrics.onCacheEvent({ model, operation, result: 'hit', path: 'optimized' });
            return cachedValue.value;
        }
        return query(cleanedArgs);
    }

    if (!bypassReason) {
        if (cacheOptions.debug) {
            config.logger.debug(
                { model, operation, cacheKey: lookup.cacheKey, tags: preparedRead.normalizedTags },
                'Cache miss',
            );
        }
        config.metrics.onCacheEvent({ model, operation, result: 'miss', path: 'optimized' });
    }

    if (!lookup.lockAcquired) {
        let waitedValue: CachedHit | undefined;
        try {
            waitedValue = await waitForCachedValue(
                lookup.cacheKey,
                cacheOptions,
                config,
                redisAdapter,
                getCachedValue,
                () => bypassReason !== undefined,
            );
        } catch (error) {
            config.logger.warn(
                { model, operation, cacheKey: lookup.cacheKey, error: errorMessage(error) },
                'Cache waiter read failed; falling back to Prisma query',
            );
        }
        if (waitedValue !== undefined) {
            config.metrics.onCacheEvent({ model, operation, result: 'hit', path: 'optimized' });
            return waitedValue.value;
        }
        return query(cleanedArgs);
    }

    let populated = false;
    try {
        const result = await query(cleanedArgs);
        if (!bypassReason && shouldCacheResult(result, config)) {
            const populateObservation = createOptimizedScriptObservation(config.metrics);
            try {
                populated = await optimized.populateAndRelease(
                    {
                        cacheKey: lookup.cacheKey,
                        lockToken,
                        value: serializeCacheEnvelope({
                            identity: preparedRead.preparedKey.identity,
                            tenantScope: preparedRead.tenantScope,
                            value: result,
                        }),
                        ttlSeconds,
                    },
                    populateObservation.callbacks,
                );
                if (populated && cacheOptions.debug) {
                    config.logger.debug(
                        { model, operation, cacheKey: lookup.cacheKey, ttlSeconds, tags: preparedRead.normalizedTags },
                        'Cached query result',
                    );
                }
            } catch (error) {
                const failure = populateObservation.failureDetails();
                logScriptFailure(config, 'populateAndRelease', failure?.error ?? error, failure?.retry ?? false);
            }
        }
        return result;
    } finally {
        if (!populated) {
            await releaseCacheLock({ key: getCacheLockKey(lookup.cacheKey), token: lockToken }, redisAdapter, config);
        }
    }
}

export async function readThroughCache(params: ReadThroughParams): Promise<unknown> {
    const { model, operation, args, cleanedArgs, query, cacheOptions, config, redisAdapter } = params;
    const ttlSeconds = normalizeTtl(cacheOptions, config);
    const preparedRead = params.preparedRead ?? prepareRead(model, operation, cleanedArgs, args, cacheOptions, config);

    if (preparedRead.cacheable === false) {
        const reason = preparedRead.bypassReason ?? 'tenant-tag-limit';
        config.logger.warn({ model, operation, reason }, 'Cache read bypassed safely');
        config.metrics.onCacheEvent({
            model,
            operation,
            result: 'bypass',
            path: 'bypass',
            reason,
        });
        return query(cleanedArgs);
    }

    if (redisAdapter.optimized) {
        return readThroughOptimized(params, preparedRead, ttlSeconds);
    }

    return readThroughFallback(params, preparedRead, ttlSeconds);
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
export function createCacheTagsExtension<TSchema extends CacheSchemaDescriptor>(
    redisAdapter: RedisAdapter,
    config: CacheTagsConfig<TSchema>,
) {
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

                        try {
                            const preparedRead = prepareRead(model, operation, cleanedArgs, args, cacheOptions, finalConfig);
                            return readThroughCache({
                                model,
                                operation,
                                args,
                                cleanedArgs,
                                preparedRead,
                                query: query as (args: unknown) => Promise<unknown>,
                                cacheOptions,
                                config: finalConfig,
                                redisAdapter,
                            });
                        } catch (error) {
                            if (!(error instanceof CanonicalizationError)) {
                                throw error;
                            }

                            finalConfig.logger.error(
                                { model, operation, path: error.path, reason: error.reason },
                                'Cache canonicalization failed; bypassing cache',
                            );
                            finalConfig.metrics.onCacheEvent({
                                model,
                                operation,
                                result: 'bypass',
                                path: 'bypass',
                                reason: 'canonicalization',
                            });
                            return (query as (args: unknown) => Promise<unknown>)(cleanedArgs);
                        }
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
