import superjson from 'superjson';
import type { PreparedCacheKey, CachedEnvelopeV2 } from './types';

export type { CachedEnvelopeV2 } from './types';

export function serializeCacheEnvelope(envelope: CachedEnvelopeV2): string {
    return superjson.stringify(envelope);
}

export function deserializeCacheEnvelope(payload: string): CachedEnvelopeV2 {
    return superjson.parse<CachedEnvelopeV2>(payload);
}

export function matchesCacheIdentity(envelope: CachedEnvelopeV2, prepared: PreparedCacheKey): boolean {
    if (
        !envelope ||
        typeof envelope.identity !== 'string' ||
        !Array.isArray(envelope.tenantScope) ||
        !Array.isArray(prepared.tenantScope)
    ) {
        return false;
    }

    return (
        envelope.identity === prepared.identity &&
        envelope.tenantScope.length === prepared.tenantScope.length &&
        envelope.tenantScope.every((tenantId, index) => tenantId === prepared.tenantScope[index])
    );
}
