import { BenchmarkMetrics } from './benchmark-metrics';
import { createBenchmarkFixture, deleteRedisNamespace, type BenchmarkFixture } from './benchmark-fixture';
import { buildBenchmarkReportRow } from './benchmark-report';
import { runColdKeyContention, type ContentionBenchmarkResult } from './contention-benchmark';
import { runModelWorkload, warmBenchmarkCache } from './model-workload';
import {
    buildReadComparisonKindReportRows,
    buildReadComparisonReportRow,
} from './read-comparison-report';
import { runReadOnlyComparison } from './read-comparison';
import { parseBenchmarkArgs, type BenchmarkProfile, type BenchmarkProfileName, type BenchmarkWorkloadName } from './profiles';
import {
    measureRedisCommandPhase,
    summarizeEventLoopDelta,
    type RedisCommandCounts,
    type RedisCommandPhaseMeasurement,
} from './query-kind-metrics';
import { calculateHotKeyShare, ZIPFIAN_EXPONENT } from './realistic-workload';
import { performance } from 'node:perf_hooks';
import {
    checkPostgresReachability,
    ensureFixtureSchema,
    TEST_DATABASE_URL,
} from '../integration/global-setup';
import {
    checkRedisReachability,
    formatError,
    formatServiceUnavailable,
    logError,
    TEST_REDIS_URL,
} from '../support/service-preflight';

interface ServiceCheck {
    service: string;
    url: string;
    environmentVariable: string;
    run(): Promise<void>;
}

async function checkServices(): Promise<void> {
    const checks: ServiceCheck[] = [
        {
            service: 'Redis',
            url: TEST_REDIS_URL,
            environmentVariable: 'TEST_REDIS_URL',
            run: () => checkRedisReachability(TEST_REDIS_URL),
        },
        {
            service: 'Postgres',
            url: TEST_DATABASE_URL,
            environmentVariable: 'TEST_DATABASE_URL',
            run: checkPostgresReachability,
        },
    ];
    const results = await Promise.allSettled(checks.map((check) => check.run()));
    const failures: string[] = [];

    for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
            const check = checks[index]!;
            failures.push(
                `${formatServiceUnavailable(check.service, check.url, check.environmentVariable)}\nDetails:\n${formatError(result.reason)}`,
            );
        }
    }

    if (failures.length > 0) {
        throw new Error(failures.join('\n\n'));
    }
}

function printPreservedResources(fixture: BenchmarkFixture): void {
    console.log(`Run ID: ${fixture.runId}`);
    console.log(`Tenant IDs: ${fixture.tenantIds.join(', ')}`);
    console.log(`Redis key prefix: ${fixture.keyPrefix}`);
    console.log('Cleanup skipped because --preserve was specified.');
}

