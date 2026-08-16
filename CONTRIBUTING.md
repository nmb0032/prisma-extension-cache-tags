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

`pnpm db:up` is required before running the integration or benchmark suites:

```bash
pnpm test:integration
pnpm test:benchmark:invalidation
pnpm test:benchmark:load
```

The invalidation benchmark is a synthetic Redis keyspace-scaling check. The
model-backed benchmark uses real Prisma `Widget` and `Part` operations against
PostgreSQL and Redis. It defaults to the quick profile; use
`pnpm test:benchmark:load -- --profile stress` for a larger, longer run.
Benchmark performance is informational and is not a CI gate.

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
