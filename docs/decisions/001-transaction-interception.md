# Transaction interception on Prisma 7

`$transaction` interception works on Prisma 7.9.1: the compatibility spike wrapped the extended client's interactive transaction method and observed the callback exactly once, while the transaction committed successfully and rollback remained intact.

The tested version is Prisma 7.9.1 (`prisma`, `@prisma/client`, and `@prisma/adapter-pg`). We take the interception branch: later cache invalidation work may patch `$transaction` on the extended client, and the `withCacheInvalidation` fallback wrapper is not required.
