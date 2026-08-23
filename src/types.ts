import type { Prisma } from '@prisma/client/extension';
import type { Operation } from '@prisma/client/runtime/client';

export interface PreparedCacheKey {
    baseKey: string;
    tagVersionKeys: string[];
    identity: string;
    tenantScope: string[];
}

export interface CachedEnvelopeV3 {
    identity: string;
    tenantScope: string[];
    value: unknown;
}

export interface OptimizedLookupInput {
    baseKey: string;
    tagVersionKeys: string[];
    lockToken?: string;
    lockTtlMs?: number;
}

export interface OptimizedScriptCallbacks {
    onScriptEvent?(event: CacheScriptEvent): void;
    onScriptFailure?(event: { retry: boolean; error: unknown }): void;
}

export interface OptimizedLookupResult {
    cacheKey: string;
    value: string | null;
    lockAcquired: boolean;
}

export interface OptimizedRedisPrimitives {
    lookupVersioned(input: OptimizedLookupInput, callbacks?: OptimizedScriptCallbacks): Promise<OptimizedLookupResult>;
    populateAndRelease(input: {
        cacheKey: string;
        lockToken: string;
        value: string;
        ttlSeconds: number;
    }, callbacks?: OptimizedScriptCallbacks): Promise<boolean>;
    bumpTagVersions(keys: string[], ttlSeconds: number, callbacks?: OptimizedScriptCallbacks): Promise<number[]>;
}

import type { AnalysisContext, CacheModelConfigs, CacheSchemaDescriptor, CacheScope } from './schema';

export type CacheBypassReason =
    | 'model-scope-unconfigured'
    | 'tenant-scope-missing'
    | 'query-shape-unsupported'
    | 'relation-field-unknown'
    | 'cross-namespace-scope-unknown'
    | 'dependency-tag-limit'
    | 'canonicalization'
    | 'identity-mismatch'
    | 'invalid-envelope';

export type ReadDependency =
    | { model: string; scope?: CacheScope }
    | { tag: string };

export type ReadDependencyResolver = (context: {
    model: string;
    operation: string;
    args: unknown;
    scopes: readonly CacheScope[];
    schema: CacheSchemaDescriptor;
}) => readonly ReadDependency[];

export interface ReadAnalysis {
    cacheable: boolean;
    tags: string[];
    tenantScope: string[];
    dependencies: string[];
    bypassReason?: CacheBypassReason;
}

export interface WriteAnalysis {
    tags: string[];
    changedModels: string[];
    tenantScope: string[];
    globalFallbackModels: string[];
}

/**
 * Redis adapter interface for cache operations
 *
 * This interface defines the minimal Redis operations required by the cache extension.
 * Users can provide their own Redis client implementation that matches this interface.
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 *
 * const client = createClient({ url: 'redis://localhost:6379' });
 * await client.connect();
 *
 * const adapter: RedisAdapter = {
 *   getString: async (key: string) => {
 *     return client.get(key);
 *   },
 *   setString: async (key: string, value: string, ttlSeconds?: number) => {
 *     if (ttlSeconds) {
 *       await client.setEx(key, ttlSeconds, value);
 *     } else {
 *       await client.set(key, value);
 *     }
 *   },
 *   delete: async (key: string) => {
 *     await client.del(key);
 *   },
 *   increment: async (key: string, amount = 1) => {
 *     return amount === 1 ? await client.incr(key) : await client.incrBy(key, amount);
 *   },
 *   expire: async (key: string, ttlSeconds: number) => {
 *     await client.expire(key, ttlSeconds);
 *   },
 *   mgetString: async (keys: string[]) => {
 *     return keys.length === 0 ? [] : await client.mGet(keys);
 *   },
 * };
 * ```
 */
