// ============================================================
// Video Decoders - SMK (Smacker) and BIK (Bink)
// Depends on parsers.js (DataView2, window.H3)
//
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// This file contains algorithms and data tables derived from FFmpeg
// (https://ffmpeg.org), which is licensed under the GNU Lesser General
// Public License version 2.1 or later. The SMK and BIK decoder logic,
// Huffman/bundle structures, DCT coefficients, quantization tables,
// and scan patterns are based on FFmpeg's libavcodec/smacker.c and
// libavcodec/bink.c / libavcodec/binkb.c.
// ============================================================

// ============================================================
// SMK (Smacker) Video Decoder
// ============================================================
const SMK_PAL = new Uint8Array([
    0x00,0x04,0x08,0x0C,0x10,0x14,0x18,0x1C,
    0x20,0x24,0x28,0x2C,0x30,0x34,0x38,0x3C,
    0x41,0x45,0x49,0x4D,0x51,0x55,0x59,0x5D,
    0x61,0x65,0x69,0x6D,0x71,0x75,0x79,0x7D,
    0x82,0x86,0x8A,0x8E,0x92,0x96,0x9A,0x9E,
    0xA2,0xA6,0xAA,0xAE,0xB2,0xB6,0xBA,0xBE,
    0xC3,0xC7,0xCB,0xCF,0xD3,0xD7,0xDB,0xDF,
    0xE3,0xE7,0xEB,0xEF,0xF3,0xF7,0xFB,0xFF
]);

const SMK_BLOCK_RUNS = [
     1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
    49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 128, 256, 512, 1024, 2048
];

class SmkBitReader {
    constructor(data, offset = 0) {
        this.d = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.p = offset;
        this.b = 0;
    }
    bit() {
        if (this.p >= this.d.length) return 0;
        const v = (this.d[this.p] >> this.b) & 1;
        if (++this.b >= 8) { this.b = 0; this.p++; }
        return v;
    }
    bits(n) {
        let val = 0, shift = 0;
        while (n > 0) {
            if (this.p >= this.d.length) break;
            const avail = 8 - this.b;
            const take = Math.min(n, avail);
            val |= ((this.d[this.p] >> this.b) & ((1 << take) - 1)) << shift;
            shift += take; n -= take; this.b += take;
            if (this.b >= 8) { this.b = 0; this.p++; }
        }
        return val;
    }
    skip() { if (++this.b >= 8) { this.b = 0; this.p++; } }
}

class SmackerDecoder {
    static async decode(data, onProgress) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        const r = new DataView2(u8);

        const magic = r.readUint32LE();
        const m3 = (magic >> 24) & 0xFF;
        if ((magic & 0xFFFFFF) !== 0x4B4D53 || (m3 !== 0x32 && m3 !== 0x34))
            throw new Error('Not a valid SMK file');
        const isSMK4 = m3 === 0x34;

        const width = r.readUint32LE();
        const height = r.readUint32LE();
        let nframes = r.readUint32LE();
        const ptsInc = r.readInt32LE();
        const flags = r.readUint32LE();
        if (flags & 1) nframes++;

        let frameDuration;
        if (ptsInc < 0) frameDuration = -ptsInc / 100;
        else if (ptsInc > 0) frameDuration = ptsInc;
        else frameDuration = 1000 / 15;
        const fps = 1000 / frameDuration;

        r.readBytes(28);
        const treesize = r.readUint32LE();
        const treeSizes = [r.readUint32LE(), r.readUint32LE(), r.readUint32LE(), r.readUint32LE()];

        const audioTracks = [];
        for (let i = 0; i < 7; i++) {
            const rate = r.readUint16LE() | (r.readUint8() << 16);
            audioTracks.push({ rate, flags: r.readUint8() });
        }
        r.readUint32LE();

        const frameSizes = new Uint32Array(nframes);
        for (let i = 0; i < nframes; i++) frameSizes[i] = r.readUint32LE();
        const frameFlags = new Uint8Array(nframes);
        for (let i = 0; i < nframes; i++) frameFlags[i] = r.readUint8();
        const treeData = r.readBytes(treesize);
        const dataOffset = r.tell();

        const trees = SmackerDecoder._buildTrees(treeData, treeSizes);

        const frameBuffer = new Uint8Array(width * height);
        const palette = new Uint8Array(768);
        const indexedFrames = [];
        const palettes = [];
        const audioChunks = [];

        let pos = dataOffset;
        for (let f = 0; f < nframes; f++) {
            const fsize = frameSizes[f] & ~3;
            r.seek(pos);
            let rem = fsize;
            const ff = frameFlags[f];

            if (ff & 1) rem = SmackerDecoder._decodePalette(r, palette, rem);

            const af = ff >> 1;
            for (let t = 0; t < 7; t++) {
                if (af & (1 << t)) {
                    const asize = r.readUint32LE();
                    rem -= asize;
                    if (t === 0 && audioTracks[0].rate && asize > 4) {
                        const payload = r.readBytes(asize - 4);
                        if (audioTracks[0].flags & 0x80) {
                            audioChunks.push(SmackerDecoder._decodeAudio(payload));
                        } else {
                            const is16 = !!(audioTracks[0].flags & 0x20);
                            audioChunks.push(is16
                                ? new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1)
                                : payload);
                        }
                    } else {
                        r.readBytes(Math.max(0, asize - 4));
                    }
                }
            }

            SmackerDecoder._decodeVideoFrame(r, rem, frameBuffer, width, height, trees, isSMK4);

            indexedFrames.push(new Uint8Array(frameBuffer));
            palettes.push(new Uint8Array(palette));

            pos += fsize;
            if (onProgress && f % 5 === 0) {
                onProgress(f / nframes);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        let audio = null;
        if (audioChunks.length > 0 && audioTracks[0].rate) {
            const is16 = !!(audioTracks[0].flags & 0x20);
            const isStereo = !!(audioTracks[0].flags & 0x10);
            let totalLen = 0;
            for (const c of audioChunks) totalLen += c.length;
            const combined = is16 ? new Int16Array(totalLen) : new Uint8Array(totalLen);
            let off = 0;
            for (const c of audioChunks) { combined.set(c, off); off += c.length; }
            audio = { samples: combined, sampleRate: audioTracks[0].rate, channels: isStereo ? 2 : 1, bitsPerSample: is16 ? 16 : 8 };
        }

        return { width, height, fps, frameDuration, nframes, indexedFrames, palettes, audio, isSMK4 };
    }

    static _buildTrees(treeData, sizes) {
        const bits = new SmkBitReader(treeData);
        const trees = [];
        for (let i = 0; i < 4; i++) {
            if (!bits.bit()) {
                trees.push({ values: new Int32Array(2), last: [1, 1, 1] });
            } else {
                trees.push(SmackerDecoder._decodeHeaderTree(bits, sizes[i]));
            }
        }
        return trees;
    }

    static _decodeHeaderTree(bits, size) {
        const subs = [null, null], vals = [0, 0];
        for (let i = 0; i < 2; i++) {
            if (!bits.bit()) { vals[i] = 0; continue; }
            subs[i] = SmackerDecoder._decodeSmallTree(bits, 0);
            bits.skip();
        }
        const esc = [bits.bits(16), bits.bits(16), bits.bits(16)];
        const maxLen = ((size + 3) >> 2) + 3;
        const values = new Int32Array(maxLen);
        const last = [-1, -1, -1];
        let cur = 0;
        (function build(depth) {
            if (depth > 500 || cur >= maxLen) return;
            if (!bits.bit()) {
                const i1 = subs[0] !== null ? SmackerDecoder._readSmallTree(bits, subs[0]) : vals[0];
                const i2 = subs[1] !== null ? SmackerDecoder._readSmallTree(bits, subs[1]) : vals[1];
                let v = i1 | (i2 << 8);
                if (v === esc[0]) { last[0] = cur; v = 0; }
                else if (v === esc[1]) { last[1] = cur; v = 0; }
                else if (v === esc[2]) { last[2] = cur; v = 0; }
                values[cur++] = v;
            } else {
                const t = cur++;
                build(depth + 1);
                values[t] = (0x80000000 | (cur - t - 1)) | 0;
                build(depth + 1);
            }
        })(0);
        bits.skip();
        if (last[0] === -1) last[0] = cur++;
        if (last[1] === -1) last[1] = cur++;
        if (last[2] === -1) last[2] = cur++;
        return { values, last };
    }

    static _decodeSmallTree(bits, depth) {
        if (depth > 30 || !bits.bit()) return bits.bits(8);
        return [SmackerDecoder._decodeSmallTree(bits, depth + 1), SmackerDecoder._decodeSmallTree(bits, depth + 1)];
    }

    static _readSmallTree(bits, tree) {
        while (Array.isArray(tree)) tree = bits.bit() ? tree[1] : tree[0];
        return tree;
    }

    static _smkGetCode(bits, tree) {
        const v = tree.values, l = tree.last;
        let i = 0;
        while (v[i] < 0) {
            if (bits.bit()) i += v[i] & 0x7FFFFFFF;
            i++;
        }
        const val = v[i];
        if (val !== v[l[0]]) { v[l[2]] = v[l[1]]; v[l[1]] = v[l[0]]; v[l[0]] = val; }
        return val;
    }

    static _lastReset(t) {
        t.values[t.last[0]] = t.values[t.last[1]] = t.values[t.last[2]] = 0;
    }

    static _decodePalette(r, pal, remaining) {
        const old = new Uint8Array(pal);
        let size = r.readUint8() * 4;
        remaining -= size;
        size--;
        let sz = 0, pi = 0, rd = 0;
        while (sz < 256 && rd < size) {
            const t = r.readUint8(); rd++;
            if (t & 0x80) {
                const skip = (t & 0x7F) + 1;
                sz += skip; pi += skip * 3;
            } else if (t & 0x40) {
                const off = r.readUint8(); rd++;
                let cnt = (t & 0x3F) + 1, src = off * 3;
                while (cnt-- > 0 && sz < 256) {
                    pal[pi++] = old[src++]; pal[pi++] = old[src++]; pal[pi++] = old[src++]; sz++;
                }
            } else {
                pal[pi++] = SMK_PAL[t];
                pal[pi++] = SMK_PAL[r.readUint8() & 0x3F];
                pal[pi++] = SMK_PAL[r.readUint8() & 0x3F];
                rd += 2; sz++;
            }
        }
        if (rd < size) r.readBytes(size - rd);
        return remaining;
    }

    static _decodeVideoFrame(r, remaining, fb, w, h, trees, isSMK4) {
        if (remaining <= 0) return;
        const data = r.readBytes(remaining);
        const bits = new SmkBitReader(data);
        const [mmap, mclr, full, type] = trees;
        SmackerDecoder._lastReset(mmap);
        SmackerDecoder._lastReset(mclr);
        SmackerDecoder._lastReset(full);
        SmackerDecoder._lastReset(type);

        const bw = w >> 2, blocks = (w >> 2) * (h >> 2);
        let blk = 0;
        while (blk < blocks) {
            const t = SmackerDecoder._smkGetCode(bits, type);
            let run = SMK_BLOCK_RUNS[(t >> 2) & 0x3F];
            switch (t & 3) {
                case 0: // MONO
                    while (run-- > 0 && blk < blocks) {
                        const clr = SmackerDecoder._smkGetCode(bits, mclr);
                        let map = SmackerDecoder._smkGetCode(bits, mmap);
                        const bx = (blk % bw) * 4, by = (blk / bw | 0) * 4;
                        const hi = (clr >> 8) & 0xFF, lo = clr & 0xFF;
                        for (let row = 0; row < 4; row++) {
                            const o = (by + row) * w + bx;
                            fb[o] = (map & 1) ? hi : lo; fb[o+1] = (map & 2) ? hi : lo;
                            fb[o+2] = (map & 4) ? hi : lo; fb[o+3] = (map & 8) ? hi : lo;
                            map >>= 4;
                        }
                        blk++;
                    }
                    break;
                case 1: { // FULL
                    let mode = 0;
                    if (isSMK4) { if (bits.bit()) mode = 1; else if (bits.bit()) mode = 2; }
                    while (run-- > 0 && blk < blocks) {
                        const bx = (blk % bw) * 4, by = (blk / bw | 0) * 4;
                        if (mode === 0) {
                            for (let row = 0; row < 4; row++) {
                                const o = (by + row) * w + bx;
                                let p = SmackerDecoder._smkGetCode(bits, full);
                                fb[o+2] = p & 0xFF; fb[o+3] = (p >> 8) & 0xFF;
                                p = SmackerDecoder._smkGetCode(bits, full);
                                fb[o] = p & 0xFF; fb[o+1] = (p >> 8) & 0xFF;
                            }
                        } else if (mode === 1) {
                            let p = SmackerDecoder._smkGetCode(bits, full);
                            for (let row = 0; row < 2; row++) {
                                const o = (by + row) * w + bx;
                                fb[o] = fb[o+1] = p & 0xFF; fb[o+2] = fb[o+3] = (p >> 8) & 0xFF;
                            }
                            p = SmackerDecoder._smkGetCode(bits, full);
                            for (let row = 2; row < 4; row++) {
                                const o = (by + row) * w + bx;
                                fb[o] = fb[o+1] = p & 0xFF; fb[o+2] = fb[o+3] = (p >> 8) & 0xFF;
                            }
                        } else {
                            for (let i = 0; i < 2; i++) {
                                const p2 = SmackerDecoder._smkGetCode(bits, full);
                                const p1 = SmackerDecoder._smkGetCode(bits, full);
                                for (let row = 0; row < 2; row++) {
                                    const o = (by + i * 2 + row) * w + bx;
                                    fb[o] = p1 & 0xFF; fb[o+1] = (p1 >> 8) & 0xFF;
                                    fb[o+2] = p2 & 0xFF; fb[o+3] = (p2 >> 8) & 0xFF;
                                }
                            }
                        }
                        blk++;
                    }
                    break;
                }
                case 2: // SKIP
                    while (run-- > 0 && blk < blocks) blk++;
                    break;
                case 3: { // FILL
                    const c = (t >> 8) & 0xFF;
                    while (run-- > 0 && blk < blocks) {
                        const bx = (blk % bw) * 4, by = (blk / bw | 0) * 4;
                        for (let row = 0; row < 4; row++) {
                            const o = (by + row) * w + bx;
                            fb[o] = fb[o+1] = fb[o+2] = fb[o+3] = c;
                        }
                        blk++;
                    }
                    break;
                }
            }
        }
    }

