// ============================================================
// InnoExtract.js - Inno Setup 5.6.2 data extractor
// Extracts game data files from GOG Heroes 3 installer (EXE+BIN)
// ============================================================

const InnoExtract = (function () {
    'use strict';

    // "rDlPtS\xcd\xe6\xd7{\x0b*"
    const LOADER_MAGIC = [0x72, 0x44, 0x6C, 0x50, 0x74, 0x53, 0xCD, 0xE6, 0xD7, 0x7B, 0x0B, 0x2A];

    // Target data files to extract (LOD archives only)
    const TARGET_FILES = [
        'Data\\H3bitmap.lod',
        'Data\\H3sprite.lod',
        'Data\\H3ab_bmp.lod',
        'Data\\H3ab_spr.lod',
        'Data\\Heroes3.snd',
        'Data\\H3ab_ahd.snd',
        'Data\\H3ab_ahd.vid',
        'Data\\VIDEO.VID'
    ];

    // ---- Low-level helpers ----

    function readUint16LE(data, off) {
        return data[off] | (data[off + 1] << 8);
    }

    function readUint32LE(data, off) {
        return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
    }

    function readUint64LE(data, off) {
        const lo = readUint32LE(data, off);
        const hi = readUint32LE(data, off + 4);
        return lo + hi * 0x100000000;
    }

    function findBytes(haystack, needle, start) {
        const end = haystack.length - needle.length;
        outer: for (let i = start; i <= end; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (haystack[i + j] !== needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    function encodeUTF16LE(str) {
        const buf = new Uint8Array(str.length * 2);
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            buf[i * 2] = c & 0xFF;
            buf[i * 2 + 1] = (c >> 8) & 0xFF;
        }
        return buf;
    }

    function decodeUTF16LE(bytes, off, len) {
        let str = '';
        for (let i = off; i + 1 < off + len; i += 2) {
            str += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
        }
        return str;
    }

    // Strip CRC32 prefixes from Inno Setup block sub-blocks (4096-byte chunks)
    function stripBlockCrc(raw) {
        const parts = [];
        let totalLen = 0;
        let pos = 0;
        while (pos < raw.length) {
            pos += 4; // skip CRC32
            const chunkLen = Math.min(4096, raw.length - pos);
            parts.push(raw.subarray(pos, pos + chunkLen));
            totalLen += chunkLen;
            pos += chunkLen;
        }
        const result = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) {
            result.set(p, off);
            off += p.length;
        }
        return result;
    }

    // Read a slice from a File object
    function readFileSlice(file, offset, size) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const blob = file.slice(offset, offset + size);
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }

    // ---- LZMA decompression (uses global LZMA from lzma_worker.js) ----

    function lzmaDecompress(stripped) {
        // Build LZMA "alone" format: props(5) + size(8) + data
        // First 5 bytes of stripped = LZMA properties
        // Use 0xFFFFFFFFFFFFFFFF for unknown uncompressed size
        const lzmaInput = new Array(5 + 8 + stripped.length - 5);
        for (let i = 0; i < 5; i++) lzmaInput[i] = stripped[i];
        for (let i = 0; i < 8; i++) lzmaInput[5 + i] = 0xFF;
        for (let i = 5; i < stripped.length; i++) lzmaInput[8 + i] = stripped[i];

        const result = LZMA.decompress(lzmaInput);

        // result is a plain array of signed bytes (or binary-detected raw array)
        if (result instanceof Uint8Array) return result;
        const out = new Uint8Array(result.length);
        for (let i = 0; i < result.length; i++) out[i] = result[i] & 0xFF;
        return out;
    }

    // ---- EXE parsing ----

    function isHeroes3Installer(exeData) {
        try {
            const loaderOff = findBytes(exeData, LOADER_MAGIC, 0);
            if (loaderOff < 0) return false;

            const headerOffset = readUint32LE(exeData, loaderOff + 32);
            if (headerOffset >= exeData.length) return false;

            let vEnd = headerOffset;
            while (vEnd < exeData.length && exeData[vEnd] !== 0) vEnd++;
            const ver = '';
            const bytes = exeData.subarray(headerOffset, vEnd);
            let versionStr = '';
            for (let i = 0; i < bytes.length; i++) versionStr += String.fromCharCode(bytes[i]);

            return versionStr.indexOf('Inno Setup') >= 0;
        } catch (e) {
            return false;
        }
    }

    function parseExe(exeData) {
        // Find loader magic in PE resources
        const loaderOff = findBytes(exeData, LOADER_MAGIC, 0);
        if (loaderOff < 0) throw new Error('Kein Inno Setup Installer erkannt');

        // Loader offset table (for >= 5.1.5):
        // magic(12) + revision(4) + skip(4) + exe_offset(4) + exe_uncompressed(4)
        // + exe_crc(4) + header_offset(4) + data_offset(4) + table_crc(4)
        const headerOffset = readUint32LE(exeData, loaderOff + 32);

        // Read version string
        let vEnd = headerOffset;
        while (vEnd < exeData.length && exeData[vEnd] !== 0) vEnd++;
        let versionStr = '';
        for (let i = headerOffset; i < vEnd; i++) versionStr += String.fromCharCode(exeData[i]);

        if (versionStr.indexOf('Inno Setup') < 0) {
            throw new Error('Kein Inno Setup Installer');
        }

        // Skip version string + null byte + padding zeros to find block1
        let block1Start = vEnd + 1;
        while (block1Start < exeData.length && exeData[block1Start] === 0) block1Start++;

        // Block1: CRC32(4) + stored_size(4) + compressed(1)
        const block1StoredSize = readUint32LE(exeData, block1Start + 4);
        const block1Compressed = exeData[block1Start + 8];

        const block1Raw = exeData.subarray(block1Start + 9, block1Start + 9 + block1StoredSize);
        const block1Stripped = stripBlockCrc(block1Raw);

        let block1;
        if (block1Compressed) {
            block1 = lzmaDecompress(block1Stripped);
        } else {
            block1 = block1Stripped;
        }

        // Block2: immediately after block1
        const block2Start = block1Start + 9 + block1StoredSize;
        const block2StoredSize = readUint32LE(exeData, block2Start + 4);
        const block2Compressed = exeData[block2Start + 8];

        const block2Raw = exeData.subarray(block2Start + 9, block2Start + 9 + block2StoredSize);
        let block2 = stripBlockCrc(block2Raw);

        if (block2Compressed) {
            block2 = lzmaDecompress(block2);
        }

        // Parse data entries from block2 (74 bytes each)
        const numEntries = Math.floor(block2.length / 74);
        const dataEntries = new Array(numEntries);

        for (let i = 0; i < numEntries; i++) {
            const off = i * 74;
            dataEntries[i] = {
                firstSlice: readUint32LE(block2, off),
                lastSlice: readUint32LE(block2, off + 4),
                chunkOffset: readUint32LE(block2, off + 8),
                fileOffset: readUint64LE(block2, off + 12),
                fileSize: readUint64LE(block2, off + 20),
                chunkSize: readUint64LE(block2, off + 28),
                flags: readUint16LE(block2, off + 72)
            };
        }

        // Scan block1 for before_install scripts to find target files
        const fileMap = scanTargetFiles(block1);

        return { versionStr, dataEntries, fileMap };
    }

    function scanTargetFiles(block1) {
        const biMarker = encodeUTF16LE("before_install('");
        const fileMap = new Map();
        let pos = 0;

        while (pos < block1.length - biMarker.length) {
            const idx = findBytes(block1, biMarker, pos);
            if (idx < 0) break;

            // String length prefix is 4 bytes before the string content
            const strLen = readUint32LE(block1, idx - 4);
            if (strLen > 1000 || idx + strLen > block1.length) {
                pos = idx + biMarker.length;
                continue;
            }

            const text = decodeUTF16LE(block1, idx, strLen);

            // before_install('hash', 'path', count)
            const parts = text.split("'");
            if (parts.length >= 4) {
                const path = parts[3];
                const countStr = text.slice(text.lastIndexOf(',') + 1).trim().replace(')', '');
                const count = parseInt(countStr, 10) || 1;

                // location field: 20 bytes after string end
                // (min_version: uint32+uint32+uint16=10, only_below_version: same=10)
                const strEnd = idx + strLen;
                const location = readUint32LE(block1, strEnd + 20);

                if (TARGET_FILES.indexOf(path) >= 0) {
                    const name = path.split('\\').pop();
                    fileMap.set(name, { path, location, chunkCount: count });
                }
            }

            pos = idx + strLen;
        }

        return fileMap;
    }

    // ---- File extraction from BIN ----

    async function extractFile(binFile, dataEntries, fileInfo, onProgress) {
        const { location, chunkCount } = fileInfo;
        const chunks = [];
        let totalSize = 0;

        for (let i = 0; i < chunkCount; i++) {
            const entry = dataEntries[location + i];

            // Read zlb header (4 bytes magic) + zlib data (chunkSize bytes)
            const raw = await readFileSlice(binFile, entry.chunkOffset, 4 + entry.chunkSize);

            // Verify zlb magic
            if (raw[0] !== 0x7A || raw[1] !== 0x6C || raw[2] !== 0x62 || raw[3] !== 0x1A) {
                throw new Error('Ungültige Chunk-Daten bei Offset ' + entry.chunkOffset);
            }

            // Decompress zlib data with pako
            const zlibData = raw.subarray(4);
            const decompressed = pako.inflate(zlibData);

            chunks.push(decompressed);
            totalSize += decompressed.length;

            if (onProgress) onProgress(i + 1, chunkCount);
        }

        // Assemble
        const result = new Uint8Array(totalSize);
        let off = 0;
        for (const chunk of chunks) {
            result.set(chunk, off);
            off += chunk.length;
        }
        return result;
    }

    // ---- Public API ----
    return {
        isHeroes3Installer,
        parseExe,
        extractFile,
        TARGET_FILES
    };
})();
