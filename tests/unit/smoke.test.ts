import { describe, expect, test } from 'vitest';
import { VERSION } from '../../src/index';

describe('package scaffold', () => {
    test('exports a version constant', () => {
        expect(VERSION).toBe('0.0.0');
    });
});
