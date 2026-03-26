// ============================================================
// LZMA2 Decoder - Pure JavaScript implementation
// Based on the 7-Zip LZMA SDK by Igor Pavlov
// (https://www.7-zip.org/sdk.html) - Public Domain
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

const LZMA2Decode = (function () {
    'use strict';

    // ---- Range Decoder ----

    function RangeDecoder(data, pos) {
        this.data = data;
        this.pos = pos;
        this.code = 0;
        this.range = 0xFFFFFFFF;
        // Initialize: read 5 bytes (first ignored, then 4 into code)
        this.pos++; // skip first byte
        for (let i = 0; i < 4; i++) {
            this.code = ((this.code << 8) | this.data[this.pos++]) >>> 0;
        }
    }

    RangeDecoder.prototype.normalize = function () {
        if ((this.range >>> 0) < 0x1000000) {
            this.range = (this.range << 8) >>> 0;
            this.code = ((this.code << 8) | this.data[this.pos++]) >>> 0;
        }
    };

    RangeDecoder.prototype.decodeBit = function (probs, index) {
        this.normalize();
        const bound = ((this.range >>> 11) * probs[index]) >>> 0;
        if ((this.code >>> 0) < (bound >>> 0)) {
            this.range = bound;
            probs[index] += (2048 - probs[index]) >> 5;
            return 0;
        } else {
            this.range = (this.range - bound) >>> 0;
            this.code = (this.code - bound) >>> 0;
            probs[index] -= probs[index] >> 5;
            return 1;
        }
    };

    RangeDecoder.prototype.decodeDirectBits = function (numBits) {
        let result = 0;
        for (let i = 0; i < numBits; i++) {
            this.normalize();
            this.range >>>= 1;
            const t = (this.code - this.range) >>> 31;
            this.code = (this.code - (this.range & (t - 1))) >>> 0;
            result = (result << 1) | (1 - t);
        }
        return result;
    };

    // ---- Bit Tree Decoder ----

    function BitTreeDecoder(numBits) {
        this.numBits = numBits;
        this.probs = new Uint16Array(1 << numBits);
    }

    BitTreeDecoder.prototype.init = function () {
        for (let i = 0; i < this.probs.length; i++) this.probs[i] = 1024;
    };

    BitTreeDecoder.prototype.decode = function (rc) {
        let m = 1;
        for (let i = 0; i < this.numBits; i++) {
            m = (m << 1) | rc.decodeBit(this.probs, m);
        }
        return m - (1 << this.numBits);
    };

    BitTreeDecoder.prototype.reverseDecode = function (rc) {
        let m = 1, symbol = 0;
        for (let i = 0; i < this.numBits; i++) {
            const bit = rc.decodeBit(this.probs, m);
            m = (m << 1) | bit;
            symbol |= bit << i;
        }
        return symbol;
    };

    function reverseDecodeFromProbs(probs, startIndex, rc, numBits) {
        let m = 1, symbol = 0;
        for (let i = 0; i < numBits; i++) {
            const bit = rc.decodeBit(probs, startIndex + m);
            m = (m << 1) | bit;
            symbol |= bit << i;
        }
        return symbol;
    }

    // ---- Length Decoder ----

    function LenDecoder() {
        this.choice = new Uint16Array(2);
        this.lowCoder = [];
        this.midCoder = [];
        this.highCoder = new BitTreeDecoder(8);
        for (let i = 0; i < 16; i++) {
            this.lowCoder[i] = new BitTreeDecoder(3);
            this.midCoder[i] = new BitTreeDecoder(3);
        }
    }

    LenDecoder.prototype.init = function () {
        this.choice[0] = this.choice[1] = 1024;
        this.highCoder.init();
        for (let i = 0; i < 16; i++) {
            this.lowCoder[i].init();
            this.midCoder[i].init();
        }
    };

    LenDecoder.prototype.decode = function (rc, posState) {
        if (!rc.decodeBit(this.choice, 0))
            return this.lowCoder[posState].decode(rc);
        if (!rc.decodeBit(this.choice, 1))
            return 8 + this.midCoder[posState].decode(rc);
        return 16 + this.highCoder.decode(rc);
    };

    // ---- Literal Decoder ----

    function LiteralDecoder(lp, lc) {
        this.lp = lp;
        this.lc = lc;
        this.numStates = 1 << (lp + lc);
        this.coders = [];
        for (let i = 0; i < this.numStates; i++) {
            this.coders[i] = new Uint16Array(768);
        }
    }

    LiteralDecoder.prototype.init = function () {
        for (let i = 0; i < this.numStates; i++) {
            for (let j = 0; j < 768; j++) this.coders[i][j] = 1024;
        }
    };

    LiteralDecoder.prototype.getDecoder = function (pos, prevByte) {
        return this.coders[((pos & ((1 << this.lp) - 1)) << this.lc) + ((prevByte & 0xFF) >>> (8 - this.lc))];
    };

    function decodeLiteral(rc, probs, matchMode, matchByte) {
        let symbol = 1;
        if (matchMode) {
            do {
                const matchBit = (matchByte >> 7) & 1;
                matchByte <<= 1;
                const bit = rc.decodeBit(probs, ((1 + matchBit) << 8) + symbol);
                symbol = (symbol << 1) | bit;
                if (matchBit !== bit) {
                    while (symbol < 0x100) {
                        symbol = (symbol << 1) | rc.decodeBit(probs, symbol);
                    }
                    break;
                }
            } while (symbol < 0x100);
        } else {
            do {
                symbol = (symbol << 1) | rc.decodeBit(probs, symbol);
            } while (symbol < 0x100);
        }
        return symbol & 0xFF;
    }

    // ---- LZMA Decoder State ----

    function LzmaState(lc, lp, pb, dictSize) {
        this.lc = lc;
        this.lp = lp;
        this.pb = pb;
        this.dictSize = dictSize;
        this.posStateMask = (1 << pb) - 1;

        this.isMatch = new Uint16Array(192);
        this.isRep = new Uint16Array(12);
        this.isRepG0 = new Uint16Array(12);
        this.isRepG1 = new Uint16Array(12);
        this.isRepG2 = new Uint16Array(12);
        this.isRep0Long = new Uint16Array(192);

        this.posSlotDecoder = [];
        for (let i = 0; i < 4; i++) this.posSlotDecoder[i] = new BitTreeDecoder(6);
        this.posDecoders = new Uint16Array(114);
        this.posAlignDecoder = new BitTreeDecoder(4);

        this.lenDecoder = new LenDecoder();
        this.repLenDecoder = new LenDecoder();
        this.litDecoder = new LiteralDecoder(lp, lc);

        this.state = 0;
        this.rep0 = 0;
        this.rep1 = 0;
        this.rep2 = 0;
        this.rep3 = 0;
    }

    LzmaState.prototype.initState = function () {
        const fill1024 = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = 1024; };
        fill1024(this.isMatch);
        fill1024(this.isRep);
        fill1024(this.isRepG0);
        fill1024(this.isRepG1);
        fill1024(this.isRepG2);
        fill1024(this.isRep0Long);
        fill1024(this.posDecoders);
        for (let i = 0; i < 4; i++) this.posSlotDecoder[i].init();
        this.posAlignDecoder.init();
        this.lenDecoder.init();
        this.repLenDecoder.init();
        this.litDecoder.init();
        this.state = 0;
        this.rep0 = 0;
        this.rep1 = 0;
        this.rep2 = 0;
        this.rep3 = 0;
    };

    function stateUpdateLit(state) { return state < 4 ? 0 : (state < 10 ? state - 3 : state - 6); }
    function stateUpdateMatch(state) { return state < 7 ? 7 : 10; }
    function stateUpdateRep(state) { return state < 7 ? 8 : 11; }
    function stateUpdateShortRep(state) { return state < 7 ? 9 : 11; }

    // ---- Output Window (Dictionary) ----

    function OutWindow(dictSize) {
        // Make sure dictionary is at least the specified size
        this.size = Math.max(dictSize, 4096);
        this.buf = new Uint8Array(this.size);
        this.pos = 0;
        this.full = false;
    }

    OutWindow.prototype.putByte = function (b) {
        this.buf[this.pos++] = b;
        if (this.pos >= this.size) {
            this.pos = 0;
            this.full = true;
        }
    };

    OutWindow.prototype.getByte = function (dist) {
        let p = this.pos - dist - 1;
        if (p < 0) p += this.size;
        return this.buf[p];
    };

    OutWindow.prototype.copyBlock = function (dist, len) {
        let p = this.pos - dist - 1;
        if (p < 0) p += this.size;
        for (let i = 0; i < len; i++) {
            this.buf[this.pos++] = this.buf[p++];
            if (this.pos >= this.size) { this.pos = 0; this.full = true; }
            if (p >= this.size) p = 0;
        }
    };

    OutWindow.prototype.reset = function () {
        this.pos = 0;
        this.full = false;
    };

    // ---- LZMA1 Block Decoder ----

    function decodeLzmaBlock(lzmaState, outWindow, rc, uncompressedSize, output, outPos) {
        let remaining = uncompressedSize;
        let prevByte = (outWindow.pos > 0 || outWindow.full) ? outWindow.getByte(0) : 0;

        while (remaining > 0) {
            const posState = (outPos + (uncompressedSize - remaining)) & lzmaState.posStateMask;

            if (!rc.decodeBit(lzmaState.isMatch, (lzmaState.state << 4) + posState)) {
                // Literal
                const litProbs = lzmaState.litDecoder.getDecoder(
                    outPos + (uncompressedSize - remaining), prevByte
                );
                const matchMode = lzmaState.state >= 7;
                const matchByte = matchMode ? outWindow.getByte(lzmaState.rep0) : 0;
                prevByte = decodeLiteral(rc, litProbs, matchMode, matchByte);
                outWindow.putByte(prevByte);
                const writeIdx = outPos + (uncompressedSize - remaining);
                if (writeIdx < output.length) output[writeIdx] = prevByte;
                lzmaState.state = stateUpdateLit(lzmaState.state);
                remaining--;
            } else {
                let len;
                if (rc.decodeBit(lzmaState.isRep, lzmaState.state)) {
                    // Rep match
                    if (!rc.decodeBit(lzmaState.isRepG0, lzmaState.state)) {
                        if (!rc.decodeBit(lzmaState.isRep0Long, (lzmaState.state << 4) + posState)) {
                            // Short rep
                            lzmaState.state = stateUpdateShortRep(lzmaState.state);
                            prevByte = outWindow.getByte(lzmaState.rep0);
                            outWindow.putByte(prevByte);
                            const writeIdx = outPos + (uncompressedSize - remaining);
                            if (writeIdx < output.length) output[writeIdx] = prevByte;
                            remaining--;
                            continue;
                        }
                    } else {
                        let dist;
                        if (!rc.decodeBit(lzmaState.isRepG1, lzmaState.state)) {
                            dist = lzmaState.rep1;
                        } else {
                            if (!rc.decodeBit(lzmaState.isRepG2, lzmaState.state)) {
                                dist = lzmaState.rep2;
                            } else {
                                dist = lzmaState.rep3;
                                lzmaState.rep3 = lzmaState.rep2;
                            }
                            lzmaState.rep2 = lzmaState.rep1;
                        }
                        lzmaState.rep1 = lzmaState.rep0;
                        lzmaState.rep0 = dist;
                    }
                    len = lzmaState.repLenDecoder.decode(rc, posState) + 2;
                    lzmaState.state = stateUpdateRep(lzmaState.state);
                } else {
                    // Normal match
                    lzmaState.rep3 = lzmaState.rep2;
                    lzmaState.rep2 = lzmaState.rep1;
                    lzmaState.rep1 = lzmaState.rep0;
                    len = lzmaState.lenDecoder.decode(rc, posState) + 2;
                    lzmaState.state = stateUpdateMatch(lzmaState.state);

                    const lenState = Math.min(len - 2, 3);
                    const posSlot = lzmaState.posSlotDecoder[lenState].decode(rc);
                    if (posSlot >= 4) {
                        const numDirectBits = (posSlot >> 1) - 1;
                        let dist = (2 | (posSlot & 1)) << numDirectBits;
                        if (posSlot < 14) {
                            dist += reverseDecodeFromProbs(
                                lzmaState.posDecoders, dist - posSlot - 1, rc, numDirectBits
                            );
                        } else {
                            dist += rc.decodeDirectBits(numDirectBits - 4) << 4;
                            dist += lzmaState.posAlignDecoder.reverseDecode(rc);
                        }
                        lzmaState.rep0 = dist;
                    } else {
                        lzmaState.rep0 = posSlot;
                    }

                    const available = outWindow.full ? outWindow.size : outWindow.pos;
                    if (lzmaState.rep0 >= available) {
                        if (lzmaState.rep0 === 0xFFFFFFFF) {
                            // End marker — return actual bytes written
                            return uncompressedSize - remaining;
                        }
                        throw new Error('LZMA: invalid distance ' + lzmaState.rep0 + ' >= ' + available);
                    }
                }

                // Copy match
                const writePos = outPos + (uncompressedSize - remaining);
                for (let i = 0; i < len && remaining > 0; i++) {
                    prevByte = outWindow.getByte(lzmaState.rep0);
                    outWindow.putByte(prevByte);
                    const writeIdx = writePos + i;
                    if (writeIdx < output.length) output[writeIdx] = prevByte;
                    remaining--;
                }
            }
        }
        return uncompressedSize;
    }

    // ---- LZMA2 Decoder ----

    /**
     * Decompress LZMA2 data.
     * @param {Uint8Array} data - The LZMA2 data (starting with dict property byte)
     * @param {number} uncompressedTotal - Expected total uncompressed size
     * @returns {Uint8Array} Decompressed data
     */
    function decompress(data, uncompressedTotal) {
        const dictProp = data[0];
        let dictSize;
        if (dictProp > 40) throw new Error('LZMA2: invalid dictionary property');
        if (dictProp === 40) {
            dictSize = 0xFFFFFFFF;
        } else {
            dictSize = ((2 | (dictProp & 1)) << ((dictProp >>> 1) + 11));
        }

        const output = new Uint8Array(uncompressedTotal);
        const outWindow = new OutWindow(dictSize);
        let lzmaState = null;
        let outPos = 0;
        let pos = 1; // skip dict property byte

        while (pos < data.length) {
            const ctrl = data[pos++];

            if (ctrl === 0x00) {
                // End of stream
                break;
            }

            if (ctrl <= 0x02) {
                // Uncompressed block
                const hi = data[pos++];
                const lo = data[pos++];
                const size = ((hi << 8) | lo) + 1;

                if (ctrl === 0x01) {
                    // Reset dictionary
                    outWindow.reset();
                }

                // Copy uncompressed data
                for (let i = 0; i < size; i++) {
                    const b = data[pos++];
                    output[outPos++] = b;
                    outWindow.putByte(b);
                }
                continue;
            }

            if (ctrl < 0x80) {
                throw new Error('LZMA2: invalid control byte 0x' + ctrl.toString(16));
            }

            // Compressed LZMA block
            const mode = ctrl & 0xE0;
            const resetDict = mode === 0xE0;
            const newProps = mode >= 0xC0;
            const resetState = mode >= 0xA0;

            const uncompressedHi = ctrl & 0x1F;
            const uncompressedSize =
                (uncompressedHi << 16 | data[pos] << 8 | data[pos + 1]) + 1;
            pos += 2;

            const compressedSize = (data[pos] << 8 | data[pos + 1]) + 1;
            pos += 2;

            if (newProps) {
                const propsByte = data[pos++];
                const pb = Math.floor(propsByte / 45);
                const lp = Math.floor((propsByte % 45) / 9);
                const lc = propsByte % 9;

                if (lzmaState === null || lzmaState.lc !== lc || lzmaState.lp !== lp || lzmaState.pb !== pb) {
                    lzmaState = new LzmaState(lc, lp, pb, dictSize);
                }
            }

            if (resetDict) {
                outWindow.reset();
            }

            if (resetState) {
                lzmaState.initState();
            }

            // Create range decoder for this block
            const rc = new RangeDecoder(data, pos);

            // Decode LZMA data
            decodeLzmaBlock(lzmaState, outWindow, rc, uncompressedSize, output, outPos);
            outPos += uncompressedSize;
            pos += compressedSize;
        }

        return output;
    }

    // Raw LZMA1 decompression (no LZMA2 container)
    function decompressRaw(data, uncompressedSize, lc, lp, pb, dictSize) {
        const output = new Uint8Array(uncompressedSize);
        const outWindow = new OutWindow(dictSize);
        const lzmaState = new LzmaState(lc, lp, pb, dictSize);
        lzmaState.initState();
        const rc = new RangeDecoder(data, 0);
        decodeLzmaBlock(lzmaState, outWindow, rc, uncompressedSize, output, 0);
        return output;
    }

    // LZMA1 decompression from standard header: props(1) + dictSize(4) + data
    // Uncompressed size unknown — uses end-of-stream marker
    function decompressLzma1(data) {
        const propsByte = data[0];
        const pb = Math.floor(propsByte / 45);
        const lp = Math.floor((propsByte % 45) / 9);
        const lc = propsByte % 9;
        const dictSize = (data[1] | (data[2] << 8) | (data[3] << 16) | ((data[4] << 24) >>> 0)) || 65536;
        const maxSize = Math.max(dictSize * 16, data.length * 20);
        const output = new Uint8Array(maxSize);
        const outWindow = new OutWindow(dictSize);
        const lzmaState = new LzmaState(lc, lp, pb, dictSize);
        lzmaState.initState();
        const rc = new RangeDecoder(data, 5);
        const actualSize = decodeLzmaBlock(lzmaState, outWindow, rc, maxSize, output, 0);
        return output.subarray(0, actualSize);
    }

    return { decompress, decompressRaw, decompressLzma1 };
})();
