import { Prisma } from '@prisma/client/extension';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestPrismaClient } from '../fixture/client';

const base = createTestPrismaClient();

afterAll(async () => {
    await base.$disconnect();
});

beforeEach(async () => {
    await base.part.deleteMany();
    await base.widget.deleteMany();
});

describe('prisma 7 extension compatibility', () => {
    test('extra properties on args reach $allOperations and can be stripped', async () => {
        const seen: Array<{ model?: string; operation: string; extra: unknown }> = [];

        const extended = base.$extends(
            Prisma.defineExtension((client) =>
                client.$extends({
                    name: 'spike',
                    query: {
                        async $allOperations({ model, operation, args, query }) {
                            const { cache, ...cleaned } = (args ?? {}) as Record<string, unknown>;
                            seen.push({ model, operation, extra: cache });
                            return query(cleaned as Parameters<typeof query>[0]);
                        },
                    },
                }),
            ),
        );

        await extended.widget.create({ data: { tenantId: 't1', name: 'w1' } });

        // The unknown `cache` property must survive to the interceptor and must not
        // reach Prisma itself (stripping it is what keeps the query valid).
        const result = await (extended.widget as unknown as {
            findMany: (args: unknown) => Promise<unknown[]>;
        }).findMany({ where: { tenantId: 't1' }, cache: { ttlSeconds: 30 } });

        expect(result).toHaveLength(1);
        expect(seen.some((entry) => entry.operation === 'findMany' && entry.extra !== undefined)).toBe(true);
    });

    test('$transaction can be intercepted on the extended client', async () => {
        let intercepted = 0;

        const extended = base.$extends(
            Prisma.defineExtension((client) => {
                const withQuery = client.$extends({
                    name: 'spike-tx',
                    query: {
                        async $allOperations({ args, query }) {
                            return query(args);
                        },
                    },
                });

                const patched = withQuery as typeof withQuery & { $transaction: typeof withQuery.$transaction };
                const original = patched.$transaction.bind(patched);

                patched.$transaction = ((input: unknown, ...rest: unknown[]) => {
                    if (typeof input === 'function') {
                        intercepted += 1;
                    }
                    return original(input as never, ...(rest as never[]));
                }) as typeof withQuery.$transaction;

                return patched;
            }),
        );

        await extended.$transaction(async (tx) => {
            await tx.widget.create({ data: { tenantId: 't1', name: 'in-tx' } });
        });

        expect(intercepted).toBe(1);
        expect(await base.widget.count()).toBe(1);
    });

    test('interactive transaction rollback still rolls back', async () => {
        await expect(
            base.$transaction(async (tx) => {
                await tx.widget.create({ data: { tenantId: 't1', name: 'doomed' } });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await base.widget.count()).toBe(0);
    });
});
