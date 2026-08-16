export function percentile(samples: readonly number[], percentileValue: number): number {
    if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
        throw new Error('percentile must be between 0 and 1');
    }

    if (samples.length === 0) {
        return 0;
    }

    const sortedSamples = [...samples].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(percentileValue * sortedSamples.length) - 1);
    return sortedSamples[index] ?? 0;
}

export function operationsPerSecond(completed: number, durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('durationMs must be greater than 0');
    }

    return completed / (durationMs / 1000);
}
