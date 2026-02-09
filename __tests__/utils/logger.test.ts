import { createLogger } from '../../src/utils/logger.js';

describe('Logger', () => {
    test('should create a logger with default level', () => {
        const logger = createLogger();
        expect(logger).toBeDefined();
        expect(logger.level).toBe('info');
    });

    test('should create a logger with custom level', () => {
        const logger = createLogger('debug');
        expect(logger.level).toBe('debug');
    });

    test('should write to stdout without throwing', () => {
        const logger = createLogger('debug', 'test-label');
        expect(() => logger.info('hello world')).not.toThrow();
        expect(() => logger.debug('debug message')).not.toThrow();
    });
});
