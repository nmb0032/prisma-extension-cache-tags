import { inspect } from 'node:util';
import { createClient } from 'redis';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;

export function createTestRedisClient(url: string = TEST_REDIS_URL) {
    return createClient({
        url,
        socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            reconnectStrategy: false,
        },
    });
}

type TestRedisClient = ReturnType<typeof createTestRedisClient>;

export async function closeTestRedisClient(client: TestRedisClient): Promise<void> {
    if (client.isOpen) {
        try {
            await client.quit();
            return;
        } catch {
            // The connection may have failed while it was being closed.
        }
    }

    try {
        client.destroy();
    } catch {
        // Redis throws when destroy is called after a failed connection already closed it.
    }
}

export async function checkRedisReachability(url: string = TEST_REDIS_URL): Promise<void> {
    const client = createTestRedisClient(url);

    try {
        await client.connect();
        await client.ping();
    } finally {
        await closeTestRedisClient(client);
    }
}

export function formatServiceUnavailable(service: string, url: string, environmentVariable: string): string {
    return [
        `Cannot reach ${service} at ${redactServiceUrl(url)}`,
        'Start the local services first:  pnpm db:up',
        `(or set ${environmentVariable} to point at another instance)`,
    ].join('\n');
}

export function redactServiceUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const key of url.searchParams.keys()) {
            if (/(?:user|pass|token|secret|key)/i.test(key)) {
                url.searchParams.set(key, '[REDACTED]');
            }
        }
        return url.toString();
    } catch {
        return '[redacted service URL]';
    }
}

export function formatError(error: unknown, seen = new Set<unknown>()): string {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        if (seen.has(error)) {
            return '[circular error reference]';
        }
        seen.add(error);
    }

    if (error instanceof AggregateError) {
        const header = error.stack ?? `${error.name}: ${error.message || 'AggregateError'}`;
        const causes = error.errors
            .map((cause, index) => `Cause ${index + 1}:\n${formatError(cause, seen)}`)
            .join('\n');
        return causes ? `${header}\n${causes}` : header;
    }

    if (error instanceof Error) {
        const header = error.stack ?? `${error.name}: ${error.message || 'Unknown error'}`;
        const cause = 'cause' in error ? error.cause : undefined;
        return cause === undefined ? header : `${header}\nCaused by:\n${formatError(cause, seen)}`;
    }

    return inspect(error, { depth: null, breakLength: Infinity }) || 'Unknown error';
}

export function logError(error: unknown): void {
    console.error(formatError(error));
}
