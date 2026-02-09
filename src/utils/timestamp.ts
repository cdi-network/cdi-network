/**
 * Returns the current Unix timestamp in milliseconds.
 * Wrapped in a function for testability (can be mocked).
 */
export const now = (): number => Date.now();
