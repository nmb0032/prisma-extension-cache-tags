import { defineConfig } from 'tsup';
import { chmod } from 'node:fs/promises';

export default [
    defineConfig({
        clean: true,
        dts: true,
        entry: {
            index: 'src/index.ts',
            'adapters/node-redis': 'src/adapters/node-redis.ts',
            'adapters/ioredis': 'src/adapters/ioredis.ts',
        },
        format: ['cjs', 'esm'],
        sourcemap: true,
        target: 'node20',
    }),
    defineConfig({
        banner: { js: '#!/usr/bin/env node' },
        clean: false,
        dts: false,
        entry: {
            generator: 'src/generator/index.ts',
        },
        format: ['cjs'],
        onSuccess: async () => {
            await chmod('dist/generator.js', 0o755);
        },
        sourcemap: true,
        target: 'node20',
    }),
];
