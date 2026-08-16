import { defineConfig } from 'tsup';

export default defineConfig({
    clean: true,
    dts: true,
    entry: {
        index: 'src/index.ts',
        // restored in Task 9
        // 'adapters/node-redis': 'src/adapters/node-redis.ts',
        // 'adapters/ioredis': 'src/adapters/ioredis.ts',
    },
    format: ['cjs', 'esm'],
    sourcemap: true,
    target: 'node20',
});
