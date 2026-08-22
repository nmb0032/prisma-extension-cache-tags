import superjson from 'superjson';
import type { PreparedCacheKey, CachedEnvelopeV2 } from './types';

export type { CachedEnvelopeV2 } from './types';

export class InvalidCacheEnvelopeError extends Error {
    constructor() {
        super('Invalid cache envelope');
        this.name = 'InvalidCacheEnvelopeError';
    }
}

function isCacheEnvelope(value: unknown): value is CachedEnvelopeV2 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const envelope = value as Record<string, unknown>;
    if (
        typeof envelope.identity !== 'string' ||
        !Array.isArray(envelope.tenantScope) ||
        !Object.prototype.hasOwnProperty.call(envelope, 'value')
    ) {
        return false;
    }

    for (const tenantId of envelope.tenantScope) {
        if (typeof tenantId !== 'string') {
            return false;
        }
    }

    return true;
}

export function serializeCacheEnvelope(envelope: CachedEnvelopeV2): string {
    return superjson.stringify(envelope);
}

export function deserializeCacheEnvelope(payload: string): CachedEnvelopeV2 {
    let parsed: unknown;
    try {
        parsed = superjson.parse<unknown>(payload);
    } catch {
        throw new InvalidCacheEnvelopeError();
    }

    if (!isCacheEnvelope(parsed)) {
        throw new InvalidCacheEnvelopeError();
    }

    return parsed;
}

export function matchesCacheIdentity(envelope: CachedEnvelopeV2, prepared: PreparedCacheKey): boolean {
    if (!isCacheEnvelope(envelope) || !Array.isArray(prepared.tenantScope)) {
        return false;
    }

    return (
        envelope.identity === prepared.identity &&
        envelope.tenantScope.length === prepared.tenantScope.length &&
        envelope.tenantScope.every((tenantId, index) => tenantId === prepared.tenantScope[index])
    );
}
