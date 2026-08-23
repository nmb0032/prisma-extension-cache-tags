import { describe, expect, test } from 'vitest';
import * as api from '../../src/index';

describe('public api', () => {
    test('exports the extension factory and invalidation wrapper', () => {
        expect(typeof api.createCacheTagsExtension).toBe('function');
        expect(typeof api.withCacheInvalidation).toBe('function');
        expect(typeof api.invalidateScope).toBe('function');
    });

    test('tag helpers produce the documented formats', () => {
        const scope = { namespace: 'tenant', id: 't1' };
        expect(api.createCacheTags.forScope(scope)).toEqual(['scope:tenant:t1:root']);
        expect(api.createCacheTags.forModel(scope, 'Widget')).toEqual(['scope:tenant:t1:model:Widget']);
        expect(api.createCacheTags.forModel(undefined, 'Widget')).toEqual(['global:model:Widget']);
        expect(api.createCacheTags.forEntity(scope, 'Widget', 'w9')).toEqual(['scope:tenant:t1:entity:Widget:w9']);
        expect(api.createCacheTags.forEntity(undefined, 'Widget', 'w9')).toEqual(['global:entity:Widget:w9']);
    });

    test('combine dedupes across lists', () => {
        expect(
            api.createCacheTags.combine(api.createCacheTags.forScope({ namespace: 'tenant', id: 't1' }), api.createCacheTags.forScope({ namespace: 'tenant', id: 't1' })),
        ).toEqual(['scope:tenant:t1:root']);
    });

    test('does not leak internal helpers', () => {
        expect('readThroughCache' in api).toBe(false);
        expect('handleWrite' in api).toBe(false);
        expect('bumpTagVersions' in api).toBe(false);
    });
});
