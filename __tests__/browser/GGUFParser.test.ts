/**
 * GGUFParser — TDD tests for GGUF binary format parsing.
 *
 * GGUF format: Header → KV Metadata → Tensor Info → Tensor Data
 * See: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
 */

// @ts-nocheck — binary buffer mocking

import { GGUFParser, buildTestGGUF, GGUF_MAGIC } from '../../browser/llm/GGUFParser';

describe('GGUFParser', () => {

    describe('header parsing', () => {
        it('rejects non-GGUF files', () => {
            const badData = new Uint8Array(32);
            expect(() => new GGUFParser(badData.buffer)).toThrow('Not a GGUF file');
        });

        it('parses GGUF magic number and version', () => {
            const buf = buildTestGGUF({ kvCount: 0, tensorCount: 0 });
            const parser = new GGUFParser(buf);
            expect(parser.version).toBe(3);
            expect(parser.tensorCount).toBe(0);
            expect(parser.kvCount).toBe(0);
        });
    });

    describe('metadata parsing', () => {
        it('parses string KV pairs', () => {
            const buf = buildTestGGUF({
                kvCount: 1,
                tensorCount: 0,
                kvPairs: [{ key: 'general.name', type: 8, value: 'TestModel' }],
            });
            const parser = new GGUFParser(buf);
            expect(parser.metadata['general.name']).toBe('TestModel');
        });

        it('parses uint32 KV pairs', () => {
            const buf = buildTestGGUF({
                kvCount: 1,
                tensorCount: 0,
                kvPairs: [{ key: 'general.file_type', type: 4, value: 7 }],
            });
            const parser = new GGUFParser(buf);
            expect(parser.metadata['general.file_type']).toBe(7);
        });
    });

    describe('tensor info parsing', () => {
        it('parses tensor metadata (name, shape, type, offset)', () => {
            const buf = buildTestGGUF({
                kvCount: 0,
                tensorCount: 2,
                tensors: [
                    { name: 'blk.0.attn_q.weight', nDims: 2, shape: [4096, 4096], type: 2, offset: 0 },
                    { name: 'blk.0.attn_k.weight', nDims: 2, shape: [4096, 1024], type: 2, offset: 4096 * 4096 },
                ],
                tensorData: new Uint8Array(4096 * 4096 + 4096 * 1024),
            });

            const parser = new GGUFParser(buf);
            expect(parser.tensors).toHaveLength(2);
            expect(parser.tensors[0].name).toBe('blk.0.attn_q.weight');
            expect(parser.tensors[0].shape).toEqual([4096, 4096]);
            expect(parser.tensors[1].name).toBe('blk.0.attn_k.weight');
        });
    });

    describe('layer extraction', () => {
        it('extracts tensors by layer index', () => {
            const buf = buildTestGGUF({
                kvCount: 0,
                tensorCount: 4,
                tensors: [
                    { name: 'blk.0.attn_q.weight', nDims: 1, shape: [16], type: 0, offset: 0 },
                    { name: 'blk.0.attn_k.weight', nDims: 1, shape: [16], type: 0, offset: 16 * 4 },
                    { name: 'blk.1.attn_q.weight', nDims: 1, shape: [16], type: 0, offset: 32 * 4 },
                    { name: 'blk.1.attn_k.weight', nDims: 1, shape: [16], type: 0, offset: 48 * 4 },
                ],
                tensorData: new Uint8Array(256),
            });

            const parser = new GGUFParser(buf);
            const layer0 = parser.getLayerTensors(0);
            expect(layer0).toHaveLength(2);
            expect(layer0[0].name).toBe('blk.0.attn_q.weight');
            expect(layer0[1].name).toBe('blk.0.attn_k.weight');

            const layer1 = parser.getLayerTensors(1);
            expect(layer1).toHaveLength(2);
            expect(layer1[0].name).toBe('blk.1.attn_q.weight');
        });

        it('extracts tensor data as typed array', () => {
            // f32 type (type 0) = 4 bytes per element
            const tensorData = new Float32Array([1.0, 2.0, 3.0, 4.0]);
            const buf = buildTestGGUF({
                kvCount: 0,
                tensorCount: 1,
                tensors: [
                    { name: 'blk.0.attn_q.weight', nDims: 1, shape: [4], type: 0, offset: 0 },
                ],
                tensorData: new Uint8Array(tensorData.buffer),
            });

            const parser = new GGUFParser(buf);
            const data = parser.getTensorData('blk.0.attn_q.weight');
            expect(data).not.toBeNull();
            expect(data!.byteLength).toBe(16); // 4 floats × 4 bytes
        });

        it('returns layer count based on blk.N pattern', () => {
            const buf = buildTestGGUF({
                kvCount: 0,
                tensorCount: 3,
                tensors: [
                    { name: 'blk.0.attn_q.weight', nDims: 1, shape: [4], type: 0, offset: 0 },
                    { name: 'blk.1.attn_q.weight', nDims: 1, shape: [4], type: 0, offset: 16 },
                    { name: 'blk.2.attn_q.weight', nDims: 1, shape: [4], type: 0, offset: 32 },
                ],
                tensorData: new Uint8Array(48),
            });

            const parser = new GGUFParser(buf);
            expect(parser.layerCount).toBe(3);
        });
    });
});
