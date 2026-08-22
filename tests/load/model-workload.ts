import type { BenchmarkMetrics } from './benchmark-metrics';
import type { BenchmarkFixture, BenchmarkPart, BenchmarkReadCorpus, BenchmarkWidget } from './benchmark-fixture';
import { selectOperation, type BenchmarkProfile, type BenchmarkWorkloadName } from './profiles';
import { createSeededPrng, selectZipfianRank } from './realistic-workload';

const CACHE_TTL_SECONDS = 300;
const MINIMUM_WARMUP_PASSES = 2;
const MAX_WARMUP_PASSES = 4;
const MAX_WARMUP_ITEMS_PER_MODEL = 64;
const MAX_WARMUP_LIST_TENANTS = 2;
const LIST_READ_TAKE = 25;
const LIST_HEAVY_READ_TAKE = 100;

export const MAX_WARMUP_REQUESTS_PER_CLIENT =
    MAX_WARMUP_ITEMS_PER_MODEL * 2 + MAX_WARMUP_LIST_TENANTS * 3;

type ReadKind = 'widgetUnique' | 'partUnique' | 'widgetList' | 'partList' | 'widgetAggregate';

export interface ColdListProbeResult {
    resultCount: number;
    databaseQueries: number;
}

export async function warmBenchmarkCache(
    fixture: BenchmarkFixture,
    profile: BenchmarkProfile,
    workload: BenchmarkWorkloadName = 'standard',
): Promise<void> {
    if (!fixture.coldListProbeCompleted) {
        await runColdSharedListQuery(fixture);
    }

    const startedAt = Date.now();
    let completedPasses = 0;
    const widgets = sampleItems(fixture.readCorpus.widgets, MAX_WARMUP_ITEMS_PER_MODEL);
    const parts = sampleItems(fixture.readCorpus.parts, MAX_WARMUP_ITEMS_PER_MODEL);
    const tenantIds = fixture.readCorpus.tenantIds.slice(0, MAX_WARMUP_LIST_TENANTS);

    do {
        await Promise.all(
            fixture.clients.map((client) =>
                warmClient(client, widgets, parts, tenantIds, workload),
            ),
        );
        completedPasses += 1;
    } while (
        completedPasses < MINIMUM_WARMUP_PASSES ||
        (completedPasses < MAX_WARMUP_PASSES && Date.now() - startedAt < profile.warmupMs)
    );
}

export async function runColdSharedListQuery(fixture: BenchmarkFixture): Promise<ColdListProbeResult> {
    if (fixture.clients.length < 2) {
        throw new Error('The benchmark requires at least two independent clients for the cold list probe');
    }

    const tenantId = fixture.readCorpus.tenantIds[0];
    if (tenantId === undefined) {
        throw new Error('The benchmark read corpus must contain at least one tenant');
    }

    const args = {
        where: {
            tenantId,
            name: { startsWith: `benchmark:${fixture.runId}:tenant:0:widget:` },
        },
        orderBy: { id: 'asc' as const },
        select: {
            id: true,
            tenantId: true,
            name: true,
            description: true,
        },
        cache: { ttlSeconds: CACHE_TTL_SECONDS },
    };
    const beforeQueries = totalQueries(fixture);
    const [first, second] = await Promise.all(
        fixture.clients.slice(0, 2).map((client) => client.widget.findMany(args)),
    );
    const databaseQueries = totalQueries(fixture) - beforeQueries;

    if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('Cold shared list probe returned different results across independent clients');
    }
    if (databaseQueries !== 1) {
        throw new Error(`Cold shared list probe expected one database query, observed ${databaseQueries}`);
    }

    fixture.coldListProbeCompleted = true;
    return { resultCount: first?.length ?? 0, databaseQueries };
}

export async function runModelWorkload(
    fixture: BenchmarkFixture,
    profile: BenchmarkProfile,
    metrics: BenchmarkMetrics,
    options: {
        now?: () => number;
        random?: () => number;
        maxOperationsPerWorker?: number;
        workload?: BenchmarkWorkloadName;
    } = {},
): Promise<void> {
    if (fixture.clients.length < 2) {
        throw new Error('The benchmark requires at least two independent clients for cross-client freshness reads');
    }
    if (fixture.readCorpus.widgets.length === 0) {
        throw new Error('The benchmark read corpus must contain at least one widget');
    }

    const now = options.now ?? Date.now;
    const workload = options.workload ?? 'standard';
    const random =
        options.random ??
        (workload === 'zipfian' ? createSeededPrng(`${fixture.runId}:zipfian`) : Math.random);
    const deadline = now() + profile.durationMs;

    const workerResults = await Promise.allSettled(
        fixture.clients.map((client, workerIndex) =>
            runWorker(
                client,
                fixture.clients[(workerIndex + 1) % fixture.clients.length]!,
                fixture.widgetsByWorker[workerIndex]!,
                fixture.readCorpus,
                workerIndex,
                profile,
                workload,
                metrics,
                deadline,
                now,
                random,
                options.maxOperationsPerWorker,
            ),
        ),
    );

    metrics.addDatabaseQueries(totalQueries(fixture));

    const failures = workerResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Concurrent benchmark workers failed');
    }
}