function printBenchmarkReport(profile: BenchmarkProfileName, metrics: BenchmarkMetrics, startedAt: bigint) {
    const elapsedMs = Math.max(1, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    const summary = metrics.summarize(elapsedMs);
    console.table([buildBenchmarkReportRow(profile, summary)]);
    return summary;
}

function printContentionReport(result: ContentionBenchmarkResult): void {
    console.log(`Cold-key contention (${result.contenders} contenders, ${result.rounds} rounds):`);
    console.log(`Database queries per round: ${result.databaseQueriesPerRound.join(', ')}`);
    console.table([
        {
            cohort: 'winner',
            samples: result.rounds,
            'p50 (ms)': result.winner.p50Ms.toFixed(2),
            'p95 (ms)': result.winner.p95Ms.toFixed(2),
            'p99 (ms)': result.winner.p99Ms.toFixed(2),
        },
        {
            cohort: 'losers',
            samples: result.rounds * (result.contenders - 1),
            'p50 (ms)': result.losers.p50Ms.toFixed(2),
            'p95 (ms)': result.losers.p95Ms.toFixed(2),
            'p99 (ms)': result.losers.p99Ms.toFixed(2),
        },
    ]);
    console.log(
        `Contention event-loop utilization: ${(result.eventLoop.utilization * 100).toFixed(1)}% ` +
            `(active ${result.eventLoop.activeMs.toFixed(2)}ms, idle ${result.eventLoop.idleMs.toFixed(2)}ms)`,
    );
}

function createContentionProfile(profile: BenchmarkProfile): BenchmarkProfile {
    return {
        ...profile,
        tenants: 1,
        widgetsPerTenant: 1,
        partsPerWidget: 0,
        concurrency: 32,
        warmupMs: 0,
        durationMs: 1,
        readRatio: 1,
    };
}

interface RedisCommandProbeReport {
    warmRead: RedisCommandPhaseMeasurement;
    coldRead: RedisCommandPhaseMeasurement;
    write: RedisCommandPhaseMeasurement;
    multiTagInvalidation: RedisCommandPhaseMeasurement;
}

async function runRedisCommandProbes(fixture: BenchmarkFixture): Promise<RedisCommandProbeReport> {
    const client = fixture.clients[0];
    const widget = fixture.readCorpus.widgets[0];
    if (client === undefined || widget === undefined) {
        throw new Error('Redis command probes require one seeded widget and client');
    }

    await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
    await client.widget.findUnique({
        where: { id: widget.id },
        cache: { ttlSeconds: 300 },
    });
    const warmRead = await measureRedisCommandPhase(fixture.redis, async () => {
        await client.widget.findUnique({
            where: { id: widget.id },
            cache: { ttlSeconds: 300 },
        });
    });

    await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
    const coldRead = await measureRedisCommandPhase(fixture.redis, async () => {
        await client.widget.findUnique({
            where: { id: widget.id },
            cache: { ttlSeconds: 300 },
        });
    });

    const write = await measureRedisCommandPhase(fixture.redis, async () => {
        await client.widget.update({
            where: { id: widget.id },
            data: { name: `${widget.initialName}:command-probe` },
        });
    });

    const multiTagInvalidation = await measureRedisCommandPhase(fixture.redis, async () => {
        await client.widget.updateMany({
            where: { tenantId: { in: fixture.tenantIds } },
            data: { name: `${widget.initialName}:multi-tag-probe` },
        });
    });

    return { warmRead, coldRead, write, multiTagInvalidation };
}

function printRedisCommandProbeReport(report: RedisCommandProbeReport): void {
    console.log('Redis command deltas (process-wide INFO commandstats counters; not namespace-local):');
    console.table(
        Object.entries(report).map(([phase, measurement]) => ({
            phase,
            ...formatCommandCounts(measurement.delta),
            'event-loop utilization': `${(measurement.eventLoop.utilization * 100).toFixed(1)}%`,
            'event-loop active (ms)': measurement.eventLoop.activeMs.toFixed(2),
            'event-loop idle (ms)': measurement.eventLoop.idleMs.toFixed(2),
        })),
    );
}

function formatCommandCounts(counts: RedisCommandCounts): Record<string, number> {
    return {
        get: counts.get,
        mget: counts.mget,
        set: counts.set,
        eval: counts.eval,
        evalsha: counts.evalsha,
        incrby: counts.incrby,
        expire: counts.expire,
    };
}

function printReadComparisonReport(
    comparison: Awaited<ReturnType<typeof runReadOnlyComparison>>,
    workload: BenchmarkWorkloadName,
    hotKeyIds: readonly string[],
): void {
    console.log(`Read-only cache comparison for workload ${workload} (same deterministic plan and concurrency):`);
    console.table([
        comparison.phases.rawA,
        comparison.phases.cold,
        comparison.phases.warm,
        comparison.phases.rawB,
    ].map(buildReadComparisonReportRow));
    for (const phase of [
        comparison.phases.rawA,
        comparison.phases.cold,
        comparison.phases.warm,
        comparison.phases.rawB,
    ]) {
        console.log(`${phase.mode} per-query-kind latency and throughput:`);
        console.table(buildReadComparisonKindReportRows(phase));
    }

    const listOrAggregateReads = comparison.plan.filter(
        (operation) =>
            operation.kind === 'widgetList' ||
            operation.kind === 'partList' ||
            operation.kind === 'widgetAggregate',
    ).length;
    if (workload === 'list-heavy') {
        console.log(
            `List-heavy distribution: ${((listOrAggregateReads / comparison.plan.length) * 100).toFixed(1)}% ` +
                'tenant list/aggregate reads (target >= 70.0%); list take=100.',
        );
    } else if (workload === 'zipfian') {
        console.log(
            `Zipfian distribution: exponent=${ZIPFIAN_EXPONENT.toFixed(1)}, ` +
                `hottest 20% widget-key share=${(
                    calculateHotKeyShare(
                        comparison.plan,
                        hotKeyIds.length,
                        hotKeyIds,
                    ) * 100
                ).toFixed(1)}% ` +
                '(target 80.0% +/- 10.0%).',
        );
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const { profile, preserve, workload } = parseBenchmarkArgs(args[0] === '--' ? args.slice(1) : args);

    await checkServices();
    ensureFixtureSchema();

    const metrics = new BenchmarkMetrics();
    const fixture = await createBenchmarkFixture(profile, metrics, { preserve });
    let contentionFixture: BenchmarkFixture | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    let measurementStartedAt: bigint | undefined;
    let reportPrinted = false;
    let mixedEventLoop: ReturnType<typeof summarizeEventLoopDelta> | undefined;
    let commandProbes: RedisCommandProbeReport | undefined;

    try {
        console.log(`Benchmark profile: ${profile.name}`);
        console.log(`Benchmark workload: ${workload}`);
        console.log(`Environment: TEST_DATABASE_URL=${TEST_DATABASE_URL}; TEST_REDIS_URL=${TEST_REDIS_URL}`);
        console.log(`Run namespace: ${fixture.keyPrefix}`);
        if (preserve) {
            printPreservedResources(fixture);
        }

        commandProbes = await runRedisCommandProbes(fixture);
        printRedisCommandProbeReport(commandProbes);

        const comparison = await runReadOnlyComparison(fixture, metrics, workload);
        console.log(`Discarded read warm-up: ${comparison.warmupReads} reads`);
        console.log(
            `Raw A/B drift: ${comparison.rawDriftPercent.toFixed(2)}% (${comparison.stableRawBaseline ? 'stable' : 'unstable'}; stable <= 10.00%)`,
        );
        printReadComparisonReport(
            comparison,
            workload,
            fixture.readCorpus.widgets
                .slice(0, Math.ceil(fixture.readCorpus.widgets.length * 0.2))
                .map((widget) => widget.id),
        );

        const contentionTarget =
            fixture.clients.length >= 32
                ? fixture
                : (contentionFixture = await createBenchmarkFixture(
                      createContentionProfile(profile),
                      new BenchmarkMetrics(),
                      { preserve },
                  ));
        if (preserve && contentionFixture) {
            console.log('Contention fixture resources:');
            printPreservedResources(contentionFixture);
        }
        printContentionReport(await runColdKeyContention(contentionTarget));

        metrics.reset();
        for (const queryCounter of fixture.queryCounters) {
            queryCounter.reset();
        }

        await deleteRedisNamespace(fixture.redis, fixture.keyPrefix);
        await warmBenchmarkCache(fixture, profile, workload);
        metrics.reset();
        for (const queryCounter of fixture.queryCounters) {
            queryCounter.reset();
        }

        measurementStartedAt = process.hrtime.bigint();
        const mixedEventLoopStart = performance.eventLoopUtilization();
        await runModelWorkload(fixture, profile, metrics, { workload });
        const mixedEventLoopDelta = performance.eventLoopUtilization(mixedEventLoopStart);
        mixedEventLoop = summarizeEventLoopDelta({
            active: mixedEventLoopDelta.active,
            idle: mixedEventLoopDelta.idle,
        });
        const summary = printBenchmarkReport(profile.name, metrics, measurementStartedAt);
        console.log(
            `Mixed correctness workload: ${summary.errors === 0 && summary.freshnessFailures === 0 ? 'PASS' : 'FAIL'} ` +
                `(errors=${summary.errors}, freshness failures=${summary.freshnessFailures})`,
        );
        console.log(
            `Mixed event-loop utilization: ${(mixedEventLoop.utilization * 100).toFixed(1)}% ` +
                `(active ${mixedEventLoop.activeMs.toFixed(2)}ms, idle ${mixedEventLoop.idleMs.toFixed(2)}ms)`,
        );
        reportPrinted = true;

        if (summary.errors !== 0 || summary.freshnessFailures !== 0) {
            throw new Error(
                `Benchmark reported ${summary.errors} errors and ${summary.freshnessFailures} freshness failures`,
            );
        }
    } catch (error) {
        primaryFailed = true;
        primaryError = error;
    } finally {
        const failures: unknown[] = primaryFailed ? [primaryError] : [];

        if (measurementStartedAt !== undefined && !reportPrinted) {
            try {
                printBenchmarkReport(profile.name, metrics, measurementStartedAt);
                reportPrinted = true;
            } catch (error) {
                failures.push(error);
            }
        }

        for (const resource of [contentionFixture, fixture]) {
            if (!resource) {
                continue;
            }
            try {
                await resource.cleanup();
            } catch (error) {
                failures.push(error);
            }
        }

        for (const resource of [contentionFixture, fixture]) {
            if (!resource) {
                continue;
            }
            try {
                await resource.disconnect();
            } catch (error) {
                failures.push(error);
            }
        }

        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Load benchmark failed');
        }
    }
}

void main().catch((error: unknown) => {
    logError(error);
    process.exitCode = 1;
});
