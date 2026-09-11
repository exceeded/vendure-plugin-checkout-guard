import { describe, expect, it } from 'vitest';
import { formatMinor } from './ops-alert.service';

describe('formatMinor', () => {
    it('formats known currencies', () => {
        expect(formatMinor(12999, 'GBP')).toBe('£129.99');
        expect(formatMinor(-2999, 'GBP')).toBe('-£29.99');
        expect(formatMinor(500, 'EUR')).toBe('€5.00');
    });
    it('never invents a currency', () => {
        expect(formatMinor(12999)).toBe('129.99');
        expect(formatMinor(12999, null)).toBe('129.99');
        expect(formatMinor(100, 'NOPE')).toBe('1.00 NOPE');
    });
});
