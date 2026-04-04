// Apple HFS filesystem reader for HoMM3 Explorer
// Reads Apple HFS (not HFS+) disc images, typically found inside Toast .sit archives.
// Supports: Apple Partition Map, HFS Master Directory Block, Catalog B-tree traversal,
//           file data fork extraction via extent records.
// Reference: Inside Macintosh: Files (1992), Chapters 2 & Appendix B
// SPDX-License-Identifier: MIT

const HFSExtract = (() => {
    'use strict';

    const SECTOR = 512;
    const HFS_SIG = 0x4244;       // MDB drSigWord
    const DDR_SIG = 0x4552;       // Driver Descriptor Record "ER"
    const PM_SIG  = 0x504D;       // Partition Map entry "PM"

    // ── Low-level helpers ────────────────────────────────────────────────────

    function u8(data, off) { return data[off]; }
    function u16be(dv, off) { return dv.getUint16(off, false); }
    function u32be(dv, off) { return dv.getUint32(off, false); }

    function pascalStr(data, off, maxLen) {
        const len = data[off];
        let s = '';
        for (let i = 0; i < len && i < maxLen; i++) {
            s += String.fromCharCode(data[off + 1 + i]);
        }
        return s;
    }

    // Read a Mac Roman null-terminated / counted name of exactly nameLen bytes
    function macStr(data, off, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
        return s;
    }

    // ── Partition Map ────────────────────────────────────────────────────────

    /**
     * Find the first Apple_HFS partition in the Apple Partition Map.
     * @param {Uint8Array} data
     * @param {DataView} dv
     * @returns {{start: number, count: number} | null}  start in bytes
     */
    function findHfsPartition(data, dv) {
        if (u16be(dv, 0) !== DDR_SIG) return null;
        for (let i = 1; i < 64; i++) {
            const s = i * SECTOR;
            if (s + 2 > data.length) break;
            if (u16be(dv, s) !== PM_SIG) break;
            const pyStart = u32be(dv, s + 8);
            const pySize  = u32be(dv, s + 12);
            let type = '';
            for (let k = 0; k < 32 && data[s + 48 + k]; k++) {
                type += String.fromCharCode(data[s + 48 + k]);
            }
            if (type === 'Apple_HFS') {
                return { start: pyStart * SECTOR, count: pySize };
            }
        }
        return null;
    }

    // ── Master Directory Block ────────────────────────────────────────────────

    /**
     * Parse the HFS Master Directory Block.
     * @param {Uint8Array} data
     * @param {DataView} dv
     * @param {number} partStart  byte offset of start of partition
     * @returns {object|null}
     */
    function parseMDB(data, dv, partStart) {
        const mdb = partStart + 1024;
        if (mdb + 162 > data.length) return null;
        if (u16be(dv, mdb) !== HFS_SIG) return null;

        const drAlBlkSiz = u32be(dv, mdb + 0x14);
        const drAlBlSt   = u16be(dv, mdb + 0x1C);
        const drNmAlBlks = u16be(dv, mdb + 0x12);

        // Catalog file first extent from drCTExtRec (at mdb+0x92)
        const ctExtStart = u16be(dv, mdb + 0x92);
        const ctExtCount = u16be(dv, mdb + 0x94);

        // Extents overflow first extent from drXTExtRec (at mdb+0x82)
        const xtExtStart = u16be(dv, mdb + 0x82);

        const volName = pascalStr(data, mdb + 0x24, 27);

        return {
            partStart,
            drAlBlkSiz,
            drAlBlSt,
            drNmAlBlks,
            ctExtStart,
            ctExtCount,
            xtExtStart,
            volName,
            mdbOff: mdb,
        };
    }

    // ── Allocation Block Address ──────────────────────────────────────────────

    function makeAbOff(mdb) {
        const { partStart, drAlBlSt, drAlBlkSiz } = mdb;
        return (ab) => partStart + drAlBlSt * SECTOR + ab * drAlBlkSiz;
    }

    // ── B-tree Header ────────────────────────────────────────────────────────

    /**
     * Parse B-tree header node (node 0) and return key fields.
     * @param {DataView} dv
     * @param {number} btStart  byte offset of B-tree start (= abOff(firstAllocBlock))
     * @returns {object|null}
     */
    function parseBTreeHeader(dv, btStart) {
        // Node descriptor at btStart+0 (14 bytes)
        const kind = dv.getInt8(btStart + 8);
        if (kind !== 1) return null;   // must be header node
        const numRec = u16be(dv, btStart + 10);
        if (numRec < 1) return null;

        // Header record at btStart+14
        const hdr = btStart + 14;
        const depth     = u16be(dv, hdr + 0);
        const root      = u32be(dv, hdr + 2);
        const leafRecs  = u32be(dv, hdr + 6);
        const firstLeaf = u32be(dv, hdr + 10);
        const lastLeaf  = u32be(dv, hdr + 14);
        const nodeSize  = u16be(dv, hdr + 18);
        const totalNodes= u32be(dv, hdr + 22);
        return { depth, root, leafRecs, firstLeaf, lastLeaf, nodeSize, totalNodes };
    }

    // ── Extents Overflow B-tree ───────────────────────────────────────────────

    /**
     * Look up additional extents for a file from the extents overflow B-tree.
     * @param {Uint8Array} data
     * @param {DataView} dv
     * @param {number} xtStart   byte offset of extents overflow B-tree
     * @param {number} cnid      file CNID
     * @param {number} startBlk  logical alloc block # to search from (= sum of prior extents' counts)
     * @param {number} nodeSize
     * @returns {Array<{s:number,c:number}>}  additional extents
     */
    function lookupExtentsOverflow(data, dv, xtStart, cnid, startBlk, nodeSize) {
        const results = [];
        const hdr = parseBTreeHeader(dv, xtStart);
        if (!hdr || hdr.depth === 0) return results;

        // Walk leaf nodes (simpler: scan all leaves rather than descend from root)
        let nodeNum = hdr.firstLeaf;
        let guard = 0;
        while (nodeNum > 0 && guard++ < 10000) {
            const nOff = xtStart + nodeNum * nodeSize;
            if (nOff + nodeSize > data.length) break;
            const fLink = u32be(dv, nOff + 0);
            const kind  = dv.getInt8(nOff + 8);
            const numR  = u16be(dv, nOff + 10);
            if (kind !== -1) { nodeNum = fLink; continue; }

            for (let r = 0; r < numR; r++) {
                const recOff = u16be(dv, nOff + nodeSize - 2 * (r + 1));
                const rec = nOff + recOff;
                if (rec + 8 > data.length) continue;
                // Extents overflow key: keyLen(1), resv(1), forkType(1), resv(1), cnid(4), startBlock(2)
                const keyLen    = data[rec];
                if (keyLen === 0) continue;
                const forkType  = data[rec + 2];   // 0 = data fork
                const recCnid   = u32be(dv, rec + 4);
                const recStart  = u16be(dv, rec + 8);

                if (forkType === 0 && recCnid === cnid && recStart === startBlk) {
                    const kSec = 1 + keyLen;
                    const dataOff = rec + kSec + (kSec % 2 ? 1 : 0);
                    // 3 ExtDataRec entries (6 bytes each: start uint16, count uint16... wait: 4 bytes each)
                    for (let e = 0; e < 3; e++) {
                        const es = u16be(dv, dataOff + e * 4);
                        const ec = u16be(dv, dataOff + e * 4 + 2);
                        if (ec > 0) results.push({ s: es, c: ec });
                    }
                }
            }
            nodeNum = fLink;
        }
        return results;
    }

    // ── Catalog B-tree Walker ────────────────────────────────────────────────

    /**
     * Walk all HFS catalog leaf nodes and collect file entries.
     * @param {Uint8Array} data
     * @param {DataView} dv
     * @param {object} mdb
     * @param {Function} abOff
     * @returns {Array<{name:string, path:string, cnid:number, dfLen:number, exts:Array<{s,c}>}>}
     */
    function walkCatalog(data, dv, mdb, abOff) {
        // Locate catalog B-tree
        // drCTExtRec[0].start from MDB is the first alloc block of the catalog.
        // If it's 0 (ambiguous), fall back to alloc block 1 (empirically correct for Toast HFS).
        let catAllocBlock = mdb.ctExtStart;
        if (catAllocBlock === 0) catAllocBlock = 1;

        const catOff = abOff(catAllocBlock);
        if (catOff + 512 > data.length) return [];

        const hdr = parseBTreeHeader(dv, catOff);
        if (!hdr) return [];
        const { firstLeaf, nodeSize } = hdr;

        // CNID → path map. CNID 1 = root parent (virtual), CNID 2 = root directory.
        const dirs = new Map();
        dirs.set(1, '');
        dirs.set(2, '');

        const files = [];
        let nodeNum = firstLeaf;
        let guard = 0;

        while (nodeNum > 0 && guard++ < 100000) {
            const nOff = catOff + nodeNum * nodeSize;
            if (nOff + nodeSize > data.length) break;
            const fLink = u32be(dv, nOff + 0);
            const kind  = dv.getInt8(nOff + 8);
            const numR  = u16be(dv, nOff + 10);
            if (kind !== -1) { nodeNum = fLink; continue; }

            for (let r = 0; r < numR; r++) {
                const recOff = u16be(dv, nOff + nodeSize - 2 * (r + 1));
                const rec = nOff + recOff;
                if (rec >= nOff + nodeSize) continue;

                // Catalog key: keyLen(1), resv(1), parID(4), nameLen(1), name(nameLen)
                const keyLen  = data[rec];
                if (keyLen === 0) continue;
                const parID   = u32be(dv, rec + 2);
                const nameLen = data[rec + 6];
                const name    = macStr(data, rec + 7, nameLen);

                // Data record starts at word-aligned offset after key
                const keySection = 1 + keyLen;
                const dataOff = rec + keySection + (keySection % 2 ? 1 : 0);
                if (dataOff + 2 > nOff + nodeSize) continue;

                const cdrType = data[dataOff];   // uint8: 1=dir, 2=file, 3=dirThread, 4=fileThread

                if (cdrType === 1) {
                    // CdrDirRec: +6 = dirDirID (uint32)
                    const dirID = u32be(dv, dataOff + 6);
                    const parentPath = dirs.get(parID) !== undefined ? dirs.get(parID) : ('?' + parID);
                    dirs.set(dirID, parentPath ? parentPath + '/' + name : name);

                } else if (cdrType === 2) {
                    // CdrFilRec (102 bytes):
                    // +0:  cdrType (1)
                    // +1:  resv (1)
                    // +2:  filFlgs (1)
                    // +3:  filTyp (1)
                    // +4:  FInfo (16) = fdType(4)+fdCreator(4)+fdFlags(2)+fdLoc(4)+fdFldr(2)
                    // +20: filFlNum = CNID (4)
                    // +24: filStBlk (2, obsolete)
                    // +26: filLgLen = data fork logical length (4)
                    // +30: filPyLen = data fork physical length (4)
                    // +34: filRStBlk (2, obsolete)
                    // +36: filRLgLen = rsrc fork logical length (4)
                    // +40: filRPyLen (4)
                    // +44: filCrDat (4)
                    // +48: filMdDat (4)
                    // +52: filBkDat (4)
                    // +56: FXInfo (16)
                    // +72: filClpSize (2)
                    // +74: filExtRec = 3 × ExtDataRec {start uint16, count uint16} (12)
                    // +86: filRExtRec = 3 × ExtDataRec for resource fork (12)
                    // +98: resv (4)
                    const cnid   = u32be(dv, dataOff + 20);
                    const dfLen  = u32be(dv, dataOff + 26);
                    const e1s    = u16be(dv, dataOff + 74);
                    const e1c    = u16be(dv, dataOff + 76);
                    const e2s    = u16be(dv, dataOff + 78);
                    const e2c    = u16be(dv, dataOff + 80);
                    const e3s    = u16be(dv, dataOff + 82);
                    const e3c    = u16be(dv, dataOff + 84);

                    const parentPath = dirs.get(parID) !== undefined ? dirs.get(parID) : ('?' + parID);

                    files.push({
                        name,
                        path: parentPath ? parentPath + '/' + name : name,
                        cnid,
                        dfLen,
                        exts: [
                            { s: e1s, c: e1c },
                            { s: e2s, c: e2c },
                            { s: e3s, c: e3c },
                        ],
                    });
                }
                // cdrType 3 (dirThread) and 4 (fileThread) are skipped
            }
            nodeNum = fLink;
        }

        return files;
    }

    // ── File Data Extraction ─────────────────────────────────────────────────

    /**
     * Read a file's data fork into a Uint8Array, following extent records.
     * Fetches additional extents from the overflow B-tree if needed.
     * @param {Uint8Array} data         raw disc image bytes
     * @param {DataView} dv
     * @param {Function} abOff          alloc-block → byte-offset
     * @param {object} mdb
     * @param {object} entry            from walkCatalog
     * @returns {Uint8Array}
     */
    function readFileFork(data, dv, abOff, mdb, entry) {
        const { dfLen, cnid, exts } = entry;
        if (dfLen === 0) return new Uint8Array(0);

        const blkSiz = mdb.drAlBlkSiz;
        const out = new Uint8Array(dfLen);
        let written = 0;

        // Collect all extents: start from the 3 in the catalog record
        const allExts = exts.filter(e => e.c > 0).slice();

        // Check if we need more from the extents overflow B-tree
        const covered = allExts.reduce((sum, e) => sum + e.c * blkSiz, 0);
        if (covered < dfLen && mdb.xtExtStart !== undefined) {
            // Find the logical start block where the overflow begins
            const firstOverflowStart = allExts.reduce((sum, e) => sum + e.c, 0);
            const xtStart = abOff(mdb.xtExtStart === 0 ? 0 : mdb.xtExtStart);
            // Walk the extents overflow B-tree
            const nodeSize = 512; // always 512 for HFS
            const extraExts = lookupExtentsOverflow(data, dv, xtStart, cnid, firstOverflowStart, nodeSize);
            allExts.push(...extraExts);
        }

        for (const ext of allExts) {
            if (ext.c === 0 || written >= dfLen) break;
            const byteStart = abOff(ext.s);
            const byteCount = ext.c * blkSiz;
            const remaining = dfLen - written;
            const toCopy    = Math.min(byteCount, remaining);
            if (byteStart + toCopy > data.length) break;
            out.set(data.subarray(byteStart, byteStart + toCopy), written);
            written += toCopy;
        }

        if (written < dfLen) {
            return out.subarray(0, written);
        }
        return out;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Parse an HFS disc image (Uint8Array): find partition, MDB, walk catalog.
     * @param {Uint8Array} imgData
     * @returns {{volName:string, files:Array, _mdb:object, _dv:DataView, _abOff:Function} | null}
     */
    function openImage(imgData) {
        const dv = new DataView(imgData.buffer, imgData.byteOffset, imgData.byteLength);

        const part = findHfsPartition(imgData, dv);
        if (!part) return null;

        const mdb = parseMDB(imgData, dv, part.start);
        if (!mdb) return null;

        const abOff = makeAbOff(mdb);
        const files = walkCatalog(imgData, dv, mdb, abOff);

        return { volName: mdb.volName, files, _mdb: mdb, _dv: dv, _abOff: abOff, _data: imgData };
    }

    return {
        /**
         * Returns true if imgData looks like an Apple HFS disc image
         * (Driver Descriptor Record signature).
         * @param {Uint8Array} imgData
         */
        isHfsImage(imgData) {
            if (imgData.length < 2) return false;
            return (imgData[0] === 0x45 && imgData[1] === 0x52);
        },

        /**
         * List all files in an HFS disc image.
         * @param {Uint8Array} imgData
         * @returns {Array<{name:string, path:string, cnid:number, dfLen:number, exts:Array}>}
         *          or null if not a valid HFS image.
         */
        listFiles(imgData) {
            const img = openImage(imgData);
            if (!img) return null;
            return img.files;
        },

        /**
         * Get the volume name from an HFS disc image.
         * @param {Uint8Array} imgData
         * @returns {string|null}
         */
        getVolumeName(imgData) {
            const img = openImage(imgData);
            return img ? img.volName : null;
        },

        /**
         * Extract the data fork of a file entry (from listFiles).
         * @param {Uint8Array} imgData
         * @param {object} entry  one entry from listFiles()
         * @returns {Uint8Array}
         */
        extractFile(imgData, entry) {
            const dv   = new DataView(imgData.buffer, imgData.byteOffset, imgData.byteLength);
            const part = findHfsPartition(imgData, dv);
            if (!part) throw new Error('HFS: no Apple_HFS partition found');
            const mdb  = parseMDB(imgData, dv, part.start);
            if (!mdb) throw new Error('HFS: invalid MDB');
            const abOff = makeAbOff(mdb);
            return readFileFork(imgData, dv, abOff, mdb, entry);
        },
    };
})();
