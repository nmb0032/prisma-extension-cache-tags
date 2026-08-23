import { generatorHandler } from '@prisma/generator-helper';
import { buildCacheSchemaDescriptor } from './descriptor';
import { writeGeneratedCacheSchema } from './render';

generatorHandler({
    onManifest() {
        return {
            defaultOutput: './generated/cache-tags',
            prettyName: 'Prisma Cache Tags Schema Generator',
            requiresEngines: [],
        };
    },
    async onGenerate(options) {
        const output = options.generator.output?.value;
        if (!output) {
            throw new Error('prisma-cache-tags-generator requires an output path');
        }
        const descriptor = buildCacheSchemaDescriptor(options.dmmf.datamodel);
        await writeGeneratedCacheSchema(output, descriptor);
    },
});
