// ============================================================
// ISExtract.js - InstallShield v5 self-extracting EXE decoder
// Extracts HoMM3 demo files from h3demo.exe
// (MS Cabinet outer wrapper + InstallShield v5 inner cabinet)
//
// SPDX-License-Identifier: LGPL-2.1-or-later
// Based on format research from unshield by David Eriksson (LGPL-2.1)
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

const ISExtract = (() => {
    'use strict';

    const IS_CAB_SIG    = 0x28635349; // "ISc(" LE
    const FILE_OBFUSCATED = 2;
    const FILE_COMPRESSED = 4;
    const FILE_INVALID    = 8;

    // ---- Low-level read helpers ----

    function rl16(d, o) {
        return d[o] | (d[o + 1] << 8);
    }

    function rl32(d, o) {
        return ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0);
    }

    function cstr(d, o) {
        let e = o;
        while (e < d.length && d[e] !== 0) e++;
        let s = '';
        for (let i = o; i < e; i++) s += String.fromCharCode(d[i]);
        return s;
    }

    // ============================================================
    // MS Cabinet (MSCF) extractor
    // ============================================================

    // Scan buffer for a valid MSCF cabinet signature and return its offset, or -1.
    // Validates the reserved field (must be 0) and version (must be 1.x) to skip
    // false positives inside PE code/data sections.
    function findMscf(data) {
        const N = data.length - 36;
        for (let i = 0; i < N; i++) {
            if (data[i] !== 0x4D || data[i + 1] !== 0x53 ||
                data[i + 2] !== 0x43 || data[i + 3] !== 0x46) continue;
            // cabinet_reserved at +4 must be 0
            if (data[i + 4] !== 0 || data[i + 5] !== 0 ||
                data[i + 6] !== 0 || data[i + 7] !== 0) continue;
            // versionMajor at +25 must be 1
            if (data[i + 25] !== 1) continue;
            return i;
        }
        return -1;
    }

    // Parse cabinet header at `base`. Returns { folders, files, cbCFData }.
    function parseMscf(data, base) {
        // CFHEADER (36 bytes minimum):
        //   sig(4) cabinet_reserved(4) cabinet_sz(4) folder_reserved(4) files_off(4)
        //   data_reserved(4) versionMinor(1) versionMajor(1) cFolders(2) cFiles(2)
        //   flags(2) setID(2) iCabinet(2)
        const coffFiles = rl32(data, base + 16);
        const cFolders  = rl16(data, base + 26);
        const cFiles    = rl16(data, base + 28);
        const flags     = rl16(data, base + 30);

        let p = base + 36;
        let cbCFHeader = 0, cbCFFolder = 0, cbCFData = 0;

        // Optional reserved fields (flags & 0x0004)
        if (flags & 0x0004) {
            cbCFHeader = rl16(data, p); p += 2;
            cbCFFolder = data[p++];
            cbCFData   = data[p++];
            p += cbCFHeader;
        }
        // Optional prev-cabinet strings (flags & 0x0001)
        if (flags & 0x0001) {
            while (data[p]) p++; p++;  // szCabinetPrev
            while (data[p]) p++; p++;  // szDiskPrev
        }
        // Optional next-cabinet strings (flags & 0x0002)
        if (flags & 0x0002) {
            while (data[p]) p++; p++;  // szCabinetNext
            while (data[p]) p++; p++;  // szDiskNext
        }

        // CFFOLDER entries (8 bytes + cbCFFolder reserved each)
        const folders = [];
        for (let i = 0; i < cFolders; i++) {
            folders.push({
                coffCabStart: rl32(data, p),
                cCFData:      rl16(data, p + 4),
                typeCompress: rl16(data, p + 6),
            });
            p += 8 + cbCFFolder;
        }

        // CFFILE entries (16 bytes header + null-terminated szName each)
        let fp = base + coffFiles;
        const files = [];
        for (let i = 0; i < cFiles; i++) {
            const cbFile  = rl32(data, fp);      // uncompressed file size
            const uoff    = rl32(data, fp + 4);  // offset in folder's uncompressed stream
            const iFolder = rl16(data, fp + 8);  // folder index
            fp += 16;                             // skip cbFile + uoff + iFolder + date + time + attr
            const name = cstr(data, fp);
            fp += name.length + 1;
            files.push({ cbFile, uoff, iFolder, name });
        }

        return { folders, files, cbCFData };
    }

    // Decompress all CFDATA blocks of a single folder into one Uint8Array.
    // MSZip (typeCompress=1): each CFDATA block is a complete DEFLATE stream
    // (BFINAL=1) preceded by 'CK' (0x43 0x4B), but blocks share the LZ77
    // sliding-window (last 32 KB of previously decompressed data). A fresh
    // pako.Inflate is created for every block, initialised with a dictionary
    // equal to the last 32768 bytes of all previous output.
    function decompressFolder(data, base, folder, cbCFData) {
        const type = folder.typeCompress & 0x0F;
        let p = base + folder.coffCabStart;
        const parts = [];
        let total = 0;
        let prevWindow = new Uint8Array(0);  // LZ77 history carry

        for (let i = 0; i < folder.cCFData; i++) {
            p += 4;                             // skip checksum
            const cbData = rl16(data, p); p += 2;
            /* cbUncomp */ p += 2;
            p += cbCFData;                      // skip per-block reserved bytes

            const src = data.subarray(p, p + cbData);
            p += cbData;

            if (type === 0) {
                // STORED — no compression
                const copy = src.slice();
                parts.push(copy); total += copy.length;
                // Update window
                const combined = new Uint8Array(prevWindow.length + copy.length);
                combined.set(prevWindow); combined.set(copy, prevWindow.length);
                prevWindow = combined.length > 32768 ? combined.subarray(combined.length - 32768) : combined;
            } else if (type === 1) {
                // MSZip — strip 'CK' magic then inflate with LZ77 window from previous block
                if (src[0] !== 0x43 || src[1] !== 0x4B) {
                    throw new Error(`MSCF block ${i}: missing CK header (MSZip)`);
                }
                const opts = { raw: true };
                if (prevWindow.length > 0) opts.dictionary = prevWindow;
                const inf = new pako.Inflate(opts);
                const blockParts = [];
                let blockTotal = 0;
                inf.onData = chunk => { blockParts.push(chunk); blockTotal += chunk.length; };
                inf.push(src.subarray(2), true /* Z_FINISH, BFINAL=1 block */);
                if (inf.err < 0) throw new Error(`MSZip inflate error at block ${i}: ${inf.msg}`);

                // Carry the window forward: last 32768 bytes of all decompressed output so far
                const combined = new Uint8Array(prevWindow.length + blockTotal);
                combined.set(prevWindow);
                let woff = prevWindow.length;
                for (const c of blockParts) { combined.set(c, woff); woff += c.length; }
                prevWindow = combined.length > 32768 ? combined.subarray(combined.length - 32768) : combined;

                for (const c of blockParts) { parts.push(c); total += c.length; }
            } else {
                throw new Error(`Unsupported MSCF compression type: ${type}`);
            }
        }

        const result = new Uint8Array(total);
        let off = 0;
        for (const part of parts) { result.set(part, off); off += part.length; }
        return result;
    }

    // Extract all files from the MSCF cabinet at `base` within `data`.
    // Returns a Map<lowerCaseName, Uint8Array>.
    function extractMscf(data, base) {
        const { folders, files, cbCFData } = parseMscf(data, base);

        // Decompress each folder's data stream
        const streams = folders.map(f => decompressFolder(data, base, f, cbCFData));

        const map = new Map();
        for (const f of files) {
            const stream = streams[Math.min(f.iFolder, streams.length - 1)];
            map.set(f.name.toLowerCase(), stream.slice(f.uoff, f.uoff + f.cbFile));
        }
        return map;
    }

    // ============================================================
    // InstallShield v5 HDR parser
    // (Same format as used by isoextract.js, but for in-memory data)
    // ============================================================

    function parseHdr(hdrData) {
        if (hdrData.length < 20 || rl32(hdrData, 0) !== IS_CAB_SIG) return null;

        const version       = rl32(hdrData, 4);
        const cabDescOffset = rl32(hdrData, 12);

        // Decode the major version number
        const vHigh = version >>> 24;
        let majorVersion;
        if (vHigh === 1) {
            majorVersion = (version >>> 12) & 0xf;
        } else if (vHigh === 2 || vHigh === 4) {
            const v16 = version & 0xffff;
            majorVersion = v16 ? Math.floor(v16 / 100) : 0;
        } else {
            majorVersion = 0;
        }

        // CabDescriptor (offsets relative to cabDescOffset):
        //   +0x00  [skip 0x0c bytes]
        //   +0x0c  fileTableOffset  (uint32)
        //   +0x10  [skip 4]
        //   +0x14  fileTableSize    (uint32, unused)
        //   +0x18  fileTableSize2   (uint32, unused)
        //   +0x1c  directoryCount   (uint32)
        //   +0x20  [skip 8]
        //   +0x28  fileCount        (uint32)
        let p = cabDescOffset + 0x0c;
        const fileTableOffset = rl32(hdrData, p); p += 8;  // read + skip unknown
        p += 8;  // skip fileTableSize + fileTableSize2
        const directoryCount  = rl32(hdrData, p); p += 4;
        p += 8;  // skip two unknown uint32s
        const fileCount       = rl32(hdrData, p);

        const ftBase     = cabDescOffset + fileTableOffset;
        const totalEntries = directoryCount + fileCount;

        if (ftBase + totalEntries * 4 > hdrData.length) return null;

        // File-table: array of uint32 offsets (relative to ftBase)
        const table = new Array(totalEntries);
        for (let i = 0; i < totalEntries; i++) {
            table[i] = rl32(hdrData, ftBase + i * 4);
        }

        // Directory descriptors: first directoryCount entries
        // Each is just a name_offset (uint32) pointing into the string pool.
        const dirs = [];
        for (let i = 0; i < directoryCount; i++) {
            dirs.push(cstr(hdrData, ftBase + table[i]));
        }

        // FileDescriptor v5 (0x3a = 58 bytes each):
        //   +0x00  name_offset      (uint32) → string at ftBase + name_offset
        //   +0x04  directory_index  (uint16)
        //   +0x06  pad              (uint16) [skip]
        //   +0x08  flags            (uint16)
        //   +0x0a  expanded_size    (uint32)
        //   +0x0e  compressed_size  (uint32)
        //   +0x12  [skip 0x14 bytes]
        //   +0x26  data_offset      (uint32) — byte offset in .cab
        //   +0x2a  md5[16]
        const files = [];
        for (let i = 0; i < fileCount; i++) {
            const fdOff = ftBase + table[directoryCount + i];
            if (fdOff + 0x3a > hdrData.length) continue;

            const nameOffset     = rl32(hdrData, fdOff);
            const directoryIndex = rl16(hdrData, fdOff + 4);
            const flags          = rl16(hdrData, fdOff + 8);
            const expandedSize   = rl32(hdrData, fdOff + 10);
            const compressedSize = rl32(hdrData, fdOff + 14);
            const dataOffset     = rl32(hdrData, fdOff + 38);  // 0x26 = 38

            const name = cstr(hdrData, ftBase + nameOffset);
            const dir  = directoryIndex < dirs.length ? dirs[directoryIndex] : '';

            files.push({
                index: i,
                name,
                directory: dir,
                flags,
                expandedSize,
                compressedSize,
                dataOffset,
            });
        }

        return { majorVersion, dirs, files };
    }

    // ============================================================
    // IS5 file decompressor (in-memory .cab)
    // ============================================================

    function ror8(x, n) {
        return ((x >>> n) | (x << (8 - n))) & 0xFF;
    }

    // Decompress (and optionally deobfuscate) one IS5 file from cabData.
    // IS5 chunks are each an independent DEFLATE stream (unshield uses a fresh
    // inflate context per chunk), so pako.inflateRaw() per chunk is correct.
    // fileDesc must have: { dataOffset, compressedSize, expandedSize, flags }
    function extractIsFile(cabData, fileDesc) {
        const { dataOffset, compressedSize, expandedSize, flags } = fileDesc;

        let out;
        if (!(flags & FILE_COMPRESSED)) {
            // Uncompressed — copy directly
            out = cabData.slice(dataOffset, dataOffset + expandedSize);
        } else {
            // Compressed — read uint16 chunk length then inflate each chunk independently
            const parts = [];
            let pos  = dataOffset;
            let left = compressedSize;

            while (left > 1) {
                const chunkLen = rl16(cabData, pos); pos += 2; left -= 2;
                if (!chunkLen || chunkLen > left) break;
                try {
                    parts.push(pako.inflateRaw(cabData.subarray(pos, pos + chunkLen)));
                } catch (_) {
                    break;  // stop on corrupt chunk
                }
                pos  += chunkLen;
                left -= chunkLen;
            }

            let total = 0;
            for (const part of parts) total += part.length;
            out = new Uint8Array(total);
            let off = 0;
            for (const part of parts) { out.set(part, off); off += part.length; }
        }

        // Deobfuscation: ror8(byte ^ 0xd5, 2) - (seed % 0x47), seed increments per byte
        if (flags & FILE_OBFUSCATED) {
            out = new Uint8Array(out);  // ensure mutable copy
            let seed = 0;
            for (let i = 0; i < out.length; i++, seed++) {
                out[i] = (ror8(out[i] ^ 0xd5, 2) - (seed % 0x47) + 256) & 0xFF;
            }
        }

        return out;
    }

    // ============================================================
    // Public API
    // ============================================================

    return {
        // Extensions treated as game data files
        TARGET_EXTS: ['.lod', '.snd', '.vid', '.mp3', '.h3m', '.h3c'],

        // Returns true if `data` looks like an InstallShield self-extracting EXE
        // (contains an MSCF cabinet whose file list includes data1.hdr).
        isInstallShieldExe(data) {
            try {
                const base = findMscf(data);
                if (base < 0) return false;
                const { files } = parseMscf(data, base);
                return files.some(f => f.name.toLowerCase().endsWith('data1.hdr'));
            } catch (_) {
                return false;
            }
        },

        // Extract the outer MS Cabinet, parse the IS5 header.
        // Returns { hdrInfo, cabData } synchronously (CPU-heavy — yield to UI first).
        //   hdrInfo.files: Array of file descriptors (see parseHdr)
        //   cabData:       Uint8Array of the raw data1.cab content
        processExe(data) {
            const base = findMscf(data);
            if (base < 0) throw new Error('No MS Cabinet found in EXE');

            const msCabFiles = extractMscf(data, base);

            // File names in the cabinet may have a path prefix (e.g. '\Disk1\data1.hdr')
            const hdrEntry = [...msCabFiles.entries()].find(([k]) => k.endsWith('data1.hdr'));
            const cabEntry = [...msCabFiles.entries()].find(([k]) => k.endsWith('data1.cab'));
            if (!hdrEntry) throw new Error('data1.hdr not found in installer cabinet');
            if (!cabEntry) throw new Error('data1.cab not found in installer cabinet');
            const hdrData = hdrEntry[1];
            const cabData = cabEntry[1];

            const hdrInfo = parseHdr(hdrData);
            if (!hdrInfo) throw new Error('Failed to parse InstallShield cabinet header');

            return { hdrInfo, cabData };
        },

        // Decompress a single file from `cabData` using its descriptor.
        extractFile: extractIsFile,
    };
})();
