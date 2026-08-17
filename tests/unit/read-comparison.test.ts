import { describe, expect, test } from 'vitest';
import {
    assertReadComparisonEquivalent,
    buildReadComparisonPlan,
    createReadComparisonDigest,
    type ReadComparisonOperation,
} from '../../tests/load/read-comparison';

describe('read-only cache comparison planning', () => {
    test('builds a deterministic plan covering unique and list reads for both models', () => {
        const corpus = {
            tenantIds: ['tenant-0', 'tenant-1'],
            widgets: [
                { id: 'widget-0', tenantId: 'tenant-0', initialName: 'widget-0', workerIndex: 0 },
                { id: 'widget-1', tenantId: 'tenant-1', initialName: 'widget-1', workerIndex: 1 },
            ],
            parts: [
                { id: 'part-0', tenantId: 'tenant-0', label: 'part-0', widgetId: 'widget-0' },
                { id: 'part-1', tenantId: 'tenant-1', label: 'part-1', widgetId: 'widget-1' },
            ],
        };

        const plan = buildReadComparisonPlan(corpus);

        expect(plan).toEqual<ReadComparisonOperation[]>([
            { kind: 'widgetUnique', widgetId: 'widget-0' },
            { kind: 'widgetUnique', widgetId: 'widget-1' },
            { kind: 'partUnique', partId: 'part-0' },
            { kind: 'partUnique', partId: 'part-1' },
            { kind: 'widgetList', tenantId: 'tenant-0' },
            { kind: 'widgetList', tenantId: 'tenant-1' },
            { kind: 'partList', tenantId: 'tenant-0' },
            { kind: 'partList', tenantId: 'tenant-1' },
        ]);
        expect(buildReadComparisonPlan(corpus)).toEqual(plan);
    });

    test('fails when a cold or warm digest differs from the raw digest', () => {
        const rawDigest = createReadComparisonDigest([{ id: 'widget-0', name: 'raw' }]);
        const coldDigest = createReadComparisonDigest([{ id: 'widget-0', name: 'different' }]);

        expect(() => assertReadComparisonEquivalent(rawDigest, coldDigest, 'cold')).toThrow(
            'Read comparison result mismatch in cold phase',
        );
    });
});
