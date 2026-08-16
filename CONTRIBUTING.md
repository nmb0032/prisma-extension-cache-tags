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

Run the test groups with the package scripts:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:load
pnpm test:e2e
```

Unit tests must not require Docker. Integration and end-to-end tests may use
the services started by `pnpm db:up`; stop them with `pnpm db:down` when done.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
subjects, such as `docs: clarify transaction invalidation`.
