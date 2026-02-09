import { randomUUID } from 'crypto';

/**
 * Generates a UUID v4. Wraps Node.js crypto for testability.
 */
export const generateId = (): string => randomUUID();
