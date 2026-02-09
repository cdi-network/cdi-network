import { generateId } from '../../src/utils/uuid.js';

describe('UUID Generator', () => {
    test('should return a valid UUID v4 string', () => {
        const id = generateId();
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
    });

    test('should return unique IDs', () => {
        const ids = new Set(Array.from({ length: 100 }, () => generateId()));
        expect(ids.size).toBe(100);
    });
});
