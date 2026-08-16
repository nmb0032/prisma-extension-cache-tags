import tsParser from '@typescript-eslint/parser';

export default [
    {
        ignores: ['dist/**', 'tests/fixture/generated/**'],
    },
    {
        files: ['**/*.{js,mjs,cjs,ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
    },
];
