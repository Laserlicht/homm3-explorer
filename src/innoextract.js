// ============================================================
// InnoExtract.js - Inno Setup data extractor for GOG installers
// Supports v5.5.0+ (LZMA2) and v5.6.2 (zlib), single-file & EXE+BIN
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

const InnoExtract = (function () {
    'use strict';

    // "rDlPtS\xcd\xe6\xd7{\x0b*"
    const LOADER_MAGIC = [0x72, 0x44, 0x6C, 0x50, 0x74, 0x53, 0xCD, 0xE6, 0xD7, 0x7B, 0x0B, 0x2A];

    // Extensions to search for (case-insensitive)
    const TARGET_EXTS = ['.lod', '.snd', '.vid', '.mp3'];

    function isTargetFile(name) {
        const lower = name.toLowerCase();
        return TARGET_EXTS.some(ext => lower.endsWith(ext));
    }

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

    // ---- LZMA decompression for block headers ----

    function lzmaDecompress(stripped) {
        // stripped: first 5 bytes = props + dict, rest = compressed data
        return LZMA2Decode.decompressLzma1(stripped);
    }

    // ---- EXE parsing ----

    function isHeroes3Installer(exeData) {
        try {
            const loaderOff = findBytes(exeData, LOADER_MAGIC, 0);
            if (loaderOff < 0) return false;

            const headerOffset = readUint32LE(exeData, loaderOff + 32);
            if (headerOffset >= exeData.length) return false;

            // Version is a fixed 64-byte char[64] field
            let versionStr = '';
            for (let i = 0; i < 64; i++) {
                const c = exeData[headerOffset + i];
                if (c === 0) break;
                versionStr += String.fromCharCode(c);
            }

            return versionStr.indexOf('Inno Setup') >= 0;
        } catch (e) {
            return false;
        }
    }

    function parseExe(exeData) {
        const loaderOff = findBytes(exeData, LOADER_MAGIC, 0);
        if (loaderOff < 0) throw new Error('Not an Inno Setup installer');

        const headerOffset = readUint32LE(exeData, loaderOff + 32);
        const dataOffset = readUint32LE(exeData, loaderOff + 36);

        // Version: fixed 64-byte char[64] at headerOffset
        let versionStr = '';
        for (let i = 0; i < 64; i++) {
            const c = exeData[headerOffset + i];
            if (c === 0) break;
            versionStr += String.fromCharCode(c);
        }
        if (versionStr.indexOf('Inno Setup') < 0) {
            throw new Error('Not an Inno Setup installer');
        }

        // Block1 starts immediately after the 64-byte version field
        const block1Start = headerOffset + 64;

        // Block header: CRC32(4) + stored_size(4) + compressed(1)
        const block1StoredSize = readUint32LE(exeData, block1Start + 4);
        const block1Compressed = exeData[block1Start + 8];

        const block1Raw = exeData.subarray(block1Start + 9, block1Start + 9 + block1StoredSize);
        const block1Stripped = stripBlockCrc(block1Raw);
        let block1 = block1Compressed ? lzmaDecompress(block1Stripped) : block1Stripped;

        // Block2: immediately after block1
        const block2Start = block1Start + 9 + block1StoredSize;
        const block2StoredSize = readUint32LE(exeData, block2Start + 4);
        const block2Compressed = exeData[block2Start + 8];

        const block2Raw = exeData.subarray(block2Start + 9, block2Start + 9 + block2StoredSize);
        let block2 = stripBlockCrc(block2Raw);
        if (block2Compressed) block2 = lzmaDecompress(block2);

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

        // Try before_install scanning first (GOG Galaxy v5.6.2 format)
        let fileMap = scanBeforeInstallFiles(block1);

        // If no results, try destination string scanning (v5.5.0 format)
        if (fileMap.size === 0) {
            fileMap = scanDestinationFiles(block1);
        }

        return { versionStr, dataEntries, fileMap, dataOffset };
    }

    // Scan for before_install('hash','path',chunkCount) scripts (v5.6.2 GOG Galaxy)
    function scanBeforeInstallFiles(block1) {
        const biMarker = encodeUTF16LE("before_install('");
        const fileMap = new Map();
        let pos = 0;

        while (pos < block1.length - biMarker.length) {
            const idx = findBytes(block1, biMarker, pos);
            if (idx < 0) break;

            const strLen = readUint32LE(block1, idx - 4);
            if (strLen > 1000 || idx + strLen > block1.length) {
                pos = idx + biMarker.length;
                continue;
            }

            const text = decodeUTF16LE(block1, idx, strLen);
            const parts = text.split("'");
            if (parts.length >= 4) {
                const path = parts[3];
                const countStr = text.slice(text.lastIndexOf(',') + 1).trim().replace(')', '');
                const count = parseInt(countStr, 10) || 1;

                const strEnd = idx + strLen;
                const location = readUint32LE(block1, strEnd + 20);

                if (isTargetFile(path)) {
                    fileMap.set(path, { path, location, chunkCount: count });
                }
            }

            pos = idx + strLen;
        }

        return fileMap;
    }

    // Skip a UTF-16LE length-prefixed string at position pos, return new position
    function skipString(data, pos) {
        if (pos + 4 > data.length) return data.length;
        const len = readUint32LE(data, pos);
        return pos + 4 + len;
    }

    // Read a UTF-16LE length-prefixed string at position pos
    function readString(data, pos) {
        if (pos + 4 > data.length) return { str: '', end: data.length };
        const len = readUint32LE(data, pos);
        if (pos + 4 + len > data.length) return { str: '', end: data.length };
        const str = decodeUTF16LE(data, pos + 4, len);
        return { str, end: pos + 4 + len };
    }

    // Scan for destination strings containing target extensions (v5.5.0)
    // File entry strings: source, dest, install_font_name, strong_assembly_name,
    //   components, tasks, languages, check, after_install, before_install
    // After 10 strings: 20 bytes version data, then location(u32)
    function scanDestinationFiles(block1) {
        const fileMap = new Map();
        // Search for target extensions in UTF-16LE
        for (const ext of TARGET_EXTS) {
            const extBytes = encodeUTF16LE(ext);
            // Also search uppercase variant
            const extBytesUpper = encodeUTF16LE(ext.toUpperCase());
            const patterns = [extBytes, extBytesUpper];

            for (const pattern of patterns) {
                let searchPos = 0;
                while (searchPos < block1.length) {
                    const idx = findBytes(block1, pattern, searchPos);
                    if (idx < 0) break;

                    // Find the string that contains this match by reading backward to the length prefix
                    // The string content starts at some (len_pos + 4), and idx is within it
                    // Try to find the string start by looking for a plausible length prefix
                    let found = false;
                    for (let backtrack = idx - 2; backtrack >= Math.max(0, idx - 2000); backtrack -= 2) {
                        if (backtrack < 4) break;
                        const maybeLen = readUint32LE(block1, backtrack - 4);
                        // Check if this length prefix points to the end of a string that includes our match
                        if (maybeLen > 0 && maybeLen < 2000 && maybeLen % 2 === 0) {
                            const strStart = backtrack;
                            const strEnd = strStart + maybeLen;
                            if (idx >= strStart && idx + pattern.length <= strEnd) {
                                // This is the destination string. Read it.
                                const destStr = decodeUTF16LE(block1, strStart, maybeLen);
                                if (isTargetFile(destStr)) {
                                    // Now we need to find the location field.
                                    // This is the 2nd string (destination). We need to skip strings 3-10 (8 more)
                                    // then 20 bytes of version data, then read location u32.
                                    let p = strStart + maybeLen;  // after destination string
                                    for (let s = 0; s < 8; s++) {
                                        p = skipString(block1, p);  // skip strings 3-10
                                    }
                                    p += 20; // skip version data
                                    if (p + 4 <= block1.length) {
                                        const location = readUint32LE(block1, p);
                                        if (!fileMap.has(destStr)) {
                                            fileMap.set(destStr, { path: destStr, location, chunkCount: 1 });
                                        }
                                    }
                                    found = true;
                                }
                                break;
                            }
                        }
                    }

                    searchPos = idx + pattern.length;
                }
            }
        }
        return fileMap;
    }

    // ---- Data chunk decompression ----

    function decompressChunk(compData, expectedSize) {
        // Try zlib first
        try {
            return pako.inflate(compData);
        } catch (e) {
            // Fall back to LZMA2
            if (typeof LZMA2Decode !== 'undefined') {
                return LZMA2Decode.decompress(compData, expectedSize);
            }
            throw new Error('Decompression failed: ' + e.message);
        }
    }

    // ---- File extraction ----

    async function extractFile(sourceFile, dataOffset, dataEntries, fileInfo, onProgress) {
        const { location, chunkCount } = fileInfo;

        if (chunkCount > 1) {
            // Multi-chunk mode (GOG Galaxy v5.6.2)
            // Each data entry is a separate chunk; decompress and concatenate
            const chunks = [];
            let totalSize = 0;

            for (let i = 0; i < chunkCount; i++) {
                const entry = dataEntries[location + i];
                const chunkPos = dataOffset + entry.chunkOffset;
                const chunkSize = Number(entry.chunkSize);

                const raw = await readFileSlice(sourceFile, chunkPos, 4 + chunkSize);

                if (raw[0] !== 0x7A || raw[1] !== 0x6C || raw[2] !== 0x62 || raw[3] !== 0x1A) {
                    throw new Error('Invalid chunk data at offset ' + chunkPos);
                }

                const compData = raw.subarray(4);
                const decompressed = decompressChunk(compData, Number(entry.fileSize));

                chunks.push(decompressed);
                totalSize += decompressed.length;

                if (onProgress) onProgress(i + 1, chunkCount);
            }

            const result = new Uint8Array(totalSize);
            let off = 0;
            for (const chunk of chunks) {
                result.set(chunk, off);
                off += chunk.length;
            }
            return result;
        }

        // Single-chunk mode (v5.5.0+)
        const entry = dataEntries[location];
        const chunkPos = dataOffset + entry.chunkOffset;
        const fileOffset = Number(entry.fileOffset);
        const fileSize = Number(entry.fileSize);
        const chunkSize = Number(entry.chunkSize);

        if (fileSize === 0) {
            if (onProgress) onProgress(1, 1);
            return new Uint8Array(0);
        }

        if (onProgress) onProgress(0, 1);

        // Peek at zlb header + first payload byte to detect compression
        const header = await readFileSlice(sourceFile, chunkPos, 5);
        if (header[0] !== 0x7A || header[1] !== 0x6C || header[2] !== 0x62 || header[3] !== 0x1A) {
            throw new Error('Invalid chunk data at offset ' + chunkPos);
        }

        // 0x78 = zlib CMF byte, 0x00-0x28 = valid LZMA2 dict property
        const firstByte = header[4];
        if (firstByte !== 0x78 && firstByte > 40) {
            // Uncompressed: read directly from the chunk at fileOffset
            const data = await readFileSlice(sourceFile, chunkPos + 4 + fileOffset, fileSize);
            if (onProgress) onProgress(1, 1);
            return data;
        }

        // Compressed: read full chunk and decompress
        const compData = await readFileSlice(sourceFile, chunkPos + 4, chunkSize);
        let decompressed;
        try {
            decompressed = decompressChunk(compData, fileOffset + fileSize);
        } catch (e) {
            // Heuristic was wrong — treat as uncompressed
            const data = await readFileSlice(sourceFile, chunkPos + 4 + fileOffset, fileSize);
            if (onProgress) onProgress(1, 1);
            return data;
        }

        if (onProgress) onProgress(1, 1);
        // Copy to own buffer to avoid DataView2 offset issues with shared ArrayBuffer
        return new Uint8Array(decompressed.subarray(fileOffset, fileOffset + fileSize));
    }

    // Fast check: reads only LOADER_MAGIC offset + 4 bytes, no LZMA parse
    function getDataOffset(exeData) {
        const loaderOff = findBytes(exeData, LOADER_MAGIC, 0);
        if (loaderOff < 0) return -1;
        return readUint32LE(exeData, loaderOff + 36);
    }

    return {
        isHeroes3Installer,
        getDataOffset,
        parseExe,
        extractFile,
        TARGET_EXTS
    };
})();
