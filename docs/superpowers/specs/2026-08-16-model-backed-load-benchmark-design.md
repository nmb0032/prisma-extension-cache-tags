# Model-Backed Load Benchmark Design

## Goal

Add a realistic benchmark that exercises `prisma-extension-cache-tags` through Prisma 7, PostgreSQL, and Redis while preserving the existing focused proof that tag invalidation cost does not scale with Redis keyspace size.

The benchmark is developer-facing performance instrumentation. It reports measurements without enforcing environment-sensitive latency or throughput thresholds. Correctness failures, stale reads, and workload errors remain fatal.

## Command Surface

- Rename the current synthetic command from `test:load` to `test:benchmark:invalidation`.
- Add `test:benchmark:load` for the model-backed benchmark.
- Select a workload with `--profile quick` or `--profile stress`; `quick` is the default.
- Retain benchmark data only when `--preserve` is passed. Cleanup is the default.

No additional package script is needed for the stress profile.

## Architecture

The load benchmark is a standalone TypeScript program under `tests/load/`. It uses the existing Prisma fixture models and the production node-redis adapter rather than reimplementing cache behavior.

The benchmark is split into focused units:

1. **Profile configuration** defines dataset size, tenant count, concurrency, warm-up duration, measurement duration, and the read/write mix.
2. **Fixture lifecycle** verifies service availability, initializes the generated Prisma fixture, seeds benchmark-owned `Widget` and `Part` records, and removes only records created by the current run.
3. **Workload runner** creates multiple independent extended Prisma clients and distributes operations across workers for the selected duration.
4. **Metrics collector** records operation counts, errors, cache behavior, database query counts, freshness failures, throughput, and latency samples.
5. **Reporter** renders the selected profile and p50, p95, and p99 results in a terminal-readable summary.

The harness will reuse shared service-preflight and fixture-bootstrap behavior where practical. Benchmark-specific code will not be added to production exports.

## Workload

Each run creates a unique run ID, multiple tenant IDs, and associated `Widget` and `Part` rows. Reads select existing records and representative lists through the cache extension. Writes update existing widgets through the same extended clients so automatic invalidation is exercised.

The measured workload uses a 90% read and 10% write mix. Before measurement, a warm-up phase populates the cache. Multiple independent Prisma clients model concurrent application instances and exercise distributed stampede protection.

The profiles differ only in scale:

- **Quick** uses a modest dataset, bounded concurrency, and a short duration suitable for routine local development.
- **Stress** uses a larger dataset, higher concurrency, and a longer duration for deliberate capacity investigation.

Profile values are constants covered by tests. Environment variables select service URLs, but they do not redefine the workload contract.

## Measurements and Correctness

The terminal report includes:

- completed operations and operations per second;
- read and write counts;
- p50, p95, and p99 latency;
- cache hit rate;
- database query count;
- workload error count;
- stale-read or invalidation-freshness failure count.

Performance measurements are informational because local hardware, Docker resources, and CI contention vary. The command exits unsuccessfully when service setup fails, an operation fails, or a post-write read observes stale data.

The cache hit rate is derived from extension metrics, while the existing query-counting layer distinguishes cache-served reads from database queries. Correctness checks use known write values and subsequent reads rather than timing assumptions.

## Isolation and Cleanup

The benchmark must not call `FLUSHDB`.

Every run receives a unique Redis `keyPrefix` and unique database tenant marker. Default cleanup deletes only Redis keys under that run prefix and only fixture rows associated with that run. Redis cleanup uses incremental `SCAN` because it is test teardown scoped to a unique namespace; production invalidation remains scan-free.

`--preserve` skips both Redis and database cleanup and prints the run ID, tenant markers, and key prefix so a developer can inspect the data. Even after an error, default cleanup runs in `finally` and all Prisma and Redis clients are closed.

## Existing Invalidation Benchmark

`tests/load/invalidation-scaling.ts` remains a focused microbenchmark. It directly seeds stable synthetic Redis keyspaces and calls the production tag-version increment path to verify that invalidation latency and Redis command count do not grow with unrelated cache-key count.

Its command becomes `test:benchmark:invalidation`. Its documentation will clearly label its synthetic keys and cleanup behavior so it is not mistaken for an end-to-end load test.

## Automated Testing

Deterministic unit tests cover:

- profile selection and invalid arguments;
- percentile and throughput calculations;
- operation-mix selection;
- report aggregation;
- benchmark namespace generation and cleanup filtering.

A reduced integration smoke test uses real Prisma, PostgreSQL, and Redis to prove:

- warm reads produce cache hits and reduce database queries;
- a write invalidates the relevant cached read;
- the next read returns the updated value;
- default cleanup removes only the benchmark namespace and rows.

CI runs this correctness smoke coverage through the integration suite. It does not run or gate on benchmark performance. The full quick and stress benchmarks remain manual commands.

## Documentation

`README.md` and `CONTRIBUTING.md` will explain:

- the distinction between invalidation and model-backed benchmarks;
- Docker/service prerequisites;
- quick and stress commands;
- reported metrics;
- default cleanup and `--preserve`;
- why performance numbers are not CI thresholds.

## Execution Boundaries

Implementation will be divided into sequential, reviewable tasks:

1. Rename and document the existing invalidation benchmark command.
2. Add tested workload profiles, statistics, and reporting primitives.
3. Add the fixture lifecycle and isolated cleanup.
4. Add the concurrent model-backed workload runner and CLI.
5. Add the real-service correctness smoke test.
6. Update user and contributor documentation.
7. Run focused and whole-package verification.

GPT-5.6 Luna Max subagents will implement these tasks. Each task will be reviewed before the next dependent task begins.