async function warmClient(
    client: BenchmarkFixture['clients'][number],
    widgets: BenchmarkWidget[],
    parts: BenchmarkPart[],
    tenantIds: string[],
    workload: BenchmarkWorkloadName,
): Promise<void> {
    const listTake = workload === 'standard' ? LIST_READ_TAKE : LIST_HEAVY_READ_TAKE;
    await Promise.all([
        ...widgets.map((widget) =>
            client.widget.findUnique({
                where: { id: widget.id },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
        ...parts.map((part) =>
            client.part.findUnique({
                where: { id: part.id },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
        ...tenantIds.map((tenantId) =>
            client.widget.findMany({
                where: { tenantId },
                orderBy: { id: 'asc' },
                take: listTake,
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
        ...tenantIds.map((tenantId) =>
            client.part.findMany({
                where: { tenantId },
                orderBy: { id: 'asc' },
                take: listTake,
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
        ...tenantIds.map((tenantId) =>
            client.widget.aggregate({
                where: { tenantId },
                _count: { _all: true },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            }),
        ),
    ]);
}

async function runWorker(
    client: BenchmarkFixture['clients'][number],
    readbackClient: BenchmarkFixture['clients'][number],
    ownedWidgets: BenchmarkWidget[],
    readCorpus: BenchmarkReadCorpus,
    workerIndex: number,
    profile: BenchmarkProfile,
    workload: BenchmarkWorkloadName,
    metrics: BenchmarkMetrics,
    deadline: number,
    now: () => number,
    random: () => number,
    maxOperationsPerWorker: number | undefined,
): Promise<void> {
    if (ownedWidgets.length === 0) {
        return;
    }

    let operations = 0;
    let writeCounter = 0;

    while (now() < deadline && (maxOperationsPerWorker === undefined || operations < maxOperationsPerWorker)) {
        const startedAt = now();

        try {
            const operation = selectOperation(random(), profile.readRatio);

            if (operation === 'read') {
                await runReadOperation(readbackClient, readCorpus, random, workload);
            } else {
                const widget = ownedWidgets[selectIndex(random(), ownedWidgets.length)]!;
                const expectedName = `benchmark:${workerIndex}:write:${writeCounter}`;
                writeCounter += 1;
                await client.widget.update({
                    where: { id: widget.id },
                    data: { name: expectedName },
                });

                const observed = await readbackClient.widget.findUnique({
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

async function runReadOperation(
    client: BenchmarkFixture['clients'][number],
    readCorpus: BenchmarkReadCorpus,
    random: () => number,
    workload: BenchmarkWorkloadName,
): Promise<void> {
    const readKind = selectReadKind(random(), readCorpus.parts.length > 0, workload);
    const listTake = workload === 'standard' ? LIST_READ_TAKE : LIST_HEAVY_READ_TAKE;

    switch (readKind) {
        case 'widgetUnique': {
            const widget = readCorpus.widgets[
                workload === 'zipfian'
                    ? selectZipfianRank(random, readCorpus.widgets.length)
                    : selectIndex(random(), readCorpus.widgets.length)
            ]!;
            await client.widget.findUnique({
                where: { id: widget.id },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            });
            return;
        }
        case 'partUnique': {
            const part = readCorpus.parts[selectIndex(random(), readCorpus.parts.length)]!;
            await client.part.findUnique({
                where: { id: part.id },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            });
            return;
        }
        case 'widgetList': {
            const tenantId = readCorpus.tenantIds[selectIndex(random(), readCorpus.tenantIds.length)]!;
            await client.widget.findMany({
                where: { tenantId },
                orderBy: { id: 'asc' },
                take: listTake,
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            });
            return;
        }
        case 'partList': {
            const tenantId = readCorpus.tenantIds[selectIndex(random(), readCorpus.tenantIds.length)]!;
            await client.part.findMany({
                where: { tenantId },
                orderBy: { id: 'asc' },
                take: listTake,
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            });
            return;
        }
        case 'widgetAggregate': {
            const tenantId = readCorpus.tenantIds[
                workload === 'zipfian'
                    ? selectZipfianRank(random, readCorpus.tenantIds.length)
                    : selectIndex(random(), readCorpus.tenantIds.length)
            ]!;
            await client.widget.aggregate({
                where: { tenantId },
                _count: { _all: true },
                cache: { ttlSeconds: CACHE_TTL_SECONDS },
            });
            return;
        }
    }
}

function selectReadKind(sample: number, hasParts: boolean, workload: BenchmarkWorkloadName): ReadKind {
    const kinds: ReadKind[] =
        workload === 'list-heavy'
            ? [
                  'widgetList',
                  'partList',
                  'widgetAggregate',
                  'widgetList',
                  'partList',
                  'widgetAggregate',
                  'widgetList',
                  'partList',
                  'widgetUnique',
                  'partUnique',
              ]
            : hasParts
              ? ['widgetUnique', 'partUnique', 'widgetList', 'partList']
              : ['widgetUnique', 'widgetList', 'partList'];
    return kinds[Math.min(kinds.length - 1, selectIndex(sample, kinds.length))]!;
}

function selectIndex(sample: number, length: number): number {
    if (length < 1) {
        throw new Error('Cannot select from an empty benchmark corpus');
    }
    return Math.min(length - 1, Math.floor(sample * length));
}

function sampleItems<T>(items: readonly T[], limit: number): T[] {
    if (items.length <= limit) {
        return [...items];
    }

    const samples: T[] = [];
    for (let index = 0; index < limit; index += 1) {
        const item = items[Math.floor((index * items.length) / limit)];
        if (item !== undefined) {
            samples.push(item);
        }
    }
    return samples;
}

function totalQueries(fixture: BenchmarkFixture): number {
    return fixture.queryCounters.reduce((total, counter) => total + counter.total, 0);
}
