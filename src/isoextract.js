// ============================================================
// ISOExtract.js - ISO 9660 + InstallShield CAB extractor
// Extracts HoMM3 game files (.lod, .snd, .vid) from CD images
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

const ISOExtract = (function () {
    'use strict';

    const SECTOR = 2048;
    const IS_CAB_SIGNATURE = 0x28635349; // "ISc("
    const TARGET_EXTS = ['.lod', '.snd', '.vid'];
    const COMMON_HEADER_SIZE = 20;
    const VOLUME_HEADER_SIZE_V5 = 40;
    const FILE_SPLIT = 1;
    const FILE_COMPRESSED = 4;
    const FILE_INVALID = 8;

    // ---- Low-level helpers ----

    function readUint16LE(data, off) {
        return data[off] | (data[off + 1] << 8);
    }

    function readUint32LE(data, off) {
        return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
    }

    function readCString(data, off, maxLen) {
        let end = off;
        const limit = Math.min(off + (maxLen || 256), data.length);
        while (end < limit && data[end] !== 0) end++;
        let str = '';
        for (let i = off; i < end; i++) str += String.fromCharCode(data[i]);
        return str;
    }

    function isTargetFile(name) {
        const lower = name.toLowerCase();
        return TARGET_EXTS.some(ext => lower.endsWith(ext));
    }

    // Read a slice from a File object (returns Uint8Array)
    async function readFileSlice(file, offset, length) {
        const blob = file.slice(offset, offset + length);
        return new Uint8Array(await blob.arrayBuffer());
    }

    // ============================================================
    // ISO 9660 Filesystem Parser
    // ============================================================

    function parseDirectoryRecord(data, offset) {
        const recLen = data[offset];
        if (recLen === 0) return null;

        const extLba = readUint32LE(data, offset + 2);
        const extSize = readUint32LE(data, offset + 10);
        const flags = data[offset + 25];
        const nameLen = data[offset + 32];
        let name = '';
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(data[offset + 33 + i]);

        return {
            length: recLen,
            lba: extLba,
            size: extSize,
            isDirectory: !!(flags & 2),
            name: name
        };
    }

    function parseDirectory(data, size) {
        const entries = [];
        let pos = 0;
        while (pos < size) {
            if (data[pos] === 0) {
                // Padding to next sector
                pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
                continue;
            }
            const rec = parseDirectoryRecord(data, pos);
            if (!rec) break;
            // Skip self (0x00) and parent (0x01) entries
            if (rec.name !== '\x00' && rec.name !== '\x01') {
                // Strip ISO version suffix (;1)
                rec.name = rec.name.replace(/;.*$/, '');
                entries.push(rec);
            }
            pos += rec.length;
        }
        return entries;
    }

    // Recursively walk ISO directory tree, returning flat list of files
    async function walkIsoTree(file, lba, size, path) {
        const data = await readFileSlice(file, lba * SECTOR, Math.ceil(size / SECTOR) * SECTOR);
        const entries = parseDirectory(data, size);
        const results = [];

        for (const entry of entries) {
            const fullPath = path ? path + '/' + entry.name : entry.name;
            if (entry.isDirectory) {
                const children = await walkIsoTree(file, entry.lba, entry.size, fullPath);
                results.push(...children);
            } else {
                results.push({
                    path: fullPath,
                    name: entry.name,
                    lba: entry.lba,
                    size: entry.size
                });
            }
        }
        return results;
    }

    // Check if ISO file by reading PVD signature
    async function isIsoFile(file) {
        if (file.size < 17 * SECTOR) return false;
        const pvd = await readFileSlice(file, 16 * SECTOR, SECTOR);
        // Check CD001 signature at offset 1
        return pvd[0] === 1 && pvd[1] === 0x43 && pvd[2] === 0x44 &&
               pvd[3] === 0x30 && pvd[4] === 0x30 && pvd[5] === 0x31;
    }

    // Parse ISO and return all files with their paths
    async function listIsoFiles(file) {
        const pvd = await readFileSlice(file, 16 * SECTOR, SECTOR);
        const rootRec = pvd.slice(156, 156 + 34);
        const rootLba = readUint32LE(rootRec, 2);
        const rootSize = readUint32LE(rootRec, 10);
        return walkIsoTree(file, rootLba, rootSize, '');
    }

    // Extract a raw file from the ISO
    async function extractIsoFile(file, lba, size) {
        return readFileSlice(file, lba * SECTOR, size);
    }

    // ============================================================
    // InstallShield v5 CAB Parser/Extractor
    // ============================================================

    function parseCommonHeader(data, offset) {
        return {
            signature: readUint32LE(data, offset),
            version: readUint32LE(data, offset + 4),
            volumeInfo: readUint32LE(data, offset + 8),
            cabDescriptorOffset: readUint32LE(data, offset + 12),
            cabDescriptorSize: readUint32LE(data, offset + 16)
        };
    }

    function parseVolumeHeaderV5(data, offset) {
        // Volume header starts after common header (offset 20 within CAB)
        const p = offset;
        return {
            dataOffset: readUint32LE(data, p),
            // p+4: unknown
            firstFileIndex: readUint32LE(data, p + 8),
            lastFileIndex: readUint32LE(data, p + 12),
            firstFileOffset: readUint32LE(data, p + 16),
            firstFileSizeExpanded: readUint32LE(data, p + 20),
            firstFileSizeCompressed: readUint32LE(data, p + 24),
            lastFileOffset: readUint32LE(data, p + 28),
            lastFileSizeExpanded: readUint32LE(data, p + 32),
            lastFileSizeCompressed: readUint32LE(data, p + 36)
        };
    }

    function parseCabDescriptor(hdrData, cabDescOffset) {
        let p = cabDescOffset + 0xc;
        const fileTableOffset = readUint32LE(hdrData, p); p += 4;
        p += 4; // skip
        const fileTableSize = readUint32LE(hdrData, p); p += 4;
        p += 4; // file_table_size2
        const directoryCount = readUint32LE(hdrData, p); p += 4;
        p += 8; // skip
        const fileCount = readUint32LE(hdrData, p); p += 4;
        const fileTableOffset2 = readUint32LE(hdrData, p);

        return { fileTableOffset, fileTableSize, directoryCount, fileCount, fileTableOffset2 };
    }

    function parseHdrFile(hdrData) {
        if (hdrData.length < COMMON_HEADER_SIZE) return null;
        const common = parseCommonHeader(hdrData, 0);
        if (common.signature !== IS_CAB_SIGNATURE) return null;

        // Determine major version
        let majorVersion;
        if ((common.version >>> 24) === 1) {
            majorVersion = (common.version >>> 12) & 0xf;
        } else if ((common.version >>> 24) === 2 || (common.version >>> 24) === 4) {
            majorVersion = (common.version & 0xffff);
            if (majorVersion !== 0) majorVersion = Math.floor(majorVersion / 100);
        } else {
            majorVersion = 0;
        }

        const cab = parseCabDescriptor(hdrData, common.cabDescriptorOffset);
        const ftBase = common.cabDescriptorOffset + cab.fileTableOffset;

        // Read file table (uint32 offsets)
        const totalEntries = cab.directoryCount + cab.fileCount;
        if (ftBase + totalEntries * 4 > hdrData.length) return null;
        const fileTable = new Array(totalEntries);
        for (let i = 0; i < totalEntries; i++) {
            fileTable[i] = readUint32LE(hdrData, ftBase + i * 4);
        }

        // Read directory names
        const directories = [];
        for (let i = 0; i < cab.directoryCount; i++) {
            directories.push(readCString(hdrData, ftBase + fileTable[i]));
        }

        // Read file descriptors (version 5 format, 0x3a = 58 bytes each)
        const FILE_DESCRIPTOR_SIZE = 0x3a;
        const files = [];
        for (let i = 0; i < cab.fileCount; i++) {
            const fdOff = ftBase + fileTable[cab.directoryCount + i];
            // Bounds check: need at least FILE_DESCRIPTOR_SIZE bytes
            if (fdOff + FILE_DESCRIPTOR_SIZE > hdrData.length) continue;

            const nameOffset = readUint32LE(hdrData, fdOff);
            const directoryIndex = readUint16LE(hdrData, fdOff + 4);
            // skip 2 bytes at fdOff+6
            const flags = readUint16LE(hdrData, fdOff + 8);
            const expandedSize = readUint32LE(hdrData, fdOff + 10);
            const compressedSize = readUint32LE(hdrData, fdOff + 14);
            // skip 0x14 (20) bytes at fdOff+18
            const dataOffset = readUint32LE(hdrData, fdOff + 38);

            const name = readCString(hdrData, ftBase + nameOffset);
            const dir = directoryIndex < directories.length ? directories[directoryIndex] : '';

            files.push({
                index: i,
                name,
                directory: dir,
                flags,
                expandedSize,
                compressedSize,
                dataOffset
            });
        }

        return { majorVersion, common, cab, directories, files };
    }

    // Find which volumes contain data for a given file, and what offsets/sizes to use
    function resolveFileVolumes(fileIdx, fileDesc, volumeHeaders) {
        const isSplit = !!(fileDesc.flags & FILE_SPLIT);
        const isCompressed = !!(fileDesc.flags & FILE_COMPRESSED);

        // Non-split files: use file descriptor offset directly, just find the right volume
        if (!isSplit) {
            for (const vol of volumeHeaders) {
                if (fileIdx < vol.header.firstFileIndex || fileIdx > vol.header.lastFileIndex) continue;
                const bytesNeeded = isCompressed ? fileDesc.compressedSize : fileDesc.expandedSize;
                return [{
                    cabLba: vol.cabLba,
                    cabSize: vol.cabSize,
                    offset: fileDesc.dataOffset,
                    compressedBytes: bytesNeeded
                }];
            }
            return [];
        }

        // Split files: each volume contributes a segment
        const segments = [];
        for (const vol of volumeHeaders) {
            if (fileIdx < vol.header.firstFileIndex || fileIdx > vol.header.lastFileIndex) continue;

            let offset, compressedBytes;

            // Check last file match first (unshield convention)
            if (fileIdx === vol.header.lastFileIndex && vol.header.lastFileOffset !== 0x7FFFFFFF) {
                offset = vol.header.lastFileOffset;
                compressedBytes = vol.header.lastFileSizeCompressed;
            } else if (fileIdx === vol.header.firstFileIndex) {
                offset = vol.header.firstFileOffset;
                compressedBytes = vol.header.firstFileSizeCompressed;
            } else {
                offset = fileDesc.dataOffset;
                compressedBytes = fileDesc.compressedSize;
            }

            segments.push({
                cabLba: vol.cabLba,
                cabSize: vol.cabSize,
                offset,
                compressedBytes
            });
        }

        return segments;
    }

    // Extract and decompress a file from IS CABs within an ISO
    async function extractIsCabFile(isoFile, fileDesc, volumeHeaders, onProgress) {
        const segments = resolveFileVolumes(fileDesc.index, fileDesc, volumeHeaders);
        if (segments.length === 0) return null;

        const isCompressed = !!(fileDesc.flags & FILE_COMPRESSED);
        const outputSize = fileDesc.expandedSize;
        const output = new Uint8Array(outputSize);
        let outputOffset = 0;
        let totalCompressed = 0;
        const totalCompressedSize = fileDesc.compressedSize;

        for (const seg of segments) {
            const absOffset = seg.cabLba * SECTOR + seg.offset;
            let bytesLeft = seg.compressedBytes;

            if (!isCompressed) {
                // Uncompressed: read directly
                const toRead = Math.min(bytesLeft, outputSize - outputOffset);
                const chunk = await readFileSlice(isoFile, absOffset, toRead);
                output.set(chunk, outputOffset);
                outputOffset += toRead;
                totalCompressed += toRead;
                if (onProgress) onProgress(totalCompressed, totalCompressedSize);
                continue;
            }

            // Compressed: read chunk-by-chunk (uint16 length + raw deflate data)
            // Read the entire segment into memory for efficiency
            const segData = await readFileSlice(isoFile, absOffset, bytesLeft);
            let pos = 0;

            while (pos < segData.length && bytesLeft > 0) {
                if (pos + 2 > segData.length) break;
                const chunkLen = readUint16LE(segData, pos);
                pos += 2;
                bytesLeft -= 2;

                if (chunkLen === 0 || pos + chunkLen > segData.length) break;

                const chunkData = segData.subarray(pos, pos + chunkLen);
                pos += chunkLen;
                bytesLeft -= chunkLen;

                try {
                    const decompressed = pako.inflateRaw(chunkData);
                    output.set(decompressed, outputOffset);
                    outputOffset += decompressed.length;
                } catch (e) {
                    // Corrupt chunk - skip and continue with remaining data
                    console.warn('ISOExtract: deflate error in chunk, data may be from a damaged disc');
                    break;
                }

                totalCompressed += chunkLen + 2;
                if (onProgress) onProgress(totalCompressed, totalCompressedSize);
            }
        }

        return output.subarray(0, outputOffset);
    }

    // ============================================================
    // High-level ISO processing
    // ============================================================

    // Scan ISO for game files and IS CAB setups
    async function scanIso(file, onProgress) {
        const allFiles = await listIsoFiles(file);

        // Separate into categories
        const directGameFiles = [];
        const hdrFiles = [];
        const cabFiles = [];

        for (const f of allFiles) {
            const upper = f.name.toUpperCase();
            if (isTargetFile(f.name)) {
                directGameFiles.push(f);
            } else if (upper.match(/^DATA\d+\.HDR$/)) {
                hdrFiles.push(f);
            } else if (upper.match(/^DATA\d+\.CAB$/)) {
                cabFiles.push(f);
            }
        }

        // Parse all IS CAB setups (group by directory)
        const cabSetups = [];
        const hdrByDir = new Map();
        for (const h of hdrFiles) {
            const dir = h.path.substring(0, h.path.lastIndexOf('/'));
            if (!hdrByDir.has(dir)) hdrByDir.set(dir, []);
            hdrByDir.get(dir).push(h);
        }

        for (const [dir, hdrs] of hdrByDir) {
            // Find associated CABs in same directory
            const dirCabs = cabFiles.filter(c => c.path.startsWith(dir + '/'));
            if (dirCabs.length === 0) continue;

            // Parse the first (usually only) HDR
            // Use DATA1.HDR specifically if available
            const mainHdr = hdrs.find(h => h.name.toUpperCase() === 'DATA1.HDR') || hdrs[0];
            const hdrData = await extractIsoFile(file, mainHdr.lba, mainHdr.size);
            const parsed = parseHdrFile(hdrData);
            if (!parsed) continue;

            // Find target files in the HDR
            const targetFiles = parsed.files.filter(f =>
                isTargetFile(f.name) && !(f.flags & FILE_INVALID) && f.dataOffset > 0
            );
            if (targetFiles.length === 0) continue;

            // Read volume headers from all CABs
            const volumeHeaders = [];
            // Sort CABs by their number (DATA1.CAB, DATA2.CAB, ...)
            const sortedCabs = dirCabs.sort((a, b) => {
                const numA = parseInt(a.name.match(/\d+/)?.[0] || '0');
                const numB = parseInt(b.name.match(/\d+/)?.[0] || '0');
                return numA - numB;
            });

            for (const cab of sortedCabs) {
                const headerData = await readFileSlice(file, cab.lba * SECTOR,
                    COMMON_HEADER_SIZE + VOLUME_HEADER_SIZE_V5);
                const sig = readUint32LE(headerData, 0);
                if (sig !== IS_CAB_SIGNATURE) continue;

                const volHeader = parseVolumeHeaderV5(headerData, COMMON_HEADER_SIZE);
                volumeHeaders.push({
                    cabName: cab.name,
                    cabLba: cab.lba,
                    cabSize: cab.size,
                    header: volHeader
                });
            }

            cabSetups.push({
                directory: dir,
                hdr: parsed,
                targetFiles,
                volumeHeaders
            });
        }

        return { directGameFiles, cabSetups };
    }

    // Public API
    return {
        isIsoFile,
        scanIso,
        extractIsoFile,
        extractIsCabFile,
        TARGET_EXTS
    };
})();
