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

`pnpm db:up` is required before running the integration or load suites:

```bash
pnpm test:integration
pnpm test:load
```

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
