// ============================================================
// HoMM3 File Parsers - JavaScript reimplementation of homm3data
// Matches the Python library algorithms 100%
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

// ---- Utility helpers ----
class DataView2 {
    constructor(buffer, offset = 0) {
        if (buffer instanceof ArrayBuffer) {
            this.buffer = buffer;
            this._baseOffset = 0;
        } else {
            // Uint8Array or typed array — respect byteOffset
            this.buffer = buffer.buffer;
            this._baseOffset = buffer.byteOffset;
        }
        this.view = new DataView(this.buffer);
        this.offset = this._baseOffset + offset;
    }
    readUint8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
    readInt8() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
    readUint16LE() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    readInt16LE() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
    readUint32LE() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    readInt32LE() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    readBytes(n) {
        const arr = new Uint8Array(this.buffer, this.offset, n);
        this.offset += n;
        return new Uint8Array(arr);
    }
    readString(n) {
        const bytes = this.readBytes(n);
        const nullIdx = bytes.indexOf(0);
        const slice = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
        let str = '';
        for (const b of slice) str += String.fromCharCode(b);
        return str;
    }
    seek(pos) { this.offset = this._baseOffset + pos; }
    tell() { return this.offset - this._baseOffset; }
}

// ---- zlib / gzip decompression (pako preferred, DecompressionStream fallback) ----
function zlibDecompress(data) {
    if (typeof pako !== 'undefined') {
        return pako.inflate(data);
    }
    if (typeof DecompressionStream !== 'undefined') {
        return _decompressStream('deflate', data);
    }
    throw new Error('No decompression available (need pako or DecompressionStream)');
}

function gzipDecompress(data) {
    if (typeof pako !== 'undefined') {
        return pako.ungzip(data);
    }
    if (typeof DecompressionStream !== 'undefined') {
        return _decompressStream('gzip', data);
    }
    throw new Error('No decompression available (need pako or DecompressionStream)');
}

async function _decompressStream(format, data) {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return result;
}

// ============================================================
// LOD File Parser
// ============================================================
class LodFile {
    constructor() {
        this.files = [];
        this.isHota18 = false;
        this._buffer = null;
    }

    static async open(data) {
        const lod = new LodFile();
        await lod._parse(data);
        return lod;
    }

    _xorDecrypt(data, key) {
        const result = new Uint8Array(data.length);
        const keyLen = key.length;
        for (let i = 0; i < data.length; i++) {
            result[i] = data[i] ^ key[i % keyLen];
        }
        return result;
    }

    _extractFirstLzmaStream(data, uncompressedSize) {
        // Raw LZMA1 stream at offset 1, params from binwalk/homm3data:
        // lc=3, lp=0, pb=2, dict_size=262144 (256 KiB)
        return LZMA2Decode.decompressRaw(data.subarray(1), uncompressedSize, 3, 0, 2, 262144);
    }

    async _parse(data) {
        // Check if gzipped (linux files)
        if (data[0] === 0x1f && data[1] === 0x8b) {
            data = await gzipDecompress(data);
        }
        this._buffer = data;

        const r = new DataView2(data);

        const header = r.readString(4);
        if (header !== 'LOD') {
            throw new Error('Not a LOD file: ' + header);
        }

        r.seek(8);
        const total = r.readUint32LE();

        r.seek(0x0C);
        const key = r.readBytes(4);

        this.files = [];
        // HotA 1.8+ stores a xor key here, original H3 files don't (h3sprite.lod contains leftover junk)
        const keyValue = ((key[0] | (key[1] << 8) | (key[2] << 16) | (key[3] << 24)) >>> 0);
        this.isHota18 = keyValue !== 0 && keyValue !== 0x7E0213;

        if (this.isHota18) {
            r.seek(80);
            for (let i = 0; i < total; i++) {
                const filenameBytes = r.readBytes(16);
                // No filenames in hota 1.8, only unique IDs - convert to hex
                let filename = '';
                for (const b of filenameBytes) filename += b.toString(16).padStart(2, '0');

                const encr = r.readBytes(16);
                const decr = this._xorDecrypt(encr, key);
                const dv = new DataView2(decr);
                const offset = dv.readUint32LE();
                const size = dv.readUint32LE();
                const csize = dv.readUint32LE();
                const compressionMethod = encr[12];
                const unknown = encr.slice(13, 16);
                this.files.push({ filename, offset, size, csize, compressionMethod, unknown });
            }
        } else {
            r.seek(92);
            for (let i = 0; i < total; i++) {
                const filename = r.readString(16).toLowerCase();
                const offset = r.readUint32LE();
                const size = r.readUint32LE();
                const unknown = r.readUint32LE();
                const csize = r.readUint32LE();
                this.files.push({ filename, offset, size, csize, compressionMethod: null, unknown });
            }
        }
    }

    getFilelist() {
        return this.files.map(f => f.filename);
    }

    async getFile(selectedFilename) {
        selectedFilename = selectedFilename.toLowerCase();
        for (const { filename, offset, size, csize, compressionMethod } of this.files) {
            if (selectedFilename !== filename) continue;
            const buf = this._buffer;
            if (csize !== 0) {
                const compressed = buf.slice(offset, offset + csize);
                if (this.isHota18 && compressionMethod === 2) {
                    return this._extractFirstLzmaStream(compressed, size);
                } else {
                    return await zlibDecompress(compressed);
                }
            } else {
                return buf.slice(offset, offset + size);
            }
        }
        console.warn('file not found:', selectedFilename);
        return null;
    }

    /**
     * Synchronously peek at the raw (possibly compressed) bytes of a file.
     * For uncompressed entries (csize === 0) the bytes ARE the actual content.
     * For compressed entries the bytes are the compressed stream header.
     * @param {string} filename
     * @param {number} n  max bytes to return
     * @returns {{ bytes: Uint8Array, isCompressed: boolean, compressionMethod: number|null } | null}
     */
    peekBytesSync(filename, n = 64) {
        filename = filename.toLowerCase();
        for (const f of this.files) {
            if (f.filename !== filename) continue;
            const isCompressed = f.csize !== 0;
            const readLen = isCompressed ? Math.min(n, f.csize) : Math.min(n, f.size);
            return {
                bytes: this._buffer.slice(f.offset, f.offset + readLen),
                isCompressed,
                compressionMethod: f.compressionMethod ?? null,
            };
        }
        return null;
    }
}

// ============================================================
// PCX File Parser
// ============================================================
const PCX = {
    isPcx(data) {
        if (data.length < 12) return false;
        const r = new DataView2(data);
        const magic = r.readUint32LE();
        if (magic === 0x46323350) return true; // P32 format from HotA

        r.seek(0);
        const size = r.readUint32LE();
        const width = r.readUint32LE();
        const height = r.readUint32LE();
        return size === width * height || size === width * height * 3;
    },

    readPcx(data) {
        const r = new DataView2(data);
        const magic = r.readUint32LE();

        if (magic === 0x46323350) { // P32 format from HotA
            r.seek(0);
            const p32_magic = r.readUint32LE();
            const unknown1 = r.readUint32LE();
            const bitsPerPixel = r.readUint32LE();
            const sizeRaw = r.readUint32LE();
            const sizeHeader = r.readUint32LE();
            const sizeData = r.readUint32LE();
            const width = r.readUint32LE();
            const height = r.readUint32LE();
            const unknown8 = r.readUint32LE();
            const unknown9 = r.readUint32LE();

            // BGRA -> RGBA, flip vertically
            const pixelData = r.readBytes(sizeData);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(width, height);

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const srcIdx = (y * width + x) * 4;
                    // Flip vertically: read from bottom
                    const dstY = height - 1 - y;
                    const dstIdx = (dstY * width + x) * 4;
                    imgData.data[dstIdx + 0] = pixelData[srcIdx + 2]; // R <- B
                    imgData.data[dstIdx + 1] = pixelData[srcIdx + 1]; // G
                    imgData.data[dstIdx + 2] = pixelData[srcIdx + 0]; // B <- R
                    imgData.data[dstIdx + 3] = pixelData[srcIdx + 3]; // A
                }
            }
            ctx.putImageData(imgData, 0, 0);
            return { canvas, width, height, type: 'p32' };
        }

        r.seek(0);
        const size = r.readUint32LE();
        const width = r.readUint32LE();
        const height = r.readUint32LE();

        if (size === width * height) {
            // Paletted image
            const pixelData = r.readBytes(width * height);
            const palette = [];
            for (let i = 0; i < 256; i++) {
                const pr = r.readUint8();
                const pg = r.readUint8();
                const pb = r.readUint8();
                palette.push([pr, pg, pb]);
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(width, height);
            for (let i = 0; i < width * height; i++) {
                const idx = pixelData[i];
                imgData.data[i * 4 + 0] = palette[idx][0];
                imgData.data[i * 4 + 1] = palette[idx][1];
                imgData.data[i * 4 + 2] = palette[idx][2];
                imgData.data[i * 4 + 3] = 255;
            }
            ctx.putImageData(imgData, 0, 0);
            return { canvas, width, height, type: 'pcx8' };
        } else if (size === width * height * 3) {
            // 24-bit RGB
            const pixelData = r.readBytes(width * height * 3);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(width, height);
            for (let i = 0; i < width * height; i++) {
                // BGR -> RGB
                imgData.data[i * 4 + 0] = pixelData[i * 3 + 2]; // R <- B
                imgData.data[i * 4 + 1] = pixelData[i * 3 + 1]; // G
                imgData.data[i * 4 + 2] = pixelData[i * 3 + 0]; // B <- R
                imgData.data[i * 4 + 3] = 255;
            }
            ctx.putImageData(imgData, 0, 0);
            return { canvas, width, height, type: 'pcx24' };
        }
        return null;
    }
};

