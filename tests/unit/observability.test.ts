import { describe, expect, test, vi } from 'vitest';
import { noopLogger, noopMetrics } from '../../src/observability';

describe('observability defaults', () => {
    test('noopLogger exposes all four levels and never throws', () => {
        expect(() => {
            noopLogger.debug({ a: 1 }, 'debug');
            noopLogger.info({ a: 1 }, 'info');
            noopLogger.warn({ a: 1 }, 'warn');
            noopLogger.error({ a: 1 }, 'error');
        }).not.toThrow();
    });

    test('noopMetrics accepts a cache event and never throws', () => {
        expect(() => {
            noopMetrics.onCacheEvent({ model: 'Widget', operation: 'findMany', result: 'hit', path: 'fallback' });
        }).not.toThrow();
    });

    test('a custom logger receives structured data and a message', () => {
        const warn = vi.fn();
        const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

        logger.warn({ tag: 'tenant:1' }, 'something happened');

        expect(warn).toHaveBeenCalledWith({ tag: 'tenant:1' }, 'something happened');
    });
});
