import type { Logger, Metrics } from './types';

export const noopLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

export const noopMetrics: Metrics = {
    onCacheEvent: () => undefined,
};
