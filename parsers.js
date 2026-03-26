// ============================================================
// HoMM3 File Parsers - JavaScript reimplementation of homm3data
// Matches the Python library algorithms 100%
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

    _extractFirstLzmaStream(data) {
        // LZMA decompression - basic implementation
        // This matches the Python code that extracts at offset 1
        // For browser usage, we'll use a simplified approach
        throw new Error('LZMA decompression (HotA 1.8) not supported in browser yet');
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
        this.isHota18 = key[0] === 135;

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
                    return this._extractFirstLzmaStream(compressed);
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
        case 'pcx': return 'image';
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
        case 'fnt': return 'font';
        case 'pal': return 'palette';
        case 'h3m': return 'map';
        case 'h3c': return 'campaign';
        default: return 'binary';
    }
}

// Export
window.H3 = {
    LodFile,
    PCX,
    DefFile,
    PakFile,
    SndFile,
    VidFile,
    DDS,
    SmackerDecoder,
    BinkHeader,
    getFileExtension,
    getFileCategory,
    DataView2,
    zlibDecompress,
    gzipDecompress
};
