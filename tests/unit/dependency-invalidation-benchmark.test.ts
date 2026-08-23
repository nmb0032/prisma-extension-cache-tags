import { describe, expect, test } from 'vitest';
import { compareInvalidationFanout } from '../../tests/load/dependency-invalidation-model';

describe('dependency invalidation benchmark model', () => {
    test('compares the representative legacy and query-aware fanout', () => {
        expect(compareInvalidationFanout({
            tenants: 100,
            modelsPerTenant: 20,
            queriesPerModel: 50,
            dependentModels: 2,
        })).toEqual({
            totalEntries: 100_000,
            legacyAffectedPerWrite: 5_950,
            queryAwareAffectedPerWrite: 150,
            reduction: 5_950 / 150,
        });
    });
});
