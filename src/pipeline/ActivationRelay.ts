import { WebSocketServer, WebSocket } from 'ws';
import { createHmac } from 'crypto';
import type { PipelineStage } from './types.js';

/**
 * Binary protocol:
 * Request:  [4B tensorSize (LE)][tensorSize * 4B Float32 data][32B HMAC-SHA256]
 * Response: [1B status][4B tensorSize (LE)][tensorSize * 4B Float32 data][32B HMAC-SHA256]
 *   status: 0x00 = OK, 0x01 = HMAC error, 0x02 = computation error
 */

const HMAC_SIZE = 32;
const STATUS_OK = 0x00;
const STATUS_HMAC_ERR = 0x01;
const STATUS_COMPUTE_ERR = 0x02;

function computeHmac(data: Buffer, secret: string): Buffer {
    return createHmac('sha256', secret).update(data).digest();
}

function encodeActivation(data: Float32Array, secret: string): Buffer {
    const tensorBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(data.length, 0);
    const payload = Buffer.concat([sizeBuf, tensorBuf]);
    const hmac = computeHmac(payload, secret);
    return Buffer.concat([payload, hmac]);
}

function decodeActivation(msg: Buffer, secret: string): Float32Array {
    if (msg.length < 4 + HMAC_SIZE) {
        throw new Error('Message too short');
    }
    const payload = msg.subarray(0, msg.length - HMAC_SIZE);
    const receivedHmac = msg.subarray(msg.length - HMAC_SIZE);
    const expectedHmac = computeHmac(payload, secret);

    if (!receivedHmac.equals(expectedHmac)) {
        throw new Error('HMAC verification failed — activations may be tampered');
    }

    const tensorSize = payload.readUInt32LE(0);
    const tensorBytes = payload.subarray(4);
    if (tensorBytes.length !== tensorSize * 4) {
        throw new Error(`Tensor size mismatch: expected ${tensorSize * 4} bytes, got ${tensorBytes.length}`);
    }
    // Copy to aligned buffer for Float32Array
    const aligned = Buffer.alloc(tensorBytes.length);
    tensorBytes.copy(aligned);
    return new Float32Array(aligned.buffer, aligned.byteOffset, tensorSize);
}

function encodeResponse(status: number, data: Float32Array | null, secret: string): Buffer {
    const statusBuf = Buffer.alloc(1);
    statusBuf[0] = status;

    if (status !== STATUS_OK || !data) {
        return statusBuf;
    }

    const tensorBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(data.length, 0);
    const payload = Buffer.concat([statusBuf, sizeBuf, tensorBuf]);
    const hmac = computeHmac(payload, secret);
    return Buffer.concat([payload, hmac]);
}

function decodeResponse(msg: Buffer, secret: string): Float32Array {
    if (msg.length < 1) {
        throw new Error('Empty response');
    }
    const status = msg[0];
    if (status === STATUS_HMAC_ERR) {
        throw new Error('HMAC verification failed on server side');
    }
    if (status === STATUS_COMPUTE_ERR) {
        throw new Error('Computation error on server');
    }
    if (msg.length < 1 + 4 + HMAC_SIZE) {
        throw new Error('Response too short');
    }

    const payload = msg.subarray(0, msg.length - HMAC_SIZE);
    const receivedHmac = msg.subarray(msg.length - HMAC_SIZE);
    const expectedHmac = computeHmac(payload, secret);

    if (!receivedHmac.equals(expectedHmac)) {
        throw new Error('HMAC verification failed on response');
    }

    const tensorSize = payload.readUInt32LE(1);
    const tensorBytes = payload.subarray(5);
    const aligned = Buffer.alloc(tensorBytes.length);
    tensorBytes.copy(aligned);
    return new Float32Array(aligned.buffer, aligned.byteOffset, tensorSize);
}

// ─── Server ─────────────────────────────────────────────

interface ActivationRelayServerConfig {
    port: number;
    layerServer: PipelineStage;
    hmacSecret: string;
}

export class ActivationRelayServer {
    private wss: WebSocketServer | null = null;
    private readonly config: ActivationRelayServerConfig;
    private assignedPort = 0;

    constructor(config: ActivationRelayServerConfig) {
        this.config = config;
    }

    async listen(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: this.config.port }, () => {
                const addr = this.wss!.address();
                if (typeof addr === 'object' && addr !== null) {
                    this.assignedPort = addr.port;
                }
                resolve(`ws://127.0.0.1:${this.assignedPort}`);
            });

            this.wss.on('error', reject);

            this.wss.on('connection', (ws) => {
                ws.binaryType = 'nodebuffer';
                ws.on('message', async (raw: Buffer) => {
                    try {
                        const input = decodeActivation(raw, this.config.hmacSecret);
                        const output = await this.config.layerServer.forward(input);
                        const response = encodeResponse(STATUS_OK, output, this.config.hmacSecret);
                        ws.send(response);
                    } catch (err: any) {
                        if (err.message?.includes('HMAC')) {
                            ws.send(encodeResponse(STATUS_HMAC_ERR, null, this.config.hmacSecret));
                        } else {
                            ws.send(encodeResponse(STATUS_COMPUTE_ERR, null, this.config.hmacSecret));
                        }
                    }
                });
            });
        });
    }

    async close(): Promise<void> {
        return new Promise((resolve) => {
            if (this.wss) {
                // Close all connections first
                for (const client of this.wss.clients) {
                    client.terminate();
                }
                this.wss.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}

// ─── Client ─────────────────────────────────────────────

interface ActivationRelayClientConfig {
    hmacSecret: string;
    timeoutMs: number;
}

export class ActivationRelayClient {
    private readonly config: ActivationRelayClientConfig;

    constructor(config: ActivationRelayClientConfig) {
        this.config = config;
    }

    async send(address: string, input: Float32Array): Promise<Float32Array> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new Error(`Timeout connecting to ${address}`));
            }, this.config.timeoutMs);

            const ws = new WebSocket(address);
            ws.binaryType = 'nodebuffer';

            ws.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });

            ws.on('open', () => {
                const msg = encodeActivation(input, this.config.hmacSecret);
                ws.send(msg);
            });

            ws.on('message', (raw: Buffer) => {
                clearTimeout(timer);
                try {
                    const result = decodeResponse(raw, this.config.hmacSecret);
                    ws.close();
                    resolve(result);
                } catch (err) {
                    ws.close();
                    reject(err);
                }
            });
        });
    }
}
