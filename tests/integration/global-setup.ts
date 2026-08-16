import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../fixture/generated/client';
import { TEST_DATABASE_URL } from '../fixture/client';
import {
    checkRedisReachability,
    formatError,
    formatServiceUnavailable,
    TEST_REDIS_URL,
} from '../support/service-preflight';

const POSTGRES_CONNECT_TIMEOUT_MS = 5_000;

async function checkPostgresReachability(): Promise<void> {
    const adapter = new PrismaPg({
        connectionString: TEST_DATABASE_URL,
        connectionTimeoutMillis: POSTGRES_CONNECT_TIMEOUT_MS,
    });
    const client = new PrismaClient({ adapter });

    try {
        await client.$queryRaw`SELECT 1`;
    } finally {
        await client.$disconnect();
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
}
