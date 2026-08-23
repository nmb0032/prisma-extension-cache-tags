import { normalizeConfig } from './config';
import { publishInvalidation } from './invalidation';
import type { CacheSchemaDescriptor, CacheScope } from './schema';
import { scopeRootTag } from './tag-format';
import type { CacheTagsConfig, RedisAdapter } from './types';

function validateScope(scope: CacheScope): void {
    if (typeof scope?.namespace !== 'string' || scope.namespace.trim().length === 0) {
        throw new Error('Scope namespace must be a non-empty string');
    }
    if (typeof scope.id !== 'string' || scope.id.trim().length === 0) {
        throw new Error('Scope id must be a non-empty string');
    }
}

export async function invalidateScope<TSchema extends CacheSchemaDescriptor>(
    scope: CacheScope,
    redisAdapter: RedisAdapter,
    config: CacheTagsConfig<TSchema>,
): Promise<void> {
    validateScope(scope);
    const normalized = normalizeConfig(config);
    await publishInvalidation([scopeRootTag(scope)], normalized, redisAdapter);
}