// ============================================================
// PAL File Parser
// ============================================================
// Three palette formats exist in HoMM3:
//   1. RIFF PAL (PLAYERS.PAL):  24-byte RIFF header + 256×4 bytes (R,G,B,flags), 8-bit values
//   2. DEF-embedded palette:    raw 256×3 bytes at offset 16 in .DEF files, 8-bit values
//   3. NEUTRAL.PAL (raw):       32×4 bytes raw binary, no header, 8-bit values
//
// For PLAYERS.PAL the file also contains HoMM3-specific RIFF sub-chunks after the main
// palette data: "offl" (player color offsets), "tran" (transparency indices),
// "unde" (underline indices). These are 32 bytes each including the 8-byte RIFF sub-header.
const PAL = {
    // Detect format from first 4 bytes
    _isRiff(data) {
        return data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46; // "RIFF"
    },

    // Parse a Windows RIFF PAL file (e.g. PLAYERS.PAL)
    // Returns { colors: [[r,g,b], ...], flags: [uint8, ...], count: number, type: 'riff' }
    readRiff(data) {
        const r = new DataView2(data);
        const magic = r.readString(4);
        if (magic !== 'RIFF') throw new Error('Not a RIFF PAL file');
        r.seek(22);
        const count = r.readUint16LE(); // LOGPALETTE entry count (256 for PLAYERS.PAL)
        const colors = [];
        const flags = [];
        for (let i = 0; i < count; i++) {
            colors.push([r.readUint8(), r.readUint8(), r.readUint8()]);
            flags.push(r.readUint8()); // NOT alpha — game-specific flags byte
        }
        return { colors, flags, count, type: 'riff' };
    },

    // Parse a DEF-embedded raw palette (256×3 bytes at a given offset)
    readDefPalette(data, offset = 16) {
        const colors = [];
        for (let i = 0; i < 256; i++) {
            colors.push([
                data[offset + i * 3 + 0],
                data[offset + i * 3 + 1],
                data[offset + i * 3 + 2]
            ]);
        }
        return { colors, flags: null, count: 256, type: 'def' };
    },

    // Auto-detect and parse any HoMM3 PAL format
    parse(data) {
        if (this._isRiff(data)) return this.readRiff(data);
        if (data.length === 768) return this.readDefPalette(data, 0);
        if (data.length === 128) {
            // NEUTRAL.PAL: 32 entries × 4 bytes raw
            const colors = [], flags = [];
            for (let i = 0; i < 32; i++) {
                colors.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
                flags.push(data[i * 4 + 3]);
            }
            return { colors, flags, count: 32, type: 'raw' };
        }
        throw new Error('Unknown PAL format (size=' + data.length + ')');
    }
};

// ============================================================
// IFR File Parser (Immersion Force Resource)
// ============================================================
// Haptic feedback effect library used in HoMM3 SoD (H3SHAD.IFR in H3bitmap.lod).
// Created by Immersion Studio. Magic: "ifpr".
//
// File layout:
//   [0]  4 bytes  magic "ifpr"
//   [4]  uint32   entry count (165 in H3SHAD.IFR)
//   [8]  entries  (variable-length, self-inclusive sizes)
//
// Each entry:
//   uint32       recSize  — total record size including this 4-byte field
//   cstring      name     — effect name (e.g. "GuiPop", "Mirth A", "BlindSpell")
//   cstring      type     — "Periodic" | "Vector Force" | "Damper" | "Compound"
//   byte         0x00     — separator byte
//   uint32       blockSize — self-inclusive; covers block data below
//   cstring[]    block data — key\0value\0 pairs:
//                  all types: ID = Windows GUID {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
//                  Compound only: ContainedObjects = GUID;GUID;... (semicolon-separated)
//   cstring[]    parameter key\0value\0 pairs (all numeric ASCII decimals):
//                  Periodic:     Magnitude, Period, Waveform, Duration, Phase, Direction,
//                                AttackLevel, AttackDuration, FadeLevel, FadeDuration,
//                                InfiniteDuration, TriggerButton, ValueOffset, StartDelay
//                  Vector Force: Magnitude, Direction, Duration, AttackLevel, AttackDuration,
//                                FadeLevel, FadeDuration, InfiniteDuration, TriggerButton,
//                                RepeatInterval, StartDelay
//                  Damper:       Axes, BothAxes, Offset, Offset2, DeadBand, DeadBand2,
//                                NegCoefficient, NegCoefficient2, PosCoefficient, PosCoefficient2,
//                                Symmetry, Symmetry2, Duration, InfiniteDuration
//                  Compound:     (no additional params; sub-effects via ContainedObjects)
const IFR = {
    parse(data) {
        if (data[0] !== 0x69 || data[1] !== 0x66 || data[2] !== 0x70 || data[3] !== 0x72) {
            throw new Error('Not an IFR file (wrong magic, expected "ifpr")');
        }
        const r = new DataView2(data);
        r.seek(4);
        const count = r.readUint32LE();
        const effects = [];

        for (let i = 0; i < count; i++) {
            const recStart = r.tell();
            const recSize = r.readUint32LE();
            const recEnd = recStart + recSize;

            const name = IFR._cstr(data, r);
            const type = IFR._cstr(data, r);
            r.readUint8(); // separator 0x00

            // Block section: self-inclusive blockSize covering ID / ContainedObjects
            const blockSize = r.readUint32LE();
            const blockEnd = r.tell() + (blockSize - 4); // -4: uint32 itself already read
            const blockProps = {};
            while (r.tell() < blockEnd) {
                const k = IFR._cstr(data, r);
                if (k === '') break;
                blockProps[k] = IFR._cstr(data, r);
            }
            r.seek(blockEnd);

            // Remaining key-value parameter pairs
            const props = {};
            while (r.tell() < recEnd) {
                const k = IFR._cstr(data, r);
                if (k === '') break;
                props[k] = IFR._cstr(data, r);
            }

            effects.push({
                name,
                type,
                id: blockProps['ID'] || null,
                containedObjects: blockProps['ContainedObjects']
                    ? blockProps['ContainedObjects'].split(';').filter(s => s)
                    : null,
                props
            });

            r.seek(recEnd); // advance to next record
        }

        return effects;
    },

    _cstr(data, r) {
        let s = '';
        while (r.tell() < data.length) {
            const b = r.readUint8();
            if (b === 0) break;
            s += String.fromCharCode(b);
        }
        return s;
    }
};

// ============================================================
// DEF File Parser
// ============================================================
const DEF_FILE_TYPES = {
    0x40: 'SPELL',
    0x41: 'SPRITE',
    0x42: 'CREATURE',
    0x43: 'MAP',
    0x44: 'MAP_HERO',
    0x45: 'TERRAIN',
    0x46: 'CURSOR',
    0x47: 'INTERFACE',
    0x48: 'SPRITE_FRAME',
    0x49: 'BATTLE_HERO'
};

const SPECIAL_SOURCE_PALETTE = [
    [0, 255, 255],    // 0: Transparency (cyan)
    [255, 150, 255],  // 1: Shadow border (pink)
    [255, 100, 255],  // 2: Shadow border - fog of war (pink)
    [255, 50, 255],   // 3: Shadow body - fog of war (magenta)
    [255, 0, 255],    // 4: Shadow body (magenta)
    [255, 255, 0],    // 5: Selection / owner flag (yellow)
    [180, 0, 255],    // 6: Shadow body below selection (violet)
    [0, 255, 0],      // 7: Shadow border below selection (green)
];

const SPECIAL_TARGET_PALETTE = [
    [0, 0, 0, 0],       // 0: Full transparency
    [0, 0, 0, 0x40],    // 1: Shadow border
    [0, 0, 0, 0x40],    // 2: Shadow border (fog of war)
    [0, 0, 0, 0x80],    // 3: Shadow body (fog of war)
    [0, 0, 0, 0x80],    // 4: Shadow body
    [0, 0, 0, 0],       // 5: Selection highlight (transparent)
    [0, 0, 0, 0x80],    // 6: Shadow body below selection
    [0, 0, 0, 0x40],    // 7: Shadow border below selection
];

const ALWAYS_REPLACE = new Set([0, 1, 4]);

function paletteMatches(actual, expected, threshold = 8) {
    return Math.abs(actual[0] - expected[0]) < threshold &&
           Math.abs(actual[1] - expected[1]) < threshold &&
           Math.abs(actual[2] - expected[2]) < threshold;
}

function detectSpecialIndices(palette) {
    const special = new Set();
    for (let i = 0; i < Math.min(8, palette.length); i++) {
        if (ALWAYS_REPLACE.has(i)) {
            special.add(i);
        } else if (paletteMatches(palette[i], SPECIAL_SOURCE_PALETTE[i])) {
            special.add(i);
        }
    }
    return special;
}

class DefFile {
    constructor() {
        this.type = null;
        this.typeName = '';
        this.width = 0;
        this.height = 0;
        this.blockCount = 0;
        this.palette = [];
        this.rawData = [];
        this._isD32 = false;
    }

    static open(data) {
        const def = new DefFile();
        def._parse(data);
        return def;
    }

    _parseD32(data) {
        this._isD32 = true;
        const r = new DataView2(data);

        const magic = r.readUint32LE();
        const unknown1 = r.readUint32LE();
        const unknown2 = r.readUint32LE();
        this.width = r.readUint32LE();
        this.height = r.readUint32LE();
        const groupCount = r.readUint32LE();
        const unknown6 = r.readUint32LE();
        const unknown7 = r.readUint32LE();

        this.rawData = [];

        for (let group = 0; group < groupCount; group++) {
            const headerSize = r.readUint32LE();
            const groupNo = r.readUint32LE();
            const entriesCount = r.readUint32LE();
            const unknownB = r.readUint32LE();

            const fileNames = [];
            const offsets = [];

            for (let i = 0; i < entriesCount; i++) {
                fileNames.push(r.readString(13));
            }
            for (let i = 0; i < entriesCount; i++) {
                offsets.push(r.readUint32LE());
            }

            const filepos = r.tell();

            for (let i = 0; i < entriesCount; i++) {
                r.seek(offsets[i]);
                const bitsPerPixel = r.readUint32LE();
                const imageSize = r.readUint32LE();
                const fullWidth = r.readUint32LE();
                const fullHeight = r.readUint32LE();
                const storedWidth = r.readUint32LE();
                const storedHeight = r.readUint32LE();
                const marginLeft = r.readUint32LE();
                const marginTop = r.readUint32LE();
                const entryUnknown1 = r.readUint32LE();
                const entryUnknown2 = r.readUint32LE();

                const pixeldata = r.readBytes(imageSize);

                // BGRA -> RGBA, flip vertically
                const canvas = document.createElement('canvas');
                canvas.width = storedWidth;
                canvas.height = storedHeight;
                const ctx = canvas.getContext('2d');
                const imgData = ctx.createImageData(storedWidth, storedHeight);

                for (let y = 0; y < storedHeight; y++) {
                    for (let x = 0; x < storedWidth; x++) {
                        const srcIdx = (y * storedWidth + x) * 4;
                        const dstY = storedHeight - 1 - y;
                        const dstIdx = (dstY * storedWidth + x) * 4;
                        imgData.data[dstIdx + 0] = pixeldata[srcIdx + 2]; // R
                        imgData.data[dstIdx + 1] = pixeldata[srcIdx + 1]; // G
                        imgData.data[dstIdx + 2] = pixeldata[srcIdx + 0]; // B
                        imgData.data[dstIdx + 3] = pixeldata[srcIdx + 3]; // A
                    }
                }
                ctx.putImageData(imgData, 0, 0);

                // Compose into full-size frame
                const fullCanvas = document.createElement('canvas');
                fullCanvas.width = fullWidth;
                fullCanvas.height = fullHeight;
                const fullCtx = fullCanvas.getContext('2d');
                fullCtx.drawImage(canvas, marginLeft, marginTop);

                this.rawData.push({
                    groupId: groupNo,
                    imageId: i,
                    offset: offsets[i],
                    name: fileNames[i],
                    image: {
                        size: imageSize,
                        format: null,
                        fullWidth,
                        fullHeight,
                        width: storedWidth,
                        height: storedHeight,
                        marginLeft,
                        marginTop,
                        hasShadow: false,
                        pixeldata,
                        canvas: fullCanvas,
                        _prerendered: true
                    }
                });
            }
            r.seek(filepos);
        }
    }