export interface RedisAdapter {
    /** Get a raw string value from Redis. */
    getString(key: string): Promise<string | null>;
    /** Set an already-serialized raw string in Redis with optional TTL. */
    setString(key: string, value: string, ttlSeconds?: number): Promise<void>;
    /** Delete a key from Redis */
    delete(key: string): Promise<void>;
    /** Increment a numeric value in Redis */
    increment(key: string, amount?: number): Promise<number>;
    /** Set expiration on a key */
    expire(key: string, ttlSeconds: number): Promise<void>;
    /** Get multiple string values from Redis */
    mgetString(keys: string[]): Promise<Array<string | null>>;
    /** Atomically set a string value only when the key does not exist, with a TTL in milliseconds */
    setIfNotExists?(key: string, value: string, ttlMs: number): Promise<boolean>;
    /** Atomically delete a key only when its current string value matches */
    deleteIfValue?(key: string, value: string): Promise<boolean>;
    /** Optional standalone Redis scripts for atomic multi-key cache operations. */
    optimized?: OptimizedRedisPrimitives;
}

export interface CacheStampedeOptions {
    /** Maximum time waiters spend polling for the lock owner to populate the cache */
    waitMs?: number;
    /** Poll interval while waiting for the cache owner */
    pollMs?: number;
    /** Redis lock TTL; should be longer than the expected DB query duration */
    lockTtlMs?: number;
}

/**
 * Cache options for read operations (findMany, findUnique, findFirst, count, aggregate, groupBy)
 *
 * @example
 * ```typescript
 * // Enable caching with custom TTL
 * cache: { ttlSeconds: 60 }
 *
 * // Use custom cache key
 * cache: { key: 'my-custom-key', ttlSeconds: 300 }
 *
 * // Enable debug logging
 * cache: { ttlSeconds: 60, debug: true }
 *
 * // Disable caching for this query
 * cache: { enabled: false }
 *
 * // Multi-tenant scoping with tags
 *   cache: { ttlSeconds: 60, tags: ['tenant:123', 'tenant:123:model:Widget'] }
 * ```
 */
export interface CacheReadOptions {
    /** TTL in seconds. If not provided, uses defaultTtlSeconds from config */
    ttlSeconds?: number;
    /** Optional custom cache key override */
    key?: string;
    /** Enable/disable caching for this query (defaults to true if cache option is present) */
    enabled?: boolean;
    /** Enable debug logging for cache hits/misses */
    debug?: boolean;
    /** Tags for scoped cache invalidation (e.g., ['tenant:123'] for multi-tenant) */
    tags?: string[];
    /** Merge explicit tags with analyzed dependencies (default: true). When false, explicit tags replace inferred tags. */
    mergeTags?: boolean;
    /** Override stampede protection settings for this query */
    stampede?: CacheStampedeOptions;
}

/**
 * Cache options for write operations (create, update, delete, upsert, createMany, updateMany, deleteMany)
 *
 * @example
 * ```typescript
 * // Invalidate cache with tags (scoped invalidation)
 * cache: { tags: ['tenant:123', 'tenant:123:model:Widget'] }
 *
 * // Enable debug logging for cache invalidation
 * cache: { tags: ['tenant:123'], debug: true }
 * ```
 */
export interface CacheWriteOptions {
    /** Tags for scoped cache invalidation (e.g., ['tenant:123'] for multi-tenant) */
    tags?: string[];
    /** Enable debug logging for cache invalidation */
    debug?: boolean;
    /** Merge explicit tags with analyzed dependencies (default: true). When false, explicit tags replace inferred tags. */
    mergeTags?: boolean;
}

export type LogData = Record<string, unknown>;

export interface Logger {
    debug(data: LogData, message: string): void;
    info(data: LogData, message: string): void;
    warn(data: LogData, message: string): void;
    error(data: LogData, message: string): void;
}

export interface CacheEvent {
    model: string;
    operation: string;
    result: 'hit' | 'miss' | 'bypass';
    path: 'optimized' | 'fallback' | 'bypass';
    reason?: CacheBypassReason;
    dependencyCount?: number;
}

export interface Metrics {
    onCacheEvent(event: CacheEvent): void;
    onScriptEvent?(event: CacheScriptEvent): void;
}

