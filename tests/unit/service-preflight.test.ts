import { describe, expect, test } from 'vitest';
import { formatServiceUnavailable, redactServiceUrl } from '../../tests/support/service-preflight';

describe('service URL diagnostics', () => {
    test.each([
        {
            url: 'postgresql://db-user:db-password@db.example:5432/cachetags?password=query-password&token=query-token&sslmode=require',
            secrets: ['db-user', 'db-password', 'query-password', 'query-token'],
            usefulParts: ['postgresql://db.example:5432/cachetags', 'sslmode=require'],
        },
        {
            url: 'redis://redis-user:redis-password@cache.example:6380/2?token=redis-token',
            secrets: ['redis-user', 'redis-password', 'redis-token'],
            usefulParts: ['redis://cache.example:6380/2'],
        },
        {
            url: 'redis://userinfo-token@cache.example:6380/2',
            secrets: ['userinfo-token'],
            usefulParts: ['redis://cache.example:6380/2'],
        },
        {
            url: 'redis://cache.example:6380/2#fragment-token',
            secrets: ['fragment-token'],
            usefulParts: ['redis://cache.example:6380/2'],
        },
    ])('redacts credentials while preserving useful topology for $url', ({ url, secrets, usefulParts }) => {
        const redacted = redactServiceUrl(url);

        for (const secret of secrets) {
            expect(redacted).not.toContain(secret);
        }
        for (const usefulPart of usefulParts) {
            expect(redacted).toContain(usefulPart);
        }
    });

    test.each(['redis://admin:malformed-password@bad host:6380/2', 'not-a-url?token=malformed-token'])(
        'uses a safe fallback for malformed URL %j',
        (url) => {
            const redacted = redactServiceUrl(url);

            expect(redacted).toBe('[redacted service URL]');
            expect(redacted).not.toContain('malformed-password');
            expect(redacted).not.toContain('malformed-token');
        },
    );

    test('redacts credentials in unavailable-service diagnostics', () => {
        const message = formatServiceUnavailable(
            'Redis',
            'redis://diagnostic-user:diagnostic-secret@cache.example:6380/2',
            'TEST_REDIS_URL',
        );

        expect(message).toContain('redis://cache.example:6380/2');
        expect(message).not.toContain('diagnostic-user');
        expect(message).not.toContain('diagnostic-secret');
    });
});
