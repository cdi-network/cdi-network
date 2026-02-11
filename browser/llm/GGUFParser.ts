/**
 * GGUFParser — Parse GGUF binary format for layer-sharded distributed inference.
 *
 * GGUF v3 format:
 *   Magic (4B) → Version (4B) → TensorCount (8B) → KVCount (8B) → KV Pairs → Tensor Infos → Tensor Data
 *
 * Reference: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
 *
 * @module browser/llm/GGUFParser
 */

export const GGUF_MAGIC = 0x46475547; // 'GGUF' in little-endian

// GGUF value types
const GGUF_TYPE = {
    UINT8: 0,
    INT8: 1,
    UINT16: 2,
    INT16: 3,
    UINT32: 4,
    INT32: 5,
    FLOAT32: 6,
    BOOL: 7,
    STRING: 8,
    ARRAY: 9,
    UINT64: 10,
    INT64: 11,
    FLOAT64: 12,
} as const;

// GGML tensor types — bytes per element
const GGML_TYPE_SIZE: Record<number, number> = {
    0: 4,    // F32
    1: 2,    // F16
    2: 0.5,  // Q4_0 (4-bit quantized, ~0.5 byte/element + overhead)
    3: 0.5,  // Q4_1
    6: 1,    // Q5_0
    7: 1,    // Q5_1
    8: 1,    // Q8_0
    9: 1,    // Q8_1
};

interface TensorInfo {
    name: string;
    nDims: number;
    shape: number[];
    type: number;
    offset: number;
    byteSize: number;
}

export class GGUFParser {
    readonly version: number;
    readonly tensorCount: number;
    readonly kvCount: number;
    readonly metadata: Record<string, any> = {};
    readonly tensors: TensorInfo[] = [];

    private dataView: DataView;
    private buffer: ArrayBuffer;
    private cursor = 0;
    private tensorDataOffset = 0;

    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.dataView = new DataView(buffer);

        // Parse magic
        const magic = this.readU32();
        if (magic !== GGUF_MAGIC) {
            throw new Error('Not a GGUF file');
        }

        // Parse header
        this.version = this.readU32();
        this.tensorCount = Number(this.readU64());
        this.kvCount = Number(this.readU64());

        // Parse KV pairs
        for (let i = 0; i < this.kvCount; i++) {
            const key = this.readString();
            const type = this.readU32();
            const value = this.readValue(type);
            this.metadata[key] = value;
        }

        // Parse tensor infos
        for (let i = 0; i < this.tensorCount; i++) {
            const name = this.readString();
            const nDims = this.readU32();
            const shape: number[] = [];
            for (let d = 0; d < nDims; d++) {
                shape.push(Number(this.readU64()));
            }
            const type = this.readU32();
            const offset = Number(this.readU64());

            // Calculate byte size from shape and type
            const numElements = shape.reduce((a, b) => a * b, 1);
            const bytesPerElement = GGML_TYPE_SIZE[type] ?? 4;
            const byteSize = Math.ceil(numElements * bytesPerElement);

            this.tensors.push({ name, nDims, shape, type, offset, byteSize });
        }

