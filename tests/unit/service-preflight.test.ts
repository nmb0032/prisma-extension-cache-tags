import { describe, expect, test } from 'vitest';
import { formatError, formatServiceUnavailable, redactServiceUrl } from '../../tests/support/service-preflight';

describe('service URL diagnostics', () => {
    test.each([
        {
            url: 'postgresql://db-user:db-password@db.example:5432/cachetags?password=query-password&token=query-token&sslmode=require',
            secrets: ['db-user', 'db-password', 'query-password', 'query-token'],
            usefulParts: ['postgresql://db.example:5432/cachetags'],
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

    test('allowlists only safe URL components and strips every query key and fragment', () => {
        const secrets = [
            'url-user',
            'url-password',
            'auth-value',
            'pwd-value',
            'credential-value',
            'signature-value',
            'unknown-value',
            'fragment-value',
        ];
        const redacted = redactServiceUrl(
            'redis://url-user:url-password@cache.example:6380/2?auth=auth-value&pwd=pwd-value&credential=credential-value&sig=signature-value&unknown=unknown-value#fragment-value',
        );

        expect(redacted).toBe('redis://cache.example:6380/2');
        expect(redacted).not.toContain('?');
        expect(redacted).not.toContain('#');
        for (const secret of secrets) {
            expect(redacted).not.toContain(secret);
        }
    });

    test.each([
        'redis://user:password@bad host:6380/2?unknown=secret#fragment',
        'redis://user:password@cache.example:6380/%ZZ?credential=secret',
        'not-a-url?auth=malformed-secret#fragment-secret',
    ])('uses the safe fallback for malformed URLs containing arbitrary secrets: %j', (url) => {
        const redacted = redactServiceUrl(url);

        expect(redacted).toBe('[redacted service URL]');
        expect(redacted).not.toContain('password');
        expect(redacted).not.toContain('secret');
        expect(redacted).not.toContain('fragment');
    });

    test('formats downstream errors by category without exposing messages or causes', () => {
        const rawUrl =
            'postgresql://error-user:error-password@db.example:5432/cachetags?auth=auth-secret&unknown=query-secret#fragment-secret';
        const cause = new Error(`socket failed while connecting to ${rawUrl}`);
        const error = Object.assign(new Error(`connect ECONNREFUSED ${rawUrl}`), { code: 'ECONNREFUSED', cause });
        const unsafeNamedError = new Error('raw secret');
        unsafeNamedError.name = 'password';
        const aggregate = new AggregateError([error, new Error(`retry failed: ${rawUrl}`)], 'service checks failed');
        const formatted = `${formatError(aggregate)}\n${formatError(unsafeNamedError)}`;

        expect(formatted).toContain('AggregateError');
        expect(formatted).toContain('ECONNREFUSED');
        for (const secret of [
            'error-user',
            'error-password',
            'auth-secret',
            'unknown=query-secret',
            'fragment-secret',
            rawUrl,
            'raw secret',
        ]) {
            expect(formatted).not.toContain(secret);
        }
    });
});
