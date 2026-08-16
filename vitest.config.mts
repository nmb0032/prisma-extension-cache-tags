import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        fileParallelism: false,
        testTimeout: 30000,
        hookTimeout: 30000,
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['tests/unit/**/*.test.ts'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['tests/integration/**/*.test.ts'],
                    globalSetup: ['./tests/integration/global-setup.ts'],
                },
            },
        ],
    },
});