        // Tensor data starts after all metadata (aligned to 32 bytes typically)
        this.tensorDataOffset = this.cursor;
    }

    /** Number of transformer layers based on blk.N naming pattern */
    get layerCount(): number {
        const layerIndices = new Set<number>();
        for (const t of this.tensors) {
            const match = t.name.match(/^blk\.(\d+)\./);
            if (match) layerIndices.add(parseInt(match[1]));
        }
        return layerIndices.size;
    }

    /** Get all tensors belonging to a specific layer index */
    getLayerTensors(layerIdx: number): TensorInfo[] {
        const prefix = `blk.${layerIdx}.`;
        return this.tensors.filter(t => t.name.startsWith(prefix));
    }

    /** Get raw tensor data by name */
    getTensorData(name: string): Uint8Array | null {
        const tensor = this.tensors.find(t => t.name === name);
        if (!tensor) return null;

        const start = this.tensorDataOffset + tensor.offset;
        const end = start + tensor.byteSize;
        if (end > this.buffer.byteLength) return null;

        return new Uint8Array(this.buffer, start, tensor.byteSize);
    }

    /** Get tensors for a range of layers [startLayer, endLayer] inclusive */
    getLayerRangeTensors(startLayer: number, endLayer: number): TensorInfo[] {
        const result: TensorInfo[] = [];
        for (let i = startLayer; i <= endLayer; i++) {
            result.push(...this.getLayerTensors(i));
        }
        return result;
    }

    // ── Binary readers ──

    private readU32(): number {
        const val = this.dataView.getUint32(this.cursor, true);
        this.cursor += 4;
        return val;
    }

    private readI32(): number {
        const val = this.dataView.getInt32(this.cursor, true);
        this.cursor += 4;
        return val;
    }

    private readU64(): bigint {
        const lo = this.dataView.getUint32(this.cursor, true);
        const hi = this.dataView.getUint32(this.cursor + 4, true);
        this.cursor += 8;
        return BigInt(lo) | (BigInt(hi) << 32n);
    }

    private readF32(): number {
        const val = this.dataView.getFloat32(this.cursor, true);
        this.cursor += 4;
        return val;
    }

    private readString(): string {
        const len = Number(this.readU64());
        const bytes = new Uint8Array(this.buffer, this.cursor, len);
        this.cursor += len;
        return new TextDecoder().decode(bytes);
    }

    private readValue(type: number): any {
        switch (type) {
            case GGUF_TYPE.UINT8: { const v = this.dataView.getUint8(this.cursor); this.cursor += 1; return v; }
            case GGUF_TYPE.INT8: { const v = this.dataView.getInt8(this.cursor); this.cursor += 1; return v; }
            case GGUF_TYPE.UINT16: { const v = this.dataView.getUint16(this.cursor, true); this.cursor += 2; return v; }
            case GGUF_TYPE.INT16: { const v = this.dataView.getInt16(this.cursor, true); this.cursor += 2; return v; }
            case GGUF_TYPE.UINT32: return this.readU32();
            case GGUF_TYPE.INT32: return this.readI32();
            case GGUF_TYPE.FLOAT32: return this.readF32();
            case GGUF_TYPE.BOOL: { const v = this.dataView.getUint8(this.cursor); this.cursor += 1; return v !== 0; }
            case GGUF_TYPE.STRING: return this.readString();
            case GGUF_TYPE.UINT64:
            case GGUF_TYPE.INT64: return Number(this.readU64());
            case GGUF_TYPE.FLOAT64: {
                const v = this.dataView.getFloat64(this.cursor, true);
                this.cursor += 8;
                return v;
            }
            case GGUF_TYPE.ARRAY: {
                const elemType = this.readU32();
                const len = Number(this.readU64());
                const arr: any[] = [];
                for (let i = 0; i < len; i++) arr.push(this.readValue(elemType));
                return arr;
            }
            default:
                throw new Error(`Unknown GGUF type: ${type}`);
        }
    }
}


// ── Test helper: build a minimal valid GGUF buffer ──

interface TestKV {
    key: string;
    type: number;    // GGUF_TYPE value
    value: any;
}

interface TestTensor {
    name: string;
    nDims: number;
    shape: number[];
    type: number;    // GGML type
    offset: number;  // Offset within tensor data section
}

interface BuildOpts {
    kvCount: number;
    tensorCount: number;
    kvPairs?: TestKV[];
    tensors?: TestTensor[];
    tensorData?: Uint8Array;
}

/**
 * Build a minimal GGUF v3 binary buffer for testing.
 * This produces a valid GGUF file that GGUFParser can parse.
 */
export function buildTestGGUF(opts: BuildOpts): ArrayBuffer {
    const parts: number[] = [];
    const textEncoder = new TextEncoder();

    // Helper: write u32 LE
    function writeU32(val: number) {
        parts.push(val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF);
    }

    // Helper: write u64 LE (as two u32)
    function writeU64(val: number) {
        writeU32(val & 0xFFFFFFFF);
        writeU32((val / 0x100000000) | 0);
    }

    // Helper: write string (u64 length + bytes)
    function writeString(s: string) {
        const encoded = textEncoder.encode(s);
        writeU64(encoded.length);
        for (const b of encoded) parts.push(b);
    }

    // Helper: write f32 LE
    function writeF32(val: number) {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, val, true);
        const bytes = new Uint8Array(buf);
        for (const b of bytes) parts.push(b);
    }

    // Header
    writeU32(GGUF_MAGIC);     // Magic
    writeU32(3);               // Version 3
    writeU64(opts.tensorCount); // Tensor count
    writeU64(opts.kvCount);     // KV count

    // KV Pairs
    if (opts.kvPairs) {
        for (const kv of opts.kvPairs) {
            writeString(kv.key);
            writeU32(kv.type);
            switch (kv.type) {
                case 4: // UINT32
                    writeU32(kv.value);
                    break;
                case 8: // STRING
                    writeString(kv.value);
                    break;
                default:
                    writeU32(kv.value); // fallback
            }
        }
    }

    // Tensor Infos
    if (opts.tensors) {
        for (const t of opts.tensors) {
            writeString(t.name);
            writeU32(t.nDims);
            for (const dim of t.shape) {
                writeU64(dim);
            }
            writeU32(t.type);
            writeU64(t.offset);
        }
    }

    // Tensor Data
    if (opts.tensorData) {
        for (const b of opts.tensorData) parts.push(b);
    }

    return new Uint8Array(parts).buffer;
}
