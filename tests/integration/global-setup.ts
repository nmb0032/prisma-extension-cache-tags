import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { URL } from 'node:url';
import {
    checkRedisReachability,
    formatError,
    formatServiceUnavailable,
    TEST_REDIS_URL,
} from '../support/service-preflight';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://cachetags:cachetags@localhost:5433/cachetags';
const POSTGRES_CONNECT_TIMEOUT_MS = 5_000;

export async function checkPostgresReachability(): Promise<void> {
    const databaseUrl = new URL(TEST_DATABASE_URL);
    const port = Number(databaseUrl.port || 5432);

    await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: databaseUrl.hostname, port });
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Connection timed out after ${POSTGRES_CONNECT_TIMEOUT_MS}ms`));
        }, POSTGRES_CONNECT_TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timeout);
            socket.end();
            resolve();
        });
        socket.once('error', (error: Error) => {
            clearTimeout(timeout);
            socket.destroy();
            reject(error);
        });
    });
}

export function ensureFixtureSchema(): void {
    try {
        execFileSync('pnpm', ['exec', 'prisma', 'generate'], {
            cwd: process.cwd(),
            stdio: 'inherit',
        });
        execFileSync('pnpm', ['exec', 'prisma', 'db', 'push'], {
            cwd: process.cwd(),
            stdio: 'inherit',
        });
    } catch (error) {
        throw new Error(
            'Could not prepare the Prisma fixture schema.\nRun `pnpm exec prisma generate && pnpm exec prisma db push` to inspect the failure.',
            { cause: error },
        );
    }
}

export async function setup(): Promise<void> {
    const checks = [
        {
            service: 'Redis',
            url: TEST_REDIS_URL,
            environmentVariable: 'TEST_REDIS_URL',
            run: () => checkRedisReachability(TEST_REDIS_URL),
        },
        {
            service: 'Postgres',
            url: TEST_DATABASE_URL,
            environmentVariable: 'TEST_DATABASE_URL',
            run: checkPostgresReachability,
        },
    ];
    const results = await Promise.allSettled(checks.map((check) => check.run()));
    const failures: string[] = [];

    for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
            const check = checks[index]!;
            failures.push(
                `${formatServiceUnavailable(check.service, check.url, check.environmentVariable)}\nDetails:\n${formatError(result.reason)}`,
            );
        }
    }

    if (failures.length > 0) {
        throw new Error(failures.join('\n\n'));
    }

    ensureFixtureSchema();
}