    _parse(data) {
        const r = new DataView2(data);
        const magic = r.readUint32LE();
        r.seek(0);

        if (magic === 0x46323344) { // D32 format from HotA
            this._parseD32(data);
            return;
        }

        this.type = r.readUint32LE();
        this.typeName = DEF_FILE_TYPES[this.type] || 'UNKNOWN';
        this.width = r.readUint32LE();
        this.height = r.readUint32LE();
        this.blockCount = r.readUint32LE();

        this.palette = [];
        for (let i = 0; i < 256; i++) {
            const pr = r.readUint8();
            const pg = r.readUint8();
            const pb = r.readUint8();
            this.palette.push([pr, pg, pb]);
        }

        const offsets = {};
        const fileNames = {};

        for (let i = 0; i < this.blockCount; i++) {
            const groupId = r.readUint32LE();
            const imageCount = r.readUint32LE();
            r.readUint32LE(); // unknown
            r.readUint32LE(); // unknown

            if (!offsets[groupId]) offsets[groupId] = [];
            if (!fileNames[groupId]) fileNames[groupId] = [];

            for (let j = 0; j < imageCount; j++) {
                fileNames[groupId].push(r.readString(13));
            }
            for (let j = 0; j < imageCount; j++) {
                offsets[groupId].push(r.readUint32LE());
            }
        }

        this.rawData = [];
        const noShadowTypes = new Set([0x40, 0x45, 0x46, 0x47]); // SPELL, TERRAIN, CURSOR, INTERFACE

        for (const groupIdStr of Object.keys(offsets)) {
            const groupId = parseInt(groupIdStr);
            for (let imageId = 0; imageId < offsets[groupId].length; imageId++) {
                const offset = offsets[groupId][imageId];
                const name = fileNames[groupId][imageId];

                const imageData = this._getImageData(data, offset, name);
                if (imageData) {
                    imageData.hasShadow = !noShadowTypes.has(this.type);
                }

                this.rawData.push({
                    groupId,
                    imageId,
                    offset,
                    name,
                    image: imageData
                });
            }
        }
    }

    _getImageData(data, offset, name) {
        const r = new DataView2(data);
        r.seek(offset);

        const size = r.readUint32LE();
        const format = r.readUint32LE();
        const fullWidth = r.readUint32LE();
        const fullHeight = r.readUint32LE();
        const width = r.readUint32LE();
        const height = r.readUint32LE();
        const marginLeft = r.readInt32LE();
        const marginTop = r.readInt32LE();

        if (marginLeft > fullWidth || marginTop > fullHeight) {
            console.warn(`Image ${name} - margins exceed dimensions`);
            return null;
        }

        if (width === 0 || height === 0) {
            console.warn(`Image ${name} - no image size`);
            return null;
        }

        let pixeldata;

        switch (format) {
            case 0: {
                pixeldata = r.readBytes(width * height);
                break;
            }
            case 1: {
                const lineOffsets = [];
                for (let i = 0; i < height; i++) lineOffsets.push(r.readUint32LE());
                const chunks = [];
                let totalBytes = 0;
                for (const lineOffset of lineOffsets) {
                    r.seek(offset + 32 + lineOffset);
                    let totalLength = 0;
                    while (totalLength < width) {
                        const code = r.readUint8();
                        let length = r.readUint8() + 1;
                        if (code === 0xff) {
                            chunks.push(r.readBytes(length));
                        } else {
                            const fill = new Uint8Array(length);
                            fill.fill(code);
                            chunks.push(fill);
                        }
                        totalLength += length;
                        totalBytes += length;
                    }
                }
                pixeldata = new Uint8Array(totalBytes);
                let off = 0;
                for (const c of chunks) { pixeldata.set(c, off); off += c.length; }
                break;
            }
            case 2: {
                const lineOffsets = [];
                for (let i = 0; i < height; i++) lineOffsets.push(r.readUint16LE());
                r.readUint8(); r.readUint8(); // unknown

                const chunks = [];
                let totalBytes = 0;
                for (const lineOffset of lineOffsets) {
                    if (r.tell() !== offset + 32 + lineOffset) {
                        r.seek(offset + 32 + lineOffset);
                    }
                    let totalLength = 0;
                    while (totalLength < width) {
                        const segment = r.readUint8();
                        const code = segment >> 5;
                        const length = (segment & 0x1f) + 1;
                        if (code === 7) {
                            chunks.push(r.readBytes(length));
                        } else {
                            const fill = new Uint8Array(length);
                            fill.fill(code);
                            chunks.push(fill);
                        }
                        totalLength += length;
                        totalBytes += length;
                    }
                }
                pixeldata = new Uint8Array(totalBytes);
                let off = 0;
                for (const c of chunks) { pixeldata.set(c, off); off += c.length; }
                break;
            }
            case 3: {
                // Each row split into 32-byte blocks
                const blocksPerRow = Math.floor(width / 32);
                const lineOffsets = [];
                for (let i = 0; i < height; i++) {
                    const row = [];
                    for (let j = 0; j < blocksPerRow; j++) {
                        row.push(r.readUint16LE());
                    }
                    lineOffsets.push(row);
                }

                const chunks = [];
                let totalBytes = 0;
                for (const lineOffset of lineOffsets) {
                    for (const blockOffset of lineOffset) {
                        if (r.tell() !== offset + 32 + blockOffset) {
                            r.seek(offset + 32 + blockOffset);
                        }
                        let totalLength = 0;
                        while (totalLength < 32) {
                            const segment = r.readUint8();
                            const code = segment >> 5;
                            const length = (segment & 0x1f) + 1;
                            if (code === 7) {
                                chunks.push(r.readBytes(length));
                            } else {
                                const fill = new Uint8Array(length);
                                fill.fill(code);
                                chunks.push(fill);
                            }
                            totalLength += length;
                            totalBytes += length;
                        }
                    }
                }
                pixeldata = new Uint8Array(totalBytes);
                let off = 0;
                for (const c of chunks) { pixeldata.set(c, off); off += c.length; }
                break;
            }
            default:
                console.warn(`Image ${name} - unknown format ${format}`);
                return null;
        }

        return {
            size,
            format,
            fullWidth,
            fullHeight,
            width,
            height,
            marginLeft,
            marginTop,
            hasShadow: false,
            pixeldata
        };
    }

    getGroups() {
        const seen = new Set();
        const groups = [];
        for (const d of this.rawData) {
            if (!seen.has(d.groupId)) {
                seen.add(d.groupId);
                groups.push(d.groupId);
            }
        }
        return groups;
    }

    getFrameCount(groupId) {
        return this.rawData.filter(d => d.groupId === groupId).length;
    }

    getSize() {
        return [this.width, this.height];
    }

    getBlockCount() {
        return this.blockCount;
    }

    getType() {
        return this.type;
    }

    getTypeName() {
        return this.typeName;
    }

    getPalette() {
        return this.palette;
    }

    getRawData() {
        return this.rawData;
    }

    readImage(how = 'combined', groupId = null, imageId = null, name = null) {
        const foundData = this.rawData.filter(v =>
            (groupId === null || v.groupId === groupId) &&
            (imageId === null || v.imageId === imageId) &&
            (name === null || v.name === name)
        );

        if (foundData.length !== 1) {
            console.warn(`Image read unsuccessful. Found ${foundData.length} images with filter criteria.`);
            return null;
        }

        const fd = foundData[0];
        if (!fd.image) return null;

        // D32 pre-rendered images
        if (fd.image._prerendered) {
            return fd.image.canvas;
        }

        return this._getImage(
            fd.image.pixeldata,
            fd.image.width,
            fd.image.height,
            fd.image.fullWidth,
            fd.image.fullHeight,
            fd.image.marginLeft,
            fd.image.marginTop,
            fd.image.hasShadow,
            how
        );
    }

    _getImage(pixeldata, width, height, fullWidth, fullHeight, marginLeft, marginTop, hasShadow, how) {
        if (this._isD32) return null; // Should use _prerendered path

        const palette = this.palette;
        const special = detectSpecialIndices(palette);
        const shadowIndices = new Set([1, 2, 3, 4, 6, 7]);
        const overlayIndices = new Set([5, 6, 7]);

        // Check if has overlay
        let hasOverlay = false;
        if (hasShadow && special.has(5)) {
            for (let i = 0; i < pixeldata.length; i++) {
                if (pixeldata[i] === 5) { hasOverlay = true; break; }
            }
        }

        // Create RGBA pixel array from paletted data
        const rgbaData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const idx = pixeldata[i];
            if (idx < palette.length) {
                rgbaData[i * 4 + 0] = palette[idx][0];
                rgbaData[i * 4 + 1] = palette[idx][1];
                rgbaData[i * 4 + 2] = palette[idx][2];
                rgbaData[i * 4 + 3] = 255;
            }
        }

