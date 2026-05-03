// Mac VISE 3.6 Lite Installer Extractor for HoMM3 Explorer
// Fully reverse-engineered from 'Install Heroes 3 Complete' (Heroes of Might & Magic III, Mac CD)
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
//
// ============================================================
// FORMAT REFERENCE — Mac VISE 3.6 Lite Installer
// (Result of complete reverse engineering of the binary)
// ============================================================
//
// Overview
// --------
// The VISE installer is stored as a Macintosh HFS file:
//   Data fork  — ~383 MB, the installer payload (this file)
//   Resource fork — ~586 KB, CODE/Dcmp/DATA resources (toolbox, code, key)
//
// The data fork begins with an SVCT header, followed by the compressed
// file payload, and ends with a CVCT catalog section.
//
// ── SVCT Header ─────────────────────────────────────────────────────────────
//
//   Offset  Size  Type    Description
//   0x00    4     char[4] Magic: "SVCT"
//   0x04    4     BE u32  Unknown / format version flags
//   0x08    4     BE u32  Unknown
//   0x0C    4     BE u32  Unknown
//   0x10    4     BE u32  CVCT catalog offset from start of file
//   0x14    4     BE u32  CVCT catalog length
//   0x18    4     BE u32  Number of FVCT entries
//   0x1C    ...   –       Remaining header fields (unused for extraction)
//
//   Important: the first compressed file always starts at absolute offset
//   0x0000002C (the byte immediately after the 44-byte SVCT header).
//   All cumulative offsets in FVCT entries are absolute file offsets.
//
// ── CVCT Catalog Section ────────────────────────────────────────────────────
//
//   Located near the end of the data fork.
//   Magic bytes: "CVCT" (4 bytes).  Followed immediately by FVCT entries.
//   FVCT entries are variable-length and begin with the magic bytes "FVCT".
//
// ── FVCT Entry Structure ────────────────────────────────────────────────────
//
//   All multi-byte integers are big-endian.
//   Offsets are relative to the start of the "FVCT" magic:
//
//   +0x00   4   char[4]  Magic: "FVCT"
//   +0x04   4   BE u32   Unknown flags
//   +0x08   4   BE u32   Unknown
//   +0x0C   4   BE u32   Unknown
//   +0x10   4   BE u32   Unknown
//   +0x14   4   BE u32   Unknown
//   +0x18   4   BE u32   Unknown
//   +0x1C   4   BE u32   Unknown
//   +0x20   4   BE u32   Unknown
//   +0x24   4   BE u32   Unknown
//   +0x28   4   BE u32   Unknown
//   +0x2C   4   char[4]  Macintosh file type (OSType), e.g. "LOD ", "MAP ", "APPL"
//   +0x30   4   char[4]  Macintosh creator code (OSType), e.g. "H3XP"
//   +0x34   4   BE u32   Unknown
//   +0x38   4   BE u32   Unknown
//   +0x3C   4   BE u32   Unknown
//   +0x40   4   BE u32   Unknown
//   +0x44   4   BE u32   Compressed data fork size (bytes in installer stream)
//   +0x48   4   BE u32   Uncompressed data fork size (bytes after decompression)
//   +0x4C   4   BE u32   Compressed resource fork size  –OR–
//                         Total uncompressed group size when uncomp_rsrc == 0
//                         and multiple FVCT entries share the same cum_off
//   +0x50   4   BE u32   Uncompressed resource fork size (0 if no separate rsrc fork)
//   +0x54   4   BE u32   Unknown
//   +0x58   4   BE u32   Unknown
//   +0x5C   4   BE u32   Unknown
//   +0x60   4   BE u32   Unknown
//   +0x64   4   BE u32   Cumulative data offset — ABSOLUTE byte position in installer
//                         data fork where the compressed block for this file begins.
//                         (Includes the 0x2C SVCT header; first file at 0x0000002C.)
//   +0x68   4   BE u32   Unknown
//   +0x6C   4   BE u32   Unknown
//   +0x70   1   u8       Pascal string length byte (for a preceding field, not the name)
//   ...
//   Somewhere after +0x70: a length byte `L` followed by comma `,` followed by
//   exactly `L` Mac Roman bytes that form the filename.
//   The scanner finds the comma, reads the byte before it as `L`, then reads
//   `L` bytes after the comma as the filename.
//
// ── Grouped Files ───────────────────────────────────────────────────────────
//
//   Multiple FVCT entries may share the same cumulative offset (cum_off).
//   These entries form a "group" where all files are packed into ONE shared
//   compressed block. Recognition:
//     - Multiple entries with identical cum_off
//     - When all group members have uncomp_rsrc == 0:
//       comp_rsrc holds the TOTAL uncompressed size of the shared block
//       (= sum of all members' uncomp_data values).
//     - When all group members have uncomp_data == 0 and uncomp_rsrc > 0:
//       This is a resource-fork-only group; comp_rsrc is the compressed size,
//       and files are split by their individual uncomp_rsrc values.
//   The decompressed block is split sequentially in FVCT order.
//
// ── Files with a Separate Resource Fork ─────────────────────────────────────
//
//   A file that has uncomp_rsrc > 0 (and uncomp_data > 0) stores both forks:
//     - Data fork compression starts at cum_off, length = comp_data
//     - Resource fork compression starts at cum_off + comp_data, length = comp_rsrc
//
// ── Decompression Algorithm ─────────────────────────────────────────────────
//
//   Each compressed block uses a two-step pipeline:
//
//   1. Substitution cipher (transposition table):
//      Replace every byte B with SUBST_TABLE[B].
//      The 256-byte lookup table is stored in the DATA resource of the
//      resource fork, at offset 0x4AC within the DATA resource payload.
//
//      For VISE 3.6 Lite / HoMM3 Complete (fixed table, reverse-engineered):
//      See SUBST_TABLE constant below.
//
//   2. VISE Deflate — a modified RFC 1951 DEFLATE stream:
//
//      Key difference from standard DEFLATE:
//        Standard DEFLATE: reads input bytes, stored blocks byte-aligned
//        VISE DEFLATE:     reads input as 16-bit BIG-ENDIAN words,
//                          stored blocks WORD-aligned (2-byte boundary)
//
//      Bit reading (VISEBitReader):
//        - Input consumed as 16-bit BE words: (data[pos]<<8) | data[pos+1]
//        - Bits are fed into buffer LSB-first (same bit order as standard deflate)
//        - Standard Huffman decoding applies (RFC 1951 alphabet)
//
//      Block types (btype field, 2 bits after BFINAL bit):
//        BTYPE=0: Stored block
//          - align_word(): flush bit buffer entirely (not byte-align as in std)
//          - read 16-bit word → LEN (little-endian stored as 2 BE bytes = word)
//          - read 16-bit word → NLEN (must equal LEN ^ 0xFFFF)
//          - read LEN bytes from word-ordered byte stream (8 bits/call)
//          - align_word() again (odd-length block leaves leftover byte in buffer)
//        BTYPE=1: Fixed Huffman (standard RFC 1951 tables, standard bit order)
//        BTYPE=2: Dynamic Huffman (standard RFC 1951 header + tables, standard bit order)
//
//      LZ77 back-reference tables: identical to RFC 1951 (length codes 257-285,
//      distance codes 0-29, extra bits, base values all standard).
//
// ── Resource Fork DATA Resource ─────────────────────────────────────────────
//
//   Standard Macintosh Resource Fork layout (Inside Macintosh: Files, §1).
//   Resource type 'DATA' (0x44415441):
//     - Resource header at data_off + resource_data_offset
//     - 4-byte length prefix, then payload
//     - Substitution table at payload offset 0x4AC (256 bytes)
//     - The table is a valid permutation (all 256 values distinct)
//
// ============================================================

