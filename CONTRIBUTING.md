# Contributing

## Local setup

Install dependencies, start the PostgreSQL and Redis services, then generate
the Prisma client and push the fixture schema:

```bash
pnpm install
pnpm db:up
export TEST_DATABASE_URL='postgresql://cachetags:cachetags@localhost:5433/cachetags'
export TEST_REDIS_URL='redis://localhost:6380'
pnpm exec prisma generate && pnpm exec prisma db push
```

`TEST_DATABASE_URL` is required because the Prisma 7 `prisma.config.ts`
resolves the datasource URL with `env('TEST_DATABASE_URL')`.

## Verification

`pnpm db:up` starts both PostgreSQL and Redis and is the simplest setup for the
integration suite and the model-backed benchmark. The exact service
requirements are:

- `pnpm test:integration`: PostgreSQL and Redis.
- `pnpm test:benchmark:invalidation`: Redis only, using a disposable database
  because the synthetic benchmark calls `FLUSHDB`.
- `pnpm test:benchmark:load`: PostgreSQL and Redis, with the fixture schema
  prepared above.

To run the integration and both benchmark commands with the local services:

```bash
pnpm db:up
pnpm test:integration
pnpm test:benchmark:invalidation
pnpm test:benchmark:load
```

The invalidation benchmark is a synthetic Redis keyspace-scaling check. The
model-backed benchmark first compares raw cache-bypassed Prisma/Postgres reads,
cold misses in an empty run namespace, and warm hits by repeating the exact
same deterministic read plan and concurrency. It checks that all three result
digests match and reports completed reads, throughput, latency percentiles,
cache events, database queries, and speedup relative to raw. It then prints the
existing blended 90% read / 10% write workload report for invalidation,
distributed stampede behavior, and post-write freshness checks. It defaults to
the quick profile; use `pnpm test:benchmark:load -- --profile stress` for a
larger, longer run. Benchmark performance is informational, makes no
statistical or CI-threshold claims, and correctness failures remain fatal.
The comparison namespace is cleared before the existing mixed-workload warm-up,
so its cache state and counters remain isolated from the comparison.
Warm-up requests are sampled and bounded; each benchmark Prisma client uses one
PostgreSQL connection so the stress profile remains within its concurrency
budget.

The model-backed benchmark cleans up only its run-specific database rows and
Redis namespace by default; normal cleanup never flushes the Redis database.
Use `pnpm test:benchmark:load -- --preserve` to leave those resources for
inspection. The command prints the run ID, tenant IDs, and Redis key prefix so
they can be located afterward. The synthetic invalidation benchmark does use
`FLUSHDB`, so run it only with a disposable Redis database and no concurrent
users.

These commands do not require Docker or the local services:

```bash
pnpm test:unit
pnpm build
pnpm typecheck
pnpm test:e2e
```

Stop the services with `pnpm db:down` when done.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
subjects, such as `docs: clarify transaction invalidation`.
