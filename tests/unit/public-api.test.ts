import { describe, expect, test } from 'vitest';
import * as api from '../../src/index';

describe('public api', () => {
    test('exports the extension factory and invalidation wrapper', () => {
        expect(typeof api.createCacheTagsExtension).toBe('function');
        expect(typeof api.withCacheInvalidation).toBe('function');
    });

    test('tag helpers produce the documented formats', () => {
        expect(api.createCacheTags.forTenant('t1')).toEqual(['tenant:t1']);
        expect(api.createCacheTags.forModel('t1', 'Widget')).toEqual(['tenant:t1:model:Widget']);
        expect(api.createCacheTags.forModel(undefined, 'Widget')).toEqual(['global:model:Widget']);
        expect(api.createCacheTags.forEntity('t1', 'Widget', 'w9')).toEqual(['tenant:t1:widget:w9']);
        expect(api.createCacheTags.forEntity(undefined, 'Widget', 'w9')).toEqual(['global:widget:w9']);
    });

    test('combine dedupes across lists', () => {
        expect(
            api.createCacheTags.combine(api.createCacheTags.forTenant('t1'), api.createCacheTags.forTenant('t1')),
        ).toEqual(['tenant:t1']);
    });

    test('does not leak internal helpers', () => {
        expect('readThroughCache' in api).toBe(false);
        expect('handleWrite' in api).toBe(false);
        expect('bumpTagVersions' in api).toBe(false);
    });
});
