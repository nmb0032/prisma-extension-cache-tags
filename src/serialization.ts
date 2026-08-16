import superjson from 'superjson';
import type { CachedEnvelope } from './types';

export function serializeCacheEnvelope(value: unknown, fingerprint: string): ReturnType<typeof superjson.serialize> {
    const envelope: CachedEnvelope = {
        fingerprint,
        value: superjson.serialize(value),
    };

    return superjson.serialize(envelope);
}

export function deserializeCacheEnvelope(serialized: ReturnType<typeof superjson.serialize>): CachedEnvelope {
    return superjson.deserialize<CachedEnvelope>(serialized);
}

export function deserializeCachedValue(envelope: CachedEnvelope): unknown {
    return superjson.deserialize(envelope.value);
}

export function stableStringify(value: unknown): string {
    return superjson.stringify(value);
}