    static _decodeAudio(payload) {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const unpSize = view.getUint32(0, true);
        const bits = new SmkBitReader(payload, 4);

        if (!bits.bit()) return new Int16Array(0);
        const stereo = bits.bit();
        const is16 = bits.bit();
        const nTrees = 1 << (is16 + stereo);
        const trees = [], tVals = [];
        for (let i = 0; i < nTrees; i++) {
            bits.skip();
            const tree = SmackerDecoder._decodeSmallTree(bits, 0);
            bits.skip();
            trees.push(tree);
            tVals.push(typeof tree === 'number' ? tree : null);
        }
        const channels = stereo + 1;
        if (is16) {
            const nSamples = unpSize >> 1;
            const samples = new Int16Array(nSamples);
            const pred = new Array(channels);
            for (let ch = stereo; ch >= 0; ch--) {
                const v = bits.bits(16);
                pred[ch] = ((v >> 8) & 0xFF) | ((v & 0xFF) << 8);
            }
            for (let ch = 0; ch <= stereo; ch++)
                samples[ch] = pred[ch] >= 32768 ? pred[ch] - 65536 : pred[ch];
            for (let i = stereo + 1; i < nSamples; i++) {
                const idx = 2 * (i & stereo);
                const lo = tVals[idx] !== null ? tVals[idx] : SmackerDecoder._readSmallTree(bits, trees[idx]);
                const hi = tVals[idx+1] !== null ? tVals[idx+1] : SmackerDecoder._readSmallTree(bits, trees[idx+1]);
                const ch = stereo ? (idx >> 1) : 0;
                pred[ch] = (pred[ch] + (lo | (hi << 8))) & 0xFFFF;
                samples[i] = pred[ch] >= 32768 ? pred[ch] - 65536 : pred[ch];
            }
            return samples;
        } else {
            const samples = new Uint8Array(unpSize);
            const pred = new Array(channels);
            for (let ch = stereo; ch >= 0; ch--) pred[ch] = bits.bits(8);
            for (let ch = 0; ch <= stereo; ch++) samples[ch] = pred[ch];
            for (let i = stereo + 1; i < unpSize; i++) {
                const idx = i & stereo;
                const val = tVals[idx] !== null ? tVals[idx] : SmackerDecoder._readSmallTree(bits, trees[idx]);
                pred[idx] = (pred[idx] + val) & 0xFF;
                samples[i] = pred[idx];
            }
            return samples;
        }
    }
}

// ============================================================
// BIK (Bink) Header Parser (metadata only, no video/audio decode)
// ============================================================
class BinkHeader {
    static parse(data) {
        const r = new DataView2(data);
        const tag = r.readUint32LE();
        const sig = tag & 0xFFFFFF;
        // 'BIK' = 0x4B4942, 'KB2' = 0x32424B
        if (sig !== 0x4B4942 && sig !== 0x32424B)
            throw new Error('Not a valid BIK file');
        const fileSize = r.readUint32LE() + 8;
        const nframes = r.readUint32LE();
        r.readUint32LE(); // largest frame
        r.readUint32LE(); // skip
        const width = r.readUint32LE();
        const height = r.readUint32LE();
        const fpsNum = r.readUint32LE();
        const fpsDen = r.readUint32LE();
        const fps = fpsDen > 0 ? fpsNum / fpsDen : 0;
        r.readUint32LE(); // video flags
        const numAudioTracks = r.readUint32LE();
        const audioTracks = [];
        if (numAudioTracks > 0 && numAudioTracks <= 256) {
            const revision = (tag >> 24) & 0xFF;
            if ((sig === 0x4B4942 && revision === 0x6B) ||
                (sig === 0x32424B && (revision === 0x69 || revision === 0x6A || revision === 0x6B)))
                r.readUint32LE();
            r.readBytes(numAudioTracks * 4);
            for (let i = 0; i < numAudioTracks; i++) {
                const sampleRate = r.readUint16LE();
                const fl = r.readUint16LE();
                audioTracks.push({ sampleRate, stereo: !!(fl & 0x2000), useDCT: !!(fl & 0x1000) });
            }
        }
        return { width, height, fps, nframes, fileSize, audioTracks };
    }
}

// ============================================================
// BIK (Bink) Full Decoder - Audio + Video (version b)
// ============================================================
const _BINK_RDFT_WMA_CRITICAL_FREQS = [
    100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270,
    1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400,
    7700, 9500, 12000, 15500, 24500
];

const _BINK_RLE_LENS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 32, 64];

class BinkBitReader {
    constructor(data, offset = 0) {
        this.d = data instanceof Uint8Array ? data : new Uint8Array(data);
        this._pos = offset * 8; // bit position
        this._len = this.d.length;
        // Build a DataView for fast 32-bit reads
        // Pad to avoid OOB on last reads (need 8 for cross-boundary 32-bit reads)
        const padded = new Uint8Array(this.d.length + 8);
        padded.set(this.d);
        this._dv = new DataView(padded.buffer);
    }
    bit() {
        const bytePos = this._pos >> 3;
        if (bytePos >= this._len) return 0;
        const v = (this.d[bytePos] >> (this._pos & 7)) & 1;
        this._pos++;
        return v;
    }
    bits(n) {
        if (n === 0) return 0;
        const bytePos = this._pos >> 3;
        if (bytePos >= this._len) return 0;
        const bitOff = this._pos & 7;
        this._pos += n;
        if (n + bitOff <= 32) {
            const raw = this._dv.getUint32(bytePos, true) >>> bitOff;
            if (n >= 32) return raw >>> 0;
            return (raw & ((1 << n) - 1)) >>> 0;
        }
        // Need more than 32 bits from the buffer (crosses a 32-bit boundary)
        const lo = this._dv.getUint32(bytePos, true) >>> bitOff;
        const hi = this._dv.getUint32(bytePos + 4, true);
        const combined = lo | (hi << (32 - bitOff));
        if (n >= 32) return combined >>> 0;
        return (combined & ((1 << n) - 1)) >>> 0;
    }
    bitsUsed() { return this._pos; }
    bitsLeft(totalBits) { return totalBits - this._pos; }
    alignTo32() {
        const n = (32 - (this._pos & 31)) & 31;
        this._pos += n;
    }
    // legacy accessors for compatibility
    get p() { return this._pos >> 3; }
    get b() { return this._pos & 7; }
}

class BinkDecoder {
    static async decode(data, onProgress) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        const r = new DataView2(u8);

        // Parse header
        const tag = r.readUint32LE();
        const sig = tag & 0xFFFFFF;
        if (sig !== 0x4B4942) throw new Error('Not a valid BIK file (only Bink 1 supported)');
        const version = String.fromCharCode((tag >> 24) & 0xFF);
        const fileSize = r.readUint32LE() + 8;
        const nframes = r.readUint32LE();
        const largestFrame = r.readUint32LE();
        r.readUint32LE(); // skip
        const width = r.readUint32LE();
        const height = r.readUint32LE();
        const fpsNum = r.readUint32LE();
        const fpsDen = r.readUint32LE();
        const fps = fpsDen > 0 ? fpsNum / fpsDen : 15;
        const frameDuration = fpsDen > 0 ? 1000 * fpsDen / fpsNum : 1000 / 15;
        const videoFlags = r.readUint32LE();
        const hasAlpha = !!(videoFlags & 0x00100000);
        const numAudioTracks = r.readUint32LE();

        const audioTracks = [];
        if (numAudioTracks > 0 && numAudioTracks <= 256) {
            if (version === 'k') r.readUint32LE();
            r.readBytes(numAudioTracks * 4); // max decoded sizes
            for (let i = 0; i < numAudioTracks; i++) {
                const sampleRate = r.readUint16LE();
                const fl = r.readUint16LE();
                audioTracks.push({
                    sampleRate,
                    stereo: !!(fl & 0x2000),
                    useDCT: !!(fl & 0x1000),
                    is16bit: !!(fl & 0x4000),
                    flags: fl
                });
            }
            r.readBytes(numAudioTracks * 4); // track IDs
        }

        // Frame index table
        const frameOffsets = new Uint32Array(nframes + 1);
        const frameKeyflags = new Uint8Array(nframes + 1);
        for (let i = 0; i <= nframes; i++) {
            const val = r.readUint32LE();
            frameKeyflags[i] = val & 1;
            frameOffsets[i] = val & ~1;
        }

        // Initialize audio decoder if audio track 0 exists
        let audioDecoder = null;
        if (audioTracks.length > 0 && audioTracks[0].sampleRate > 0) {
            audioDecoder = new BinkAudioDecoder(audioTracks[0], version);
        }

        // Initialize video decoder
        const numPlanes = hasAlpha ? 4 : 3;
        const planes = [];
        const lastPlanes = [];
        for (let p = 0; p < numPlanes; p++) {
            const pw = p > 0 && p < 3 ? ((width + 1) >> 1) : width;
            const ph = p > 0 && p < 3 ? ((height + 1) >> 1) : height;
            const plane = new Uint8Array(pw * ph);
            const lastPlane = new Uint8Array(pw * ph);
            // Initialize chroma planes to 128 (neutral) so undecoded areas
            // appear black instead of green (YUV 0,0,0 = green in BT.601)
            if (p === 1 || p === 2) { plane.fill(128); lastPlane.fill(128); }
            planes.push(plane);
            lastPlanes.push(lastPlane);
        }

        const rgbaFrames = [];
        const audioChunks = [];

