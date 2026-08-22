import { describe, expect, test, vi } from 'vitest';
import { createOptimizedRedisPrimitives } from '../../src/optimized';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

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

    test('distinguishes script reloads and terminal failures through scoped callbacks', async () => {
        const onScriptEvent = vi.fn();
        const reloadOperations = {
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi
                .fn()
                .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
                .mockResolvedValueOnce(['query-key:', '{"identity":"id","tenantScope":[],"value":1}', '1', '0']),
        };
        const reloadPrimitives = createOptimizedRedisPrimitives(reloadOperations);

        await reloadPrimitives.lookupVersioned(
            { baseKey: 'query-key', tagVersionKeys: [] },
            { onScriptEvent },
        );
        expect(onScriptEvent).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'reload',
            retry: true,
        });

        const failure = new Error('connection refused');
        const failureOperations = {
            load: vi.fn().mockResolvedValue('sha-1'),
            evalSha: vi.fn().mockRejectedValue(failure),
        };
        const failurePrimitives = createOptimizedRedisPrimitives(failureOperations);
        const failureEvents = vi.fn();
        const failureDetails = vi.fn();
        await expect(
            failurePrimitives.lookupVersioned(
                { baseKey: 'query-key', tagVersionKeys: [] },
                { onScriptEvent: failureEvents, onScriptFailure: failureDetails },
            ),
        ).rejects.toBe(failure);
        expect(failureEvents).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'failure',
            retry: false,
        });
        expect(failureDetails).toHaveBeenCalledWith({ retry: false, error: failure });
    });

    test('scopes interleaved lookup, population, and invalidation events to each execution', async () => {
        const gates = {
            lookup: deferred<void>(),
            populate: deferred<void>(),
            bump: deferred<void>(),
        };
        const attempts = new Map<string, number>();
        const operations = {
            load: vi.fn().mockResolvedValue('sha'),
            evalSha: vi.fn().mockImplementation(async (_sha: string, keys: string[], args: string[]) => {
                const primitive = args.length === 1 ? 'bump' : keys[0] === 'populate-key' ? 'populate' : 'lookup';
                const attempt = (attempts.get(primitive) ?? 0) + 1;
                attempts.set(primitive, attempt);
                if (attempt === 1) {
                    await gates[primitive].promise;
                    throw new Error('NOSCRIPT missing');
                }
                if (primitive === 'lookup') {
                    return ['lookup-key', '', '0', '0'];
                }
                if (primitive === 'populate') {
                    return 1;
                }
                return [1];
            }),
        };
        const optimized = createOptimizedRedisPrimitives(operations);
        const lookupEvents = vi.fn();
        const populateEvents = vi.fn();
        const bumpEvents = vi.fn();

        const lookup = optimized.lookupVersioned(
            { baseKey: 'lookup-base', tagVersionKeys: [], lockToken: 'lookup-token', lockTtlMs: 1000 },
            { onScriptEvent: lookupEvents },
        );
        const populate = optimized.populateAndRelease(
            { cacheKey: 'populate-key', lockToken: 'populate-token', value: 'value', ttlSeconds: 60 },
            { onScriptEvent: populateEvents },
        );
        const bump = optimized.bumpTagVersions(
            ['bump-key'],
            3600,
            { onScriptEvent: bumpEvents },
        );

        gates.bump.resolve();
        await expect(bump).resolves.toEqual([1]);
        gates.populate.resolve();
        await expect(populate).resolves.toBe(true);
        gates.lookup.resolve();
        await expect(lookup).resolves.toEqual({ cacheKey: 'lookup-key', value: null, lockAcquired: false });

        expect(lookupEvents.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'lookupVersioned', result: 'reload', retry: true },
        ]);
        expect(populateEvents.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'populateAndRelease', result: 'reload', retry: true },
        ]);
        expect(bumpEvents.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'bumpTagVersions', result: 'reload', retry: true },
        ]);
    });

    test('does not retain scoped callbacks after success or failure', async () => {
        const failure = new Error('connection lost');
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValue('sha'),
            evalSha: vi
                .fn()
                .mockResolvedValueOnce(['query-key:', '', '0', '0'])
                .mockRejectedValueOnce(failure)
                .mockResolvedValueOnce(['query-key:', '', '0', '0']),
        });
        const firstEvents = vi.fn();
        const secondEvents = vi.fn();
        const thirdEvents = vi.fn();

        await optimized.lookupVersioned({ baseKey: 'query-key', tagVersionKeys: [] }, { onScriptEvent: firstEvents });
        await expect(
            optimized.lookupVersioned({ baseKey: 'query-key', tagVersionKeys: [] }, { onScriptEvent: secondEvents }),
        ).rejects.toBe(failure);
        await optimized.lookupVersioned({ baseKey: 'query-key', tagVersionKeys: [] }, { onScriptEvent: thirdEvents });

        expect(firstEvents).not.toHaveBeenCalled();
        expect(secondEvents).toHaveBeenCalledTimes(1);
        expect(secondEvents).toHaveBeenCalledWith({
            primitive: 'lookupVersioned',
            result: 'failure',
            retry: false,
        });
        expect(thirdEvents).not.toHaveBeenCalled();
    });

    test('emits one terminal failure for a malformed lookup reply after reload', async () => {
        const onScriptEvent = vi.fn();
        const onScriptFailure = vi.fn();
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi.fn().mockRejectedValueOnce(new Error('NOSCRIPT missing')).mockResolvedValueOnce(['malformed']),
        });

        await expect(
            optimized.lookupVersioned(
                { baseKey: 'query-key', tagVersionKeys: [] },
                { onScriptEvent, onScriptFailure },
            ),
        ).rejects.toThrow('Invalid versioned lookup response');

        expect(onScriptEvent.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'lookupVersioned', result: 'reload', retry: true },
            { primitive: 'lookupVersioned', result: 'failure', retry: true },
        ]);
        expect(onScriptFailure).toHaveBeenCalledTimes(1);
        expect(onScriptFailure).toHaveBeenCalledWith({
            retry: true,
            error: expect.objectContaining({ message: 'Invalid versioned lookup response' }),
        });
    });

    test('emits one terminal failure for a malformed population reply after reload', async () => {
        const onScriptEvent = vi.fn();
        const onScriptFailure = vi.fn();
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi.fn().mockRejectedValueOnce(new Error('NOSCRIPT missing')).mockResolvedValueOnce(2),
        });

        await expect(
            optimized.populateAndRelease(
                { cacheKey: 'query-key', lockToken: 'owner', value: 'value', ttlSeconds: 60 },
                { onScriptEvent, onScriptFailure },
            ),
        ).rejects.toThrow('Invalid Redis script flag');

        expect(onScriptEvent.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'populateAndRelease', result: 'reload', retry: true },
            { primitive: 'populateAndRelease', result: 'failure', retry: true },
        ]);
        expect(onScriptFailure).toHaveBeenCalledTimes(1);
        expect(onScriptFailure).toHaveBeenCalledWith({
            retry: true,
            error: expect.objectContaining({ message: 'Invalid Redis script flag' }),
        });
    });

    test('emits one terminal failure for malformed invalidation versions after reload', async () => {
        const onScriptEvent = vi.fn();
        const onScriptFailure = vi.fn();
        const optimized = createOptimizedRedisPrimitives({
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi.fn().mockRejectedValueOnce(new Error('NOSCRIPT missing')).mockResolvedValueOnce(['not-a-number']),
        });

        await expect(
            optimized.bumpTagVersions(['tag:a'], 3600, { onScriptEvent, onScriptFailure }),
        ).rejects.toThrow('Invalid tag-version response');

        expect(onScriptEvent.mock.calls.map(([event]) => event)).toEqual([
            { primitive: 'bumpTagVersions', result: 'reload', retry: true },
            { primitive: 'bumpTagVersions', result: 'failure', retry: true },
        ]);
        expect(onScriptFailure).toHaveBeenCalledTimes(1);
        expect(onScriptFailure).toHaveBeenCalledWith({
            retry: true,
            error: expect.objectContaining({ message: 'Invalid tag-version response' }),
        });
    });
});
