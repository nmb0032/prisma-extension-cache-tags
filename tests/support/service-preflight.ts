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
        const pathname = url.pathname === '/' ? '' : url.pathname;
        if (
            url.hostname.length === 0 ||
            (pathname.length > 0 && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathname))
        ) {
            return '[redacted service URL]';
        }

        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${pathname}`;
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
        const causes = error.errors
            .map((cause, index) => `Cause ${index + 1}:\n${formatError(cause, seen)}`)
            .join('\n');
        return causes ? `AggregateError (${error.errors.length} causes)\n${causes}` : 'AggregateError';
    }

    if (error instanceof Error) {
        const name = safeErrorName(error.name);
        const code = safeErrorCode(error);
        const category = classifyError(error.message);
        const header = `${name}${code ? ` [${code}]` : ''}: ${category}`;
        const cause = 'cause' in error ? error.cause : undefined;
        return cause === undefined ? header : `${header}\nCaused by:\n${formatError(cause, seen)}`;
    }

    return 'Unknown error';
}

export function logError(error: unknown): void {
    console.error(formatError(error));
}

function safeErrorName(name: string): string {
    return /^(?:[A-Z][A-Za-z0-9]*(?:Error|Exception))$/.test(name) ? name : 'Error';
}

function safeErrorCode(error: Error): string | undefined {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function classifyError(message: string): string {
    const normalized = message.toLowerCase();
    if (normalized.includes('econnrefused') || normalized.includes('connection refused')) {
        return 'connection refused';
    }
    if (normalized.includes('econnreset') || normalized.includes('connection reset')) {
        return 'connection reset';
    }
    if (normalized.includes('etimedout') || normalized.includes('timed out') || normalized.includes('timeout')) {
        return 'timed out';
    }
    if (
        normalized.includes('enotfound') ||
        normalized.includes('eai_again') ||
        normalized.includes('name resolution') ||
        normalized.includes('dns')
    ) {
        return 'host lookup failed';
    }
    if (
        normalized.includes('authentication') ||
        normalized.includes('auth failed') ||
        normalized.includes('invalid password') ||
        normalized.includes('password authentication')
    ) {
        return 'authentication failed';
    }
    if (
        normalized.includes('eacces') ||
        normalized.includes('eperm') ||
        normalized.includes('permission denied') ||
        normalized.includes('forbidden')
    ) {
        return 'permission denied';
    }
    if (normalized.includes('socket') || normalized.includes('connection') || normalized.includes('connect')) {
        return 'connection failure';
    }
    return 'operation failed';
}
