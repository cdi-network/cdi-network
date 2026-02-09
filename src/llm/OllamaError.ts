/**
 * Custom error class for Ollama API errors.
 * Wraps HTTP errors and connection failures with contextual information.
 */
export class OllamaError extends Error {
    public readonly statusCode?: number;
    public readonly endpoint: string;
    public override readonly cause?: Error;

    constructor(message: string, endpoint: string, statusCode?: number, cause?: Error) {
        super(message);
        this.name = 'OllamaError';
        this.endpoint = endpoint;
        this.statusCode = statusCode;
        this.cause = cause;
    }
}
