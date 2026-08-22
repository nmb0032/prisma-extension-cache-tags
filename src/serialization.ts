import superjson from 'superjson';
import type { CachedEnvelope } from './types';

export function serializeCacheEnvelope(value: unknown): ReturnType<typeof superjson.serialize> {
    const envelope: CachedEnvelope = {
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
