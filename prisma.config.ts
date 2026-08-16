import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
    schema: path.join('tests', 'fixture', 'schema.prisma'),
    datasource: {
        url: env('TEST_DATABASE_URL'),
    },
});
