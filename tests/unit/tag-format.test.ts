import { describe, expect, test } from 'vitest';
import {
    globalEntityTag,
    globalModelTag,
    normalizeTags,
    scopeEntityTag,
    scopeModelTag,
    scopeRootTag,
} from '../../src/tag-format';

describe('v3 tag format', () => {
    test('encodes dynamic components without delimiter collisions', () => {
        expect(scopeRootTag({ namespace: 'org:type', id: 'a:b%2Fc' })).toBe(
            'scope:org%3Atype:a%3Ab%252Fc:root',
        );
        expect(scopeModelTag({ namespace: 'organization', id: 'org_1' }, 'WorkOrder')).toBe(
            'scope:organization:org_1:model:WorkOrder',
        );
        expect(scopeEntityTag({ namespace: 'organization', id: 'org_1' }, 'Work:Order', 'a:b')).toBe(
            'scope:organization:org_1:entity:Work%3AOrder:a%3Ab',
        );
        expect(globalModelTag('Equipment')).toBe('global:model:Equipment');
        expect(globalEntityTag('Equipment:Part', 'a:b')).toBe(
            'global:entity:Equipment%3APart:a%3Ab',
        );
    });

    test('normalizes tags by trimming, deduplicating, and sorting', () => {
        expect(normalizeTags([' b ', '', 'a', 'b', '  ', 'a'])).toEqual(['a', 'b']);
    });
});
