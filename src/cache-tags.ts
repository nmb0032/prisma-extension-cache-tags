import type { CacheScope } from './schema';
import { globalEntityTag, globalModelTag, normalizeTags, scopeEntityTag, scopeModelTag, scopeRootTag } from './tag-format';

export const createCacheTags = {
    forScope(scope: CacheScope): string[] {
        return [scopeRootTag(scope)];
    },
    forModel(scope: CacheScope | undefined, model: string): string[] {
        return [scope ? scopeModelTag(scope, model) : globalModelTag(model)];
    },
    forEntity(scope: CacheScope | undefined, model: string, identity: string): string[] {
        return [scope ? scopeEntityTag(scope, model, identity) : globalEntityTag(model, identity)];
    },
    combine(...tagLists: string[][]): string[] {
        return normalizeTags(tagLists.flat());
    },
};