        // Apply special color handling based on 'how' parameter
        switch (how) {
            case 'combined': {
                for (let i = 0; i < width * height; i++) {
                    const idx = pixeldata[i];
                    if (idx === 0 && special.has(0)) {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                    if (hasShadow) {
                        if (shadowIndices.has(idx) && special.has(idx)) {
                            const t = SPECIAL_TARGET_PALETTE[idx];
                            rgbaData[i*4] = t[0]; rgbaData[i*4+1] = t[1]; rgbaData[i*4+2] = t[2]; rgbaData[i*4+3] = t[3];
                        }
                        if (hasOverlay && idx === 5 && special.has(5)) {
                            rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                        }
                    }
                }
                break;
            }
            case 'normal': {
                for (let i = 0; i < width * height; i++) {
                    const idx = pixeldata[i];
                    if (idx === 0 && special.has(0)) {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                    if (hasShadow) {
                        if ((shadowIndices.has(idx) || overlayIndices.has(idx)) && special.has(idx)) {
                            rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                        }
                    }
                }
                break;
            }
            case 'shadow': {
                if (!hasShadow) return null;
                for (let i = 0; i < width * height; i++) {
                    const idx = pixeldata[i];
                    if (idx === 0 && special.has(0)) {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                    for (let j = 2; j < 8; j++) {
                        if (idx === j) {
                            if (special.has(j) && !shadowIndices.has(j)) {
                                rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                            } else if (special.has(j) && shadowIndices.has(j)) {
                                const t = SPECIAL_TARGET_PALETTE[j];
                                rgbaData[i*4] = t[0]; rgbaData[i*4+1] = t[1]; rgbaData[i*4+2] = t[2]; rgbaData[i*4+3] = t[3];
                            }
                        }
                    }
                    // Non-special pixels become transparent in shadow view
                    if (idx > 7 && !special.has(idx)) {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                    if (idx === 1 && special.has(1)) {
                        const t = SPECIAL_TARGET_PALETTE[1];
                        rgbaData[i*4] = t[0]; rgbaData[i*4+1] = t[1]; rgbaData[i*4+2] = t[2]; rgbaData[i*4+3] = t[3];
                    }
                    if (idx > 7) {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                }
                break;
            }
            case 'overlay': {
                if (!hasOverlay) return null;
                for (let i = 0; i < width * height; i++) {
                    const idx = pixeldata[i];
                    if (overlayIndices.has(idx) && special.has(idx)) {
                        rgbaData[i*4] = 255; rgbaData[i*4+1] = 255; rgbaData[i*4+2] = 255; rgbaData[i*4+3] = 255;
                    } else {
                        rgbaData[i*4] = 0; rgbaData[i*4+1] = 0; rgbaData[i*4+2] = 0; rgbaData[i*4+3] = 0;
                    }
                }
                break;
            }
            default:
                console.warn('Unknown how:', how);
                return null;
        }

        // Create canvas with full dimensions
        const canvas = document.createElement('canvas');
        canvas.width = fullWidth;
        canvas.height = fullHeight;
        const ctx = canvas.getContext('2d');

        // Draw the decoded region
        const subCanvas = document.createElement('canvas');
        subCanvas.width = width;
        subCanvas.height = height;
        const subCtx = subCanvas.getContext('2d');
        const imgData = subCtx.createImageData(width, height);
        imgData.data.set(rgbaData);
        subCtx.putImageData(imgData, 0, 0);

        ctx.drawImage(subCanvas, marginLeft, marginTop);
        return canvas;
    }
}

// ============================================================
// DDS Texture Decoder (DXT1/DXT3/DXT5 + uncompressed)
// ============================================================
const DDS = {
    decode(data) {
        if (data.length < 128) return null;
        const r = new DataView2(data);
        const magic = r.readUint32LE();
        if (magic !== 0x20534444) return null; // "DDS "

        r.readUint32LE(); // headerSize (124)
        r.readUint32LE(); // flags
        const height = r.readUint32LE();
        const width = r.readUint32LE();
        r.readUint32LE(); // pitchOrLinearSize
        r.readUint32LE(); // depth
        r.readUint32LE(); // mipMapCount
        r.readBytes(44);  // reserved[11]

        // Pixel format
        r.readUint32LE(); // pfSize (32)
        const pfFlags = r.readUint32LE();
        const fourCC = r.readUint32LE();
        const rgbBitCount = r.readUint32LE();
        const rMask = r.readUint32LE();
        const gMask = r.readUint32LE();
        const bMask = r.readUint32LE();
        const aMask = r.readUint32LE();
        // skip caps (20 bytes)

        const pixelData = data.subarray ? data.subarray(128) : new Uint8Array(data.buffer, data.byteOffset + 128);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        const out = imgData.data;

        if (pfFlags & 0x4) { // DDPF_FOURCC
            if (fourCC === 0x31545844) this._decodeDXT1(pixelData, width, height, out);
            else if (fourCC === 0x33545844) this._decodeDXT3(pixelData, width, height, out);
            else if (fourCC === 0x35545844) this._decodeDXT5(pixelData, width, height, out);
            else { console.warn('Unsupported DDS fourCC:', fourCC); return null; }
        } else if (pfFlags & 0x40) { // DDPF_RGB
            this._decodeRGB(pixelData, width, height, rgbBitCount, rMask, gMask, bMask, aMask, !!(pfFlags & 0x1), out);
        } else {
            console.warn('Unsupported DDS pixel format flags:', pfFlags);
            return null;
        }

        ctx.putImageData(imgData, 0, 0);
        return canvas;
    },

    _rgb565(c) {
        return [
            ((c >> 11) & 0x1F) * 255 / 31 | 0,
            ((c >> 5) & 0x3F) * 255 / 63 | 0,
            (c & 0x1F) * 255 / 31 | 0
        ];
    },

    _colorTable(c0, c1, hasAlpha) {
        const [r0, g0, b0] = this._rgb565(c0);
        const [r1, g1, b1] = this._rgb565(c1);
        // 4 colors × RGBA
        const t = new Uint8Array(16);
        t[0] = r0; t[1] = g0; t[2] = b0; t[3] = 255;
        t[4] = r1; t[5] = g1; t[6] = b1; t[7] = 255;
        if (c0 > c1 || !hasAlpha) {
            t[8]  = (2*r0 + r1 + 1) / 3 | 0; t[9]  = (2*g0 + g1 + 1) / 3 | 0; t[10] = (2*b0 + b1 + 1) / 3 | 0; t[11] = 255;
            t[12] = (r0 + 2*r1 + 1) / 3 | 0; t[13] = (g0 + 2*g1 + 1) / 3 | 0; t[14] = (b0 + 2*b1 + 1) / 3 | 0; t[15] = 255;
        } else {
            t[8]  = (r0 + r1 + 1) / 2 | 0; t[9]  = (g0 + g1 + 1) / 2 | 0; t[10] = (b0 + b1 + 1) / 2 | 0; t[11] = 255;
            t[12] = 0; t[13] = 0; t[14] = 0; t[15] = 0;
        }
        return t;
    },

    _decodeDXT1(data, w, h, out) {
        const bx = Math.ceil(w / 4), by = Math.ceil(h / 4);
        let off = 0;
        for (let y = 0; y < by; y++) {
            for (let x = 0; x < bx; x++) {
                const c0 = data[off] | (data[off+1] << 8);
                const c1 = data[off+2] | (data[off+3] << 8);
                const t = this._colorTable(c0, c1, true);
                for (let r = 0; r < 4; r++) {
                    const py = y*4+r; if (py >= h) break;
                    const bits = data[off+4+r];
                    for (let c = 0; c < 4; c++) {
                        const px = x*4+c; if (px >= w) continue;
                        const ci = ((bits >> (c*2)) & 3) * 4;
                        const di = (py*w+px)*4;
                        out[di]=t[ci]; out[di+1]=t[ci+1]; out[di+2]=t[ci+2]; out[di+3]=t[ci+3];
                    }
                }
                off += 8;
            }
        }
    },

    _decodeDXT3(data, w, h, out) {
        const bx = Math.ceil(w / 4), by = Math.ceil(h / 4);
        let off = 0;
        for (let y = 0; y < by; y++) {
            for (let x = 0; x < bx; x++) {
                // Color block at off+8
                const c0 = data[off+8] | (data[off+9] << 8);
                const c1 = data[off+10] | (data[off+11] << 8);
                const t = this._colorTable(c0, c1, false);
                for (let r = 0; r < 4; r++) {
                    const py = y*4+r; if (py >= h) break;
                    const bits = data[off+12+r];
                    const alphaBits = data[off+r*2] | (data[off+r*2+1] << 8);
                    for (let c = 0; c < 4; c++) {
                        const px = x*4+c; if (px >= w) continue;
                        const ci = ((bits >> (c*2)) & 3) * 4;
                        const di = (py*w+px)*4;
                        out[di]=t[ci]; out[di+1]=t[ci+1]; out[di+2]=t[ci+2];
                        const a4 = (alphaBits >> (c*4)) & 0xF;
                        out[di+3] = a4 | (a4 << 4);
                    }
                }
                off += 16;
            }
        }
    },

    _decodeDXT5(data, w, h, out) {
        const bx = Math.ceil(w / 4), by = Math.ceil(h / 4);
        let off = 0;
        for (let y = 0; y < by; y++) {
            for (let x = 0; x < bx; x++) {
                // Alpha
                const a0 = data[off], a1 = data[off+1];
                const at = new Uint8Array(8);
                at[0] = a0; at[1] = a1;
                if (a0 > a1) {
                    at[2]=(6*a0+a1+3)/7|0; at[3]=(5*a0+2*a1+3)/7|0;
                    at[4]=(4*a0+3*a1+3)/7|0; at[5]=(3*a0+4*a1+3)/7|0;
                    at[6]=(2*a0+5*a1+3)/7|0; at[7]=(a0+6*a1+3)/7|0;
                } else {
                    at[2]=(4*a0+a1+2)/5|0; at[3]=(3*a0+2*a1+2)/5|0;
                    at[4]=(2*a0+3*a1+2)/5|0; at[5]=(a0+4*a1+2)/5|0;
                    at[6]=0; at[7]=255;
                }

                // Color block at off+8
                const c0 = data[off+8] | (data[off+9] << 8);
                const c1 = data[off+10] | (data[off+11] << 8);
                const t = this._colorTable(c0, c1, false);
                for (let r = 0; r < 4; r++) {
                    const py = y*4+r; if (py >= h) break;
                    const bits = data[off+12+r];
                    for (let c = 0; c < 4; c++) {
                        const px = x*4+c; if (px >= w) continue;
                        const ci = ((bits >> (c*2)) & 3) * 4;
                        const di = (py*w+px)*4;
                        out[di]=t[ci]; out[di+1]=t[ci+1]; out[di+2]=t[ci+2];
                        // 3-bit alpha index from 48-bit field
                        const ai = r*4+c;
                        const bitPos = ai * 3;
                        const byteIdx = bitPos >> 3;
                        const bitIdx = bitPos & 7;
                        const ab0 = data[off+2+byteIdx];
                        const ab1 = (byteIdx+1 < 6) ? data[off+2+byteIdx+1] : 0;
                        out[di+3] = at[((ab0 | (ab1 << 8)) >> bitIdx) & 7];
                    }
                }
                off += 16;
            }
        }
    },

    _decodeRGB(data, w, h, bpp, rM, gM, bM, aM, hasAlpha, out) {
        const bytesPerPixel = bpp / 8;
        const rShift = this._maskShift(rM), rBits = this._maskBits(rM);
        const gShift = this._maskShift(gM), gBits = this._maskBits(gM);
        const bShift = this._maskShift(bM), bBits = this._maskBits(bM);
        const aShift = hasAlpha ? this._maskShift(aM) : 0;
        const aBits = hasAlpha ? this._maskBits(aM) : 0;
        let off = 0;
        for (let i = 0; i < w * h; i++) {
            let px = 0;
            for (let b = 0; b < bytesPerPixel; b++) px |= data[off+b] << (b*8);
            off += bytesPerPixel;
            const di = i * 4;
            out[di]   = rBits ? ((px >> rShift) & ((1 << rBits) - 1)) * 255 / ((1 << rBits) - 1) | 0 : 0;
            out[di+1] = gBits ? ((px >> gShift) & ((1 << gBits) - 1)) * 255 / ((1 << gBits) - 1) | 0 : 0;
            out[di+2] = bBits ? ((px >> bShift) & ((1 << bBits) - 1)) * 255 / ((1 << bBits) - 1) | 0 : 0;
            out[di+3] = hasAlpha && aBits ? ((px >> aShift) & ((1 << aBits) - 1)) * 255 / ((1 << aBits) - 1) | 0 : 255;
        }
    },

    _maskShift(m) { if (!m) return 0; let s = 0; while ((m & 1) === 0) { m >>= 1; s++; } return s; },
    _maskBits(m) { if (!m) return 0; while ((m & 1) === 0) m >>= 1; let b = 0; while (m & 1) { m >>= 1; b++; } return b; }
};

// ============================================================
// PAK File Parser
// ============================================================
class PakFile {
    constructor() {
        this.data = {};
    }

    static async open(data, onProgress) {
        const pak = new PakFile();
        await pak._parse(data, onProgress);
        return pak;
    }

    async _parse(data, onProgress) {
        const r = new DataView2(data);
        r.readUint32LE(); // dummy
        const infoOffset = r.readUint32LE();

        r.seek(infoOffset);
        const files = r.readUint32LE();
        let offsetName = r.tell();

        for (let i = 0; i < files; i++) {
            if (onProgress && i % 10 === 0) {
                onProgress(i / files);
                await new Promise(r2 => setTimeout(r2, 0));
            }
            r.seek(offsetName);
            const nameBytes = r.readBytes(8);
            const nullIdx = nameBytes.indexOf(0);
            const name = String.fromCharCode(...(nullIdx >= 0 ? nameBytes.slice(0, nullIdx) : nameBytes));

            r.readBytes(12); // dummy
            const offset = r.readUint32LE();
            const dummySize = r.readUint32LE();
            const chunks = r.readUint32LE();
            const zsize = r.readUint32LE();
            const size = r.readUint32LE();

            const chunkZsizeArr = [];
            for (let j = 0; j < chunks; j++) {
                chunkZsizeArr.push(r.readUint32LE());
            }
            const chunkSizeArr = [];
            for (let j = 0; j < chunks; j++) {
                chunkSizeArr.push(r.readUint32LE());
            }
            offsetName = r.tell();

            r.seek(offset);

            // Read image config text
            const configBytes = r.readBytes(dummySize);
            let imageConfig = '';
            for (const b of configBytes) imageConfig += String.fromCharCode(b);

            // Read and decompress each chunk individually
            let currentOffset = offset + dummySize;
            const resultChunks = [];

            for (let j = 0; j < chunks; j++) {
                r.seek(currentOffset);
                if (chunkZsizeArr[j] === chunkSizeArr[j]) {
                    // Uncompressed chunk
                    resultChunks.push(r.readBytes(chunkSizeArr[j]));
                } else {
                    // Compressed chunk - read exact compressed size
                    const compressed = r.readBytes(chunkZsizeArr[j]);
                    try {
                        const decompressed = await zlibDecompress(compressed);
                        resultChunks.push(decompressed);
                    } catch (e) {
                        console.warn('PAK chunk decompression failed:', j, e);
                        resultChunks.push(compressed);
                    }
                }
                currentOffset += chunkZsizeArr[j];
            }

            this.data[name] = { config: imageConfig, chunks: resultChunks };
        }
    }

    getSheetnames() {
        return Object.keys(this.data);
    }

    async getSheets(name) {
        for (const [k, v] of Object.entries(this.data)) {
            if (k.toUpperCase() === name.toUpperCase()) {
                const sheets = [];
                for (const chunk of v.chunks) {
                    // Try DDS decode first (HD PAK files contain DDS textures)
                    const ddsCanvas = DDS.decode(chunk);
                    if (ddsCanvas) {
                        sheets.push(ddsCanvas);
                        continue;
                    }
                    // Fallback: try as browser-native image (PNG/BMP/etc.)
                    try {
                        const blob = new Blob([chunk]);
                        const img = await createImageBitmap(blob);
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0);
                        sheets.push(canvas);
                    } catch (e) {
                        console.warn('Failed to decode PAK sheet chunk:', e);
                    }
                }
                return sheets;
            }
        }
        console.warn('file not found:', name);
        return null;
    }

    getSheetConfig(name) {
        for (const [k, v] of Object.entries(this.data)) {
            if (k.toUpperCase() === name.toUpperCase()) {
                const ret = {};
                for (const line of v.config.split('\r\n')) {
                    const tmp = line.split(' ');
                    if (tmp.length > 11) {
                        ret[tmp[0]] = {
                            name: tmp[0],
                            no: parseInt(tmp[1]),
                            xOffsetSdHd: parseInt(tmp[2]),
                            unknown1: parseInt(tmp[3]),
                            yOffsetSdHd: parseInt(tmp[4]),
                            unknown2: parseInt(tmp[5]),
                            x: parseInt(tmp[6]),
                            y: parseInt(tmp[7]),
                            width: parseInt(tmp[8]),
                            height: parseInt(tmp[9]),
                            rotation: parseInt(tmp[10]),
                            hasShadow: parseInt(tmp[11]),
                            shadowNo: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[12]),
                            shadowX: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[13]),
                            shadowY: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[14]),
                            shadowWidth: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[15]),
                            shadowHeight: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[16]),
                            shadowRotation: parseInt(tmp[11]) === 0 ? null : parseInt(tmp[17])
                        };
                    }
                }
                return ret;
            }
        }
        console.warn('file not found:', name);
        return null;
    }

    getFilenamesForSheet(name) {
        for (const [k, v] of Object.entries(this.data)) {
            if (k.toUpperCase() === name.toUpperCase()) {
                const ret = [];
                for (const line of v.config.split('\r\n')) {
                    const tmp = line.split(' ');
                    if (tmp.length > 11) {
                        ret.push(tmp[0]);
                    }
                }
                return ret;
            }
        }
        console.warn('file not found:', name);
        return null;
    }

    getRawChunks(name) {
        for (const [k, v] of Object.entries(this.data)) {
            if (k.toUpperCase() === name.toUpperCase()) {
                return v.chunks;
            }
        }
        return null;
    }

    async getImage(sheetname, imagename) {
        const cfg = this.getSheetConfig(sheetname);
        const sheets = await this.getSheets(sheetname);

        if (cfg) {
            for (const [k, v] of Object.entries(cfg)) {
                if (k.toUpperCase() === imagename.toUpperCase()) {
                    const sheet = sheets[v.no];
                    const canvas = document.createElement('canvas');
                    canvas.width = v.width;
                    canvas.height = v.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(sheet, v.x, v.y, v.width, v.height, 0, 0, v.width, v.height);

                    // Apply rotation
                    if (v.rotation !== 0) {
                        const rotCanvas = document.createElement('canvas');
                        if (v.rotation % 2 === 1) {
                            rotCanvas.width = v.height;
                            rotCanvas.height = v.width;
                        } else {
                            rotCanvas.width = v.width;
                            rotCanvas.height = v.height;
                        }
                        const rotCtx = rotCanvas.getContext('2d');
                        rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
                        rotCtx.rotate(-90 * v.rotation * Math.PI / 180);
                        rotCtx.drawImage(canvas, -v.width / 2, -v.height / 2);
                        return { image: rotCanvas, shadow: null };
                    }

                    let shadowCanvas = null;
                    if (v.hasShadow === 1) {
                        shadowCanvas = document.createElement('canvas');
                        shadowCanvas.width = v.shadowWidth;
                        shadowCanvas.height = v.shadowHeight;
                        const shadowCtx = shadowCanvas.getContext('2d');
                        shadowCtx.drawImage(sheets[v.shadowNo], v.shadowX, v.shadowY, v.shadowWidth, v.shadowHeight, 0, 0, v.shadowWidth, v.shadowHeight);

                        if (v.shadowRotation !== 0) {
                            const rotShadow = document.createElement('canvas');
                            if (v.shadowRotation % 2 === 1) {
                                rotShadow.width = v.shadowHeight;
                                rotShadow.height = v.shadowWidth;
                            } else {
                                rotShadow.width = v.shadowWidth;
                                rotShadow.height = v.shadowHeight;
                            }
                            const rotCtx = rotShadow.getContext('2d');
                            rotCtx.translate(rotShadow.width / 2, rotShadow.height / 2);
                            rotCtx.rotate(-90 * v.shadowRotation * Math.PI / 180);
                            rotCtx.drawImage(shadowCanvas, -v.shadowWidth / 2, -v.shadowHeight / 2);
                            shadowCanvas = rotShadow;
                        }
                    }

                    return { image: canvas, shadow: shadowCanvas };
                }
            }
        }
        console.warn('file not found:', sheetname, '-', imagename);
        return null;
    }
}