const VISEExtract = (() => {
    'use strict';

    // ── Substitution table ────────────────────────────────────────────────────
    // 256-byte permutation extracted from the DATA resource at offset 0x4AC
    // in the resource fork of 'Install Heroes 3 Complete' (VISE 3.6 Lite).
    // Applies to ALL compressed blocks in the installer.
    /* eslint-disable */
    const SUBST_TABLE = new Uint8Array([
        0x6a,0xb7,0x36,0xec,0x15,0xd9,0xc8,0x73,0xe8,0x38,0x9a,0xdf,0x21,0x25,0xd0,0xcc,
        0xfd,0xdc,0x16,0xd7,0xe3,0x43,0x05,0xc5,0x8f,0x48,0xda,0xf2,0x3f,0x10,0x23,0x6c,
        0x77,0x7c,0xf9,0xa0,0xa3,0xe9,0xed,0x46,0x8b,0xd8,0xac,0x54,0xce,0x2d,0x19,0x5e,
        0x6d,0x7d,0x87,0x5d,0xfa,0x5b,0x9b,0xe0,0xc7,0xee,0x9f,0x52,0xa9,0xb9,0x0a,0xd1,
        0xfe,0x78,0x76,0x4a,0x3d,0x44,0x5a,0x96,0x90,0x1f,0x26,0x9d,0x58,0x1b,0x8e,0x57,
        0x59,0xc3,0x0b,0x6b,0xfc,0x1d,0xe6,0xa2,0x7f,0x92,0x4f,0x40,0xb4,0x06,0x72,0x4d,
        0xf4,0x34,0xaa,0xd2,0x49,0xad,0xef,0x22,0x1a,0xb5,0xba,0xbf,0x29,0x68,0x89,0x93,
        0x3e,0x32,0x04,0xf5,0xde,0xe1,0x6f,0xfb,0x67,0xe4,0x7e,0x08,0xaf,0xf0,0xab,0x41,
        0x82,0xea,0x50,0x0f,0x2a,0xc6,0x35,0xb3,0xa8,0xca,0xe5,0x4c,0x45,0x8a,0x97,0xae,
        0xd6,0x66,0x27,0x53,0xc9,0x1c,0x3c,0x03,0x99,0xc1,0x09,0x2e,0x69,0x37,0x8d,0x2f,
        0x60,0xc2,0xa6,0x18,0x4e,0x7a,0xb8,0xcf,0xa7,0x3a,0x17,0xd5,0x9e,0xf1,0x84,0x51,
        0x0d,0xa4,0x64,0xc4,0x1e,0xb1,0x30,0x98,0xbb,0x79,0x01,0xf6,0x62,0x0e,0xb2,0x63,
        0x91,0xcb,0xff,0x80,0x71,0xe7,0xd4,0x00,0xdb,0x75,0x2c,0xbd,0x39,0x33,0x94,0xbc,
        0x8c,0x3b,0xb6,0x20,0x85,0x24,0x88,0x2b,0x70,0x83,0x6e,0x7b,0x9c,0xbe,0x14,0x47,
        0x65,0x4b,0x56,0x81,0xf8,0x12,0x11,0x28,0xeb,0x55,0x74,0xa1,0x31,0xf7,0xb0,0x13,
        0x86,0xdd,0x5f,0x42,0xd3,0x02,0x61,0x95,0x0c,0x5c,0xa5,0xcd,0xc0,0x07,0xe2,0xf3,
    ]);
    /* eslint-enable */

    // ── DEFLATE constants (RFC 1951) ──────────────────────────────────────────

    const FIXED_LIT_LENGTHS = new Uint8Array(288);
    for (let i = 0; i < 144; i++) FIXED_LIT_LENGTHS[i] = 8;
    for (let i = 144; i < 256; i++) FIXED_LIT_LENGTHS[i] = 9;
    for (let i = 256; i < 280; i++) FIXED_LIT_LENGTHS[i] = 7;
    for (let i = 280; i < 288; i++) FIXED_LIT_LENGTHS[i] = 8;

    const FIXED_DIST_LENGTHS = new Uint8Array(32).fill(5);

    // Length codes 257-285: base value and extra bits count
    const LEN_BASE = new Uint16Array([
        3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,
        67,83,99,115,131,163,195,227,258
    ]);
    const LEN_EXTRA = new Uint8Array([
        0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0
    ]);

    // Distance codes 0-29: base value and extra bits count
    const DIST_BASE = new Uint32Array([
        1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,
        257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577
    ]);
    const DIST_EXTRA = new Uint8Array([
        0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13
    ]);

    // Code-length alphabet reorder (RFC 1951 §3.2.7)
    const CODELEN_ORDER = new Uint8Array([
        16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15
    ]);

    // ── VISEBitReader ─────────────────────────────────────────────────────────
    //
    // Reads bits from a byte stream that is logically organised as 16-bit
    // big-endian words.  Bits within each word are consumed LSB-first, which
    // is the same order as standard DEFLATE — the only difference is that the
    // refill unit is a 2-byte word (high byte first), not a single byte.
    //
    // Invariant: _nbits < 16  before each _fill() call, so after _fill()
    // _nbits <= 31, all bits fit in positions 0–30 of a signed 32-bit integer
    // (sign bit always 0 ⇒ no signed-overflow problems in JavaScript).

    class VISEBitReader {
        constructor(data) {
            this._data  = data;   // Uint8Array
            this._pos   = 0;      // byte position (always even when freshly filled)
            this._buf   = 0;      // integer bit buffer, bits[0] = next bit
            this._nbits = 0;      // number of valid bits in _buf
        }

        _fill() {
            // Load one 16-bit BE word.  Called only when _nbits < 16,
            // so the shift _nbits is at most 15, keeping _buf ≤ 2^31-1.
            if (this._pos + 1 >= this._data.length) {
                throw new Error('Unexpected end of VISE deflate stream');
            }
            const word = (this._data[this._pos] << 8) | this._data[this._pos + 1];
            this._pos  += 2;
            this._buf  |= word << this._nbits;
            this._nbits += 16;
        }

        /** Read n bits (≤ 15) from the stream, LSB first. */
        readBits(n) {
            if (n === 0) return 0;
            if (this._nbits < n) this._fill();
            const val   = this._buf & ((1 << n) - 1);
            this._buf >>= n;
            this._nbits -= n;
            return val;
        }

        /**
         * Read exactly 16 bits as an unsigned integer.
         * Used for LEN / NLEN fields of stored blocks.
         * Must only be called when the buffer is already word-aligned
         * (i.e. after align_word()).
         */
        readWord() {
            // After align_word() the buffer is empty; load one word fresh.
            if (this._nbits === 0) this._fill();
            // We now have exactly 16 bits available.
            const val   = this._buf & 0xFFFF;
            this._buf >>= 16;
            this._nbits -= 16;
            return val;
        }

        /**
         * Align to the next 16-bit word boundary.
         * Discards ALL bits currently in the buffer (including a partial word
         * left over from an odd-length stored block).
         * This is the key VISE-vs-standard-DEFLATE difference for BTYPE=0.
         */
        alignWord() {
            this._buf   = 0;
            this._nbits = 0;
        }

        /**
         * Read one byte from the stored-block byte-stream.
         * After alignWord(), data is consumed 8 bits at a time from
         * successive words (2 bytes per word, high byte first in the word).
         */
        readStoredByte() {
            if (this._nbits < 8) this._fill();
            const val   = this._buf & 0xFF;
            this._buf >>= 8;
            this._nbits -= 8;
            return val;
        }
    }

    // ── Huffman table builder ─────────────────────────────────────────────────
    //
    // Returns a flat array `table` of size (1 << maxBits).
    // Each entry is either null (invalid code) or a packed integer:
    //   bits[0..7]  = symbol  (up to 286 for lit, 30 for dist)
    //   bits[8..12] = actual code length in bits (1–15)
    // Using  entry = sym | (len << 9)  with sym ≤ 285, len ≤ 15 → fits 16 bits.

    function buildHuffmanTable(lengths) {
        let maxBits = 0;
        for (let i = 0; i < lengths.length; i++) {
            if (lengths[i] > maxBits) maxBits = lengths[i];
        }
        if (maxBits === 0) return { table: null, maxBits: 0 };

        // RFC 1951 §3.2.2 — assign codes
        const blCount = new Int32Array(maxBits + 1);
        for (let i = 0; i < lengths.length; i++) {
            if (lengths[i]) blCount[lengths[i]]++;
        }
        const nextCode = new Int32Array(maxBits + 1);
        let code = 0;
        for (let bits = 1; bits <= maxBits; bits++) {
            code = (code + blCount[bits - 1]) << 1;
            nextCode[bits] = code;
        }

        // Build canonical assignment symbol → (code, len)
        const tableSize = 1 << maxBits;
        const table = new Int32Array(tableSize).fill(-1);

        for (let sym = 0; sym < lengths.length; sym++) {
            const len = lengths[sym];
            if (len === 0) continue;
            const c = nextCode[len]++;

            // Reverse the code bits (deflate reads LSB first)
            let revCode = 0;
            for (let b = 0; b < len; b++) {
                if (c & (1 << (len - 1 - b))) revCode |= (1 << b);
            }
            // Populate all table entries that share this prefix
            const fill = 1 << (maxBits - len);
            for (let p = 0; p < fill; p++) {
                table[revCode | (p << len)] = sym | (len << 9);
            }
        }

        return { table, maxBits };
    }

    /** Decode one Huffman symbol using a pre-built table. */
    function decodeSymbol(reader, table, maxBits) {
        if (reader._nbits < maxBits) reader._fill();
        const idx   = reader._buf & ((1 << maxBits) - 1);
        const entry = table[idx];
        if (entry < 0) throw new Error('Invalid Huffman code at bit pos ' + reader._pos);
        const sym  = entry & 0x1FF;
        const bits = (entry >> 9) & 0x1F;
        reader._buf  >>= bits;
        reader._nbits -= bits;
        return sym;
    }

    // ── Inflate one Huffman-coded block ───────────────────────────────────────

    function inflateBlock(reader, litTable, litMaxBits, distTable, distMaxBits, out, outPos) {
        let pos = outPos;
        while (true) {
            const sym = decodeSymbol(reader, litTable, litMaxBits);

            if (sym < 256) {
                out[pos++] = sym;
            } else if (sym === 256) {
                break; // end-of-block
            } else {
                // Length / distance back-reference
                const li      = sym - 257;
                let   length  = LEN_BASE[li];
                const lextra  = LEN_EXTRA[li];
                if (lextra) length += reader.readBits(lextra);

                const distSym = decodeSymbol(reader, distTable, distMaxBits);
                let   dist    = DIST_BASE[distSym];
                const dextra  = DIST_EXTRA[distSym];
                if (dextra) dist += reader.readBits(dextra);

                let src = pos - dist;
                if (src < 0) throw new Error(`VISE: distance ${dist} exceeds output position ${pos}`);

                // Copy (may overlap — byte-by-byte required for RLE runs)
                for (let i = 0; i < length; i++) out[pos++] = out[src++];
            }
        }
        return pos;
    }

    // ── Main VISE inflate loop ────────────────────────────────────────────────

    function viseInflate(data, expectedSize) {
        const reader = new VISEBitReader(data);
        const out    = expectedSize > 0 ? new Uint8Array(expectedSize) : null;
        // For unknown size we collect chunks and concatenate at the end.
        let chunks  = out ? null : [];
        let outPos  = 0;

        // Pre-build fixed Huffman tables (RFC 1951 §3.2.6)
        const { table: fixedLitT,  maxBits: fixedLitB  } = buildHuffmanTable(FIXED_LIT_LENGTHS);
        const { table: fixedDistT, maxBits: fixedDistB } = buildHuffmanTable(FIXED_DIST_LENGTHS);

        let bfinal = 0;
        while (!bfinal) {
            bfinal = reader.readBits(1);
            const btype = reader.readBits(2);

            if (btype === 0) {
                // ── Stored block ──────────────────────────────────────────────
                // VISE difference: align to WORD (16-bit) boundary, not byte boundary.
                reader.alignWord();
                const len  = reader.readWord();
                const nlen = reader.readWord();
                if ((len ^ nlen) !== 0xFFFF) {
                    throw new Error(`VISE stored block: LEN=${len} NLEN=${nlen} checksum mismatch`);
                }
                if (out) {
                    for (let i = 0; i < len; i++) out[outPos++] = reader.readStoredByte();
                } else {
                    const chunk = new Uint8Array(len);
                    for (let i = 0; i < len; i++) chunk[i] = reader.readStoredByte();
                    chunks.push(chunk);
                    outPos += len;
                }
                // Re-align after stored data (odd-length block leaves 8 leftover bits)
                reader.alignWord();

            } else if (btype === 1) {
                // ── Fixed Huffman block ───────────────────────────────────────
                if (out) {
                    outPos = inflateBlock(reader, fixedLitT, fixedLitB, fixedDistT, fixedDistB, out, outPos);
                } else {
                    const tmp    = new Uint8Array(65536);
                    const end    = inflateBlock(reader, fixedLitT, fixedLitB, fixedDistT, fixedDistB, tmp, 0);
                    chunks.push(tmp.subarray(0, end));
                    outPos += end;
                }

            } else if (btype === 2) {
                // ── Dynamic Huffman block ─────────────────────────────────────
                const hlit  = reader.readBits(5) + 257;
                const hdist = reader.readBits(5) + 1;
                const hclen = reader.readBits(4) + 4;

                const clLengths = new Uint8Array(19);
                for (let i = 0; i < hclen; i++) clLengths[CODELEN_ORDER[i]] = reader.readBits(3);
                const { table: clTable, maxBits: clBits } = buildHuffmanTable(clLengths);

                const allLengths = new Uint8Array(hlit + hdist);
                let   ai         = 0;
                while (ai < allLengths.length) {
                    const sym = decodeSymbol(reader, clTable, clBits);
                    if (sym < 16) {
                        allLengths[ai++] = sym;
                    } else if (sym === 16) {
                        const rep = reader.readBits(2) + 3;
                        const prev = ai > 0 ? allLengths[ai - 1] : 0;
                        for (let r = 0; r < rep; r++) allLengths[ai++] = prev;
                    } else if (sym === 17) {
                        ai += reader.readBits(3) + 3;  // zeros
                    } else { // sym === 18
                        ai += reader.readBits(7) + 11; // zeros
                    }
                }

                const { table: litT,  maxBits: litB  } = buildHuffmanTable(allLengths.subarray(0, hlit));
                const { table: distT, maxBits: distB } = buildHuffmanTable(allLengths.subarray(hlit));

                if (out) {
                    outPos = inflateBlock(reader, litT, litB, distT, distB, out, outPos);
                } else {
                    const tmp  = new Uint8Array(65536);
                    const end  = inflateBlock(reader, litT, litB, distT, distB, tmp, 0);
                    chunks.push(tmp.subarray(0, end));
                    outPos += end;
                }

            } else {
                throw new Error(`VISE: invalid block type ${btype}`);
            }
        }

        if (out) return out.subarray(0, outPos);
        // Concatenate chunks
        const result = new Uint8Array(outPos);
        let off = 0;
        for (const c of chunks) { result.set(c, off); off += c.length; }
        return result;
    }

    // ── Full decompression pipeline ───────────────────────────────────────────
    // Step 1: Apply substitution table  ·  Step 2: VISE deflate

    function decompressVise(raw, expectedSize) {
        // Substitute
        const dec = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) dec[i] = SUBST_TABLE[raw[i]];
        // Inflate
        return viseInflate(dec, expectedSize);
    }

    // ── FVCT entry parser ─────────────────────────────────────────────────────

    function parseFvctEntries(data) {
        // Find CVCT catalog section
        let cvctPos = -1;
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0x43 && data[i+1] === 0x56 && data[i+2] === 0x43 && data[i+3] === 0x54) {
                cvctPos = i; break;
            }
        }
        if (cvctPos < 0) throw new Error('VISE: CVCT catalog not found');

        const dv      = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const entries = [];
        let pos       = cvctPos;

        while (pos < data.length - 4) {
            // Scan for next FVCT
            let fvctPos = -1;
            for (let i = pos; i < data.length - 4; i++) {
                if (data[i] === 0x46 && data[i+1] === 0x56 && data[i+2] === 0x43 && data[i+3] === 0x54) {
                    fvctPos = i; break;
                }
            }
            if (fvctPos < 0) break;

            const b = fvctPos;
            if (b + 0x70 + 200 > data.length) break;

            const fileType  = String.fromCharCode(data[b+0x2C], data[b+0x2D], data[b+0x2E], data[b+0x2F]);
            const compData  = dv.getUint32(b + 0x44, false);
            const uncompData= dv.getUint32(b + 0x48, false);
            const compRsrc  = dv.getUint32(b + 0x4C, false);
            const uncompRsrc= dv.getUint32(b + 0x50, false);
            const cumOff    = dv.getUint32(b + 0x64, false);

            // Find filename: scan for comma after 0x70, byte before comma = length
            let name = '';
            for (let s = b + 0x70; s < b + 0x70 + 200 && s < data.length; s++) {
                if (data[s] === 0x2C) { // ','
                    const nameLen = data[s - 1];
                    if (nameLen > 0 && nameLen < 200 && s + nameLen < data.length) {
                        const nameBytes = data.subarray(s + 1, s + 1 + nameLen);
                        for (let k = 0; k < nameBytes.length; k++) {
                            name += String.fromCharCode(nameBytes[k]);
                        }
                    }
                    break;
                }
            }

            entries.push({ fileType, compData, uncompData, compRsrc, uncompRsrc, cumOff, name });
            pos = fvctPos + 4;
        }

        // Sort by cumulative offset (installation order)
        entries.sort((a, b) => a.cumOff - b.cumOff);
        return entries;
    }

    // ── Main extraction engine ────────────────────────────────────────────────
    //
    // Calls onFile(name, data) for each extracted file.
    // Calls onProgress(doneFiles, totalFiles, currentName) for UI updates.
    // Returns a promise that resolves when all files are extracted.

    async function extractAll(data, { onFile, onProgress } = {}) {
        const entries = parseFvctEntries(data);
        const total   = entries.length;

        // Group entries by cumulative offset
        const groups = new Map();
        for (const e of entries) {
            const key = e.cumOff;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }

        let done = 0;
        const processedOffsets = new Set();

        for (const entry of entries) {
            const name = entry.name || `unknown_${done}`;
            if (!entry.compData) { done++; continue; }

            const cumOff = entry.cumOff;
            const group  = groups.get(cumOff);
            const isGrouped = group.length > 1;

            if (isGrouped) {
                if (processedOffsets.has(cumOff)) { continue; } // already counted when group was first processed
                processedOffsets.add(cumOff);

                // Determine if this is a data-fork group or resource-fork group
                const isRsrcGroup = group.every(e => e.uncompData === 0 && e.uncompRsrc > 0);
                const sizeField   = isRsrcGroup ? 'uncompRsrc' : 'uncompData';
                const suffix      = isRsrcGroup ? '.rsrc' : '';
                const totalUncomp = isRsrcGroup
                    ? group.reduce((s, e) => s + e.uncompRsrc, 0)
                    : (entry.uncompRsrc === 0 ? entry.compRsrc : group.reduce((s, e) => s + e.uncompData, 0));

                if (onProgress) onProgress(done, total, `Group (${group.length} files)`);
                // Yield to UI
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                const raw    = data.subarray(cumOff, cumOff + entry.compData);
                const result = decompressVise(raw, totalUncomp);

                let off = 0;
                for (const ge of group) {
                    const sz = ge[sizeField];
                    if (sz === 0) { done++; continue; }
                    const safeName = _safeName(ge.name || 'unknown') + suffix;
                    if (onFile) onFile(safeName, result.subarray(off, off + sz));
                    off  += sz;
                    done++;
                }

            } else {
                // Single file
                if (!entry.uncompData) { done++; continue; }
                if (onProgress) onProgress(done, total, name);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                const raw    = data.subarray(cumOff, cumOff + entry.compData);
                const result = decompressVise(raw, entry.uncompData);
                const safe   = _safeName(name);
                if (onFile) onFile(safe, result);
                done++;

                // Separate resource fork?
                if (entry.uncompRsrc > 0) {
                    const rsrcOff  = cumOff + entry.compData;
                    const rsrcRaw  = data.subarray(rsrcOff, rsrcOff + entry.compRsrc);
                    const rsrcData = decompressVise(rsrcRaw, entry.uncompRsrc);
                    if (onFile) onFile(safe + '.rsrc', rsrcData);
                }
            }
        }
    }

    function _safeName(name) {
        return name.replace(/[/:\\]/g, '_').replace(/\x00/g, '') || 'unnamed';
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        /**
         * Check if this looks like a Mac VISE installer data fork.
         * The data fork starts with "SVCT" at offset 0.
         * @param {Uint8Array} data
         * @returns {boolean}
         */
        isViseInstaller(data) {
            return data.length > 4 &&
                data[0] === 0x53 && data[1] === 0x56 &&   // 'SV'
                data[2] === 0x43 && data[3] === 0x54;      // 'CT'
        },

        /**
         * Extract game-relevant files (LOD, SND, VID) from a VISE installer.
         * Calls onGameFile(name, Uint8Array) for each game file found.
         * Calls onProgress(done, total, currentName) for progress reporting.
         * @param {Uint8Array} data      — installer data fork
         * @param {Object}     callbacks — { onGameFile, onProgress }
         * @returns {Promise<number>}    — number of game files extracted
         */
        async extractGameFiles(data, { onGameFile, onProgress } = {}) {
            const GAME_EXTS = new Set(['lod', 'snd', 'vid']);
            let count = 0;
            await extractAll(data, {
                onFile(name, fileData) {
                    const ext = name.includes('.')
                        ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
                        : '';
                    if (GAME_EXTS.has(ext)) {
                        if (onGameFile) onGameFile(name, fileData);
                        count++;
                    }
                },
                onProgress,
            });
            return count;
        },
    };
})();
