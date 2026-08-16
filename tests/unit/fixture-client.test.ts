import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    PrismaPg: vi.fn(function PrismaPgMock() {
        return { adapter: true };
    }),
    PrismaClient: vi.fn(function PrismaClientMock() {
        return { client: true };
    }),
}));

vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: mocks.PrismaPg }));
vi.mock('../../tests/fixture/generated/client', () => ({ PrismaClient: mocks.PrismaClient }));

import { createTestPrismaClient } from '../../tests/fixture/client';

describe('test Prisma client construction', () => {
    test('keeps the default pool configuration unchanged unless a benchmark limit is supplied', () => {
        createTestPrismaClient();
        expect(mocks.PrismaPg).toHaveBeenLastCalledWith({
            connectionString: expect.any(String),
        });

        createTestPrismaClient({ maxConnections: 1 });
        expect(mocks.PrismaPg).toHaveBeenLastCalledWith({
            connectionString: expect.any(String),
            max: 1,
        });
    });
});
