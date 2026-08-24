import { randomUUID } from 'node:crypto';
import { getCacheLockKey } from './keys';
import type { CacheReadOptions, NormalizedCacheConfig, RedisAdapter } from './types';

export interface CacheLock {
    key: string;
    token: string;
}

export function resolveStampedeOptions(
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

    const lockKey = getCacheLockKey(cacheKey);
    const token = randomUUID();
    const { lockTtlMs } = resolveStampedeOptions(options, config);
    const acquired = await redisAdapter.setIfNotExists(lockKey, token, lockTtlMs);

    return acquired ? { key: lockKey, token } : null;
}

export async function releaseCacheLock(lock: CacheLock, redisAdapter: RedisAdapter, config: NormalizedCacheConfig): Promise<void> {
    try {
        if (!redisAdapter.deleteIfValue) {
            return;
        }

        await redisAdapter.deleteIfValue(lock.key, lock.token);
    } catch (error) {
        config.logger.warn({ reason: 'cache-lock-release-failed' }, 'Failed to release cache lock');
    }
}

export async function waitForCachedValue<T>(
    _cacheKey: string,
    options: CacheReadOptions | undefined,
    config: NormalizedCacheConfig,
    _redisAdapter: RedisAdapter,
    getCachedValue: () => Promise<T | undefined>,
    shouldStop?: () => boolean,
): Promise<T | undefined> {
    const { waitMs, pollMs } = resolveStampedeOptions(options, config);
    const deadline = Date.now() + waitMs;
    let delayMs = Math.min(2, pollMs, waitMs);

    const immediateValue = await getCachedValue();
    if (immediateValue !== undefined) {
        return immediateValue;
    }
    if (shouldStop?.()) {
        return undefined;
    }

    while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
        const value = await getCachedValue();
        if (value !== undefined) {
            return value;
        }
        if (shouldStop?.()) {
            return undefined;
        }
        delayMs = Math.min(delayMs * 2, pollMs);
    }

    config.logger.debug({ path: 'lock', reason: 'cache-lock-timeout' }, 'Timed out waiting for cache lock owner');
    return undefined;
}
