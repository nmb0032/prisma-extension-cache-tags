import type { RedisAdapter } from '../../src/types';

export interface FakeRedis extends RedisAdapter {
    store: Map<string, string>;
    callCounts: Record<string, number>;
    resetCallCounts(): void;
}

export function createFakeRedis(): FakeRedis {
    const store = new Map<string, string>();
    const callCounts: Record<string, number> = {};

    const count = (name: string) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
    };

    return {
        store,
        callCounts,
        resetCallCounts() {
            for (const key of Object.keys(callCounts)) {
                delete callCounts[key];
            }
        },
        async get<T>(key: string): Promise<T | null> {
            count('get');
            const raw = store.get(key);
            return raw === undefined ? null : (JSON.parse(raw) as T);
        },
        async set(key: string, value: unknown): Promise<void> {
            count('set');
            store.set(key, JSON.stringify(value));
        },
        async delete(key: string): Promise<void> {
            count('delete');
            store.delete(key);
        },
        async increment(key: string, amount = 1): Promise<number> {
            count('increment');
            const next = Number(store.get(key) ?? '0') + amount;
            store.set(key, String(next));
            return next;
        },
        async expire(): Promise<void> {
            count('expire');
        },
        async mgetString(keys: string[]): Promise<Array<string | null>> {
            count('mgetString');
            return keys.map((key) => store.get(key) ?? null);
        },
        async setIfNotExists(key: string, value: string): Promise<boolean> {
            count('setIfNotExists');
            if (store.has(key)) {
                return false;
            }
            store.set(key, value);
            return true;
        },
        async deleteIfValue(key: string, value: string): Promise<boolean> {
            count('deleteIfValue');
            if (store.get(key) !== value) {
                return false;
            }
            store.delete(key);
            return true;
        },
    };
}
