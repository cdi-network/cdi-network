import { now } from '../../src/utils/timestamp.js';

describe('Timestamp', () => {
    test('should return a number close to Date.now()', () => {
        const before = Date.now();
        const ts = now();
        const after = Date.now();
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });
});
