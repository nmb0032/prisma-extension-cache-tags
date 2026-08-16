import type { BenchmarkMetrics } from './benchmark-metrics';
import type { BenchmarkFixture, BenchmarkWidget } from './benchmark-fixture';
import { selectOperation, type BenchmarkProfile } from './profiles';

const CACHE_TTL_SECONDS = 300;
const MINIMUM_WARMUP_PASSES = 2;

export async function warmBenchmarkCache(fixture: BenchmarkFixture, profile: BenchmarkProfile): Promise<void> {
    const startedAt = Date.now();
    let completedPasses = 0;

    do {
        await Promise.all(
            fixture.widgetsByWorker.map((widgets, workerIndex) =>
                warmWorkerShard(fixture.clients[workerIndex]!, widgets),
            ),
        );
        completedPasses += 1;
    } while (completedPasses < MINIMUM_WARMUP_PASSES || Date.now() - startedAt < profile.warmupMs);
}

export async function runModelWorkload(
    fixture: BenchmarkFixture,
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    options: { now?: () => number; random?: () => number; maxOperationsPerWorker?: number } = {},
): Promise<void> {
    const now = options.now ?? Date.now;
    const random = options.random ?? Math.random;
    const deadline = now() + profile.durationMs;

    const workerResults = await Promise.allSettled(
        fixture.clients.map((client, workerIndex) =>
            runWorker(
                client,
                fixture.widgetsByWorker[workerIndex]!,
                workerIndex,
                profile,
                metrics,
                deadline,
                now,
                random,
                options.maxOperationsPerWorker,
            ),
        ),
    );

    metrics.addDatabaseQueries(fixture.queryCounters.reduce((total, counter) => total + counter.total, 0));

    const failures = workerResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Concurrent benchmark workers failed');
    }
}

async function warmWorkerShard(client: BenchmarkFixture['clients'][number], widgets: BenchmarkWidget[]): Promise<void> {
    await Promise.all(
        widgets.map((widget) =>
            client.widget.findUnique({
                where: { id: widget.id },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
    );
}

async function runWorker(
    client: BenchmarkFixture['clients'][number],
    widgets: BenchmarkWidget[],
    workerIndex: number,
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    deadline: number,
    now: () => number,
    random: () => number,
    maxOperationsPerWorker: number | undefined,
): Promise<void> {
    if (widgets.length === 0) {
        return;
    }

    let operations = 0;
    let writeCounter = 0;

    while (now() < deadline && (maxOperationsPerWorker === undefined || operations < maxOperationsPerWorker)) {
        const startedAt = now();

        try {
            const operation = selectOperation(random(), profile.readRatio);
            const widget = widgets[Math.min(widgets.length - 1, Math.floor(random() * widgets.length))]!;

            if (operation === 'read') {
                await client.widget.findUnique({
                    where: { id: widget.id },
                    cache: { ttlSeconds: CACHE_TTL_SECONDS },
                });
            } else {
                const expectedName = `benchmark:${workerIndex}:write:${writeCounter}`;
                writeCounter += 1;
                await client.widget.update({
                    where: { id: widget.id },
                    data: { name: expectedName },
                });

                const observed = await client.widget.findUnique({
                    where: { id: widget.id },
                    cache: { ttlSeconds: CACHE_TTL_SECONDS },
                });
                const observedName = observed?.name;
                if (observedName !== expectedName) {
                    metrics.recordFreshnessFailure();
                    throw new Error(
                        `Freshness failure for widget ${widget.id}: expected name ${expectedName}, observed name ${String(observedName)}`,
                    );
                }
            }

            metrics.recordOperation(operation, now() - startedAt);
            operations += 1;
        } catch (error) {
            metrics.recordError();
            throw error;
        }
    }
}
