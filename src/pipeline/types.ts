import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Interface: any node that can perform a forward pass on activations.
 */
export interface PipelineStage {
    nodeId: string;
    forward(input: Float32Array): Promise<Float32Array>;
}

/**
 * Metrics collected per pipeline stage.
 */
export interface StageMetric {
    nodeId: string;
    durationMs: number;
}

export interface PipelineMetrics {
    stages: StageMetric[];
    totalDurationMs: number;
}

/**
 * ActivationPacket — encrypts/decrypts Float32Array activations
 * using AES-256-CBC for inter-node transport.
 */
export const ActivationPacket = {
    encrypt(data: Float32Array, key: string): Buffer {
        const iv = randomBytes(16);
        const keyBuf = Buffer.alloc(32);
        keyBuf.write(key);
        const cipher = createCipheriv('aes-256-cbc', keyBuf, iv);
        const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const encrypted = Buffer.concat([iv, cipher.update(raw), cipher.final()]);
        return encrypted;
    },

    decrypt(encrypted: Buffer, key: string): Float32Array {
        const iv = encrypted.subarray(0, 16);
        const encData = encrypted.subarray(16);
        const keyBuf = Buffer.alloc(32);
        keyBuf.write(key);
        const decipher = createDecipheriv('aes-256-cbc', keyBuf, iv);
        const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
        return new Float32Array(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength / 4);
    },
};