export interface CacheScriptEvent {
    primitive: 'lookupVersioned' | 'populateAndRelease' | 'bumpTagVersions';
    result: 'reload' | 'failure';
    retry: boolean;
}

/**
 * Configuration for the Prisma cache-tags extension
 *
 * @example
 * ```typescript
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { createClient } from 'redis';
 * import { createCacheTagsExtension } from 'prisma-extension-cache-tags';
 * import { cacheSchema } from './generated/cache-tags';
 * import { createNodeRedisAdapter } from 'prisma-extension-cache-tags/node-redis';
 * import { PrismaClient } from './generated/prisma/client';
 *
 * const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
 * await redis.connect();
 * const prismaAdapter = new PrismaPg({
 *   connectionString: process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/app',
 * });
 * const redisAdapter = createNodeRedisAdapter(redis);
 *
 * const prisma = new PrismaClient({ adapter: prismaAdapter }).$extends(
 *   createCacheTagsExtension(redisAdapter, {
 *     defaultTtlSeconds: 60,
 *     maxTtlSeconds: 600,
 *     schema: cacheSchema,
 *     models: {
 *       Widget: { tenant: { field: 'tenantId', namespace: 'tenant' } },
 *     },
 *   }),
 * );
 *
 * // Use tags directly on writes and reads
 * await prisma.widget.create({
 *   data: { name: 'Example', tenantId: '123' },
 *   cache: { tags: ['tenant:123'] }
 * });
 *
 * await prisma.widget.findMany({
 *   where: { tenantId: '123' },
 *   cache: { tags: ['tenant:123'] }
 * });
 * ```
 */
export interface CacheTagsConfig<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> {
    schema: TSchema;
    models: CacheModelConfigs<TSchema>;
    /** Enable/disable caching globally (default: true) */
    enabled?: boolean;
    /** Default TTL in seconds when not specified (default: 30) */
    defaultTtlSeconds?: number;
    /** Maximum allowed TTL in seconds (default: 300) */
    maxTtlSeconds?: number;
    /** Key prefix for all cache keys (default: 'prismaCacheTags:v3') */
    keyPrefix?: string;
    /** Cache null results (default: true) */
    cacheNull?: boolean;
    /** Cache empty array results (default: true) */
    cacheEmpty?: boolean;
    /** Bump to invalidate every cache entry after a breaking code change (default: 1) */
    schemaVersion?: number;
    /**
     * Maximum number of tags included in a cached read key (default: 30). Never limits write invalidation.
     * Tenant-precise reads that exceed the limit bypass caching rather than dropping invalidation tags.
     */
    maxTagsPerQuery?: number;
    /** Default stampede protection behaviour */
    stampede?: CacheStampedeOptions;
    /** Structured logger. Default: no-op. */
    logger?: Logger;
    /** Metrics sink for cache and optimized-script events. Default: no-op. */
    metrics?: Metrics;
}

export interface NormalizedCacheConfig<TSchema extends CacheSchemaDescriptor = CacheSchemaDescriptor> {
    enabled: boolean;
    defaultTtlSeconds: number;
    maxTtlSeconds: number;
    keyPrefix: string;
    cacheNull: boolean;
    cacheEmpty: boolean;
    schemaVersion: number;
    maxTagsPerQuery: number;
    stampede: Required<CacheStampedeOptions>;
    analysis: AnalysisContext<TSchema>;
    logger: Logger;
    metrics: Metrics;
}

/**
 * Cacheable read operations
 */
export const READ_OPERATIONS = [
    'findUnique',
    'findFirst',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
] as const satisfies ReadonlyArray<Operation>;

/**
 * Write operations that trigger cache invalidation
 */
export const WRITE_OPERATIONS = [
    'create',
    'update',
    'delete',
    'upsert',
    'createMany',
    'updateMany',
    'deleteMany',
] as const satisfies ReadonlyArray<Operation>;

/**
 * Read operations that require args
 */
export const CACHE_REQUIRED_ARG_OPERATIONS = ['findUnique', 'groupBy'] as const satisfies ReadonlyArray<Operation>;

