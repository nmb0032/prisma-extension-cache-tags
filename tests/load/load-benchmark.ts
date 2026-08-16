import { BenchmarkMetrics } from './benchmark-metrics';
import { createBenchmarkFixture, type BenchmarkFixture } from './benchmark-fixture';
import { runModelWorkload, warmBenchmarkCache } from './model-workload';
import { parseBenchmarkArgs } from './profiles';
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

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const { profile, preserve } = parseBenchmarkArgs(args[0] === '--' ? args.slice(1) : args);

    await checkServices();
    ensureFixtureSchema();

    const metrics = new BenchmarkMetrics();
    const fixture = await createBenchmarkFixture(profile, metrics, { preserve });
    let primaryFailed = false;
    let primaryError: unknown;

    try {
        console.log(`Benchmark profile: ${profile.name}`);
        console.log(`Run namespace: ${fixture.keyPrefix}`);
        if (preserve) {
            printPreservedResources(fixture);
        }

        await warmBenchmarkCache(fixture, profile);
        metrics.reset();
        for (const queryCounter of fixture.queryCounters) {
            queryCounter.reset();
        }

        const startedAt = process.hrtime.bigint();
        await runModelWorkload(fixture, profile, metrics);
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const summary = metrics.summarize(elapsedMs);

        console.table([
            {
                profile: profile.name,
                completed: summary.completed,
                reads: summary.reads,
                writes: summary.writes,
                'ops/sec': summary.operationsPerSecond.toFixed(1),
                'p50 (ms)': summary.p50Ms.toFixed(2),
                'p95 (ms)': summary.p95Ms.toFixed(2),
                'p99 (ms)': summary.p99Ms.toFixed(2),
                'cache hit rate': `${(summary.cacheHitRate * 100).toFixed(1)}%`,
                'database queries': summary.databaseQueries,
                errors: summary.errors,
                'freshness failures': summary.freshnessFailures,
            },
        ]);

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

        try {
            await fixture.cleanup();
        } catch (error) {
            failures.push(error);
        }

        try {
            await fixture.disconnect();
        } catch (error) {
            failures.push(error);
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
