import { createScriptExecutor, type ScriptOperations } from './adapters/scripts';
import { BUMP_VERSIONS_SCRIPT } from './lua/bump-versions';
import { POPULATE_RELEASE_SCRIPT } from './lua/populate-release';
import { VERSIONED_LOOKUP_SCRIPT } from './lua/versioned-lookup';
import type {
    CacheScriptEvent,
    Metrics,
    OptimizedLookupInput,
    OptimizedLookupResult,
    OptimizedRedisPrimitives,
    OptimizedScriptCallbacks,
} from './types';

export type {
    CacheScriptEvent,
    OptimizedLookupInput,
    OptimizedLookupResult,
    OptimizedRedisPrimitives,
    OptimizedScriptCallbacks,
} from './types';

export type ScriptEventHandler = (event: CacheScriptEvent) => void;
export type ScriptFailureHandler = (event: { primitive: CacheScriptEvent['primitive']; retry: boolean; error: unknown }) => void;

type ScriptResult = string | number;

interface RetryState {
    value: boolean;
}

function asScriptResult(value: unknown): ScriptResult {
    if (typeof value === 'string' || typeof value === 'number') {
        return value;
    }
    throw new Error('Invalid Redis script response');
}

function asFlag(value: unknown): boolean {
    const normalized = asScriptResult(value);
    if (normalized === 1 || normalized === '1') {
        return true;
    }
    if (normalized === 0 || normalized === '0') {
        return false;
    }
    throw new Error('Invalid Redis script flag');
}

function parseLookupResult(result: unknown): OptimizedLookupResult {
    if (!Array.isArray(result) || result.length !== 4) {
        throw new Error('Invalid versioned lookup response');
    }

    const [cacheKey, rawValue, valuePresent, lockAcquired] = result;
    if (typeof cacheKey !== 'string' || typeof rawValue !== 'string') {
        throw new Error('Invalid versioned lookup response');
    }

    const hasValue = asFlag(valuePresent);
    const ownsLock = asFlag(lockAcquired);
    if ((hasValue && rawValue.length === 0) || (!hasValue && rawValue.length > 0) || (hasValue && ownsLock)) {
        throw new Error('Invalid versioned lookup response');
    }

    return {
        cacheKey,
        value: hasValue ? rawValue : null,
        lockAcquired: ownsLock,
    };
}

function parseBooleanResult(result: unknown): boolean {
    return asFlag(result);
}

function parseVersions(result: unknown): number[] {
    if (!Array.isArray(result)) {
        throw new Error('Invalid tag-version response');
    }

    return result.map((value) => {
        const numeric = Number(asScriptResult(value));
        if (!Number.isSafeInteger(numeric) || numeric < 0) {
            throw new Error('Invalid tag-version response');
        }
        return numeric;
    });
}

function reportFailure(
    primitive: CacheScriptEvent['primitive'],
    callbacks: OptimizedScriptCallbacks | undefined,
    event: { retry: boolean; error: unknown },
): void {
    callbacks?.onScriptEvent?.({ primitive, result: 'failure', retry: event.retry });
    callbacks?.onScriptFailure?.(event);
}

function createExecutorEvents(
    primitive: CacheScriptEvent['primitive'],
    callbacks: OptimizedScriptCallbacks | undefined,
    retryState: RetryState,
): {
    onReload(retry: boolean): void;
    onFailure(event: { retry: boolean; error: unknown }): void;
} {
    return {
        onReload(retry) {
            retryState.value ||= retry;
            callbacks?.onScriptEvent?.({ primitive, result: 'reload', retry });
        },
        onFailure(event) {
            reportFailure(primitive, callbacks, event);
        },
    };
}

function parseWithFailure<T>(
    primitive: CacheScriptEvent['primitive'],
    result: unknown,
    callbacks: OptimizedScriptCallbacks | undefined,
    retryState: RetryState,
    parser: (result: unknown) => T,
): T {
    try {
        return parser(result);
    } catch (error) {
        reportFailure(primitive, callbacks, { retry: retryState.value, error });
        throw error;
    }
}

export interface OptimizedScriptObservation {
    callbacks: OptimizedScriptCallbacks;
    failureDetails(): { retry: boolean; error: unknown } | undefined;
}

/**
 * Creates callbacks for one optimized primitive invocation. The returned
 * callbacks hold no registration on the shared primitives, so they cannot
 * observe another request or outlive this invocation.
 */
export function createOptimizedScriptObservation(metrics: Metrics): OptimizedScriptObservation {
    let lastFailure: { retry: boolean; error: unknown } | undefined;

    return {
        callbacks: {
            onScriptEvent: (event) => {
                metrics.onScriptEvent?.(event);
            },
            onScriptFailure: (event) => {
                lastFailure = event;
            },
        },
        failureDetails: () => lastFailure,
    };
}

export function createOptimizedRedisPrimitives(operations: ScriptOperations): OptimizedRedisPrimitives {
    const lookupExecutor = createScriptExecutor(VERSIONED_LOOKUP_SCRIPT, operations);
    const populateExecutor = createScriptExecutor(POPULATE_RELEASE_SCRIPT, operations);
    const bumpExecutor = createScriptExecutor(BUMP_VERSIONS_SCRIPT, operations);

    return {
        async lookupVersioned(input: OptimizedLookupInput, callbacks?: OptimizedScriptCallbacks): Promise<OptimizedLookupResult> {
            const retryState: RetryState = { value: false };
            const result = await lookupExecutor.execute(
                input.tagVersionKeys,
                [input.baseKey, input.lockToken ?? '', String(input.lockTtlMs ?? 0)],
                createExecutorEvents('lookupVersioned', callbacks, retryState),
            );
            return parseWithFailure('lookupVersioned', result, callbacks, retryState, parseLookupResult);
        },
        async populateAndRelease(input, callbacks?: OptimizedScriptCallbacks): Promise<boolean> {
            const retryState: RetryState = { value: false };
            const result = await populateExecutor.execute(
                [input.cacheKey],
                [input.lockToken, input.value, String(input.ttlSeconds)],
                createExecutorEvents('populateAndRelease', callbacks, retryState),
            );
            return parseWithFailure('populateAndRelease', result, callbacks, retryState, parseBooleanResult);
        },
        async bumpTagVersions(keys: string[], ttlSeconds: number, callbacks?: OptimizedScriptCallbacks): Promise<number[]> {
            const uniqueKeys = Array.from(new Set(keys));
            if (uniqueKeys.length === 0) {
                return [];
            }

            const retryState: RetryState = { value: false };
            const result = await bumpExecutor.execute(
                uniqueKeys,
                [String(ttlSeconds)],
                createExecutorEvents('bumpTagVersions', callbacks, retryState),
            );
            const versions = parseWithFailure('bumpTagVersions', result, callbacks, retryState, parseVersions);
            if (versions.length !== uniqueKeys.length) {
                const error = new Error('Invalid tag-version response');
                reportFailure('bumpTagVersions', callbacks, { retry: retryState.value, error });
                throw error;
            }
            return versions;
        },
    };
}