// ============================================================
// SND File Parser
// ============================================================
class SndFile {
    constructor() {
        this.files = [];
        this._buffer = null;
    }

    static async open(data) {
        const snd = new SndFile();
        await snd._parse(data);
        return snd;
    }

    async _parse(data) {
        this._buffer = data;
        const r = new DataView2(data);
        const totalFiles = r.readUint32LE();
        this.files = [];
        for (let i = 0; i < totalFiles; i++) {
            const name = r.readString(40);
            const offset = r.readUint32LE();
            const size = r.readUint32LE();
            this.files.push({ filename: name.toLowerCase(), offset, size });
        }
    }

    getFilelist() {
        return this.files.map(f => f.filename);
    }

    async getFile(selectedFilename) {
        selectedFilename = selectedFilename.toLowerCase();
        for (const { filename, offset, size } of this.files) {
            if (selectedFilename !== filename) continue;
            return this._buffer.slice(offset, offset + size);
        }
        console.warn('file not found:', selectedFilename);
        return null;
    }
}

// ============================================================
// VID File Parser
// ============================================================
class VidFile {
    constructor() {
        this.files = [];
        this._buffer = null;
    }

    static async open(data) {
        const vid = new VidFile();
        await vid._parse(data);
        return vid;
    }

    async _parse(data) {
        this._buffer = data;
        const r = new DataView2(data);
        const totalFiles = r.readUint32LE();
        const entries = [];
        for (let i = 0; i < totalFiles; i++) {
            const name = r.readString(40);
            const begin = r.readUint32LE();
            entries.push({ filename: name.toLowerCase(), begin, end: 0 });
        }
        for (let i = 0; i < entries.length - 1; i++) {
            entries[i].end = entries[i + 1].begin;
        }
        if (entries.length > 0) {
            entries[entries.length - 1].end = data.length;
        }
        this.files = entries;
    }

