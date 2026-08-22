import { describe, expect, test, vi } from 'vitest';
import { createOptimizedRedisPrimitives, observeOptimizedScripts } from '../../src/optimized';

describe('optimized Redis primitives', () => {
    test('returns the versioned key and value from the lookup script', async () => {
        const evalSha = vi.fn().mockResolvedValue(['query-key:0.2', '{"value":"warm"}', '1', '0']);
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('lookup-sha'),
            evalSha,
        });

        await expect(
            optimized.lookupVersioned({
                baseKey: 'query-key',
                tagVersionKeys: ['tag:a', 'tag:b'],
                lockToken: 'lock-token',
                lockTtlMs: 5000,
            }),
        ).resolves.toEqual({
            cacheKey: 'query-key:0.2',
            value: '{"value":"warm"}',
            lockAcquired: false,
        });
        expect(evalSha).toHaveBeenCalledWith('lookup-sha', ['tag:a', 'tag:b'], ['query-key', 'lock-token', '5000']);
    });

    test('reports a cold owner lookup without fabricating a value', async () => {
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('lookup-sha'),
            evalSha: vi.fn().mockResolvedValue(['query-key:', '', '0', '1']),
        });

        await expect(
            optimized.lookupVersioned({
                baseKey: 'query-key',
                tagVersionKeys: [],
                lockToken: 'owner',
                lockTtlMs: 1000,
            }),
        ).resolves.toEqual({
            cacheKey: 'query-key:',
            value: null,
            lockAcquired: true,
        });
    });

    test('normalizes missing versions and rejects malformed script replies', async () => {
        const evalSha = vi.fn().mockResolvedValueOnce(['query-key:0.0', '', '0', '0']).mockResolvedValueOnce(['bad']);
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('lookup-sha'),
            evalSha,
        });

        await expect(
            optimized.lookupVersioned({
                baseKey: 'query-key',
                tagVersionKeys: ['tag:a', 'tag:b'],
            }),
        ).resolves.toMatchObject({ cacheKey: 'query-key:0.0', value: null, lockAcquired: false });
        await expect(
            optimized.lookupVersioned({
                baseKey: 'query-key',
                tagVersionKeys: [],
            }),
        ).rejects.toThrow('Invalid versioned lookup response');
    });

    test('atomically populates and releases the owner lock', async () => {
        const evalSha = vi.fn().mockResolvedValue(1);
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('populate-sha'),
            evalSha,
        });

        await expect(
            optimized.populateAndRelease({
                cacheKey: 'query-key:0',
                lockToken: 'owner',
                value: '{"value":"fresh"}',
                ttlSeconds: 60,
            }),
        ).resolves.toBe(true);
        expect(evalSha).toHaveBeenCalledWith('populate-sha', ['query-key:0'], ['owner', '{"value":"fresh"}', '60']);
    });

    test('bumps all unique tag-version keys through one script call', async () => {
        const evalSha = vi.fn().mockResolvedValue([1, 1]);
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('bump-sha'),
            evalSha,
        });

        await expect(optimized.bumpTagVersions(['tag:a', 'tag:b', 'tag:a'], 3600)).resolves.toEqual([1, 1]);
        expect(evalSha).toHaveBeenCalledWith('bump-sha', ['tag:a', 'tag:b'], ['3600']);
    });

    test('distinguishes script reloads and terminal failures for metrics and failure details', async () => {
        const onScriptEvent = vi.fn();
        const reloadOperations = {
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi
                .fn()
                .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
                .mockResolvedValueOnce(['query-key:', '{"identity":"id","tenantScope":[],"value":1}', '1', '0']),
        };
        const reloadPrimitives = createOptimizedRedisPrimitives(reloadOperations);
        const reloadObservation = observeOptimizedScripts(
            reloadPrimitives,
            { onCacheEvent: vi.fn(), onScriptEvent },
        );

        await reloadPrimitives.lookupVersioned({ baseKey: 'query-key', tagVersionKeys: [] });
        expect(onScriptEvent).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'reload',
            retry: true,
        });
        reloadObservation.unregister();

        const failure = new Error('connection refused');
        const failureOperations = {
            load: vi.fn().mockResolvedValue('sha-1'),
            evalSha: vi.fn().mockRejectedValue(failure),
        };
        const failurePrimitives = createOptimizedRedisPrimitives(failureOperations);
        const failureEvents = vi.fn();
        const failureObservation = observeOptimizedScripts(
            failurePrimitives,
            { onCacheEvent: vi.fn(), onScriptEvent: failureEvents },
        );
        await expect(failurePrimitives.lookupVersioned({ baseKey: 'query-key', tagVersionKeys: [] })).rejects.toBe(failure);
        expect(failureEvents).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'failure',
            retry: false,
        });
        expect(failureObservation.failureDetails()).toEqual({ retry: false, error: failure });
        failureObservation.unregister();
    });
});
