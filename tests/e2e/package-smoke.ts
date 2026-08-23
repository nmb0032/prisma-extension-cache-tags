import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const repoRoot = process.cwd();

function run(command: string, args: string[], cwd: string, showOutput = false, env?: NodeJS.ProcessEnv): void {
    execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        env: env === undefined ? process.env : { ...process.env, ...env },
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

        scratch = join(repoRoot, `.cache-tags-e2e-${process.pid}`);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        console.log(`Installing into ${scratch}...`);

        writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'e2e-consumer', version: '1.0.0', private: true }, null, 2));
        run('npm', ['install', join(repoRoot, tarball), '--legacy-peer-deps', '--no-audit', '--no-fund'], scratch);

        const generatorBinary = join(scratch, 'node_modules', '.bin', 'prisma-cache-tags-generator');
        console.log('Verifying the installed generator binary...');
        if (!existsSync(generatorBinary)) {
            throw new Error('prisma-cache-tags-generator binary is missing from the installed package');
        }
        try {
            accessSync(generatorBinary, constants.X_OK);
        } catch {
            throw new Error('prisma-cache-tags-generator binary is not executable');
        }

        console.log('Verifying CommonJS require()...');
        run(
            'node',
            [
                '-e',
                "const m = require('prisma-extension-cache-tags');" +
                    "if (typeof m.createCacheTagsExtension !== 'function') { throw new Error('createCacheTagsExtension missing from CJS build'); }" +
                    "if (typeof m.createCacheTags.forScope !== 'function') { throw new Error('createCacheTags missing from CJS build'); }" +
                    "if (typeof m.invalidateScope !== 'function') { throw new Error('invalidateScope missing from CJS build'); }" +
                    "if ('generatorProtocol' in m || typeof m.generator === 'function') { throw new Error('generator internals leaked from CJS root'); }",
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
                    "if (typeof m.createCacheTags.forScope !== 'function') { throw new Error('createCacheTags missing from ESM build'); }" +
                    "if (typeof m.invalidateScope !== 'function') { throw new Error('invalidateScope missing from ESM build'); }" +
                    "if ('generatorProtocol' in m || typeof m.generator === 'function') { throw new Error('generator internals leaked from ESM root'); }",
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

        writeFileSync(
            join(scratch, 'schema.prisma'),
            `generator cacheTags {
  provider = "prisma-cache-tags-generator"
  output   = "./generated/cache-tags"
}

datasource db {
  provider = "sqlite"
}

model WorkOrder {
  id          String    @id
  equipmentId String
  equipment   Equipment @relation(fields: [equipmentId], references: [id])
}

model Equipment {
  id         String      @id
  workOrders WorkOrder[]
}
`,
        );
        console.log('Generating the packaged cache schema descriptor...');
        run(
            join(repoRoot, 'node_modules', '.bin', 'prisma'),
            ['generate', '--schema', join(scratch, 'schema.prisma')],
            scratch,
            true,
            { PATH: `${join(scratch, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}` },
        );

        const generatedDescriptor = join(scratch, 'generated', 'cache-tags', 'index.ts');
        if (!existsSync(generatedDescriptor)) {
            throw new Error(`Prisma generator did not create ${generatedDescriptor}`);
        }
        const generatedSource = readFileSync(generatedDescriptor, 'utf8');
        if (!generatedSource.includes('"equipment"') || !generatedSource.includes('"target": "Equipment"')) {
            throw new Error('Generated descriptor is missing the WorkOrder equipment → Equipment relation');
        }

        console.log('Checking package exports metadata with publint...');
        run('pnpm', ['exec', 'publint', join(repoRoot, tarball)], repoRoot, true);

        console.log('Checking type resolution with are-the-types-wrong...');
        run(
            'pnpm',
            ['exec', 'attw', join(repoRoot, tarball), '--pack', '--ignore-rules', 'cjs-resolves-to-esm'],
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