    getFilelist() {
        return this.files.map(f => f.filename);
    }

    async getFile(selectedFilename) {
        selectedFilename = selectedFilename.toLowerCase();
        for (const { filename, begin, end } of this.files) {
            if (selectedFilename !== filename) continue;
            return this._buffer.slice(begin, end);
        }
        console.warn('file not found:', selectedFilename);
        return null;
    }
}


// ============================================================
// FNT Bitmap Font Parser
//   byte[5]           = line height
//   offset 32         = 256 × 12 bytes glyph metrics (leftOffset, width, rightOffset – each uint32LE)
//   offset 32+3072    = 256 × 4 bytes pixel-data offsets (uint32LE each)
//   offset 32+3072+1024 = raw pixel data (indexed: 0=transparent, 1=shadow, 2-255=white)
// ============================================================
const FNT = (() => {
    const SYMBOLS    = 256;
    const BASE_INDEX = 32;
    const OFF_INDEX  = BASE_INDEX + SYMBOLS * 12;   // 3104
    const DATA_INDEX = OFF_INDEX  + SYMBOLS * 4;    // 4128

    function isFnt(data) {
        return data instanceof Uint8Array && data.byteLength > DATA_INDEX;
    }

    function readFnt(data) {
        const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const height = data[5];
        const glyphs = [];
        for (let i = 0; i < SYMBOLS; i++) {
            const mb          = BASE_INDEX + i * 12;
            const leftOffset  = view.getUint32(mb + 0, true);
            const width       = view.getUint32(mb + 4, true);
            const rightOffset = view.getUint32(mb + 8, true);
            const pixOff      = view.getUint32(OFF_INDEX + i * 4, true);
            const pixCount    = height * width;
            const pixels      = data.slice(DATA_INDEX + pixOff, DATA_INDEX + pixOff + pixCount);
            glyphs.push({ charCode: i, leftOffset, width, rightOffset, height, pixels });
        }
        return { height, glyphs };
    }

    function renderSheet(font, showBorders = false) {
        const { height, glyphs } = font;
        const COLS     = 16;
        const ROWS     = 16;
        const PAD      = 3;
        const LABEL_W  = 30;
        const LABEL_H  = 16;
        const maxGW    = Math.max(8, ...glyphs.map(g => g.width));
        const CELL_W   = maxGW + PAD * 2;
        const CELL_H   = height + PAD * 2;
        const W        = LABEL_W + COLS * CELL_W;
        const H        = LABEL_H + ROWS * CELL_H;

        const canvas   = document.createElement('canvas');
        canvas.width   = W;
        canvas.height  = H;
        const ctx      = canvas.getContext('2d');

        // Fill only the label header row and label column — cells stay transparent
        ctx.fillStyle = 'rgba(28,33,40,0.88)';
        ctx.fillRect(0, 0, W, LABEL_H);
        ctx.fillRect(0, LABEL_H, LABEL_W, H - LABEL_H);

        // Column header labels
        ctx.fillStyle = '#8b949e';
        ctx.font      = '9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let c = 0; c < COLS; c++) {
            ctx.fillText(c.toString(16).toUpperCase(),
                LABEL_W + c * CELL_W + CELL_W / 2,
                LABEL_H / 2);
        }

        // Row header labels
        ctx.textAlign = 'right';
        for (let r = 0; r < ROWS; r++) {
            ctx.fillText((r * 16).toString(16).toUpperCase().padStart(2, '0') + 'h',
                LABEL_W - 3,
                LABEL_H + r * CELL_H + CELL_H / 2);
        }

        // Grid lines
        ctx.strokeStyle = '#30363d';
        ctx.lineWidth   = 1;
        for (let c = 0; c <= COLS; c++) {
            const x = LABEL_W + c * CELL_W + 0.5;
            ctx.beginPath(); ctx.moveTo(x, LABEL_H); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let r = 0; r <= ROWS; r++) {
            const y = LABEL_H + r * CELL_H + 0.5;
            ctx.beginPath(); ctx.moveTo(LABEL_W, y); ctx.lineTo(W, y); ctx.stroke();
        }
        // Header separator – slightly brighter
        ctx.strokeStyle = '#484f58';
        ctx.beginPath(); ctx.moveTo(0, LABEL_H + 0.5); ctx.lineTo(W, LABEL_H + 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(LABEL_W + 0.5, 0); ctx.lineTo(LABEL_W + 0.5, H); ctx.stroke();

        // Glyphs
        for (let i = 0; i < SYMBOLS; i++) {
            const g    = glyphs[i];
            if (!g.width || !g.height || g.pixels.length === 0) continue;
            const col  = i % COLS;
            const row  = Math.floor(i / COLS);
            const offX = LABEL_W + col * CELL_W + PAD + Math.floor((CELL_W - PAD * 2 - g.width) / 2);
            const offY = LABEL_H + row * CELL_H + PAD;
            const img  = ctx.createImageData(g.width, g.height);
            const px   = g.pixels;
            for (let p = 0; p < px.length; p++) {
                const v  = px[p];
                const b  = p * 4;
                if (v === 0) {
                    img.data[b + 3] = 0;
                } else if (v === 1) {
                    img.data[b] = 0; img.data[b + 1] = 0; img.data[b + 2] = 0; img.data[b + 3] = 200;
                } else {
                    img.data[b] = 255; img.data[b + 1] = 255; img.data[b + 2] = 255; img.data[b + 3] = 255;
                }
            }
            ctx.putImageData(img, offX, offY);

            // Per-glyph border (actual glyph bounding box)
            if (showBorders) {
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth   = 1;
                ctx.strokeRect(offX + 0.5, offY + 0.5, g.width - 1, g.height - 1);
            }
        }

        return canvas;
    }

    return { isFnt, readFnt, renderSheet };
})();

// ============================================================
// Content-based file type detection
// ============================================================

/**
 * Individual detector functions — each takes a Uint8Array of decompressed bytes
 * and returns true if the data matches the format.
 */
const FileDetectors = {
    /** HotA P32 image (magic "P32F" LE = 0x46323350) */
    isP32(data) {
        return data.length >= 4 && data[0]===0x50 && data[1]===0x33 && data[2]===0x32 && data[3]===0x46;
    },
    /** HotA D32 animation (magic "D32F" LE = 0x46323344) */
    isD32(data) {
        return data.length >= 4 && data[0]===0x44 && data[1]===0x33 && data[2]===0x32 && data[3]===0x46;
    },
    /** Standard H3 PCX: first three uint32LE = size, width, height; size == w*h or w*h*3 */
    isPcx(data) {
        if (data.length < 12) return false;
        const u32 = (o) => data[o]|(data[o+1]<<8)|(data[o+2]<<16)|((data[o+3]<<24)>>>0);
        const size=u32(0), w=u32(4), h=u32(8);
        return w>0 && w<=4096 && h>0 && h<=4096 && (size===w*h || size===w*h*3);
    },
    /** H3 DEF animation: first uint32LE is type code 0x40–0x49, then reasonable width/height */
    isDef(data) {
        if (data.length < 16) return false;
        const u32 = (o) => data[o]|(data[o+1]<<8)|(data[o+2]<<16)|((data[o+3]<<24)>>>0);
        const t=u32(0), w=u32(4), h=u32(8);
        return t>=0x40 && t<=0x49 && w>0 && w<=4096 && h>0 && h<=4096;
    },
    /** WAV audio: RIFF header */
    isWav(data) {
        return data.length >= 4 && data[0]===0x52 && data[1]===0x49 && data[2]===0x46 && data[3]===0x46;
    },
    /** Bink video: starts with "BIK" or "KB2" etc. */
    isBik(data) {
        return data.length >= 3 && data[0]===0x42 && data[1]===0x49 && data[2]===0x4B;
    },
    /** Smacker video: starts with "SMK" */
    isSmk(data) {
        return data.length >= 3 && data[0]===0x53 && data[1]===0x4D && data[2]===0x4B;
    },
    /** gzip-compressed (H3M/H3C maps) */
    isGzip(data) {
        return data.length >= 2 && data[0]===0x1f && data[1]===0x8b;
    },
    /** DDS texture */
    isDds(data) {
        return data.length >= 4 && data[0]===0x44 && data[1]===0x44 && data[2]===0x53 && data[3]===0x20;
    },
    /** H3 font (FNT): passes the FNT isFnt check */
    isFnt(data) {
        return FNT.isFnt(data);
    },
    /** Plain text: first 256 bytes contain no low control bytes (allow anything >= 0x09 to handle various 8-bit encodings like Latin-1, CP1250, CP1252) */
    isTxt(data) {
        const n = Math.min(data.length, 256);
        if (n === 0) return false;
        for (let i = 0; i < n; i++) {
            const c = data[i];
            // Allow TAB (0x09), LF (0x0A), CR (0x0D), and all bytes >= 0x20
            if (c === 0x09 || c === 0x0A || c === 0x0D) continue;
            if (c < 0x20) return false; // other control chars → not text
        }
        return true;
    },
    /** H3 MSK mask: exactly w*h bytes where the file is the terrain passability bitmask.
     *  Heuristic: size matches a square map (36, 72, 108, 144) → but MSK is hard to detect uniquely.
     *  We skip this and let it fall through to binary. */
    isMsk(_data) { return false; },
    /** H3 IFR haptic: magic "ifpr" */
    isIfr(data) {
        return data.length >= 4 && data[0]===0x69 && data[1]===0x66 && data[2]===0x70 && data[3]===0x72;
    },
};

/**
 * Detect file type from decompressed content bytes.
 * Returns { ext, category, description }.
 */
function detectFileType(data) {
    if (!data || data.length === 0) return { ext: '', category: 'binary', description: 'Empty' };
    if (FileDetectors.isP32(data))  return { ext: 'pcx', category: 'image',     description: 'PCX Image (P32/HotA)' };
    if (FileDetectors.isD32(data))  return { ext: 'def', category: 'animation', description: 'DEF Animation (D32/HotA)' };
    if (FileDetectors.isDds(data))  return { ext: 'dds', category: 'image',     description: 'DDS Texture' };
    if (FileDetectors.isWav(data))  return { ext: 'wav', category: 'audio',     description: 'WAV Audio' };
    if (FileDetectors.isBik(data))  return { ext: 'bik', category: 'video',     description: 'Bink Video' };
    if (FileDetectors.isSmk(data))  return { ext: 'smk', category: 'video',     description: 'Smacker Video' };
    if (FileDetectors.isIfr(data))  return { ext: 'ifr', category: 'haptic',    description: 'IFR Haptic' };
    if (FileDetectors.isGzip(data)) return { ext: 'h3m', category: 'map',       description: 'H3M/H3C Map (gzip)' };
    if (FileDetectors.isDef(data))  return { ext: 'def', category: 'animation', description: 'DEF Animation' };
    if (FileDetectors.isPcx(data))  return { ext: 'pcx', category: 'image',     description: 'PCX Image' };
    if (FileDetectors.isFnt(data))  return { ext: 'fnt', category: 'font',      description: 'FNT Font' };
    if (FileDetectors.isTxt(data))  return { ext: 'txt', category: 'text',      description: 'Text File' };
    return { ext: '', category: 'binary', description: 'Binary Data' };
}