        for (let f = 0; f < nframes; f++) {
            const frameStart = frameOffsets[f];
            const frameEnd = frameOffsets[f + 1] || fileSize;
            let pos = frameStart;

            // Read audio for each track
            for (let t = 0; t < numAudioTracks; t++) {
                if (pos + 4 > frameEnd) break;
                const audioSize = new DataView(u8.buffer, u8.byteOffset + pos, 4).getUint32(0, true);
                pos += 4;
                if (t === 0 && audioDecoder && audioSize >= 4) {
                    const audioData = u8.subarray(pos, pos + audioSize);
                    const decoded = audioDecoder.decodeBlock(audioData);
                    if (decoded) audioChunks.push(decoded);
                } 
                pos += audioSize;
            }

            // Video data is the rest
            const videoData = u8.subarray(pos, frameEnd);
            const isKey = !!(frameKeyflags[f]);

            try {
                BinkDecoder._decodeVideoFrame(videoData, planes, lastPlanes, width, height, version, isKey, f === 0, hasAlpha);
            } catch (e) {
                // On decode error, keep previous frame
            }

            // Convert YUV to RGBA
            const rgba = BinkDecoder._yuvToRgba(planes, width, height, version, hasAlpha);
            rgbaFrames.push(rgba);

            // Copy current to last
            for (let p = 0; p < numPlanes; p++) {
                lastPlanes[p].set(planes[p]);
            }

            if (onProgress && f % 30 === 0) {
                onProgress(f / nframes);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // Build combined audio
        let audio = null;
        if (audioChunks.length > 0 && audioDecoder) {
            let totalLen = 0;
            for (const c of audioChunks) totalLen += c.length;
            const combined = new Float32Array(totalLen);
            let off = 0;
            for (const c of audioChunks) { combined.set(c, off); off += c.length; }

            // Convert interleaved float to int16 for WAV
            const channels = audioTracks[0].stereo ? 2 : 1;
            const int16 = new Int16Array(combined.length);
            for (let i = 0; i < combined.length; i++) {
                let s = Math.round(combined[i] * 32767);
                if (s > 32767) s = 32767;
                if (s < -32768) s = -32768;
                int16[i] = s;
            }

            audio = {
                samples: int16,
                sampleRate: audioTracks[0].sampleRate,
                channels: channels,
                bitsPerSample: 16
            };
        }

        return { width, height, fps, frameDuration, nframes, rgbaFrames, audio, version, hasAlpha };
    }

    static _decodeVideoFrame(data, planes, lastPlanes, width, height, version, isKey, isFirst, hasAlpha) {
        if (data.length < 4) return;
        const bits = new BinkBitReader(data);
        const totalBits = data.length * 8;
        const numPlanes = hasAlpha ? 4 : 3;
        const swapPlanes = version >= 'h';

        // For version 'b', FFmpeg uses ff_reget_buffer so dst starts with previous frame data.
        // Copy lastPlanes into planes so SKIP blocks and motion vectors referencing dst work correctly.
        if (version <= 'b') {
            for (let p = 0; p < numPlanes; p++) {
                planes[p].set(lastPlanes[p]);
            }
        }

        // Version >= 'i': skip 32-bit flags word before planes
        if (version >= 'i') bits.bits(32);

        // Decode each plane
        for (let plane = 0; plane < 3; plane++) {
            const planeIdx = (!plane || !swapPlanes) ? plane : (plane ^ 3);
            const isChroma = (planeIdx > 0 && planeIdx < 3);
            const pw = isChroma ? ((width + 1) >> 1) : width;
            const ph = isChroma ? ((height + 1) >> 1) : height;

            if (version > 'b') {
                // Bink versions > 'b' use different decoder
                BinkDecoder._binkDecodePlane(bits, planes[planeIdx], lastPlanes[planeIdx], pw, ph, isChroma, version, totalBits);
            } else {
                BinkDecoder._binkbDecodePlane(bits, planes[planeIdx], lastPlanes[planeIdx], pw, ph, isChroma, isKey || isFirst, totalBits);
            }

            if (bits.bitsUsed() >= totalBits) break;
        }
    }

    // Bink version 'b' plane decoder
    static _binkbDecodePlane(bits, dst, prev, width, height, isChroma, isKey, totalBits) {
        const stride = width;
        const bw = (width + 7) >> 3;
        const bh = (height + 7) >> 3;
        const ybias = isKey ? -15 : 0;

        // Bundle state using typed arrays for performance
        const bundleSize = bw * bh * 64;
        const bundles_data = new Array(10);
        const bundles_curDec = new Int32Array(10);
        const bundles_curPtr = new Int32Array(10);
        const bundles_cleared = new Uint8Array(10);
        for (let i = 0; i < 10; i++) {
            bundles_data[i] = new Int32Array(bundleSize);
        }

        const coordmap = new Array(64);
        for (let i = 0; i < 64; i++) {
            coordmap[i] = (i & 7) + (i >> 3) * stride;
        }

        const BINKB_SRC_BLOCK_TYPES = 0;
        const BINKB_SRC_COLORS = 1;
        const BINKB_SRC_PATTERN = 2;
        const BINKB_SRC_X_OFF = 3;
        const BINKB_SRC_Y_OFF = 4;
        const BINKB_SRC_INTRA_DC = 5;
        const BINKB_SRC_INTER_DC = 6;
        const BINKB_SRC_INTRA_Q = 7;
        const BINKB_SRC_INTER_Q = 8;
        const BINKB_SRC_INTER_COEFS = 9;

        const binkb_bundle_sizes = [4, 8, 8, 5, 5, 11, 11, 4, 4, 7];
        const binkb_bundle_signed = [0, 0, 0, 1, 1, 0, 1, 0, 0, 0];

        // FFmpeg-compatible bundle reading: only reads new data if previous batch consumed
        function readBundle(bundleNum) {
            if (bundles_cleared[bundleNum] || bundles_curDec[bundleNum] > bundles_curPtr[bundleNum]) return;

            const bundleBits = binkb_bundle_sizes[bundleNum];
            const mask = 1 << (bundleBits - 1);
            const signed = binkb_bundle_signed[bundleNum];
            const len = bits.bits(13);
            if (!len) { bundles_cleared[bundleNum] = 1; return; }
            const bd = bundles_data[bundleNum];
            let dec = bundles_curDec[bundleNum];
            for (let i = 0; i < len; i++) {
                let v = bits.bits(bundleBits);
                if (signed) v = v - mask;
                if (dec < bundleSize) bd[dec++] = v;
            }
            bundles_curDec[bundleNum] = dec;
        }

        function getBundle(bundleNum) {
            if (bundles_curPtr[bundleNum] >= bundles_curDec[bundleNum]) return 0;
            return bundles_data[bundleNum][bundles_curPtr[bundleNum]++];
        }

        const dctblock = new Int32Array(64);
        const block16 = new Int16Array(64);

        for (let by = 0; by < bh; by++) {
            // Read all bundles for this row
            for (let i = 0; i < 10; i++) {
                readBundle(i);
            }

            for (let bx = 0; bx < bw; bx++) {
                const blkType = getBundle(BINKB_SRC_BLOCK_TYPES);
                const dstOff = by * 8 * stride + bx * 8;

                switch (blkType) {
                    case 0: // SKIP - dst already has previous frame data
                        break;

                    case 1: { // RUN
                        const scanIdx = bits.bits(4);
                        const scan = _BINK_PATTERNS[scanIdx];
                        let i = 0, si = 0;
                        do {
                            const mode = bits.bit();
                            const run = bits.bits(_BINKB_RUNBITS[i]) + 1;
                            i += run;
                            if (i > 64) break;
                            if (mode) {
                                const v = getBundle(BINKB_SRC_COLORS);
                                for (let j = 0; j < run; j++)  {
                                    const pos = dstOff + coordmap[scan[si++]];
                                    if (pos < dst.length) dst[pos] = v & 0xFF;
                                }
                            } else {
                                for (let j = 0; j < run; j++) {
                                    const v = getBundle(BINKB_SRC_COLORS);
                                    const pos = dstOff + coordmap[scan[si++]];
                                    if (pos < dst.length) dst[pos] = v & 0xFF;
                                }
                            }
                        } while (i < 63);
                        if (i === 63) {
                            const v = getBundle(BINKB_SRC_COLORS);
                            const pos = dstOff + coordmap[scan[si]];
                            if (pos < dst.length) dst[pos] = v & 0xFF;
                        }
                        break;
                    }

                    case 2: { // INTRA (DCT)
                        dctblock.fill(0);
                        dctblock[0] = getBundle(BINKB_SRC_INTRA_DC);
                        const qp = getBundle(BINKB_SRC_INTRA_Q);
                        const { coefIdx: ci } = BinkDecoder._readDctCoeffs(bits, dctblock, qp);
                        BinkDecoder._unquantizeDctCoeffs(dctblock, ci, qp, _BINKB_INTRA_QUANT);
                        BinkDecoder._binkIdctPut(dst, dstOff, stride, dctblock);
                        break;
                    }

                    case 3: { // MOTION + RESIDUE
                        const xoff = getBundle(BINKB_SRC_X_OFF);
                        const yoff = getBundle(BINKB_SRC_Y_OFF) + ybias;
                        // Copy from current frame with offset (may overlap)
                        BinkDecoder._copyBlock(dst, dstOff, stride, dst, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        // Add residue
                        block16.fill(0);
                        const ncoefs = getBundle(BINKB_SRC_INTER_COEFS);
                        BinkDecoder._readResidue(bits, block16, ncoefs);
                        for (let row = 0; row < 8; row++) {
                            for (let col = 0; col < 8; col++) {
                                const pos = dstOff + row * stride + col;
                                if (pos < dst.length) {
                                    let v = dst[pos] + block16[row * 8 + col];
                                    dst[pos] = v < 0 ? 0 : v > 255 ? 255 : v;
                                }
                            }
                        }
                        break;
                    }

                    case 4: { // INTER (MOTION + DCT)
                        const xoff = getBundle(BINKB_SRC_X_OFF);
                        const yoff = getBundle(BINKB_SRC_Y_OFF) + ybias;
                        BinkDecoder._copyBlock(dst, dstOff, stride, dst, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        dctblock.fill(0);
                        dctblock[0] = getBundle(BINKB_SRC_INTER_DC);
                        const qp2 = getBundle(BINKB_SRC_INTER_Q);
                        const { coefIdx: ci2 } = BinkDecoder._readDctCoeffs(bits, dctblock, qp2);
                        BinkDecoder._unquantizeDctCoeffs(dctblock, ci2, qp2, _BINKB_INTER_QUANT);
                        BinkDecoder._binkIdctAdd(dst, dstOff, stride, dctblock);
                        break;
                    }

                    case 5: { // FILL
                        const v = getBundle(BINKB_SRC_COLORS) & 0xFF;
                        for (let row = 0; row < 8; row++) {
                            for (let col = 0; col < 8; col++) {
                                const pos = dstOff + row * stride + col;
                                if (pos < dst.length) dst[pos] = v;
                            }
                        }
                        break;
                    }

                    case 6: { // PATTERN
                        const col0 = getBundle(BINKB_SRC_COLORS) & 0xFF;
                        const col1 = getBundle(BINKB_SRC_COLORS) & 0xFF;
                        for (let row = 0; row < 8; row++) {
                            let pat = getBundle(BINKB_SRC_PATTERN);
                            for (let col = 0; col < 8; col++) {
                                const pos = dstOff + row * stride + col;
                                if (pos < dst.length) dst[pos] = (pat & 1) ? col1 : col0;
                                pat >>= 1;
                            }
                        }
                        break;
                    }

                    case 7: { // MOTION (no residue)
                        const xoff = getBundle(BINKB_SRC_X_OFF);
                        const yoff = getBundle(BINKB_SRC_Y_OFF) + ybias;
                        BinkDecoder._copyBlock(dst, dstOff, stride, dst, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        break;
                    }

                    case 8: { // RAW
                        for (let row = 0; row < 8; row++) {
                            for (let col = 0; col < 8; col++) {
                                const pos = dstOff + row * stride + col;
                                if (pos < dst.length) dst[pos] = getBundle(BINKB_SRC_COLORS) & 0xFF;
                            }
                        }
                        break;
                    }

                    default:
                        // Unknown block type, skip
                        break;
                }
            }
        }

        // Align to 32-bit boundary
        bits.alignTo32();
    }

    // Bink versions > 'b' plane decoder (proper Huffman tree bundle reading)
    static _binkDecodePlane(bits, dst, prev, width, height, isChroma, version, totalBits) {
        const stride = width;
        const bw = (width + 7) >> 3;
        const bh = (height + 7) >> 3;

        // Version 'k' fill check
        if (version === 'k' && bits.bit()) {
            dst.fill(bits.bits(8));
            bits.alignTo32();
            return;
        }

        const coordmap = new Array(64);
        for (let i = 0; i < 64; i++)
            coordmap[i] = (i & 7) + (i >> 3) * stride;

        // Bundle type indices (matching FFmpeg enum Sources)
        const BLOCK_TYPES = 0, SUB_BLOCK_TYPES = 1, COLORS = 2, PATTERN = 3,
              X_OFF = 4, Y_OFF = 5, INTRA_DC = 6, INTER_DC = 7, RUN = 8;
        const NB_SRC = 9;

        // Compute bundle length bits: av_log2(x) + 1
        const avLog2p1 = x => { let n = 0; while ((1 << n) <= x) n++; return n; };
        const widthAligned = (width + 7) & ~7;
        const lenBitsArr = [
            avLog2p1((widthAligned >> 3) + 511),  // BLOCK_TYPES
            avLog2p1((widthAligned >> 4) + 511),  // SUB_BLOCK_TYPES
            avLog2p1(bw * 64 + 511),              // COLORS
            avLog2p1((bw << 3) + 511),            // PATTERN
            avLog2p1((widthAligned >> 3) + 511),  // X_OFF
            avLog2p1((widthAligned >> 3) + 511),  // Y_OFF
            avLog2p1((widthAligned >> 3) + 511),  // INTRA_DC
            avLog2p1((widthAligned >> 3) + 511),  // INTER_DC
            avLog2p1(bw * 48 + 511),              // RUN
        ];

        const bundleSize = bw * bh * 64 + 4096;
        const bundles = [];
        for (let i = 0; i < NB_SRC; i++) {
            bundles.push({
                data: new Int32Array(bundleSize),
                ptr: 0,
                end: 0,
                lenBits: lenBitsArr[i],
                tree: null
            });
        }

        // Color high nibble trees (16 trees for COLORS)
        const colHigh = new Array(16);
        let colLastval = 0;

        // --- Huffman tree reading ---
        function mergeSort(mdst, dstOff, src, srcOff, halfSize) {
            let i1 = 0, i2 = 0, d = dstOff;
            const src2 = srcOff + halfSize;
            while (true) {
                if (!bits.bit()) {
                    mdst[d++] = src[srcOff + i1++];
                    if (i1 === halfSize) { while (i2 < halfSize) mdst[d++] = src[src2 + i2++]; return; }
                } else {
                    mdst[d++] = src[src2 + i2++];
                    if (i2 === halfSize) { while (i1 < halfSize) mdst[d++] = src[srcOff + i1++]; return; }
                }
            }
        }

        function readTree() {
            const syms = new Uint8Array(16);
            const vlcNum = bits.bits(4);
            if (!vlcNum) {
                for (let i = 0; i < 16; i++) syms[i] = i;
                return { syms, vlcNum };
            }
            if (bits.bit()) {
                const used = new Uint8Array(16);
                let len = bits.bits(3);
                for (let i = 0; i <= len; i++) { syms[i] = bits.bits(4); used[syms[i]] = 1; }
                for (let i = 0; i < 16 && len < 15; i++) { if (!used[i]) syms[++len] = i; }
            } else {
                let a = new Uint8Array(16), b = new Uint8Array(16);
                for (let i = 0; i < 16; i++) a[i] = i;
                const rounds = bits.bits(2);
                for (let r = 0; r <= rounds; r++) {
                    const sz = 1 << r;
                    for (let t = 0; t < 16; t += sz << 1) mergeSort(b, t, a, t, sz);
                    const tmp = a; a = b; b = tmp;
                }
                syms.set(a);
            }
            return { syms, vlcNum };
        }

        function getHuff(tree) {
            const vlc = _BINK_VLC_TABLES[tree.vlcNum];
            const peek = bits.bits(vlc.maxBits);
            const entry = vlc.table[peek];
            bits._pos -= vlc.maxBits - (entry & 0xF);
            return tree.syms[entry >> 4];
        }

        // --- read_bundle: initialize all bundles (once per plane) ---
        for (let i = 0; i < NB_SRC; i++) {
            if (i === COLORS) {
                for (let j = 0; j < 16; j++) colHigh[j] = readTree();
                colLastval = 0;
            }
            if (i !== INTRA_DC && i !== INTER_DC) {
                bundles[i].tree = readTree();
            }
            bundles[i].ptr = bundles[i].end = 0;
        }

        // --- Per-row bundle reading functions ---
        function readBlockTypes(bIdx) {
            const bu = bundles[bIdx];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            let len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            if (version === 'k') {
                len ^= 0xBB;
                if (!len) { bu.end = -1; return; }
            }
            bu.ptr = 0;
            if (bits.bit()) {
                const v = bits.bits(4);
                for (let i = 0; i < len; i++) bu.data[i] = v;
            } else {
                let idx = 0, last = 0;
                while (idx < len) {
                    const v = getHuff(bu.tree);
                    if (v < 12) {
                        last = v;
                        bu.data[idx++] = v;
                    } else {
                        const run = _BINK_BT_RLE_LENS[v - 12];
                        const end = Math.min(idx + run, len);
                        for (let k = idx; k < end; k++) bu.data[k] = last;
                        idx = end;
                    }
                }
            }
            bu.end = len;
        }

        function readColors() {
            const bu = bundles[COLORS];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            const len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            bu.ptr = 0;
            if (bits.bit()) {
                colLastval = getHuff(colHigh[colLastval]);
                let v = getHuff(bu.tree);
                v = (colLastval << 4) | v;
                if (version < 'i') {
                    const sign = ((v << 24) >> 31);
                    v = ((v & 0x7F) ^ sign) - sign;
                    v = (v + 0x80) & 0xFF;
                }
                for (let i = 0; i < len; i++) bu.data[i] = v;
            } else {
                for (let i = 0; i < len; i++) {
                    colLastval = getHuff(colHigh[colLastval]);
                    let v = getHuff(bu.tree);
                    v = (colLastval << 4) | v;
                    if (version < 'i') {
                        const sign = ((v << 24) >> 31);
                        v = ((v & 0x7F) ^ sign) - sign;
                        v = (v + 0x80) & 0xFF;
                    }
                    bu.data[i] = v;
                }
            }
            bu.end = len;
        }

        function readPatterns() {
            const bu = bundles[PATTERN];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            const len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            bu.ptr = 0;
            for (let i = 0; i < len; i++) {
                let v = getHuff(bu.tree);
                v |= getHuff(bu.tree) << 4;
                bu.data[i] = v;
            }
            bu.end = len;
        }

        function readMotion(bIdx) {
            const bu = bundles[bIdx];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            const len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            bu.ptr = 0;
            if (bits.bit()) {
                let v = bits.bits(4);
                if (v) { const sign = -bits.bit(); v = (v ^ sign) - sign; }
                for (let i = 0; i < len; i++) bu.data[i] = v;
            } else {
                for (let i = 0; i < len; i++) {
                    let v = getHuff(bu.tree);
                    if (v) { const sign = -bits.bit(); v = (v ^ sign) - sign; }
                    bu.data[i] = v;
                }
            }
            bu.end = len;
        }

        function readDcs(bIdx, hasSign) {
            const bu = bundles[bIdx];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            const len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            bu.ptr = 0;
            let idx = 0;
            let v = bits.bits(hasSign ? 10 : 11);
            if (v && hasSign) { const sign = -bits.bit(); v = (v ^ sign) - sign; }
            bu.data[idx++] = v;
            const remaining = len - 1;
            for (let i = 0; i < remaining; i += 8) {
                const groupLen = Math.min(remaining - i, 8);
                const bsize = bits.bits(4);
                if (bsize) {
                    for (let j = 0; j < groupLen; j++) {
                        let v2 = bits.bits(bsize);
                        if (v2) { const sign = -bits.bit(); v2 = (v2 ^ sign) - sign; }
                        v += v2;
                        bu.data[idx++] = v;
                    }
                } else {
                    for (let j = 0; j < groupLen; j++) bu.data[idx++] = v;
                }
            }
            bu.end = idx;
        }

        function readRuns() {
            const bu = bundles[RUN];
            if (bu.end < 0 || bu.ptr < bu.end) return;
            const len = bits.bits(bu.lenBits);
            if (!len) { bu.end = -1; return; }
            bu.ptr = 0;
            if (bits.bit()) {
                const v = bits.bits(4);
                for (let i = 0; i < len; i++) bu.data[i] = v;
            } else {
                for (let i = 0; i < len; i++) bu.data[i] = getHuff(bu.tree);
            }
            bu.end = len;
        }

        function getVal(bIdx) {
            const bu = bundles[bIdx];
            if (bu.ptr >= bu.end) return 0;
            return bu.data[bu.ptr++];
        }

        // --- Block decoders ---
        const dctblock = new Int32Array(64);
        const block16 = new Int16Array(64);

        function decodeRunBlock(dstOff) {
            const scanIdx = bits.bits(4);
            const scan = _BINK_PATTERNS[scanIdx];
            let si = 0, i = 0;
            do {
                const run = getVal(RUN) + 1;
                i += run;
                if (i > 64) break;
                if (bits.bit()) {
                    const v = getVal(COLORS) & 0xFF;
                    for (let j = 0; j < run; j++) {
                        const pos = dstOff + coordmap[scan[si++]];
                        if (pos >= 0 && pos < dst.length) dst[pos] = v;
                    }
                } else {
                    for (let j = 0; j < run; j++) {
                        const v = getVal(COLORS) & 0xFF;
                        const pos = dstOff + coordmap[scan[si++]];
                        if (pos >= 0 && pos < dst.length) dst[pos] = v;
                    }
                }
            } while (i < 63);
            if (i === 63) {
                const v = getVal(COLORS) & 0xFF;
                const pos = dstOff + coordmap[scan[si]];
                if (pos >= 0 && pos < dst.length) dst[pos] = v;
            }
        }

        function decodeIntraBlock(dstOff) {
            dctblock.fill(0);
            dctblock[0] = getVal(INTRA_DC);
            const { coefIdx, q } = BinkDecoder._readDctCoeffs(bits, dctblock, -1);
            BinkDecoder._unquantizeDctCoeffs(dctblock, coefIdx, q, _BINK_INTRA_QUANT);
            BinkDecoder._binkIdctPut(dst, dstOff, stride, dctblock);
        }

        function decodeFillBlock(dstOff) {
            const v = getVal(COLORS) & 0xFF;
            for (let row = 0; row < 8; row++)
                for (let col = 0; col < 8; col++) {
                    const pos = dstOff + row * stride + col;
                    if (pos < dst.length) dst[pos] = v;
                }
        }

        function decodePatternBlock(dstOff) {
            const col0 = getVal(COLORS) & 0xFF;
            const col1 = getVal(COLORS) & 0xFF;
            for (let row = 0; row < 8; row++) {
                let pat = getVal(PATTERN);
                for (let col = 0; col < 8; col++) {
                    const pos = dstOff + row * stride + col;
                    if (pos < dst.length) dst[pos] = (pat & 1) ? col1 : col0;
                    pat >>= 1;
                }
            }
        }

        function decodeRawBlock(dstOff) {
            for (let row = 0; row < 8; row++)
                for (let col = 0; col < 8; col++) {
                    const pos = dstOff + row * stride + col;
                    if (pos < dst.length) dst[pos] = getVal(COLORS) & 0xFF;
                }
        }

        // --- Main decode loop ---
        for (let by = 0; by < bh; by++) {
            readBlockTypes(BLOCK_TYPES);
            readBlockTypes(SUB_BLOCK_TYPES);
            readColors();
            readPatterns();
            readMotion(X_OFF);
            readMotion(Y_OFF);
            readDcs(INTRA_DC, false);
            readDcs(INTER_DC, true);
            readRuns();

            for (let bx = 0; bx < bw; bx++) {
                const blkType = getVal(BLOCK_TYPES);
                const dstOff = by * 8 * stride + bx * 8;

                // 16x16 block type on odd row/col means part of already decoded block — skip it
                if (((by & 1) || (bx & 1)) && blkType === 1) {
                    bx++;
                    continue;
                }

                switch (blkType) {
                    case 0: // SKIP
                        BinkDecoder._copyBlock(dst, dstOff, stride, prev, dstOff, stride);
                        break;

                    case 1: { // SCALED (16x16 block)
                        const subType = getVal(SUB_BLOCK_TYPES);
                        const ublock = new Uint8Array(64);
                        switch (subType) {
                            case 0: // SKIP sub
                                for (let r = 0; r < 8; r++)
                                    for (let c = 0; c < 8; c++)
                                        ublock[r * 8 + c] = prev[dstOff + r * stride + c] || 0;
                                break;
                            case 3: { // RUN sub
                                const scanIdx = bits.bits(4);
                                const scan = _BINK_PATTERNS[scanIdx];
                                let si = 0, ri = 0;
                                do {
                                    const run = getVal(RUN) + 1;
                                    ri += run;
                                    if (ri > 64) break;
                                    if (bits.bit()) {
                                        const v = getVal(COLORS) & 0xFF;
                                        for (let j = 0; j < run; j++) ublock[scan[si++]] = v;
                                    } else {
                                        for (let j = 0; j < run; j++) ublock[scan[si++]] = getVal(COLORS) & 0xFF;
                                    }
                                } while (ri < 63);
                                if (ri === 63) ublock[scan[si]] = getVal(COLORS) & 0xFF;
                                break;
                            }
                            case 5: { // INTRA sub
                                dctblock.fill(0);
                                dctblock[0] = getVal(INTRA_DC);
                                const { coefIdx, q } = BinkDecoder._readDctCoeffs(bits, dctblock, -1);
                                BinkDecoder._unquantizeDctCoeffs(dctblock, coefIdx, q, _BINK_INTRA_QUANT);
                                BinkDecoder._binkIdctPut(ublock, 0, 8, dctblock);
                                break;
                            }
                            case 6: { // FILL sub
                                const v = getVal(COLORS) & 0xFF;
                                // For FILL in SCALED, fill 16x16 directly
                                for (let r = 0; r < 16; r++)
                                    for (let c = 0; c < 16; c++) {
                                        const pos = dstOff + r * stride + c;
                                        if (pos < dst.length) dst[pos] = v;
                                    }
                                bx++;
                                continue;
                            }
                            case 8: { // PATTERN sub
                                const c0 = getVal(COLORS) & 0xFF;
                                const c1 = getVal(COLORS) & 0xFF;
                                for (let r = 0; r < 8; r++) {
                                    let pat = getVal(PATTERN);
                                    for (let c = 0; c < 8; c++) {
                                        ublock[r * 8 + c] = (pat & 1) ? c1 : c0;
                                        pat >>= 1;
                                    }
                                }
                                break;
                            }
                            case 9: // RAW sub
                                for (let r = 0; r < 8; r++)
                                    for (let c = 0; c < 8; c++)
                                        ublock[r * 8 + c] = getVal(COLORS) & 0xFF;
                                break;
                            default:
                                for (let r = 0; r < 8; r++)
                                    for (let c = 0; c < 8; c++)
                                        ublock[r * 8 + c] = prev[dstOff + r * stride + c] || 0;
                                break;
                        }
                        // Scale 8x8 ublock to 16x16 destination
                        if (subType !== 6) {
                            for (let r = 0; r < 8; r++)
                                for (let c = 0; c < 8; c++) {
                                    const v = ublock[r * 8 + c];
                                    const base = dstOff + r * 2 * stride + c * 2;
                                    if (base < dst.length) dst[base] = v;
                                    if (base + 1 < dst.length) dst[base + 1] = v;
                                    if (base + stride < dst.length) dst[base + stride] = v;
                                    if (base + stride + 1 < dst.length) dst[base + stride + 1] = v;
                                }
                            bx++;
                        }
                        break;
                    }

                    case 2: { // MOTION
                        const xoff = getVal(X_OFF);
                        const yoff = getVal(Y_OFF);
                        BinkDecoder._copyBlock(dst, dstOff, stride, prev, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        break;
                    }

                    case 3: // RUN
                        decodeRunBlock(dstOff);
                        break;

                    case 4: { // RESIDUE
                        const xoff = getVal(X_OFF);
                        const yoff = getVal(Y_OFF);
                        BinkDecoder._copyBlock(dst, dstOff, stride, prev, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        block16.fill(0);
                        const ncoefs = bits.bits(7);
                        BinkDecoder._readResidue(bits, block16, ncoefs);
                        for (let row = 0; row < 8; row++)
                            for (let col = 0; col < 8; col++) {
                                const pos = dstOff + row * stride + col;
                                if (pos < dst.length) {
                                    let v = dst[pos] + block16[row * 8 + col];
                                    dst[pos] = v < 0 ? 0 : v > 255 ? 255 : v;
                                }
                            }
                        break;
                    }

                    case 5: // INTRA
                        decodeIntraBlock(dstOff);
                        break;

                    case 6: // FILL
                        decodeFillBlock(dstOff);
                        break;

                    case 7: { // INTER
                        const xoff = getVal(X_OFF);
                        const yoff = getVal(Y_OFF);
                        BinkDecoder._copyBlock(dst, dstOff, stride, prev, (by * 8 + yoff) * stride + (bx * 8 + xoff), stride);
                        dctblock.fill(0);
                        dctblock[0] = getVal(INTER_DC);
                        const { coefIdx: ci2, q: q2 } = BinkDecoder._readDctCoeffs(bits, dctblock, -1);
                        BinkDecoder._unquantizeDctCoeffs(dctblock, ci2, q2, _BINK_INTER_QUANT);
                        BinkDecoder._binkIdctAdd(dst, dstOff, stride, dctblock);
                        break;
                    }

                    case 8: // PATTERN
                        decodePatternBlock(dstOff);
                        break;

                    case 9: // RAW
                        decodeRawBlock(dstOff);
                        break;

                    default:
                        break;
                }
            }
        }

        bits.alignTo32();
    }

    // IDCT constants
    static _IDCT_A1 = 2896;
    static _IDCT_A2 = 2217;
    static _IDCT_A3 = 3784;
    static _IDCT_A4 = -5352;

    static _binkIdctCol(dest, destOff, src, srcOff) {
        if ((src[srcOff+8]|src[srcOff+16]|src[srcOff+24]|src[srcOff+32]|src[srcOff+40]|src[srcOff+48]|src[srcOff+56]) === 0) {
            for (let i = 0; i < 8; i++) dest[destOff + i * 8] = src[srcOff];
            return;
        }
        const a0 = src[srcOff] + src[srcOff+32];
        const a1 = src[srcOff] - src[srcOff+32];
        const a2 = src[srcOff+16] + src[srcOff+48];
        const a3 = ((BinkDecoder._IDCT_A1 * (src[srcOff+16] - src[srcOff+48])) >> 11);
        const a4 = src[srcOff+40] + src[srcOff+24];
        const a5 = src[srcOff+40] - src[srcOff+24];
        const a6 = src[srcOff+8] + src[srcOff+56];
        const a7 = src[srcOff+8] - src[srcOff+56];
        const b0 = a4 + a6;
        const b1 = ((BinkDecoder._IDCT_A3 * (a5 + a7)) >> 11);
        const b2 = ((BinkDecoder._IDCT_A4 * a5) >> 11) - b0 + b1;
        const b3 = ((BinkDecoder._IDCT_A1 * (a6 - a4)) >> 11) - b2;
        const b4 = ((BinkDecoder._IDCT_A2 * a7) >> 11) + b3 - b1;
        dest[destOff]      = a0 + a2 + b0;
        dest[destOff + 8]  = a1 + a3 - a2 + b2;
        dest[destOff + 16] = a1 - a3 + a2 + b3;
        dest[destOff + 24] = a0 - a2 - b4;
        dest[destOff + 32] = a0 - a2 + b4;
        dest[destOff + 40] = a1 - a3 + a2 - b3;
        dest[destOff + 48] = a1 + a3 - a2 - b2;
        dest[destOff + 56] = a0 + a2 - b0;
    }

    static _binkIdctRow(dest, destOff, src, srcOff) {
        const a0 = src[srcOff] + src[srcOff+4];
        const a1 = src[srcOff] - src[srcOff+4];
        const a2 = src[srcOff+2] + src[srcOff+6];
        const a3 = ((BinkDecoder._IDCT_A1 * (src[srcOff+2] - src[srcOff+6])) >> 11);
        const a4 = src[srcOff+5] + src[srcOff+3];
        const a5 = src[srcOff+5] - src[srcOff+3];
        const a6 = src[srcOff+1] + src[srcOff+7];
        const a7 = src[srcOff+1] - src[srcOff+7];
        const b0 = a4 + a6;
        const b1 = ((BinkDecoder._IDCT_A3 * (a5 + a7)) >> 11);
        const b2 = ((BinkDecoder._IDCT_A4 * a5) >> 11) - b0 + b1;
        const b3 = ((BinkDecoder._IDCT_A1 * (a6 - a4)) >> 11) - b2;
        const b4 = ((BinkDecoder._IDCT_A2 * a7) >> 11) + b3 - b1;
        dest[destOff]     = (a0 + a2 + b0 + 0x7F) >> 8;
        dest[destOff + 1] = (a1 + a3 - a2 + b2 + 0x7F) >> 8;
        dest[destOff + 2] = (a1 - a3 + a2 + b3 + 0x7F) >> 8;
        dest[destOff + 3] = (a0 - a2 - b4 + 0x7F) >> 8;
        dest[destOff + 4] = (a0 - a2 + b4 + 0x7F) >> 8;
        dest[destOff + 5] = (a1 - a3 + a2 - b3 + 0x7F) >> 8;
        dest[destOff + 6] = (a1 + a3 - a2 - b2 + 0x7F) >> 8;
        dest[destOff + 7] = (a0 + a2 - b0 + 0x7F) >> 8;
    }

    // Copy 8x8 block with overlap safety (src and dst may overlap in same buffer)
    static _copyBlock(dst, dstOff, dstStride, src, srcOff, srcStride) {
        const tmp = BinkDecoder._tmp64;
        const srcLen = src.length;
        for (let row = 0; row < 8; row++) {
            let sp = srcOff + row * srcStride;
            const ti = row << 3;
            for (let col = 0; col < 8; col++) {
                let s = sp + col;
                if (s < 0) s = 0;
                else if (s >= srcLen) s = srcLen - 1;
                tmp[ti + col] = src[s];
            }
        }
        for (let row = 0; row < 8; row++) {
            const dp = dstOff + row * dstStride;
            const ti = row << 3;
            if (dp >= 0 && dp + 8 <= dst.length) {
                dst[dp] = tmp[ti]; dst[dp+1] = tmp[ti+1]; dst[dp+2] = tmp[ti+2]; dst[dp+3] = tmp[ti+3];
                dst[dp+4] = tmp[ti+4]; dst[dp+5] = tmp[ti+5]; dst[dp+6] = tmp[ti+6]; dst[dp+7] = tmp[ti+7];
            } else {
                for (let col = 0; col < 8; col++) {
                    const d = dp + col;
                    if (d >= 0 && d < dst.length) dst[d] = tmp[ti + col];
                }
            }
        }
    }

    static _binkIdctPut(dst, dstOff, stride, block) {
        const temp = BinkDecoder._idctTemp;
        for (let i = 0; i < 8; i++) BinkDecoder._binkIdctCol(temp, i, block, i);
        const rowTemp = BinkDecoder._idctRow;
        for (let i = 0; i < 8; i++) {
            BinkDecoder._binkIdctRow(rowTemp, 0, temp, i * 8);
            const pos = dstOff + i * stride;
            if (pos >= 0 && pos + 8 <= dst.length) {
                for (let j = 0; j < 8; j++) {
                    const v = rowTemp[j];
                    dst[pos + j] = v < 0 ? 0 : v > 255 ? 255 : v;
                }
            } else {
                for (let j = 0; j < 8; j++) {
                    const p = pos + j;
                    if (p >= 0 && p < dst.length) {
                        const v = rowTemp[j];
                        dst[p] = v < 0 ? 0 : v > 255 ? 255 : v;
                    }
                }
            }
        }
    }

    static _binkIdctAdd(dst, dstOff, stride, block) {
        const temp = BinkDecoder._idctTemp;
        for (let i = 0; i < 8; i++) BinkDecoder._binkIdctCol(temp, i, block, i);
        const temp2 = BinkDecoder._idctTemp2;
        for (let i = 0; i < 8; i++) BinkDecoder._binkIdctRow(temp2, i * 8, temp, i * 8);
        for (let i = 0; i < 8; i++) {
            const pos = dstOff + i * stride;
            const ti = i * 8;
            if (pos >= 0 && pos + 8 <= dst.length) {
                for (let j = 0; j < 8; j++) {
                    let v = dst[pos + j] + temp2[ti + j];
                    dst[pos + j] = v < 0 ? 0 : v > 255 ? 255 : v;
                }
            } else {
                for (let j = 0; j < 8; j++) {
                    const p = pos + j;
                    if (p >= 0 && p < dst.length) {
                        let v = dst[p] + temp2[ti + j];
                        dst[p] = v < 0 ? 0 : v > 255 ? 255 : v;
                    }
                }
            }
        }
    }

    // Read DCT coefficients from bitstream
    static _readDctCoeffs(bits, block, q) {
        const coefList = new Array(128);
        const modeList = new Array(128);
        const coefIdx = [];
        let listStart = 64, listEnd = 64;

        coefList[listEnd] = 4;  modeList[listEnd++] = 0;
        coefList[listEnd] = 24; modeList[listEnd++] = 0;
        coefList[listEnd] = 44; modeList[listEnd++] = 0;
        coefList[listEnd] = 1;  modeList[listEnd++] = 3;
        coefList[listEnd] = 2;  modeList[listEnd++] = 3;
        coefList[listEnd] = 3;  modeList[listEnd++] = 3;

        const maxBits = bits.bits(4) - 1;
        for (let bitsIter = maxBits; bitsIter >= 0; bitsIter--) {
            let listPos = listStart;
            while (listPos < listEnd) {
                if (!(modeList[listPos] | coefList[listPos]) || !bits.bit()) {
                    listPos++;
                    continue;
                }
                const ccoefBase = coefList[listPos];
                const mode = modeList[listPos];
                switch (mode) {
                    case 0:
                        coefList[listPos] = ccoefBase + 4;
                        modeList[listPos] = 1;
                        // fall through
                    case 2: {
                        if (mode === 2) {
                            coefList[listPos] = 0;
                            modeList[listPos++] = 0;
                        }
                        let cc = ccoefBase;
                        for (let i = 0; i < 4; i++, cc++) {
                            if (bits.bit()) {
                                coefList[--listStart] = cc;
                                modeList[listStart] = 3;
                            } else {
                                let t;
                                if (!bitsIter) {
                                    t = 1 - (bits.bit() << 1);
                                } else {
                                    t = bits.bits(bitsIter) | (1 << bitsIter);
                                    const sign = -bits.bit();
                                    t = (t ^ sign) - sign;
                                }
                                block[_BINK_SCAN[cc]] = t;
                                coefIdx.push(cc);
                            }
                        }
                        break;
                    }
                    case 1:
                        modeList[listPos] = 2;
                        for (let i = 0; i < 3; i++) {
                            coefList[listEnd] = ccoefBase + 4 + i * 4;
                            modeList[listEnd++] = 2;
                        }
                        break;
                    case 3: {
                        let t;
                        if (!bitsIter) {
                            t = 1 - (bits.bit() << 1);
                        } else {
                            t = bits.bits(bitsIter) | (1 << bitsIter);
                            const sign = -bits.bit();
                            t = (t ^ sign) - sign;
                        }
                        block[_BINK_SCAN[ccoefBase]] = t;
                        coefIdx.push(ccoefBase);
                        coefList[listPos] = 0;
                        modeList[listPos++] = 0;
                        break;
                    }
                }
            }
        }

        return { coefIdx, q: q === -1 ? bits.bits(4) : q };
    }

    static _unquantizeDctCoeffs(block, coefIdx, q, quantTable) {
        if (q >= 0 && q < 16) {
            block[0] = (block[0] * quantTable[q][0]) >> 11;
            for (const idx of coefIdx) {
                block[_BINK_SCAN[idx]] = (block[_BINK_SCAN[idx]] * quantTable[q][idx]) >> 11;
            }
        }
    }

    // Read residue block
    static _readResidue(bits, block, masksCount) {
        const coefList = new Array(128);
        const modeList = new Array(128);
        let listStart = 64, listEnd = 64;
        const nzCoeff = [];

        coefList[listEnd] = 4;  modeList[listEnd++] = 0;
        coefList[listEnd] = 24; modeList[listEnd++] = 0;
        coefList[listEnd] = 44; modeList[listEnd++] = 0;
        coefList[listEnd] = 0;  modeList[listEnd++] = 2;

        for (let mask = 1 << bits.bits(3); mask; mask >>= 1) {
            for (let i = 0; i < nzCoeff.length; i++) {
                if (!bits.bit()) continue;
                if (block[nzCoeff[i]] < 0) block[nzCoeff[i]] -= mask;
                else block[nzCoeff[i]] += mask;
                masksCount--;
                if (masksCount < 0) return;
            }

            let listPos = listStart;
            while (listPos < listEnd) {
                if (!(coefList[listPos] | modeList[listPos]) || !bits.bit()) {
                    listPos++;
                    continue;
                }
                const ccoef = coefList[listPos];
                const mode = modeList[listPos];
                switch (mode) {
                    case 0:
                        coefList[listPos] = ccoef + 4;
                        modeList[listPos] = 1;
                        // fall through
                    case 2: {
                        if (mode === 2) {
                            coefList[listPos] = 0;
                            modeList[listPos++] = 0;
                        }
                        let cc = ccoef;
                        for (let i = 0; i < 4; i++, cc++) {
                            if (bits.bit()) {
                                coefList[--listStart] = cc;
                                modeList[listStart] = 3;
                            } else {
                                nzCoeff.push(_BINK_SCAN[cc]);
                                const sign = -bits.bit();
                                block[_BINK_SCAN[cc]] = (mask ^ sign) - sign;
                                masksCount--;
                                if (masksCount < 0) return;
                            }
                        }
                        break;
                    }
                    case 1:
                        modeList[listPos] = 2;
                        for (let i = 0; i < 3; i++) {
                            coefList[listEnd] = ccoef + 4 + i * 4;
                            modeList[listEnd++] = 2;
                        }
                        break;
                    case 3:
                        nzCoeff.push(_BINK_SCAN[ccoef]);
                        const sign = -bits.bit();
                        block[_BINK_SCAN[ccoef]] = (mask ^ sign) - sign;
                        coefList[listPos] = 0;
                        modeList[listPos++] = 0;
                        masksCount--;
                        if (masksCount < 0) return;
                        break;
                }
            }
        }
    }

    // Convert YUV420p to RGBA
    static _yuvToRgba(planes, width, height, version, hasAlpha) {
        const rgba = new Uint8Array(width * height * 4);
        const yPlane = planes[0];
        const uPlane = planes[1];
        const vPlane = planes[2];
        const aPlane = hasAlpha ? planes[3] : null;
        const cw = (width + 1) >> 1;
        const alpha = aPlane ? 0 : 255;

        let off = 0;
        if (version === 'k') {
            // JPEG full range
            for (let py = 0; py < height; py++) {
                const yRow = py * width;
                const cRow = (py >> 1) * cw;
                for (let px = 0; px < width; px++) {
                    const cIdx = cRow + (px >> 1);
                    const y = yPlane[yRow + px];
                    const u = uPlane[cIdx] - 128;
                    const v = vPlane[cIdx] - 128;
                    let r = y + 1.402 * v;
                    let g = y - 0.344136 * u - 0.714136 * v;
                    let b = y + 1.772 * u;
                    rgba[off]     = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
                    rgba[off + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
                    rgba[off + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
                    rgba[off + 3] = aPlane ? aPlane[yRow + px] : alpha;
                    off += 4;
                }
            }
        } else {
            // BT.601 limited range
            for (let py = 0; py < height; py++) {
                const yRow = py * width;
                const cRow = (py >> 1) * cw;
                for (let px = 0; px < width; px++) {
                    const cIdx = cRow + (px >> 1);
                    const yy = (yPlane[yRow + px] - 16) * 1.164383;
                    const u = uPlane[cIdx] - 128;
                    const v = vPlane[cIdx] - 128;
                    let r = yy + 1.596027 * v;
                    let g = yy - 0.391762 * u - 0.812968 * v;
                    let b = yy + 2.017232 * u;
                    rgba[off]     = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
                    rgba[off + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
                    rgba[off + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
                    rgba[off + 3] = aPlane ? aPlane[yRow + px] : alpha;
                    off += 4;
                }
            }
        }
        return rgba;
    }
}

// Pre-allocated reusable buffers (avoid per-call allocations)
BinkDecoder._tmp64 = new Uint8Array(64);
BinkDecoder._idctTemp = new Int32Array(64);
BinkDecoder._idctTemp2 = new Int32Array(64);
BinkDecoder._idctRow = new Int32Array(8);

// Bink Audio Decoder (RDFT variant)
class BinkAudioDecoder {
    constructor(trackInfo, version) {
        this.sampleRate = trackInfo.sampleRate;
        this.stereo = trackInfo.stereo;
        this.useDCT = trackInfo.useDCT;
        this.channels = this.stereo ? 2 : 1;
        this.versionB = (version === 'b');
        this.first = true;

        let sr = this.sampleRate;
        let frameLenBits;
        if (sr < 22050) frameLenBits = 9;
        else if (sr < 44100) frameLenBits = 10;
        else frameLenBits = 11;

        if (!this.useDCT) {
            // RDFT: audio is interleaved, effective sample rate multiplied by channels
            sr *= this.channels;
            this._internalChannels = 1;
            if (!this.versionB) frameLenBits += Math.floor(Math.log2(this.channels || 1));
        } else {
            this._internalChannels = this.channels;
        }

        this.frameLen = 1 << frameLenBits;
        this.overlapLen = this.frameLen >> 4;
        this.blockSize = (this.frameLen - this.overlapLen) * Math.min(2, this._internalChannels);

        const sampleRateHalf = (sr + 1) >> 1;
        this.root = this.useDCT
            ? this.frameLen / (Math.sqrt(this.frameLen) * 32768.0)
            : 2.0 / (Math.sqrt(this.frameLen) * 32768.0);

        // Quant table
        this.quantTable = new Float32Array(96);
        for (let i = 0; i < 96; i++) {
            this.quantTable[i] = Math.exp(i * 0.15289164787221953823) * this.root;
        }

        // Bands
        this.numBands = 1;
        while (this.numBands < 25 && sampleRateHalf > _BINK_RDFT_WMA_CRITICAL_FREQS[this.numBands - 1]) {
            this.numBands++;
        }
        this.bands = new Uint32Array(this.numBands + 1);
        this.bands[0] = 2;
        for (let i = 1; i < this.numBands; i++) {
            this.bands[i] = (_BINK_RDFT_WMA_CRITICAL_FREQS[i - 1] * this.frameLen / sampleRateHalf) & ~1;
        }
        this.bands[this.numBands] = this.frameLen;

        // Previous coefficients for overlap
        this.previous = [];
        for (let ch = 0; ch < Math.min(2, this._internalChannels); ch++) {
            this.previous.push(new Float32Array(this.overlapLen));
        }

        // Precompute RDFT twiddle factors
        this._rdftSize = this.frameLen;
        this._rdftCos = new Float32Array(this._rdftSize / 2);
        this._rdftSin = new Float32Array(this._rdftSize / 2);
        for (let i = 0; i < this._rdftSize / 2; i++) {
            const angle = -2 * Math.PI * i / this._rdftSize;
            this._rdftCos[i] = Math.cos(angle);
            this._rdftSin[i] = Math.sin(angle);
        }
    }

    decodeBlock(rawData) {
        if (rawData.length < 4) return null;
        const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
        const uncompressedSize = view.getUint32(0, true);
        if (rawData.length < 8) return null;

        const bits = new BinkBitReader(rawData, 4);
        const totalBits = rawData.length * 8;

        const allOutputs = [];

        // Decode all blocks from the packet
        while (bits.bitsLeft(totalBits) > 32) {
            let chOffset = 0;
            const blockOutputs = [];

            while (chOffset < this.channels) {
                const internalCh = Math.min(2, this.channels - chOffset);
                const chOutputs = [];
                for (let ch = 0; ch < internalCh; ch++) {
                    chOutputs.push(new Float32Array(this.frameLen));
                }

                for (let ch = 0; ch < this._internalChannels; ch++) {
                    if (bits.bitsLeft(totalBits) < 64) break;

                    const coeffs = new Float32Array(this.frameLen + 2);

                    if (this.versionB) {
                        coeffs[0] = BinkAudioDecoder._bitsToFloat(bits.bits(32)) * this.root;
                        coeffs[1] = BinkAudioDecoder._bitsToFloat(bits.bits(32)) * this.root;
                    } else {
                        coeffs[0] = BinkAudioDecoder._getFloat(bits) * this.root;
                        coeffs[1] = BinkAudioDecoder._getFloat(bits) * this.root;
                    }

                    if (bits.bitsLeft(totalBits) < this.numBands * 8) break;
                    const quant = new Float32Array(this.numBands);
                    for (let i = 0; i < this.numBands; i++) {
                        const val = bits.bits(8);
                        quant[i] = this.quantTable[Math.min(val, 95)];
                    }

                    let k = 0;
                    let q = quant[0];
                    let i = 2;
                    while (i < this.frameLen) {
                        let j;
                        if (this.versionB) {
                            j = i + 16;
                        } else {
                            if (bits.bit()) {
                                const v = bits.bits(4);
                                j = i + _BINK_RLE_LENS[v] * 8;
                            } else {
                                j = i + 8;
                            }
                        }
                        j = Math.min(j, this.frameLen);

                        const width = bits.bits(4);
                        if (width === 0) {
                            for (let x = i; x < j; x++) coeffs[x] = 0;
                            i = j;
                            while (k < this.numBands && this.bands[k] < i) q = quant[k++];
                        } else {
                            while (i < j) {
                                if (k < this.numBands && this.bands[k] === i) q = quant[k++];
                                const coeff = bits.bits(width);
                                if (coeff) {
                                    if (bits.bit()) coeffs[i] = -q * coeff;
                                    else coeffs[i] = q * coeff;
                                } else {
                                    coeffs[i] = 0;
                                }
                                i++;
                            }
                        }
                    }

                    let output;
                    if (this.useDCT) {
                        coeffs[0] /= 0.5;
                        output = this._idct(coeffs);
                    } else {
                        for (let x = 2; x < this.frameLen; x += 2) {
                            coeffs[x + 1] *= -1;
                        }
                        coeffs[this.frameLen] = coeffs[1];
                        coeffs[this.frameLen + 1] = coeffs[1] = 0;
                        output = this._irdft(coeffs);
                    }

                    const chIdx = ch + chOffset;
                    if (!this.first) {
                        const count = this.overlapLen * this._internalChannels;
                        for (let x = 0; x < this.overlapLen; x++) {
                            const jj = x * this._internalChannels + ch;
                            output[x] = (this.previous[chIdx][x] * (count - jj) + output[x] * jj) / count;
                        }
                    }

                    this.previous[chIdx] = new Float32Array(this.overlapLen);
                    for (let x = 0; x < this.overlapLen; x++) {
                        this.previous[chIdx][x] = output[this.frameLen - this.overlapLen + x];
                    }

                    if (chIdx < internalCh) chOutputs[chIdx] = output;
                }

                this.first = false;

                const out = new Float32Array(this.blockSize);
                for (let i = 0; i < this.blockSize; i++) {
                    const ch = i % this._internalChannels;
                    const sampleIdx = Math.floor(i / this._internalChannels);
                    if (sampleIdx < this.frameLen && ch < chOutputs.length) {
                        out[i] = chOutputs[ch][sampleIdx];
                    }
                }
                blockOutputs.push(out);

                chOffset += 2;
                bits.alignTo32();
                if (bits.bitsLeft(totalBits) <= 0) break;
            }

            for (const bo of blockOutputs) allOutputs.push(bo);

            // Check if we should continue to next block
            if (bits.bitsLeft(totalBits) <= 32) break;
        }

        // Combine output
        let totalLen = 0;
        for (const o of allOutputs) totalLen += o.length;
        const result = new Float32Array(totalLen);
        let off = 0;
        for (const o of allOutputs) { result.set(o, off); off += o.length; }
        return result;
    }

    // Inverse RDFT matching FFmpeg's av_tx with inverse=1, scale=0.5
    // Given half-complex input after Bink preprocessing (Im negated, Nyquist at position N)
    _irdft(coeffs) {
        const N = this._rdftSize;
        const half = N / 2;

        // Build X'[k] from coeffs:
        // coeffs[0] = DC, coeffs[1] = 0
        // coeffs[2k] = Re(k), coeffs[2k+1] = -Im(k) for k=1..N/2-1
        // coeffs[N] = Nyquist, coeffs[N+1] = 0

        // Compute Y[k] for k=0..N/2-1 such that IFFT(Y) deinterleaves to the IRDFT output
        // Y[k] = 0.5*(X'[k] + conj(X'[N/2-k])) + 0.5*i*exp(2πik/N)*(X'[k] - conj(X'[N/2-k]))
        const Yre = new Float32Array(half);
        const Yim = new Float32Array(half);

        const dc = coeffs[0];
        const nyq = coeffs[N];
        Yre[0] = 0.5 * (dc + nyq);
        Yim[0] = 0.5 * (dc - nyq);

        for (let k = 1; k < half; k++) {
            const xk_re = coeffs[2 * k];
            const xk_im = coeffs[2 * k + 1];
            const mk = half - k;
            // conj(X'[N/2-k])
            const cxmk_re = coeffs[2 * mk];
            const cxmk_im = -coeffs[2 * mk + 1];

            const e_re = 0.5 * (xk_re + cxmk_re);
            const e_im = 0.5 * (xk_im + cxmk_im);
            const o_re = 0.5 * (xk_re - cxmk_re);
            const o_im = 0.5 * (xk_im - cxmk_im);

            // i * exp(2πik/N) = -sin(2πk/N) + i*cos(2πk/N)
            const angle = 2 * Math.PI * k / N;
            const tw_re = -Math.sin(angle);
            const tw_im = Math.cos(angle);

            Yre[k] = e_re + (tw_re * o_re - tw_im * o_im);
            Yim[k] = e_im + (tw_re * o_im + tw_im * o_re);
        }

        // Unnormalized IFFT: conj -> forward FFT -> conj (no 1/n scaling)
        for (let i = 0; i < half; i++) Yim[i] = -Yim[i];
        BinkAudioDecoder._fft(Yre, Yim, half);
        for (let i = 0; i < half; i++) Yim[i] = -Yim[i];

        // Deinterleave to N real output samples
        const out = new Float32Array(N);
        for (let i = 0; i < half; i++) {
            out[2 * i]     = Yre[i];
            out[2 * i + 1] = Yim[i];
        }
        return out;
    }

    _idct(coeffs) {
        const N = this.frameLen / 2;
        const out = new Float32Array(this.frameLen);

        // Type-III DCT via IFFT
        const re = new Float32Array(N);
        const im = new Float32Array(N);

        re[0] = coeffs[0] * 0.5;
        im[0] = 0;
        for (let k = 1; k < N; k++) {
            const angle = Math.PI * k / (2 * N);
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            re[k] = coeffs[k] * c;
            im[k] = -coeffs[k] * s;
        }

        BinkAudioDecoder._ifft(re, im, N);

        for (let i = 0; i < N; i++) {
            out[2 * i] = re[i];
            out[2 * i + 1] = im[N - 1 - i];
        }

        return out;
    }

    static _ifft(re, im, n) {
        // Conjugate
        for (let i = 0; i < n; i++) im[i] = -im[i];
        // Forward FFT
        BinkAudioDecoder._fft(re, im, n);
        // Conjugate and scale
        const scale = 1 / n;
        for (let i = 0; i < n; i++) {
            re[i] *= scale;
            im[i] = -im[i] * scale;
        }
    }

    static _fft(re, im, n) {
        // Bit-reversal permutation
        let j = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
            let m = n >> 1;
            while (m >= 1 && j >= m) { j -= m; m >>= 1; }
            j += m;
        }

        // Cooley-Tukey
        for (let step = 1; step < n; step <<= 1) {
            const halfStep = step;
            const tableStep = n / (step << 1);
            for (let group = 0; group < n; group += step << 1) {
                for (let pair = 0; pair < halfStep; pair++) {
                    const angle = -2 * Math.PI * pair * tableStep / n;
                    const wr = Math.cos(angle);
                    const wi = Math.sin(angle);
                    const i1 = group + pair;
                    const i2 = i1 + halfStep;
                    const tr = re[i2] * wr - im[i2] * wi;
                    const ti = re[i2] * wi + im[i2] * wr;
                    re[i2] = re[i1] - tr;
                    im[i2] = im[i1] - ti;
                    re[i1] += tr;
                    im[i1] += ti;
                }
            }
        }
    }

    static _getFloat(bits) {
        const power = bits.bits(5);
        const f = bits.bits(23) * Math.pow(2, power - 23);
        return bits.bit() ? -f : f;
    }

    static _bitsToFloat(v) {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, v, false);
        return new DataView(buf).getFloat32(0, false);
    }
}

// Bink scan order
const _BINK_SCAN = [
     0,  1,  8,  9,  2,  3, 10, 11,
     4,  5, 12, 13,  6,  7, 14, 15,
    20, 21, 28, 29, 22, 23, 30, 31,
    16, 17, 24, 25, 32, 33, 40, 41,
    34, 35, 42, 43, 48, 49, 56, 57,
    50, 51, 58, 59, 18, 19, 26, 27,
    36, 37, 44, 45, 38, 39, 46, 47,
    52, 53, 60, 61, 54, 55, 62, 63
];

// Bink patterns (16 patterns, 64 entries each)
const _BINK_PATTERNS = [
    [0x00,0x08,0x10,0x18,0x20,0x28,0x30,0x38,0x39,0x31,0x29,0x21,0x19,0x11,0x09,0x01,0x02,0x0A,0x12,0x1A,0x22,0x2A,0x32,0x3A,0x3B,0x33,0x2B,0x23,0x1B,0x13,0x0B,0x03,0x04,0x0C,0x14,0x1C,0x24,0x2C,0x34,0x3C,0x3D,0x35,0x2D,0x25,0x1D,0x15,0x0D,0x05,0x06,0x0E,0x16,0x1E,0x26,0x2E,0x36,0x3E,0x3F,0x37,0x2F,0x27,0x1F,0x17,0x0F,0x07],
    [0x3B,0x3A,0x39,0x38,0x30,0x31,0x32,0x33,0x2B,0x2A,0x29,0x28,0x20,0x21,0x22,0x23,0x1B,0x1A,0x19,0x18,0x10,0x11,0x12,0x13,0x0B,0x0A,0x09,0x08,0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x0F,0x0E,0x0D,0x0C,0x14,0x15,0x16,0x17,0x1F,0x1E,0x1D,0x1C,0x24,0x25,0x26,0x27,0x2F,0x2E,0x2D,0x2C,0x34,0x35,0x36,0x37,0x3F,0x3E,0x3D,0x3C],
    [0x19,0x11,0x12,0x1A,0x1B,0x13,0x0B,0x03,0x02,0x0A,0x09,0x01,0x00,0x08,0x10,0x18,0x20,0x28,0x30,0x38,0x39,0x31,0x29,0x2A,0x32,0x3A,0x3B,0x33,0x2B,0x23,0x22,0x21,0x1D,0x15,0x16,0x1E,0x1F,0x17,0x0F,0x07,0x06,0x0E,0x0D,0x05,0x04,0x0C,0x14,0x1C,0x24,0x2C,0x34,0x3C,0x3D,0x35,0x2D,0x2E,0x36,0x3E,0x3F,0x37,0x2F,0x27,0x26,0x25],
    [0x03,0x0B,0x02,0x0A,0x01,0x09,0x00,0x08,0x10,0x18,0x11,0x19,0x12,0x1A,0x13,0x1B,0x23,0x2B,0x22,0x2A,0x21,0x29,0x20,0x28,0x30,0x38,0x31,0x39,0x32,0x3A,0x33,0x3B,0x3C,0x34,0x3D,0x35,0x3E,0x36,0x3F,0x37,0x2F,0x27,0x2E,0x26,0x2D,0x25,0x2C,0x24,0x1C,0x14,0x1D,0x15,0x1E,0x16,0x1F,0x17,0x0F,0x07,0x0E,0x06,0x0D,0x05,0x0C,0x04],
    [0x18,0x19,0x10,0x11,0x08,0x09,0x00,0x01,0x02,0x03,0x0A,0x0B,0x12,0x13,0x1A,0x1B,0x1C,0x1D,0x14,0x15,0x0C,0x0D,0x04,0x05,0x06,0x07,0x0E,0x0F,0x16,0x17,0x1E,0x1F,0x27,0x26,0x2F,0x2E,0x37,0x36,0x3F,0x3E,0x3D,0x3C,0x35,0x34,0x2D,0x2C,0x25,0x24,0x23,0x22,0x2B,0x2A,0x33,0x32,0x3B,0x3A,0x39,0x38,0x31,0x30,0x29,0x28,0x21,0x20],
    [0x00,0x01,0x02,0x03,0x08,0x09,0x0A,0x0B,0x10,0x11,0x12,0x13,0x18,0x19,0x1A,0x1B,0x20,0x21,0x22,0x23,0x28,0x29,0x2A,0x2B,0x30,0x31,0x32,0x33,0x38,0x39,0x3A,0x3B,0x04,0x05,0x06,0x07,0x0C,0x0D,0x0E,0x0F,0x14,0x15,0x16,0x17,0x1C,0x1D,0x1E,0x1F,0x24,0x25,0x26,0x27,0x2C,0x2D,0x2E,0x2F,0x34,0x35,0x36,0x37,0x3C,0x3D,0x3E,0x3F],
    [0x06,0x07,0x0F,0x0E,0x0D,0x05,0x0C,0x04,0x03,0x0B,0x02,0x0A,0x09,0x01,0x00,0x08,0x10,0x18,0x11,0x19,0x12,0x1A,0x13,0x1B,0x14,0x1C,0x15,0x1D,0x16,0x1E,0x17,0x1F,0x27,0x2F,0x26,0x2E,0x25,0x2D,0x24,0x2C,0x23,0x2B,0x22,0x2A,0x21,0x29,0x20,0x28,0x31,0x30,0x38,0x39,0x3A,0x32,0x3B,0x33,0x3C,0x34,0x3D,0x35,0x36,0x37,0x3F,0x3E],
    [0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x0F,0x0E,0x0D,0x0C,0x0B,0x0A,0x09,0x08,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x1F,0x1E,0x1D,0x1C,0x1B,0x1A,0x19,0x18,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x2F,0x2E,0x2D,0x2C,0x2B,0x2A,0x29,0x28,0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x3F,0x3E,0x3D,0x3C,0x3B,0x3A,0x39,0x38],
    [0x00,0x08,0x09,0x01,0x02,0x03,0x0B,0x0A,0x12,0x13,0x1B,0x1A,0x19,0x11,0x10,0x18,0x20,0x28,0x29,0x21,0x22,0x23,0x2B,0x2A,0x32,0x31,0x30,0x38,0x39,0x3A,0x3B,0x33,0x34,0x3C,0x3D,0x3E,0x3F,0x37,0x36,0x35,0x2D,0x2C,0x24,0x25,0x26,0x2E,0x2F,0x27,0x1F,0x17,0x16,0x1E,0x1D,0x1C,0x14,0x15,0x0D,0x0C,0x04,0x05,0x06,0x0E,0x0F,0x07],
    [0x18,0x19,0x10,0x11,0x08,0x09,0x00,0x01,0x02,0x03,0x0A,0x0B,0x12,0x13,0x1A,0x1B,0x1C,0x1D,0x14,0x15,0x0C,0x0D,0x04,0x05,0x06,0x07,0x0E,0x0F,0x16,0x17,0x1E,0x1F,0x26,0x27,0x2E,0x2F,0x36,0x37,0x3E,0x3F,0x3C,0x3D,0x34,0x35,0x2C,0x2D,0x24,0x25,0x22,0x23,0x2A,0x2B,0x32,0x33,0x3A,0x3B,0x38,0x39,0x30,0x31,0x28,0x29,0x20,0x21],
    [0x00,0x08,0x01,0x09,0x02,0x0A,0x03,0x0B,0x13,0x1B,0x12,0x1A,0x11,0x19,0x10,0x18,0x20,0x28,0x21,0x29,0x22,0x2A,0x23,0x2B,0x33,0x3B,0x32,0x3A,0x31,0x39,0x30,0x38,0x3C,0x34,0x3D,0x35,0x3E,0x36,0x3F,0x37,0x2F,0x27,0x2E,0x26,0x2D,0x25,0x2C,0x24,0x1F,0x17,0x1E,0x16,0x1D,0x15,0x1C,0x14,0x0C,0x04,0x0D,0x05,0x0E,0x06,0x0F,0x07],
    [0x00,0x08,0x10,0x18,0x19,0x1A,0x1B,0x13,0x0B,0x03,0x02,0x01,0x09,0x11,0x12,0x0A,0x04,0x0C,0x14,0x1C,0x1D,0x1E,0x1F,0x17,0x0F,0x07,0x06,0x05,0x0D,0x15,0x16,0x0E,0x24,0x2C,0x34,0x3C,0x3D,0x3E,0x3F,0x37,0x2F,0x27,0x26,0x25,0x2D,0x35,0x36,0x2E,0x20,0x28,0x30,0x38,0x39,0x3A,0x3B,0x33,0x2B,0x23,0x22,0x21,0x29,0x31,0x32,0x2A],
    [0x00,0x08,0x09,0x01,0x02,0x03,0x0B,0x0A,0x13,0x1B,0x1A,0x12,0x11,0x10,0x18,0x19,0x21,0x20,0x28,0x29,0x2A,0x22,0x23,0x2B,0x33,0x3B,0x3A,0x32,0x31,0x39,0x38,0x30,0x34,0x3C,0x3D,0x35,0x36,0x3E,0x3F,0x37,0x2F,0x27,0x26,0x2E,0x2D,0x2C,0x24,0x25,0x1D,0x1C,0x14,0x15,0x16,0x1E,0x1F,0x17,0x0E,0x0F,0x07,0x06,0x05,0x0D,0x0C,0x04],
    [0x18,0x10,0x08,0x00,0x01,0x02,0x03,0x0B,0x13,0x1B,0x1A,0x19,0x11,0x0A,0x09,0x12,0x1C,0x14,0x0C,0x04,0x05,0x06,0x07,0x0F,0x17,0x1F,0x1E,0x1D,0x15,0x0E,0x0D,0x16,0x3C,0x34,0x2C,0x24,0x25,0x26,0x27,0x2F,0x37,0x3F,0x3E,0x3D,0x35,0x2E,0x2D,0x36,0x38,0x30,0x28,0x20,0x21,0x22,0x23,0x2B,0x33,0x3B,0x3A,0x39,0x31,0x2A,0x29,0x32],
    [0x00,0x08,0x09,0x01,0x02,0x0A,0x12,0x11,0x10,0x18,0x19,0x1A,0x1B,0x13,0x0B,0x03,0x07,0x06,0x0E,0x0F,0x17,0x16,0x15,0x0D,0x05,0x04,0x0C,0x14,0x1C,0x1D,0x1E,0x1F,0x3F,0x3E,0x36,0x37,0x2F,0x2E,0x2D,0x35,0x3D,0x3C,0x34,0x2C,0x24,0x25,0x26,0x27,0x38,0x30,0x31,0x39,0x3A,0x32,0x2A,0x29,0x28,0x20,0x21,0x22,0x23,0x2B,0x33,0x3B],
    [0x00,0x01,0x08,0x09,0x10,0x11,0x18,0x19,0x20,0x21,0x28,0x29,0x30,0x31,0x38,0x39,0x3A,0x3B,0x32,0x33,0x2A,0x2B,0x22,0x23,0x1A,0x1B,0x12,0x13,0x0A,0x0B,0x02,0x03,0x04,0x05,0x0C,0x0D,0x14,0x15,0x1C,0x1D,0x24,0x25,0x2C,0x2D,0x34,0x35,0x3C,0x3D,0x3E,0x3F,0x36,0x37,0x2E,0x2F,0x26,0x27,0x1E,0x1F,0x16,0x17,0x0E,0x0F,0x06,0x07]
];

const _BINKB_RUNBITS = [
    6, 6, 6, 6, 6, 6, 6, 6,  6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6,  6, 6, 6, 6, 6, 6, 6, 6,
    5, 5, 5, 5, 5, 5, 5, 5,  5, 5, 5, 5, 5, 5, 5, 5,
    4, 4, 4, 4, 4, 4, 4, 4,  3, 3, 3, 3, 2, 2, 1, 0
];

// Pre-built VLC lookup tables for Bink Huffman tree decoding (from FFmpeg binkdata.h, LGPL-2.1-or-later)
const _BINK_VLC_TABLES = (function() {
    const treeBits = [
        [0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F],
        [0x00,0x01,0x03,0x05,0x07,0x09,0x0B,0x0D,0x0F,0x13,0x15,0x17,0x19,0x1B,0x1D,0x1F],
        [0x00,0x02,0x01,0x09,0x05,0x15,0x0D,0x1D,0x03,0x13,0x0B,0x1B,0x07,0x17,0x0F,0x1F],
        [0x00,0x02,0x06,0x01,0x09,0x05,0x0D,0x1D,0x03,0x13,0x0B,0x1B,0x07,0x17,0x0F,0x1F],
        [0x00,0x04,0x02,0x06,0x01,0x09,0x05,0x0D,0x03,0x13,0x0B,0x1B,0x07,0x17,0x0F,0x1F],
        [0x00,0x04,0x02,0x0A,0x06,0x0E,0x01,0x09,0x05,0x0D,0x03,0x0B,0x07,0x17,0x0F,0x1F],
        [0x00,0x02,0x0A,0x06,0x0E,0x01,0x09,0x05,0x0D,0x03,0x0B,0x1B,0x07,0x17,0x0F,0x1F],
        [0x00,0x01,0x05,0x03,0x13,0x0B,0x1B,0x3B,0x07,0x27,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x01,0x03,0x13,0x0B,0x2B,0x1B,0x3B,0x07,0x27,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x01,0x05,0x0D,0x03,0x13,0x0B,0x1B,0x07,0x27,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x02,0x01,0x05,0x0D,0x03,0x13,0x0B,0x1B,0x07,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x01,0x09,0x05,0x0D,0x03,0x13,0x0B,0x1B,0x07,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x02,0x01,0x03,0x13,0x0B,0x1B,0x3B,0x07,0x27,0x17,0x37,0x0F,0x2F,0x1F,0x3F],
        [0x00,0x01,0x05,0x03,0x07,0x27,0x17,0x37,0x0F,0x4F,0x2F,0x6F,0x1F,0x5F,0x3F,0x7F],
        [0x00,0x01,0x05,0x03,0x07,0x17,0x37,0x77,0x0F,0x4F,0x2F,0x6F,0x1F,0x5F,0x3F,0x7F],
        [0x00,0x02,0x01,0x05,0x03,0x07,0x27,0x17,0x37,0x0F,0x2F,0x6F,0x1F,0x5F,0x3F,0x7F],
    ];
    const treeLens = [
        [4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],
        [1,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5],
        [2,2,4,4,5,5,5,5,5,5,5,5,5,5,5,5],
        [2,3,3,4,4,4,5,5,5,5,5,5,5,5,5,5],
        [3,3,3,3,4,4,4,4,5,5,5,5,5,5,5,5],
        [3,3,4,4,4,4,4,4,4,4,4,4,5,5,5,5],
        [2,4,4,4,4,4,4,4,4,4,5,5,5,5,5,5],
        [1,3,3,5,5,5,6,6,6,6,6,6,6,6,6,6],
        [1,2,5,5,6,6,6,6,6,6,6,6,6,6,6,6],
        [1,3,4,4,5,5,5,5,6,6,6,6,6,6,6,6],
        [2,2,3,4,4,5,5,5,5,5,6,6,6,6,6,6],
        [1,4,4,4,4,5,5,5,5,5,6,6,6,6,6,6],
        [2,2,2,5,5,5,6,6,6,6,6,6,6,6,6,6],
        [1,3,3,3,6,6,6,6,7,7,7,7,7,7,7,7],
        [1,3,3,3,5,6,7,7,7,7,7,7,7,7,7,7],
        [2,2,3,3,3,6,6,6,6,6,7,7,7,7,7,7],
    ];
    const tables = [];
    for (let i = 0; i < 16; i++) {
        const maxBits = treeLens[i][15];
        const tableSize = 1 << maxBits;
        const table = new Uint8Array(tableSize); // packed: (sym << 4) | len
        for (let j = 0; j < 16; j++) {
            const code = treeBits[i][j];
            const len = treeLens[i][j];
            const numExt = 1 << (maxBits - len);
            for (let ext = 0; ext < numExt; ext++) {
                table[code | (ext << len)] = (j << 4) | len;
            }
        }
        tables.push({ table, maxBits });
    }
    return tables;
})();

// RLE lengths for block type run-length encoding
const _BINK_BT_RLE_LENS = [4, 8, 12, 32];

// Pre-computed quantization tables for Bink versions > 'b' (from FFmpeg binkdata.h, LGPL-2.1-or-later)
const _BINK_INTRA_QUANT = [
  new Int32Array([65536,90901,124989,173365,85627,91511,192998,160332,65536,61146,147714,98203,48768,24862,67644,42322,139144,121939,163757,128663,83993,42819,88625,38536,144495,200421,130042,180374,118784,164758,102983,129450,144495,130042,121939,143800,77586,122988,51984,72104,115852,104264,85638,74415,181800,163616,169909,147250,151552,109419,119074,88499,75369,36163,60959,30189,84236,66184,63285,61265,57585,29357,42200,25879]),
  new Int32Array([87381,121201,166652,231153,114169,122015,257331,213777,87381,81528,196952,130938,65024,33149,90191,56429,185525,162585,218343,171551,111991,57092,118166,51382,192661,267228,173390,240499,158379,219678,137310,172600,192661,173390,162585,191733,103448,163984,69312,96138,154470,139019,114185,99220,242400,218154,226545,196334,202069,145892,158765,117998,100492,48217,81278,40252,112315,88245,84380,81687,76780,39142,56267,34505]),
  new Int32Array([109227,151502,208315,288941,142712,152519,321663,267221,109227,101910,246190,163672,81280,41436,112739,70536,231906,203231,272929,214439,139988,71365,147708,64227,240826,334035,216737,300623,197973,274597,171638,215749,240826,216737,203231,239667,129310,204980,86640,120173,193087,173774,142731,124025,303000,272693,283181,245417,252587,182365,198456,147498,125615,60271,101598,50314,140393,110306,105474,102109,95975,48928,70334,43131]),
  new Int32Array([131072,181802,249978,346729,171254,183023,385996,320665,131072,122292,295428,196406,97537,49724,135287,84643,278287,243878,327514,257326,167986,85638,177249,77073,288991,400842,260085,360748,237568,329516,205965,258899,288991,260085,243878,287600,155172,245976,103968,144207,231705,208529,171277,148830,363600,327231,339817,294501,303104,218838,238147,176997,150738,72325,121918,60377,168472,132368,126569,122530,115170,58713,84400,51757]),
  new Int32Array([174763,242403,333304,462306,228338,244030,514661,427553,174763,163056,393905,261875,130049,66298,180383,112858,371050,325170,436686,343102,223981,114185,236333,102763,385321,534456,346780,480997,316757,439355,274620,345199,385321,346780,325170,383467,206896,327969,138624,192276,308940,278038,228369,198440,484800,436309,453090,392667,404139,291784,317530,235996,200984,96434,162557,80503,224630,176490,168759,163374,153560,78284,112534,69009]),
  new Int32Array([229376,318154,437461,606776,299694,320290,675493,561164,229376,214011,517000,343711,170689,87016,236752,148126,487003,426786,573150,450321,293975,149867,310187,134877,505734,701473,455149,631309,415744,576654,360439,453074,505734,455149,426786,503300,271551,430459,181944,252363,405483,364925,299735,260452,636300,572655,594680,515376,530432,382967,416758,309745,263792,126569,213356,105660,294826,231644,221496,214428,201548,102748,147701,90575]),
  new Int32Array([262144,363604,499956,693459,342508,366045,771992,641330,262144,244584,590857,392813,195073,99447,270574,169287,556575,487756,655029,514653,335972,171277,354499,154145,577982,801684,520170,721496,475136,659033,411930,517799,577982,520170,487756,575200,310344,491953,207935,288415,463410,417058,342554,297660,727200,654463,679635,589001,606208,437676,476295,353994,301477,144651,243835,120755,336944,264736,253139,245061,230341,117427,168801,103514]),
  new Int32Array([327680,454505,624945,866823,428135,457557,964990,801662,327680,305730,738571,491016,243841,124309,338218,211609,695719,609695,818786,643316,419965,214096,443124,192682,722477,1002104,650212,901870,593920,823791,514913,647248,722477,650212,609695,719000,387929,614941,259919,360518,579262,521322,428192,372075,909000,818079,849543,736251,757760,547095,595368,442493,376846,180813,304794,150943,421180,330919,316423,306326,287926,146783,211001,129393]),
  new Int32Array([393216,545406,749934,1040188,513761,549068,1157987,961995,393216,366876,886285,589219,292610,149171,405861,253930,834862,731633,982543,771979,503958,256915,531748,231218,866972,1202525,780255,1082244,712704,988549,617896,776698,866972,780255,731633,862800,465515,737929,311903,432622,695114,625586,513831,446490,1090800,981694,1019452,883502,909312,656514,714442,530991,452215,216976,365753,181132,505417,397103,379708,367591,345511,176140,253201,155271]),
  new Int32Array([524288,727208,999912,1386917,685015,732091,1543983,1282660,524288,489167,1181714,785625,390146,198895,541148,338574,1113150,975511,1310057,1029305,671944,342554,708998,308290,1155963,1603367,1040340,1442992,950272,1318065,823861,1035597,1155963,1040340,975511,1150400,620687,983906,415871,576829,926819,834115,685108,595319,1454400,1308926,1359269,1178002,1212416,875352,952589,707988,602953,289301,487671,241509,673889,529471,506278,490121,460681,234853,337602,207028]),
  new Int32Array([786432,1090813,1499867,2080376,1027523,1098136,2315975,1923990,786432,733751,1772570,1178438,585219,298342,811722,507861,1669725,1463267,1965086,1543958,1007916,513831,1063497,462436,1733945,2405051,1560509,2164489,1425408,1977098,1235791,1553396,1733945,1560509,1463267,1725600,931031,1475859,623806,865244,1390229,1251173,1027662,892979,2181601,1963389,2038904,1767003,1818624,1313028,1428884,1061982,904430,433952,731506,362264,1010833,794206,759416,735182,691022,352280,506402,310542]),
  new Int32Array([1114112,1545318,2124812,2947199,1455658,1555693,3280964,2725652,1114112,1039481,2511141,1669454,829061,422651,1149940,719469,2365444,2072961,2783872,2187274,1427881,727927,1506620,655117,2456422,3407155,2210722,3066359,2019328,2800889,1750704,2200644,2456422,2210722,2072961,2444600,1318960,2090800,883726,1225763,1969490,1772495,1455854,1265054,3090601,2781467,2888447,2503254,2576384,1860123,2024252,1504475,1281275,614766,1036300,513207,1432014,1125126,1075840,1041508,978948,499063,717403,439935]),
  new Int32Array([1441792,1999823,2749757,3814022,1883792,2013250,4245954,3527315,1441792,1345210,3249712,2160470,1072902,546961,1488158,931078,3061162,2682656,3602657,2830590,1847845,942023,1949744,847799,3178899,4409260,2860934,3968229,2613248,3624679,2265618,2847892,3178899,2860934,2682656,3163600,1706889,2705741,1143645,1586281,2548752,2293817,1884047,1637129,3999601,3599546,3737990,3239506,3334144,2407219,2619620,1946967,1658121,795579,1341094,664150,1853194,1456045,1392263,1347834,1266873,645846,928404,569328]),
  new Int32Array([1835008,2545229,3499690,4854210,2397554,2562318,5403941,4489310,1835008,1712086,4135998,2749689,1365511,696132,1894019,1185008,3896025,3414289,4585200,3602569,2351803,1198939,2481492,1079017,4045872,5611785,3641188,5050473,3325952,4613228,2883513,3624590,4045872,3641188,3414289,4026400,2172405,3443670,1455548,2018903,3243867,2919403,2397878,2083618,5090401,4581240,4757442,4123007,4243456,3063733,3334062,2477958,2110336,1012555,1706847,845282,2358611,1853148,1771972,1715425,1612384,821986,1181605,724599]),
  new Int32Array([2228224,3090636,4249624,5894398,2911315,3111386,6561929,5451305,2228224,2078961,5022283,3338908,1658121,845303,2299880,1438939,4730887,4145923,5567743,4374548,2855761,1455854,3013241,1310234,4912844,6814311,4421443,6132718,4038656,5601777,3501409,4401288,4912844,4421443,4145923,4889200,2637920,4181600,1767451,2451525,3938981,3544989,2911709,2530108,6181202,5562935,5776894,5006509,5152768,3720247,4048504,3008949,2562551,1229531,2072600,1026414,2864027,2250252,2151680,2083016,1957895,998126,1434807,879870]),
  new Int32Array([2883584,3999646,5499513,7628044,3767584,4026499,8491907,7054629,2883584,2690421,6499425,4320940,2145804,1093921,2976315,1862156,6122324,5365312,7205314,5661179,3695691,1884047,3899488,1695597,6357798,8818519,5721867,7936458,5226496,7249358,4531235,5695784,6357798,5721867,5365312,6327200,3413779,5411482,2287290,3172562,5097505,4587633,3768094,3274257,7999202,7199092,7475980,6479011,6668288,4814437,5239241,3893934,3316242,1591158,2682189,1328300,3706388,2912090,2784527,2695668,2533747,1291693,1856808,1138655]),
];

const _BINK_INTER_QUANT = [
  new Int32Array([65536,96582,107945,149724,90979,86695,148460,133610,73728,57928,113626,89276,42118,21472,61494,32917,112385,92505,110777,87037,63719,32484,59952,30563,112385,155883,105961,146971,94208,130670,77237,107131,123089,110777,100915,94605,55418,83017,31642,43889,78200,70378,44296,39865,146839,132151,138444,124596,98304,77237,83673,65742,53202,28252,45284,23085,59852,47025,33903,27525,33591,17125,18960,10289]),
  new Int32Array([87381,128776,143927,199632,121305,115593,197947,178147,98304,77237,151502,119034,56157,28629,81992,43889,149847,123340,147703,116049,84958,43311,79936,40751,149847,207844,141281,195962,125611,174227,102983,142841,164118,147703,134553,126140,73891,110689,42190,58519,104267,93838,59061,53154,195785,176202,184592,166129,131072,102983,111564,87656,70936,37669,60378,30781,79803,62701,45203,36700,44788,22833,25279,13719]),
  new Int32Array([109227,160971,179908,249540,151631,144492,247433,222684,122880,96546,189377,148793,70197,35786,102490,54861,187309,154176,184628,145061,106198,54139,99920,50939,187309,259805,176601,244952,157013,217784,128728,178551,205148,184628,168192,157675,92364,138362,52737,73149,130334,117297,73826,66442,244731,220252,230740,207661,163840,128728,139456,109570,88670,47087,75473,38476,99753,78376,56504,45875,55986,28541,31599,17148]),
  new Int32Array([131072,193165,215890,299448,181957,173390,296920,267221,147456,115855,227253,178551,84236,42943,122988,65834,224771,185011,221554,174074,127438,64967,119904,61127,224771,311766,211921,293943,188416,261341,154474,214261,246177,221554,201830,189211,110837,166034,63285,87778,156401,140757,88592,79730,293677,264302,276888,249193,196608,154474,167347,131483,106403,56504,90567,46171,119704,94051,67805,55050,67183,34249,37919,20578]),
  new Int32Array([174763,257553,287853,399264,242610,231187,395893,356294,196608,154474,303003,238068,112315,57258,163984,87778,299694,246681,295405,232098,169917,86623,159872,81502,299694,415688,282561,391924,251221,348454,205965,285682,328237,295405,269107,252281,147783,221379,84380,117038,208534,187676,118122,106307,391569,352403,369184,332257,262144,205965,223129,175311,141871,75339,120757,61561,159605,125401,90407,73400,89577,45666,50559,27437]),
  new Int32Array([229376,338038,377807,524034,318425,303432,519610,467636,258048,202747,397692,312465,147413,75151,215229,115209,393349,323769,387719,304629,223016,113692,209832,106971,393349,545590,370862,514400,329728,457346,270329,374958,430810,387719,353202,331118,193965,290560,110748,153612,273701,246325,155035,139528,513935,462529,484554,436087,344064,270329,292857,230096,186206,98882,158493,80799,209482,164589,118659,96337,117570,59937,66358,36012]),
  new Int32Array([262144,386329,431780,598896,363914,346780,593840,534442,294912,231711,454505,357102,168472,85886,245976,131668,449541,370021,443108,348147,254875,129934,239808,122253,449541,623532,423842,587886,376832,522681,308948,428523,492355,443108,403660,378421,221674,332068,126569,175557,312801,281514,177183,159461,587354,528605,553776,498385,393216,308948,334693,262967,212807,113008,181135,92342,239408,188102,135610,110100,134365,68499,75838,41156]),
  new Int32Array([327680,482912,539725,748620,454893,433475,742300,668052,368640,289639,568132,446378,210590,107358,307471,164584,561927,462527,553884,435184,318594,162418,299760,152816,561927,779415,529803,734857,471040,653351,386185,535654,615443,553884,504575,473026,277092,415085,158212,219446,391002,351892,221479,199326,734193,660756,692220,622982,491520,386185,418367,328709,266009,141260,226419,115427,299260,235127,169513,137625,167957,85624,94798,51445]),
  new Int32Array([393216,579494,647670,898344,545872,520170,890760,801662,442368,347566,681758,535654,252708,128830,368965,197501,674312,555032,664661,522221,382313,194901,359712,183380,674312,935298,635763,881829,565248,784022,463422,642784,738532,664661,605490,567632,332511,498102,189854,263335,469202,422271,265775,239191,881031,792907,830664,747578,589824,463422,502040,394450,319210,169513,271702,138513,359112,282152,203415,165150,201548,102748,113757,61734]),
  new Int32Array([524288,772659,863560,1197792,727829,693560,1187679,1068883,589824,463422,909010,714205,336944,171773,491953,263335,899083,740043,886215,696295,509750,259869,479616,244506,899083,1247063,847684,1175772,753664,1045362,617896,857046,984710,886215,807320,756842,443348,664136,253139,351114,625603,563028,354366,318921,1174708,1057209,1107553,996771,786432,617896,669387,525934,425614,226017,362270,184683,478816,376203,271220,220200,268731,136998,151676,82312]),
  new Int32Array([786432,1158988,1295340,1796688,1091743,1040340,1781519,1603325,884736,695133,1363516,1071307,505417,257659,737929,395003,1348624,1110064,1329323,1044442,764626,389803,719424,366759,1348624,1870595,1271526,1763657,1130496,1568043,926844,1285569,1477064,1329323,1210979,1135263,665022,996205,379708,526670,938404,844542,531549,478382,1762062,1585814,1661329,1495156,1179648,926844,1004080,788901,638421,339025,543404,277025,718224,564305,406830,330299,403096,205497,227514,123469]),
  new Int32Array([1114112,1641900,1835065,2545308,1546636,1473814,2523819,2271377,1253376,984771,1931647,1517686,716007,365017,1045400,559587,1910551,1572591,1883207,1479626,1083220,552221,1019184,519576,1910551,2650010,1801329,2498515,1601536,2221394,1313028,1821223,2092508,1883207,1715554,1608290,942114,1411290,537920,746116,1329406,1196434,753028,677707,2496255,2246570,2353549,2118138,1671168,1313028,1422447,1117610,904430,480286,769823,392452,1017483,799432,576343,467924,571053,291120,322312,174914]),
  new Int32Array([1441792,2124812,2374790,3293928,2001529,1907289,3266118,2939429,1622016,1274410,2499779,1964064,926597,472375,1352871,724172,2472477,2035118,2437092,1914811,1401814,714638,1318945,672392,2472477,3429424,2331131,3233372,2072576,2874746,1699213,2356876,2707951,2437092,2220129,2081316,1219207,1826375,696132,965562,1720408,1548326,974507,877033,3230447,2907326,3045770,2741120,2162688,1699213,1840814,1446318,1170438,621546,996241,507879,1316743,1034558,745855,605549,739009,376744,417109,226359]),
  new Int32Array([1835008,2704306,3022460,4192272,2547401,2427459,4156878,3741091,2064384,1621976,3181537,2499717,1179305,601205,1721835,921673,3146789,2590150,3101753,2437032,1784127,909540,1678657,855772,3146789,4364722,2966894,4115200,2637824,3658767,2162635,2999661,3446483,3101753,2825619,2648948,1551718,2324478,885986,1228898,2189610,1970597,1240282,1116224,4111478,3700232,3876434,3488698,2752512,2162635,2342854,1840769,1489649,791059,1267944,646392,1675855,1316711,949270,770698,940557,479492,530866,288093]),
  new Int32Array([2228224,3283800,3670130,5090616,3093272,2947629,5047638,4542754,2506752,1969542,3863294,3035371,1432014,730034,2090800,1119175,3821101,3145183,3766414,2959253,2166440,1104441,2038369,1039151,3821101,5300019,3602657,4997029,3203072,4442789,2626057,3642445,4185015,3766414,3431108,3216579,1884228,2822580,1075840,1492233,2658812,2392868,1506056,1355415,4992509,4493140,4707099,4236277,3342336,2626057,2844895,2235219,1808859,960571,1539646,784905,2034967,1598863,1152686,935848,1142106,582240,644623,349828]),
  new Int32Array([2883584,4249624,4749580,6587856,4003058,3814578,6532237,5878858,3244032,2548820,4999558,3928127,1853194,944750,2705741,1448344,4944954,4070236,4874183,3829621,2803628,1429277,2637889,1344784,4944954,6858849,4662262,6466744,4145152,5749491,3398426,4713753,5415902,4874183,4440258,4162632,2438413,3652750,1392263,1931125,3440816,3096652,1949014,1754066,6460894,5814651,6091539,5482241,4325376,3398426,3681628,2892637,2340877,1243092,1992483,1015759,2633486,2069117,1491711,1211097,1478019,753488,834218,452718]),
];

// Quantization tables for Bink version 'b' (computed from binkb seed arrays)
const _BINKB_INTRA_QUANT = (function() {
    const q = new Array(16);
    const seed = [16,16,16,19,16,19,22,22,22,22,26,24,26,22,22,27,27,27,26,26,26,29,29,29,27,27,27,26,34,34,34,29,29,29,27,27,37,34,34,32,32,29,29,38,37,35,35,34,35,40,40,40,38,38,48,48,46,46,58,56,56,69,69,83];
    const num = [1,4,5,2,7,8,3,7,4,9,5,6,7,8,9,10];
    const den = [1,3,3,1,3,3,1,2,1,2,1,1,1,1,1,1];
    const s = [
        1073741824,1489322693,1402911301,1262586814,1073741824,843633538,581104888,296244703,
        1489322693,2065749918,1945893874,1751258219,1489322693,1170153332,806015634,410903207,
        1402911301,1945893874,1832991949,1649649171,1402911301,1102260336,759250125,387062357,
        1262586814,1751258219,1649649171,1484645031,1262586814,992008094,683307060,348346918,
        1073741824,1489322693,1402911301,1262586814,1073741824,843633538,581104888,296244703,
        843633538,1170153332,1102260336,992008094,843633538,662838617,456571181,232757969,
        581104888,806015634,759250125,683307060,581104888,456571181,314491699,160326478,
        296244703,410903207,387062357,348346918,296244703,232757969,160326478,81733730
    ];
    const C = 1 << 30;
    const invScan = new Array(64);
    for (let i = 0; i < 64; i++) invScan[_BINK_SCAN[i]] = i;
    for (let j = 0; j < 16; j++) {
        q[j] = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
            const k = invScan[i];
            q[j][k] = Math.round(seed[i] * s[i] * num[j] / (den[j] * (C / 4096)));
        }
    }
    return q;
})();

const _BINKB_INTER_QUANT = (function() {
    const q = new Array(16);
    const seed = [16,17,17,18,18,18,19,19,19,19,20,20,20,20,20,21,21,21,21,21,21,22,22,22,22,22,22,22,23,23,23,23,23,23,23,23,24,24,24,25,24,24,24,25,26,26,26,26,25,27,27,27,27,27,28,28,28,28,30,30,30,31,31,33];
    const num = [1,4,5,2,7,8,3,7,4,9,5,6,7,8,9,10];
    const den = [1,3,3,1,3,3,1,2,1,2,1,1,1,1,1,1];
    const s = [
        1073741824,1489322693,1402911301,1262586814,1073741824,843633538,581104888,296244703,
        1489322693,2065749918,1945893874,1751258219,1489322693,1170153332,806015634,410903207,
        1402911301,1945893874,1832991949,1649649171,1402911301,1102260336,759250125,387062357,
        1262586814,1751258219,1649649171,1484645031,1262586814,992008094,683307060,348346918,
        1073741824,1489322693,1402911301,1262586814,1073741824,843633538,581104888,296244703,
        843633538,1170153332,1102260336,992008094,843633538,662838617,456571181,232757969,
        581104888,806015634,759250125,683307060,581104888,456571181,314491699,160326478,
        296244703,410903207,387062357,348346918,296244703,232757969,160326478,81733730
    ];
    const C = 1 << 30;
    const invScan = new Array(64);
    for (let i = 0; i < 64; i++) invScan[_BINK_SCAN[i]] = i;
    for (let j = 0; j < 16; j++) {
        q[j] = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
            const k = invScan[i];
            q[j][k] = Math.round(seed[i] * s[i] * num[j] / (den[j] * (C / 4096)));
        }
    }
    return q;
})();

// Register video decoder classes into H3 namespace
Object.assign(window.H3, {
    SmackerDecoder,
    BinkHeader,
    BinkDecoder
});
