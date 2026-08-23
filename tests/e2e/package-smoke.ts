import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

function run(command: string, args: string[], cwd: string, showOutput = false): void {
    execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: showOutput ? 'inherit' : ['ignore', 'pipe', 'inherit'],
    });
}

function main(): void {
    console.log('Building...');
    run('pnpm', ['build'], repoRoot);

    let tarball: string | undefined;
    let scratch: string | undefined;

    try {
        console.log('Packing...');
        run('npm', ['pack', '--loglevel=error'], repoRoot);
        tarball = readdirSync(repoRoot).find((file) => file.startsWith('prisma-extension-cache-tags-') && file.endsWith('.tgz'));
        if (!tarball) {
            throw new Error('npm pack produced no tarball');
        }

        scratch = mkdtempSync(join(tmpdir(), 'cache-tags-e2e-'));
        console.log(`Installing into ${scratch}...`);

        writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'e2e-consumer', version: '1.0.0', private: true }, null, 2));
        run('npm', ['install', join(repoRoot, tarball), '--no-audit', '--no-fund'], scratch);

        console.log('Verifying CommonJS require()...');
        run(
            'node',
            [
                '-e',
                "const m = require('prisma-extension-cache-tags');" +
                    "if (typeof m.createCacheTagsExtension !== 'function') { throw new Error('createCacheTagsExtension missing from CJS build'); }" +
                    "if (typeof m.createCacheTags.forScope !== 'function') { throw new Error('createCacheTags missing from CJS build'); }",
            ],
            scratch,
        );

        console.log('Verifying ESM dynamic import()...');
        run(
            'node',
            [
                '--input-type=module',
                '-e',
                "const m = await import('prisma-extension-cache-tags');" +
                    "if (typeof m.createCacheTagsExtension !== 'function') { throw new Error('createCacheTagsExtension missing from ESM build'); }" +
                    "if (typeof m.createCacheTags.forScope !== 'function') { throw new Error('createCacheTags missing from ESM build'); }",
            ],
            scratch,
        );

        console.log('Verifying adapter subpath exports...');
        run(
            'node',
            [
                '-e',
                "const a = require('prisma-extension-cache-tags/node-redis');" +
                    "const b = require('prisma-extension-cache-tags/ioredis');" +
                    "if (typeof a.createNodeRedisAdapter !== 'function') { throw new Error('node-redis subpath broken'); }" +
                    "if (typeof b.createIoRedisAdapter !== 'function') { throw new Error('ioredis subpath broken'); }",
            ],
            scratch,
        );

        console.log('Checking package exports metadata with publint...');
        run('npx', ['--yes', 'publint', join(repoRoot, tarball)], repoRoot, true);

        console.log('Checking type resolution with are-the-types-wrong...');
        run(
            'npx',
            ['--yes', '@arethetypeswrong/cli', join(repoRoot, tarball), '--pack', '--ignore-rules', 'cjs-resolves-to-esm'],
            repoRoot,
            true,
        );
    } finally {
        if (scratch) {
            rmSync(scratch, { recursive: true, force: true });
        }
        if (tarball) {
            rmSync(join(repoRoot, tarball), { force: true });
        }
    }

    console.log('\nPASS: package installs and resolves under both CJS and ESM.');
}

main();