// ============================================================
// ZIP Archive — browse any .zip as a file archive
// Supports stored (method 0) and deflated (method 8) entries.
// Uses pako.inflateRaw (already loaded via CDN) for DEFLATE.
// ============================================================
class ZipFile {
    constructor() {
        this._buffer = null;
        this._entries = []; // { name, compMethod, compSize, uncompSize, dataOffset }
    }

    static async open(data) {
        const z = new ZipFile();
        z._buffer = data;
        z._parseCentralDirectory(data);
        return z;
    }

    // ---- Parse central directory (fast path via EOCD) ----
    _parseCentralDirectory(data) {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // Search for EOCD record (PK\x05\x06) starting near end of file.
        // EOCD is at least 22 bytes; allow up to 64 KiB comment.
        const maxSearch = Math.min(data.length, 65536 + 22);
        let eocdOff = -1;
        for (let i = data.length - 22; i >= data.length - maxSearch; i--) {
            if (data[i] === 0x50 && data[i+1] === 0x4b &&
                data[i+2] === 0x05 && data[i+3] === 0x06) {
                eocdOff = i;
                break;
            }
        }
        if (eocdOff < 0) throw new Error('ZipFile: EOCD not found — not a valid ZIP');

        const cdCount  = dv.getUint16(eocdOff + 8,  true);
        let   cdOffset = dv.getUint32(eocdOff + 16, true);
        // ZIP64: if markers present use ZIP64 EOCD (not implemented here; covers 99% of ZIPs)

        this._entries = [];
        let off = cdOffset;
        for (let i = 0; i < cdCount; i++) {
            if (off + 46 > data.length) break;
            const sig = dv.getUint32(off, true);
            if (sig !== 0x02014b50) break; // PK\x01\x02

            const compMethod  = dv.getUint16(off + 10, true);
            const compSize    = dv.getUint32(off + 20, true);
            const uncompSize  = dv.getUint32(off + 24, true);
            const nameLen     = dv.getUint16(off + 28, true);
            const extraLen    = dv.getUint16(off + 30, true);
            const commentLen  = dv.getUint16(off + 32, true);
            const localOffset = dv.getUint32(off + 42, true);
            const name = new TextDecoder('utf-8').decode(data.subarray(off + 46, off + 46 + nameLen));

            // Skip directories
            if (!name.endsWith('/') && uncompSize > 0 || (!name.endsWith('/') && compSize > 0)) {
                // Resolve actual data offset from local file header
                const localNameLen  = dv.getUint16(localOffset + 26, true);
                const localExtraLen = dv.getUint16(localOffset + 28, true);
                const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
                this._entries.push({ name, compMethod, compSize, uncompSize, dataOffset });
            }

            off += 46 + nameLen + extraLen + commentLen;
        }
    }

    getFilelist() {
        return this._entries.map(e => e.name);
    }

    async getFile(selectedFilename) {
        const entry = this._entries.find(e => e.name === selectedFilename);
        if (!entry) {
            console.warn('ZipFile: file not found:', selectedFilename);
            return null;
        }
        const raw = this._buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
        if (entry.compMethod === 0) {
            // Stored — return as-is
            return raw.slice();
        } else if (entry.compMethod === 8) {
            // Deflated — decompress with pako
            return pako.inflateRaw(raw);
        } else {
            throw new Error(`ZipFile: unsupported compression method ${entry.compMethod} for "${entry.name}"`);
        }
    }

    /** Check whether data starts with the ZIP local file header or EOCD magic. */
    static isZip(data) {
        if (data.length < 4) return false;
        // PK\x03\x04 (local header) or PK\x05\x06 (EOCD — empty zip)
        return data[0] === 0x50 && data[1] === 0x4b &&
               (data[2] === 0x03 || data[2] === 0x05);
    }
}

// ============================================================
// HotA DAT file parser (HotA.dat — creature / unit data)
// Binary format: magic "HDAT", version 2, then N entries.
// Each entry: name (str), foldername (str), 9-fields sentinel,
//   data[0..8] strings, optional binary blob (data[9] as hex),
//   data[10] int32 array.
// ============================================================
class HotaDat {
    /**
     * Parse a HotA.dat binary blob.
     * @param {Uint8Array} bytes
     * @param {string} [encoding='cp1252'] IANA encoding label for string fields.
     * @returns {{ version: number, entries: object[], _rawStringBytes: Uint8Array }}
     */
    static parse(bytes, encoding = 'cp1252') {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let off = 0;
        const decoder = new TextDecoder(encoding);
        // Collect raw bytes of all text fields for encoding detection/re-decode
        const rawStringChunks = [];

        function readI32() {
            if (off + 4 > bytes.length) throw new Error('HotaDat: unexpected end of file at offset ' + off);
            const v = dv.getInt32(off, true);
            off += 4;
            return v;
        }
        function readBool() {
            if (off >= bytes.length) throw new Error('HotaDat: unexpected end of file at offset ' + off);
            return bytes[off++] !== 0;
        }
        function readStr(collect = false) {
            const len = readI32();
            if (len < 0 || off + len > bytes.length) throw new Error('HotaDat: string len overflow at offset ' + off);
            const raw = bytes.subarray(off, off + len);
            if (collect && len > 0) rawStringChunks.push(raw);
            const s = decoder.decode(raw);
            off += len;
            return s;
        }
        function readHex() {
            const len = readI32();
            if (len < 0 || off + len > bytes.length) throw new Error('HotaDat: blob len overflow at offset ' + off);
            const hex = Array.from(bytes.subarray(off, off + len)).map(b => b.toString(16).padStart(2, '0')).join('');
            off += len;
            return hex;
        }

        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== 'HDAT') throw new Error(`HotaDat: bad magic "${magic}"`);
        off = 4;

        const version = readI32();
        const count   = readI32();

        const entries = [];
        for (let i = 0; i < count; i++) {
            const name       = readStr();       // ASCII-safe internal name
            const foldername = readStr();       // ASCII-safe path
            const nine       = readI32();       // always 9
            if (nine !== 9) console.warn(`HotaDat: entry ${i} sentinel = ${nine}, expected 9`);

            const fields = {};
            for (let j = 0; j < 9; j++) fields[j] = readStr(/* collect= */ true);

            const hasBlob = readBool();
            if (hasBlob) fields[9] = readHex();

            const arrLen = readI32();
            const arr = [];
            for (let j = 0; j < arrLen; j++) arr.push(readI32());
            fields[10] = arr;

            entries.push({ name, foldername, fields });
        }

        // Merge all string bytes for encoding detection
        const totalLen = rawStringChunks.reduce((s, c) => s + c.length, 0);
        const _rawStringBytes = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of rawStringChunks) { _rawStringBytes.set(chunk, pos); pos += chunk.length; }

        return { version, entries, _rawStringBytes };
    }

    /** Convert parsed result to pretty JSON string (UTF-8, 2-space indent). */
    static toJson(parsed) {
        return JSON.stringify(parsed, null, 2);
    }

    /** Check whether bytes look like a HotA DAT file (magic "HDAT"). */
    static isHotaDat(bytes) {
        return bytes.length >= 8 &&
            bytes[0] === 0x48 && bytes[1] === 0x44 &&
            bytes[2] === 0x41 && bytes[3] === 0x54; // "HDAT"
    }
}

// ============================================================
// File type detection helpers
// ============================================================
function getFileExtension(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot === -1) return '';
    return filename.substring(dot + 1).toLowerCase();
}

function getFileCategory(filename) {
    const ext = getFileExtension(filename);
    switch (ext) {
        case 'pcx': case 'p32': return 'image';
        case 'def':
        case 'd32':
            return 'animation';
        case 'txt':
        case 'xls':
        case 'csv':
            return 'text';
        case 'wav':
        case 'snd':
            return 'audio';
        case 'smk':
        case 'bik':
            return 'video';
        case 'msk': return 'data';
        case 'dat': return 'data';
        case 'fnt': return 'font';
        case 'pal': return 'palette';
        case 'ifr': return 'haptic';
        case 'h3m': return 'map';
        case 'h3c': return 'campaign';
        default: return 'binary';
    }
}

// ─── H3T Parser ──────────────────────────────────────────────────────────────
// H3T = HotA Random-Map-Template, plain Tab-Separated-Values with CRLF endings.
// 3 header rows (group / sub-group / column names), then data rows.
// Column layout (0-based indices):
//   Pack   : cols  0–14   (name @ 7, desc @ 8)
//   Map    : cols 15–27   (name @ 15, minSize @ 16, maxSize @ 17)
//   Zone   : cols 28–126  (id @ 28, humanStart @ 29, computerStart @ 30, baseSize @ 33,
//                          monsterStrength @ 83)
//   Conns  : cols 127–139 (zone1 @ 127, zone2 @ 128, value @ 129, wide @ 130,
//                          borderGuard @ 131, road @ 132, type @ 133, fictive @ 134)

