import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgresql://cachetags:cachetags@localhost:5433/cachetags';

export interface TestPrismaClientOptions {
    maxConnections?: number;
}

export function createTestPrismaClient(options: TestPrismaClientOptions = {}): PrismaClient {
    const adapter = new PrismaPg({
        connectionString: TEST_DATABASE_URL,
        ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    });
    return new PrismaClient({ adapter });
}