/**
 * Read operations that have optional args
 */
export const CACHE_OPTIONAL_ARG_OPERATIONS = ['findFirst', 'findMany', 'count', 'aggregate'] as const satisfies ReadonlyArray<Operation>;

/**
 * Write operations that require args
 */
export const UNCACHE_REQUIRED_ARG_OPERATIONS = ['create', 'delete', 'update', 'upsert'] as const satisfies ReadonlyArray<Operation>;

/**
 * Write operations that have optional args
 */
export const UNCACHE_OPTIONAL_ARG_OPERATIONS = ['createMany', 'updateMany', 'deleteMany'] as const satisfies ReadonlyArray<Operation>;

export type ReadOperation = (typeof READ_OPERATIONS)[number];
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/**
 * Type for Prisma args with cache read options
 */
type PrismaCacheReadArgs = {
    cache?: CacheReadOptions;
};

/**
 * Type for Prisma args with cache write options
 */
type PrismaCacheWriteArgs = {
    cache?: CacheWriteOptions;
};

/**
 * Cache-enabled function type for operations with required args
 */
type CacheRequiredArgsFunction<O extends Operation> = <T, A>(
    this: T,
    args: Prisma.Exact<A, Prisma.Args<T, O> & PrismaCacheReadArgs>,
) => Promise<Prisma.Result<T, A, O>>;

/**
 * Cache-enabled function type for operations with optional args
 */
type CacheOptionalArgsFunction<O extends Operation> = <T, A>(
    this: T,
    args?: Prisma.Exact<A, Prisma.Args<T, O> & PrismaCacheReadArgs>,
) => Promise<Prisma.Result<T, A, O>>;

/**
 * Uncache-enabled function type for operations with required args
 */
type UncacheRequiredArgsFunction<O extends Operation> = <T, A>(
    this: T,
    args: Prisma.Exact<A, Prisma.Args<T, O> & PrismaCacheWriteArgs>,
) => Promise<Prisma.Result<T, A, O>>;

/**
 * Uncache-enabled function type for operations with optional args
 */
type UncacheOptionalArgsFunction<O extends Operation> = <T, A>(
    this: T,
    args?: Prisma.Exact<A, Prisma.Args<T, O> & PrismaCacheWriteArgs>,
) => Promise<Prisma.Result<T, A, O>>;

/**
 * Configuration for operations split by required/optional args
 */
type OperationsConfig<RequiredArg extends Operation[], OptionalArg extends Operation[]> = {
    requiredArg: RequiredArg;
    optionalArg: OptionalArg;
};

/**
 * Model extension type that adds cache/uncache options to operations
 */
type ModelExtension<
    CacheConfig extends OperationsConfig<Operation[], Operation[]>,
    UncacheConfig extends OperationsConfig<Operation[], Operation[]>,
> = {
    [RO in CacheConfig['requiredArg'][number]]: CacheRequiredArgsFunction<RO>;
} & {
    [OO in CacheConfig['optionalArg'][number]]: CacheOptionalArgsFunction<OO>;
} & {
    [URO in UncacheConfig['requiredArg'][number]]: UncacheRequiredArgsFunction<URO>;
} & {
    [UOO in UncacheConfig['optionalArg'][number]]: UncacheOptionalArgsFunction<UOO>;
};

/**
 * Cache operations configuration
 */
type cacheConfig = {
    requiredArg: (typeof CACHE_REQUIRED_ARG_OPERATIONS)[number][];
    optionalArg: (typeof CACHE_OPTIONAL_ARG_OPERATIONS)[number][];
};

/**
 * Uncache operations configuration
 */
type uncacheConfig = {
    requiredArg: (typeof UNCACHE_REQUIRED_ARG_OPERATIONS)[number][];
    optionalArg: (typeof UNCACHE_OPTIONAL_ARG_OPERATIONS)[number][];
};

/**
 * Extended model type with cache and uncache operations
 */
export type ExtendedModel = ModelExtension<cacheConfig, uncacheConfig>;