class H3TParser {
    // Column index constants
    static C = {
        // Pack
        PACK_TOWN_CNT: 0, PACK_TERRAIN_CNT: 1, PACK_ZONETYPE_CNT: 2,
        PACK_PACKNEW: 3, PACK_MAPNEW: 4, PACK_ZONENEW: 5, PACK_CONNNEW: 6,
        PACK_NAME: 7, PACK_DESC: 8, PACK_TOWNS: 9, PACK_HEROES: 10,
        PACK_MIRROR: 11, PACK_TAGS: 12, PACK_MAX_BATTLE: 13, PACK_FORBID_HIRE: 14,
        // Map
        MAP_NAME: 15, MAP_MIN_SIZE: 16, MAP_MAX_SIZE: 17,
        MAP_ARTIFACTS: 18, MAP_COMBO_ARTS: 19, MAP_SPELLS: 20, MAP_SEC_SKILLS: 21,
        MAP_OBJECTS: 22, MAP_ROCK_BLOCKS: 23, MAP_SPARSE: 24,
        MAP_NO_SPEC_WEEKS: 25, MAP_SPELL_RESEARCH: 26, MAP_ANARCHY: 27,
        // Zone
        ZONE_ID: 28, ZONE_HUMAN: 29, ZONE_COMPUTER: 30,
        ZONE_TREASURE: 31, ZONE_JUNCTION: 32, ZONE_BASE_SIZE: 33,
        ZONE_MIN_HUMAN_POS: 34, ZONE_MAX_HUMAN_POS: 35,
        ZONE_MIN_TOTAL_POS: 36, ZONE_MAX_TOTAL_POS: 37,
        ZONE_OWNERSHIP: 38,
        ZONE_PLAYER_MIN_TOWNS: 39, ZONE_PLAYER_MIN_CASTLES: 40,
        ZONE_PLAYER_TOWN_DENSITY: 41, ZONE_PLAYER_CASTLE_DENSITY: 42,
        ZONE_NEUTRAL_MIN_TOWNS: 43, ZONE_NEUTRAL_MIN_CASTLES: 44,
        ZONE_NEUTRAL_TOWN_DENSITY: 45, ZONE_NEUTRAL_CASTLE_DENSITY: 46,
        ZONE_SAME_TYPE: 47,
        // Town types (cols 48-59): Castle Rampart Tower Inferno Necropolis Dungeon Stronghold Fortress Conflux Cove Factory Bulwark
        ZONE_TOWN_CASTLE: 48, ZONE_TOWN_RAMPART: 49, ZONE_TOWN_TOWER: 50,
        ZONE_TOWN_INFERNO: 51, ZONE_TOWN_NECROPOLIS: 52, ZONE_TOWN_DUNGEON: 53,
        ZONE_TOWN_STRONGHOLD: 54, ZONE_TOWN_FORTRESS: 55, ZONE_TOWN_CONFLUX: 56,
        ZONE_TOWN_COVE: 57, ZONE_TOWN_FACTORY: 58, ZONE_TOWN_BULWARK: 59,
        // Mines min (60-66): Wood Mercury Ore Sulfur Crystal Gems Gold
        ZONE_MINE_WOOD: 60, ZONE_MINE_MERCURY: 61, ZONE_MINE_ORE: 62,
        ZONE_MINE_SULFUR: 63, ZONE_MINE_CRYSTAL: 64, ZONE_MINE_GEMS: 65, ZONE_MINE_GOLD: 66,
        // Mine density (67-73)
        // Terrain (74-84): Match Dirt Sand Grass Snow Swamp Rough Cave Lava Highlands Wasteland
        ZONE_TERRAIN_MATCH: 74, ZONE_TERRAIN_DIRT: 75, ZONE_TERRAIN_SAND: 76,
        ZONE_TERRAIN_GRASS: 77, ZONE_TERRAIN_SNOW: 78, ZONE_TERRAIN_SWAMP: 79,
        ZONE_TERRAIN_ROUGH: 80, ZONE_TERRAIN_CAVE: 81, ZONE_TERRAIN_LAVA: 82,
        ZONE_TERRAIN_HIGHLANDS: 83, ZONE_TERRAIN_WASTELAND: 84,
        // Monsters (85-97)
        ZONE_MONSTER_STRENGTH: 85,
        // Treasure tiers (98-106): Low High Density × 3
        ZONE_TREASURE1_LOW: 98, ZONE_TREASURE1_HIGH: 99, ZONE_TREASURE1_DENSITY: 100,
        ZONE_TREASURE2_LOW: 101, ZONE_TREASURE2_HIGH: 102, ZONE_TREASURE2_DENSITY: 103,
        ZONE_TREASURE3_LOW: 104, ZONE_TREASURE3_HIGH: 105, ZONE_TREASURE3_DENSITY: 106,
        ZONE_IMAGE_SETTINGS: 112,
        // Connections
        CONN_ZONE1: 127, CONN_ZONE2: 128, CONN_VALUE: 129,
        CONN_WIDE: 130, CONN_BORDER_GUARD: 131, CONN_ROAD: 132,
        CONN_TYPE: 133, CONN_FICTIVE: 134
    };

    static parse(text) {
        const C = H3TParser.C;
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

        // We need exactly 3 header rows (may be empty trailing lines)
        const nonEmpty = (l) => l.trim().length > 0;
        const headerLines = [];
        const dataLines = [];
        let headerDone = false;
        let headerCount = 0;
        for (const l of lines) {
            if (headerCount < 3) {
                headerLines.push(l.split('\t'));
                headerCount++;
            } else {
                dataLines.push(l.split('\t'));
            }
        }

        const colNames = headerLines[2] || [];
        const packs = [];
        let currentPack = null;
        let currentMap = null;

        const g = (row, idx) => (row[idx] || '').trim();

        for (const row of dataLines) {
            const allEmpty = row.every(c => !c.trim());
            if (allEmpty) continue;

            const packName = g(row, C.PACK_NAME);
            const mapName  = g(row, C.MAP_NAME);
            const zoneId   = g(row, C.ZONE_ID);
            const conn1    = g(row, C.CONN_ZONE1);

            // New pack
            if (packName) {
                currentPack = {
                    name: packName,
                    description: g(row, C.PACK_DESC),
                    townCount: g(row, C.PACK_TOWN_CNT),
                    terrainCount: g(row, C.PACK_TERRAIN_CNT),
                    zoneTypeCount: g(row, C.PACK_ZONETYPE_CNT),
                    towns: g(row, C.PACK_TOWNS),
                    heroes: g(row, C.PACK_HEROES),
                    mirror: g(row, C.PACK_MIRROR),
                    tags: g(row, C.PACK_TAGS),
                    maxBattleRounds: g(row, C.PACK_MAX_BATTLE),
                    forbidHireHeroes: g(row, C.PACK_FORBID_HIRE),
                    maps: []
                };
                packs.push(currentPack);
            }

            // New map
            if (mapName) {
                currentMap = {
                    name: mapName,
                    minSize: g(row, C.MAP_MIN_SIZE),
                    maxSize: g(row, C.MAP_MAX_SIZE),
                    artifacts: g(row, C.MAP_ARTIFACTS),
                    comboArts: g(row, C.MAP_COMBO_ARTS),
                    spells: g(row, C.MAP_SPELLS),
                    secSkills: g(row, C.MAP_SEC_SKILLS),
                    objects: g(row, C.MAP_OBJECTS),
                    rockBlocks: g(row, C.MAP_ROCK_BLOCKS),
                    sparseness: g(row, C.MAP_SPARSE),
                    noSpecialWeeks: g(row, C.MAP_NO_SPEC_WEEKS),
                    spellResearch: g(row, C.MAP_SPELL_RESEARCH),
                    anarchy: g(row, C.MAP_ANARCHY),
                    zones: [],
                    connections: []
                };
                if (!currentPack) {
                    currentPack = { name: '', description: '', maps: [] };
                    packs.push(currentPack);
                }
                currentPack.maps.push(currentMap);
            }

            // Zone row
            if (zoneId) {
                if (!currentMap) {
                    currentMap = { name: '(unnamed)', minSize: '', maxSize: '', zones: [], connections: [] };
                    if (!currentPack) { currentPack = { name: '', description: '', maps: [] }; packs.push(currentPack); }
                    currentPack.maps.push(currentMap);
                }
                const townTypes = [];
                const townNames = ['Castle','Rampart','Tower','Inferno','Necropolis','Dungeon','Stronghold','Fortress','Conflux','Cove','Factory','Bulwark'];
                for (let ti = 0; ti < 12; ti++) {
                    if (g(row, C.ZONE_TOWN_CASTLE + ti) === 'x') townTypes.push(townNames[ti]);
                }
                const terrainTypes = [];
                const terrainNames = ['Match','Dirt','Sand','Grass','Snow','Swamp','Rough','Cave','Lava','Highlands','Wasteland'];
                for (let ti = 0; ti < 11; ti++) {
                    if (g(row, C.ZONE_TERRAIN_MATCH + ti) === 'x') terrainTypes.push(terrainNames[ti]);
                }
                currentMap.zones.push({
                    id: zoneId,
                    humanStart: g(row, C.ZONE_HUMAN) === 'x',
                    computerStart: g(row, C.ZONE_COMPUTER) === 'x',
                    treasure: g(row, C.ZONE_TREASURE) === 'x',
                    junction: g(row, C.ZONE_JUNCTION) === 'x',
                    baseSize: g(row, C.ZONE_BASE_SIZE),
                    monsterStrength: g(row, C.ZONE_MONSTER_STRENGTH),
                    ownership: g(row, C.ZONE_OWNERSHIP),
                    townTypes,
                    terrainTypes,
                    treasure1: { low: g(row, C.ZONE_TREASURE1_LOW), high: g(row, C.ZONE_TREASURE1_HIGH), density: g(row, C.ZONE_TREASURE1_DENSITY) },
                    treasure2: { low: g(row, C.ZONE_TREASURE2_LOW), high: g(row, C.ZONE_TREASURE2_HIGH), density: g(row, C.ZONE_TREASURE2_DENSITY) },
                    treasure3: { low: g(row, C.ZONE_TREASURE3_LOW), high: g(row, C.ZONE_TREASURE3_HIGH), density: g(row, C.ZONE_TREASURE3_DENSITY) },
                    minHumanPos: g(row, C.ZONE_MIN_HUMAN_POS),
                    maxHumanPos: g(row, C.ZONE_MAX_HUMAN_POS),
                    imageSettings: g(row, C.ZONE_IMAGE_SETTINGS),
                });
            }

            // Connection row
            if (conn1 && currentMap) {
                currentMap.connections.push({
                    zone1: conn1,
                    zone2: g(row, C.CONN_ZONE2),
                    value: g(row, C.CONN_VALUE),
                    wide: g(row, C.CONN_WIDE),
                    borderGuard: g(row, C.CONN_BORDER_GUARD),
                    road: g(row, C.CONN_ROAD),
                    type: g(row, C.CONN_TYPE),
                    fictive: g(row, C.CONN_FICTIVE)
                });
            }
        }

        return { packs, colNames };
    }

    static toJson(parsed) {
        return JSON.stringify(parsed, null, 2);
    }

    static isH3T(bytes) {
        // H3T files are plain text TSV starting with group header row containing "Pack" or "Field count"
        const s = new TextDecoder('latin1').decode(bytes.slice(0, 200));
        return /^(Pack\t|Town\t|Field count\t)/i.test(s);
    }
}

// Export
window.H3 = {
    LodFile,
    PCX,
    PAL,
    IFR,
    DefFile,
    PakFile,
    SndFile,
    VidFile,
    DDS,
    FNT,
    ZipFile,
    HotaDat,
    H3TParser,
    getFileExtension,
    getFileCategory,
    FileDetectors,
    detectFileType,
    DataView2,
    zlibDecompress,
    gzipDecompress
};
