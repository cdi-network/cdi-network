import winston from 'winston';

export const createLogger = (level: string = 'info', label?: string): winston.Logger => {
    return winston.createLogger({
        level,
        format: winston.format.combine(
            winston.format.label({ label: label || 'swarm' }),
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, label, message, ...meta }) =>
                `${timestamp} [${label}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`
            )
        ),
        transports: [new winston.transports.Console()],
    });
};
