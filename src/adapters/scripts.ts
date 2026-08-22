export interface ScriptExecutorEvents {
    onReload?(retry: boolean): void;
    onFailure?(event: { retry: boolean; error: unknown }): void;
}

export interface ScriptOperations {
    load(script: string): Promise<string>;
    evalSha(sha: string, keys: string[], args: string[]): Promise<unknown>;
}

function isNoScriptError(error: unknown): boolean {
    if (error instanceof Error) {
        return error.message.toUpperCase().includes('NOSCRIPT');
    }
    if (error && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message).toUpperCase().includes('NOSCRIPT');
    }
    return String(error).toUpperCase().includes('NOSCRIPT');
}

/**
 * Loads one Lua script lazily and executes it by SHA. Redis can lose its
 * script cache after a restart, so a NOSCRIPT response gets one reload/retry.
 */
export function createScriptExecutor(
    source: string,
    operations: ScriptOperations,
    events?: ScriptExecutorEvents,
): { execute(keys: string[], args: string[]): Promise<unknown> } {
    let loadPromise: Promise<string> | undefined;
    let reloadPromise: Promise<string> | undefined;
    let loadedSha: string | undefined;

    const load = (): Promise<string> => {
        if (!loadPromise) {
            loadPromise = operations
                .load(source)
                .then((sha) => {
                    loadedSha = sha;
                    return sha;
                })
                .catch((error: unknown) => {
                    loadedSha = undefined;
                    loadPromise = undefined;
                    throw error;
                });
        }

        return loadPromise;
    };

    const reload = (): Promise<string> => {
        if (!reloadPromise) {
            const nextLoad = operations
                .load(source)
                .then((sha) => {
                    loadedSha = sha;
                    loadPromise = Promise.resolve(sha);
                    return sha;
                })
                .catch((error: unknown) => {
                    loadedSha = undefined;
                    loadPromise = undefined;
                    throw error;
                });
            reloadPromise = nextLoad.finally(() => {
                reloadPromise = undefined;
            });
        }

        return reloadPromise;
    };

    return {
        async execute(keys: string[], args: string[]): Promise<unknown> {
            let sha: string;
            try {
                sha = await load();
            } catch (error) {
                if (isNoScriptError(error)) {
                    try {
                        sha = await reload();
                        events?.onReload?.(true);
                    } catch (reloadError) {
                        events?.onFailure?.({ retry: true, error: reloadError });
                        throw reloadError;
                    }
                } else {
                    events?.onFailure?.({ retry: false, error });
                    throw error;
                }
            }

            try {
                return await operations.evalSha(sha, keys, args);
            } catch (error) {
                if (!isNoScriptError(error)) {
                    events?.onFailure?.({ retry: false, error });
                    throw error;
                }
            }

            let reloadedSha: string;
            try {
                reloadedSha = loadedSha && loadedSha !== sha ? loadedSha : await reload();
            } catch (reloadError) {
                events?.onFailure?.({ retry: true, error: reloadError });
                throw reloadError;
            }
            events?.onReload?.(true);
            try {
                return await operations.evalSha(reloadedSha, keys, args);
            } catch (error) {
                events?.onFailure?.({ retry: true, error });
                throw error;
            }
        },
    };
}
