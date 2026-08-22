import { BenchmarkMetrics } from './benchmark-metrics';
import { createBenchmarkFixture, deleteRedisNamespace, type BenchmarkFixture } from './benchmark-fixture';
import { buildBenchmarkReportRow } from './benchmark-report';
import { runColdKeyContention, type ContentionBenchmarkResult } from './contention-benchmark';
import { runModelWorkload, warmBenchmarkCache } from './model-workload';
import { buildReadComparisonReportRow } from './read-comparison-report';
import { runReadOnlyComparison } from './read-comparison';
import { parseBenchmarkArgs, type BenchmarkProfile, type BenchmarkProfileName } from './profiles';
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

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const { profile, preserve } = parseBenchmarkArgs(args[0] === '--' ? args.slice(1) : args);

    await checkServices();
    ensureFixtureSchema();

    const metrics = new BenchmarkMetrics();
    const fixture = await createBenchmarkFixture(profile, metrics, { preserve });
    let contentionFixture: BenchmarkFixture | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    let measurementStartedAt: bigint | undefined;
    let reportPrinted = false;

    try {
        console.log(`Benchmark profile: ${profile.name}`);
        console.log(`Run namespace: ${fixture.keyPrefix}`);
        if (preserve) {
            printPreservedResources(fixture);
        }

        const comparison = await runReadOnlyComparison(fixture, metrics);
        console.log(`Discarded read warm-up: ${comparison.warmupReads} reads`);
        console.log(
            `Raw A/B drift: ${comparison.rawDriftPercent.toFixed(2)}% (${comparison.stableRawBaseline ? 'stable' : 'unstable'}; stable <= 10.00%)`,
        );
        console.log('Read-only cache comparison (same deterministic plan and concurrency; raw baseline is A/B mean when stable):');
        console.table([
            comparison.phases.rawA,
            comparison.phases.cold,
            comparison.phases.warm,
            comparison.phases.rawB,
        ].map(buildReadComparisonReportRow));

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
        await warmBenchmarkCache(fixture, profile);
        metrics.reset();
        for (const queryCounter of fixture.queryCounters) {
            queryCounter.reset();
        }

        measurementStartedAt = process.hrtime.bigint();
        await runModelWorkload(fixture, profile, metrics);
        const summary = printBenchmarkReport(profile.name, metrics, measurementStartedAt);
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
