import { describe, expect, test, vi } from 'vitest';
import { createScriptExecutor } from '../../src/adapters/scripts';

describe('Redis script executor', () => {
    test('loads once and evaluates the same SHA for subsequent calls', async () => {
        const operations = {
            load: vi.fn().mockResolvedValue('sha-1'),
            evalSha: vi.fn().mockResolvedValue(['ok']),
        };
        const executor = createScriptExecutor('return ARGV[1]', operations);

        await expect(executor.execute(['k1'], ['a1'])).resolves.toEqual(['ok']);
        await expect(executor.execute(['k2'], ['a2'])).resolves.toEqual(['ok']);

        expect(operations.load).toHaveBeenCalledTimes(1);
        expect(operations.evalSha).toHaveBeenNthCalledWith(1, 'sha-1', ['k1'], ['a1']);
        expect(operations.evalSha).toHaveBeenNthCalledWith(2, 'sha-1', ['k2'], ['a2']);
    });

    test('reloads once and retries when Redis reports NOSCRIPT', async () => {
        const operations = {
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi
                .fn()
                .mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'))
                .mockResolvedValueOnce(['recovered']),
        };
        const executor = createScriptExecutor('return ARGV[1]', operations);

        await expect(executor.execute([], ['a1'])).resolves.toEqual(['recovered']);

        expect(operations.load).toHaveBeenCalledTimes(2);
        expect(operations.evalSha).toHaveBeenNthCalledWith(1, 'sha-1', [], ['a1']);
        expect(operations.evalSha).toHaveBeenNthCalledWith(2, 'sha-2', [], ['a1']);
    });

    test('shares the initial script load between concurrent calls', async () => {
        let resolveLoad!: (sha: string) => void;
        const operations = {
            load: vi.fn(
                () =>
                    new Promise<string>((resolve) => {
                        resolveLoad = resolve;
                    }),
            ),
            evalSha: vi.fn().mockResolvedValue('ok'),
        };
        const executor = createScriptExecutor('return "ok"', operations);

        const first = executor.execute(['a'], []);
        const second = executor.execute(['b'], []);
        await Promise.resolve();
        expect(operations.load).toHaveBeenCalledTimes(1);

        resolveLoad('sha-shared');
        await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
        expect(operations.evalSha).toHaveBeenCalledTimes(2);
    });

    test('shares a NOSCRIPT reload between concurrent retries', async () => {
        const operations = {
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi
                .fn()
                .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
                .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
                .mockResolvedValueOnce('first')
                .mockResolvedValueOnce('second'),
        };
        const executor = createScriptExecutor('return 1', operations);

        await expect(Promise.all([executor.execute([], []), executor.execute([], [])])).resolves.toEqual(['first', 'second']);
        expect(operations.load).toHaveBeenCalledTimes(2);
    });

    test('propagates non-NOSCRIPT errors without retrying', async () => {
        const failure = new Error('connection refused');
        const operations = {
            load: vi.fn().mockResolvedValue('sha-1'),
            evalSha: vi.fn().mockRejectedValue(failure),
        };
        const executor = createScriptExecutor('return 1', operations);

        await expect(executor.execute([], [])).rejects.toBe(failure);
        expect(operations.load).toHaveBeenCalledTimes(1);
        expect(operations.evalSha).toHaveBeenCalledTimes(1);
    });

    test('reports a terminal error after one NOSCRIPT retry', async () => {
        const failure = new Error('retry connection refused');
        const onReload = vi.fn();
        const onFailure = vi.fn();
        const operations = {
            load: vi.fn().mockResolvedValueOnce('sha-1').mockResolvedValueOnce('sha-2'),
            evalSha: vi.fn().mockRejectedValueOnce(new Error('NOSCRIPT missing')).mockRejectedValueOnce(failure),
        };
        const executor = createScriptExecutor('return 1', operations, { onReload, onFailure });

        await expect(executor.execute([], [])).rejects.toBe(failure);
        expect(onReload).toHaveBeenCalledWith(true);
        expect(onFailure).toHaveBeenCalledWith({ retry: true, error: failure });
        expect(operations.load).toHaveBeenCalledTimes(2);
        expect(operations.evalSha).toHaveBeenCalledTimes(2);
    });
});
