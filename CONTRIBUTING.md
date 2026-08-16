# Contributing

## Local setup

Install dependencies, start the PostgreSQL and Redis services, then generate
the Prisma client and push the fixture schema:

```bash
pnpm install
pnpm db:up
pnpm exec prisma generate && pnpm exec prisma db push
```

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
