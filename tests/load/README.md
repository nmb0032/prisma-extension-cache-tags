# Invalidation scaling load harness

This harness measures invalidation latency while the Redis keyspace grows from
1,000 to 100,000 cached keys. It seeds each keyspace with cached query values,
performs 200 invalidations with the real node-redis adapter, and records p50
and p99 latency. Redis command statistics also verify that each invalidation
produces exactly one `INCRBY`, regardless of keyspace size.

## Run

Start the local Docker services and run the harness:

```bash
pnpm db:up
pnpm test:load
```

Set `TEST_REDIS_URL` to use another Redis endpoint:

```bash
TEST_REDIS_URL=redis://localhost:6380 pnpm test:load
```

The harness uses `FLUSHDB` before and after each keyspace, so point it at a
disposable Redis database.

The harness passes when p50 invalidation latency grows by no more than 2x
across the 100x keyspace increase. It exits non-zero when that threshold is
exceeded or when the observed Redis `INCRBY` count is not fixed.

The measurements are taken against local Docker Redis and describe this
project's keyspace-scaling property only. They are not a benchmark or latency
comparison against other packages.
