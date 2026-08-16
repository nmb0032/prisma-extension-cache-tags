import { randomUUID } from 'node:crypto';
import { getCacheLockKey } from './keys';
import type { CacheReadOptions, NormalizedCacheConfig, RedisAdapter } from './types';

export interface CacheLock {
    key: string;
    token: string;
}

function resolveStampedeOptions(
    options: CacheReadOptions | undefined,
    config: NormalizedCacheConfig,
): Required<NonNullable<CacheReadOptions['stampede']>> {
    return {
        waitMs: options?.stampede?.waitMs ?? config.stampede.waitMs,
        pollMs: options?.stampede?.pollMs ?? config.stampede.pollMs,
        lockTtlMs: options?.stampede?.lockTtlMs ?? config.stampede.lockTtlMs,
    };
}

export async function acquireCacheLock(
    cacheKey: string,
    options: CacheReadOptions | undefined,
    config: NormalizedCacheConfig,
    redisAdapter: RedisAdapter,
): Promise<CacheLock | null> {
    if (!redisAdapter.setIfNotExists) {
        return null;
    }

    const lockKey = getCacheLockKey(cacheKey, config);
    const token = randomUUID();
    const { lockTtlMs } = resolveStampedeOptions(options, config);
    const acquired = await redisAdapter.setIfNotExists(lockKey, token, lockTtlMs);

    return acquired ? { key: lockKey, token } : null;
}

export async function releaseCacheLock(lock: CacheLock, redisAdapter: RedisAdapter, config: NormalizedCacheConfig): Promise<void> {
    try {
        if (redisAdapter.deleteIfValue) {
            await redisAdapter.deleteIfValue(lock.key, lock.token);
            return;
        }

        await redisAdapter.delete(lock.key);
    } catch (error) {
        config.logger.warn({ key: lock.key, error: (error as Error).message }, 'Failed to release cache lock');
    }
}

export async function waitForCachedValue<T>(
    cacheKey: string,
    options: CacheReadOptions | undefined,
    config: NormalizedCacheConfig,
    redisAdapter: RedisAdapter,
    getCachedValue: () => Promise<T | undefined>,
): Promise<T | undefined> {
    const { waitMs, pollMs } = resolveStampedeOptions(options, config);
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const value = await getCachedValue();
        if (value !== undefined) {
            return value;
        }
    }

    config.logger.debug({ cacheKey, waitMs }, 'Timed out waiting for cache lock owner');
    return undefined;
}
