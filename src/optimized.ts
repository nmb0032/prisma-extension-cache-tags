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
} from './types';

export type { CacheScriptEvent, OptimizedLookupInput, OptimizedLookupResult, OptimizedRedisPrimitives } from './types';
export type ScriptEventHandler = (event: CacheScriptEvent) => void;
export type ScriptFailureHandler = (event: { primitive: CacheScriptEvent['primitive']; retry: boolean; error: unknown }) => void;

type ScriptResult = string | number;

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

export interface OptimizedRedisPrimitivesWithEvents extends OptimizedRedisPrimitives {
    setScriptEventHandler(handler: ScriptEventHandler): () => void;
    setScriptFailureHandler(handler: ScriptFailureHandler): () => void;
}

export function createOptimizedRedisPrimitives(
    operations: ScriptOperations,
    initialHandler?: ScriptEventHandler,
): OptimizedRedisPrimitivesWithEvents {
    const handlers = new Set<ScriptEventHandler>();
    const failureHandlers = new Set<ScriptFailureHandler>();
    if (initialHandler) {
        handlers.add(initialHandler);
    }

    const notify = (event: CacheScriptEvent) => {
        for (const handler of handlers) {
            handler(event);
        }
    };
    const notifyFailure = (primitive: CacheScriptEvent['primitive'], event: { retry: boolean; error: unknown }) => {
        notify({ primitive, result: 'failure', retry: event.retry });
        for (const handler of failureHandlers) {
            handler({ primitive, ...event });
        }
    };

    const executorFor = (primitive: CacheScriptEvent['primitive'], source: string) =>
        createScriptExecutor(source, operations, {
            onReload: (retry) => notify({ primitive, result: 'reload', retry }),
            onFailure: (event) => notifyFailure(primitive, event),
        });

    const lookupExecutor = executorFor('lookupVersioned', VERSIONED_LOOKUP_SCRIPT);
    const populateExecutor = executorFor('populateAndRelease', POPULATE_RELEASE_SCRIPT);
    const bumpExecutor = executorFor('bumpTagVersions', BUMP_VERSIONS_SCRIPT);

    const primitives: OptimizedRedisPrimitivesWithEvents = {
        async lookupVersioned(input: OptimizedLookupInput): Promise<OptimizedLookupResult> {
            const result = await lookupExecutor.execute(input.tagVersionKeys, [
                input.baseKey,
                input.lockToken ?? '',
                String(input.lockTtlMs ?? 0),
            ]);
            return parseLookupResult(result);
        },
        async populateAndRelease(input): Promise<boolean> {
            const result = await populateExecutor.execute([input.cacheKey], [
                input.lockToken,
                input.value,
                String(input.ttlSeconds),
            ]);
            return parseBooleanResult(result);
        },
        async bumpTagVersions(keys: string[], ttlSeconds: number): Promise<number[]> {
            const uniqueKeys = Array.from(new Set(keys));
            if (uniqueKeys.length === 0) {
                return [];
            }
            const result = await bumpExecutor.execute(uniqueKeys, [String(ttlSeconds)]);
            const versions = parseVersions(result);
            if (versions.length !== uniqueKeys.length) {
                throw new Error('Invalid tag-version response');
            }
            return versions;
        },
        setScriptEventHandler(handler: ScriptEventHandler): () => void {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        setScriptFailureHandler(handler: ScriptFailureHandler): () => void {
            failureHandlers.add(handler);
            return () => {
                failureHandlers.delete(handler);
            };
        },
    };

    return primitives;
}

export function observeOptimizedScripts(
    primitives: OptimizedRedisPrimitives | undefined,
    metrics: Metrics,
): {
    unregister(): void;
    failureObserved(): boolean;
    failureDetails(): { retry: boolean; error: unknown } | undefined;
} {
    const withEvents = primitives as Partial<OptimizedRedisPrimitivesWithEvents> | undefined;
    let observedFailure = false;
    let lastFailure: { retry: boolean; error: unknown } | undefined;
    const onEvent = (event: CacheScriptEvent) => {
        metrics.onScriptEvent?.(event);
    };
    const onFailure: ScriptFailureHandler = ({ retry, error }) => {
        observedFailure = true;
        lastFailure = { retry, error };
    };
    const unregisterEvent = withEvents?.setScriptEventHandler?.(onEvent);
    const unregisterFailure = withEvents?.setScriptFailureHandler?.(onFailure);

    return {
        failureObserved: () => observedFailure,
        failureDetails: () => lastFailure,
        unregister() {
            unregisterEvent?.();
            unregisterFailure?.();
        },
    };
}
