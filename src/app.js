// ============================================================
// HoMM3 Explorer - Main Application
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

(() => {
    'use strict';

    // ---- State ----
    const state = {
        mode: 'explorer', // 'explorer' | 'defviewer'
        archive: null,      // LodFile | PakFile | null
        archiveName: '',
        archiveType: '',    // 'lod' | 'pak' | ''
        archives: new Map(), // name -> {archive, type}
        fileList: [],       // [{name, ext, category, size?}]
        selectedFile: null,
        defFiles: [],       // standalone DEF files loaded
        pcxFiles: [],       // standalone PCX files loaded
        standaloneFiles: new Map(), // name -> {data, type}

        // Explorer
        viewMode: 'grid', // 'list' | 'grid'
        iconSize: 64,

        // DEF viewer state
        currentDef: null,
        defAnim: {
            playing: false,
            groupId: 0,
            frameIdx: 0,
            speed: 150,
            how: 'combined',
            timer: null
        },

        // Image viewer sidebar (removed)

        // Def viewer sidebar
        defViewMode: 'grid',
        defIconSize: 64,
        defAnimThumbs: true,

        // Thumbnail cache
        thumbCache: new Map(),

        // Active thumbnail animation timers
        thumbAnimTimers: [],

        // Show image borders
        showBorders: false,

        // White background mode (shared across all image/animation viewers)
        whiteBg: false,

        // Active video/audio cleanup callback
        activeVideoCleanup: null,

        // Text encoding: 'auto' or a specific IANA label
        textEncoding: 'auto',
        // Map / Campaign encoding: 'auto' or a specific IANA label
        mapEncoding: 'auto',

        // Last text preview data for re-rendering on encoding change
        lastTextData: null,

        // Source files (File objects or Uint8Arrays) for hash computation
        sourceFiles: new Map() // name -> {data: Uint8Array|File, filetype}
    };

    // ---- DOM refs ----
    const $ = (s, p) => (p || document).querySelector(s);
    const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

    const els = {};
    function initRefs() {
        els.fileInput = $('#file-input');
        els.binInput = $('#bin-input');
        els.welcomeScreen = $('#welcome-screen');
        els.explorerScreen = $('#explorer-screen');
        els.defviewerScreen = $('#defviewer-screen');
        els.fileList = $('#file-list');
        els.fileSearch = $('#file-search');
        els.fileCount = $('#file-count');
        els.archiveName = $('#archive-name');
        els.archiveSelect = $('#archive-select');
        els.explorerPreview = $('#explorer-preview');
        els.defList = $('#def-list');
        els.defviewerMain = $('#defviewer-main');
        els.loadingOverlay = $('#loading-overlay');
        els.loadingText = $('#loading-text');
        els.loadingBar = $('#loading-progress-bar');
        els.iconSizeSlider = $('#icon-size-slider');
        els.iconSizeControl = $('#icon-size-control');
        els.extFilter = $('#ext-filter');
        els.btnDownloadOriginal = $('#btn-download-archive-original');
        els.btnDownloadZip = $('#btn-download-archive-zip');
        els.btnDownloadHashes = $('#btn-download-hashes');
    }

    // ---- Utilities ----
    function toast(message, type = 'info') {
        const container = $('#toast-container');
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${escapeHtml(message)}</span>`;
        container.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(30px)'; setTimeout(() => el.remove(), 300); }, 12000);
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
    function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, '&quot;');
    }
    // Render H3-style text: {title} → yellow span, newlines → <br>
    function formatH3Text(raw) {
        // escape HTML first, then apply H3 markup
        let s = escapeHtml(raw);
        s = s.replace(/\{([^}]*)\}/g, '<span class="h3-yellow">$1</span>');
        s = s.replace(/\n/g, '<br>');
        return s;
    }

    function showLoading(text = 'Loading...', progress = -1) {
        els.loadingOverlay.style.display = 'flex';
        els.loadingText.textContent = text;
        els.loadingBar.style.width = progress >= 0 ? (progress * 100) + '%' : '0%';
        if (progress < 0) {
            els.loadingBar.style.width = '100%';
            els.loadingBar.style.animation = 'pulse 1.5s ease-in-out infinite';
        } else {
            els.loadingBar.style.animation = 'none';
        }
    }

    function hideLoading() {
        els.loadingOverlay.style.display = 'none';
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function getFileIcon(ext) {
        switch (ext) {
            case 'pcx': case 'p32': return '🖼️';
            case 'def': case 'd32': return '🎬';
            case 'txt': case 'xls': case 'csv': return '📄';
            case 'wav': case 'snd': return '🔊';
            case 'mp3': return '🎵';
            case 'smk': case 'bik': return '🎥';
            case 'msk': return '🎭';
            case 'fnt': return '🔤';
            case 'pal': return '🎨';
            case 'ifr': return '📳';
            case 'h3m': return '🗺️';
            case 'h3c': return '⚔️';
            case 'pak-sheet': return '🗂️';
            case 'pak': return '🖼️';
            default: return '📁';
        }
    }

    // ---- Archive download helpers ----
    function downloadArchiveOriginal() {
        const info = state.archives.get(state.archiveName);
        if (!info || !info.data) return;
        const filename = state.archiveName.replace(/\s*\(GOG\)|\s*\(Demo\)/g, '');
        exportBlob(new Blob([info.data]), filename);
    }

    async function downloadArchiveAsZip() {
        if (!state.archive || !state.fileList.length) return;
        const btn = els.btnDownloadZip;
        btn.disabled = true;
        btn.textContent = 'Building ZIP…';
        try {
            const zipName = state.archiveName.replace(/\.[^.]+$/, '') + '.zip';
            const fileData = [];
            for (const f of state.fileList) {
                if (f.standalone) continue;
                try {
                    const bytes = await state.archive.getFile(f.name);
                    if (bytes) fileData.push({ name: f.name, bytes });
                } catch (_) { /* skip unreadable entries */ }
            }
            exportBlob(new Blob([buildZip(fileData)]), zipName);
            toast(`Downloaded ${zipName} (${fileData.length} files)`, 'success');
        } catch (err) {
            toast('ZIP export failed: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg> ZIP';
        }
    }

    // Minimal STORED (uncompressed) ZIP builder
    function buildZip(files) {
        const enc = new TextEncoder();
        const localHeaders = [];
        const centralDir = [];
        let offset = 0;
        const crc32 = makeCrc32();

        for (const { name, bytes } of files) {
            const nameBytes = enc.encode(name);
            const crc = crc32(bytes);
            const size = bytes.length;

            // Local file header
            const lh = new DataView(new ArrayBuffer(30 + nameBytes.length));
            lh.setUint32(0, 0x04034b50, true);  // signature
            lh.setUint16(4, 20, true);           // version needed
            lh.setUint16(6, 0, true);            // flags
            lh.setUint16(8, 0, true);            // method STORED
            lh.setUint16(10, 0, true);           // mod time
            lh.setUint16(12, 0, true);           // mod date
            lh.setUint32(14, crc, true);         // CRC-32
            lh.setUint32(18, size, true);        // compressed
            lh.setUint32(22, size, true);        // uncompressed
            lh.setUint16(26, nameBytes.length, true);
            lh.setUint16(28, 0, true);           // extra length
            new Uint8Array(lh.buffer).set(nameBytes, 30);

            // Central directory entry
            const cd = new DataView(new ArrayBuffer(46 + nameBytes.length));
            cd.setUint32(0, 0x02014b50, true);  // signature
            cd.setUint16(4, 20, true);           // version made
            cd.setUint16(6, 20, true);           // version needed
            cd.setUint16(8, 0, true);            // flags
            cd.setUint16(10, 0, true);           // method
            cd.setUint16(12, 0, true);           // mod time
            cd.setUint16(14, 0, true);           // mod date
            cd.setUint32(16, crc, true);
            cd.setUint32(20, size, true);
            cd.setUint32(24, size, true);
            cd.setUint16(28, nameBytes.length, true);
            cd.setUint16(30, 0, true);           // extra
            cd.setUint16(32, 0, true);           // comment
            cd.setUint16(34, 0, true);           // disk start
            cd.setUint16(36, 0, true);           // int attr
            cd.setUint32(38, 0, true);           // ext attr
            cd.setUint32(42, offset, true);      // local header offset
            new Uint8Array(cd.buffer).set(nameBytes, 46);

            localHeaders.push(new Uint8Array(lh.buffer), bytes);
            centralDir.push(new Uint8Array(cd.buffer));
            offset += lh.buffer.byteLength + size;
        }

        const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(4, 0, true);
        eocd.setUint16(6, 0, true);
        eocd.setUint16(8, files.length, true);
        eocd.setUint16(10, files.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);
        eocd.setUint16(20, 0, true);

        return new Blob([...localHeaders, ...centralDir, new Uint8Array(eocd.buffer)]);
    }

    function makeCrc32() {
        const table = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c;
        }
        return function crc32(data) {
            let crc = -1;
            for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
            return (crc ^ -1) >>> 0;
        };
    }

    // ---- Export helpers ----
    function exportBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    }

    function exportCanvasAsPng(canvas, filename) {
        canvas.toBlob(blob => { if (blob) exportBlob(blob, filename); }, 'image/png');
    }

    // ---- Hash computation ----
    async function getBytes(dataOrFile) {
        if (dataOrFile instanceof File) {
            return new Uint8Array(await dataOrFile.arrayBuffer());
        }
        return dataOrFile instanceof Uint8Array ? dataOrFile : new Uint8Array(dataOrFile);
    }

    async function computeHashes(dataOrFile) {
        const bytes = await getBytes(dataOrFile);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const toHex = ab => {
            const u8 = new Uint8Array(ab);
            let s = '';
            for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
            return s;
        };
        // Run all three WebCrypto digests in parallel — MD5 runs sync alongside
        const [sha1buf, sha256buf, sha512buf] = await Promise.all([
            crypto.subtle.digest('SHA-1',   buf),
            crypto.subtle.digest('SHA-256', buf),
            crypto.subtle.digest('SHA-512', buf),
        ]);
        return {
            'MD5':    md5Hex(bytes),
            'SHA-1':  toHex(sha1buf),
            'SHA-256': toHex(sha256buf),
            'SHA-512': toHex(sha512buf),
        };
    }

    // Fast MD5: hardcoded K constants (no runtime sin), Uint32Array message schedule,
    // no closures inside block loop, no slice() per block.
    function md5Hex(data) {
        const len = data.length;
        const blocks = ((len + 8) >>> 6) + 1;
        const W = new Uint32Array(blocks * 16);
        for (let i = 0; i < len; i++) W[i >>> 2] |= data[i] << ((i & 3) << 3);
        W[len >>> 2] |= 0x80 << ((len & 3) << 3);
        W[blocks * 16 - 2] = (len * 8) >>> 0;
        W[blocks * 16 - 1] = (len / 0x20000000) | 0;

        // Shift amounts: indexed by [round (0-3)][position in round (0-3)]
        const S = new Uint8Array([7, 12, 17, 22,  5, 9, 14, 20,  4, 11, 16, 23,  6, 10, 15, 21]);

        // Precomputed K[i] = floor(abs(sin(i+1)) * 2^32)
        /* eslint-disable no-multi-spaces */
        const K = new Int32Array([
            0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
            0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
            0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
            0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
            0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
            0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
            0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
            0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
        ]);
        /* eslint-enable no-multi-spaces */

        let ha = 0x67452301, hb = 0xefcdab89 | 0, hc = 0x98badcfe | 0, hd = 0x10325476;

        for (let bi = 0; bi < blocks; bi++) {
            const base = bi * 16;
            let a = ha, b = hb, c = hc, d = hd;

            for (let j = 0; j < 64; j++) {
                let f, g;
                const r = j >>> 4;
                if      (r === 0) { f = (b & c) | (~b & d); g = j; }
                else if (r === 1) { f = (d & b) | (~d & c); g = (5 * j + 1) & 15; }
                else if (r === 2) { f = b ^ c ^ d;           g = (3 * j + 5) & 15; }
                else              { f = c ^ (b | ~d);         g = (7 * j) & 15; }
                const s  = S[(r << 2) | (j & 3)];
                const t  = (a + f + W[base + g] + K[j]) | 0;
                a = d; d = c; c = b;
                b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
            }

            ha = (ha + a) | 0;
            hb = (hb + b) | 0;
            hc = (hc + c) | 0;
            hd = (hd + d) | 0;
        }

        let out = '';
        for (const h of [ha, hb, hc, hd])
            for (let i = 0; i < 4; i++) out += ((h >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        return out;
    }

    // ---- Web Worker utilities for parallel hashing ----
    let _hashWorkerUrl = null;
    function getHashWorkerUrl() {
        if (_hashWorkerUrl) return _hashWorkerUrl;
        // Worker script: MD5 + SHA-1/256/512 via SubtleCrypto, all hashes in one pass
        const script = `
const K = new Int32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391]);
const S = new Uint8Array([7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21]);
function md5(u8) {
    var len = u8.length, blocks = ((len + 8) >>> 6) + 1;
    var W = new Uint32Array(blocks * 16);
    for (var i = 0; i < len; i++) W[i >>> 2] |= u8[i] << ((i & 3) << 3);
    W[len >>> 2] |= 0x80 << ((len & 3) << 3);
    W[blocks * 16 - 2] = (len * 8) >>> 0;
    W[blocks * 16 - 1] = (len / 0x20000000) | 0;
    var ha = 0x67452301, hb = 0xefcdab89 | 0, hc = 0x98badcfe | 0, hd = 0x10325476;
    for (var bi = 0; bi < blocks; bi++) {
        var base = bi * 16, a = ha, b = hb, c = hc, d = hd;
        for (var j = 0; j < 64; j++) {
            var r = j >>> 4, f, g;
            if      (r === 0) { f = (b & c) | (~b & d); g = j; }
            else if (r === 1) { f = (d & b) | (~d & c); g = (5 * j + 1) & 15; }
            else if (r === 2) { f = b ^ c ^ d;           g = (3 * j + 5) & 15; }
            else              { f = c ^ (b | ~d);         g = (7 * j) & 15; }
            var s = S[(r << 2) | (j & 3)], t = (a + f + W[base + g] + K[j]) | 0;
            a = d; d = c; c = b; b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
        }
        ha = (ha + a) | 0; hb = (hb + b) | 0; hc = (hc + c) | 0; hd = (hd + d) | 0;
    }
    var out = '', hs = [ha, hb, hc, hd];
    for (var hi = 0; hi < 4; hi++)
        for (var k = 0; k < 4; k++)
            out += ((hs[hi] >>> (k * 8)) & 0xff).toString(16).padStart(2, '0');
    return out;
}
function toHex(ab) {
    var u = new Uint8Array(ab), s = '';
    for (var i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
    return s;
}
self.onmessage = async function(e) {
    var buf = e.data.buffer;
    var r = await Promise.all([
        crypto.subtle.digest('SHA-1',   buf),
        crypto.subtle.digest('SHA-256', buf),
        crypto.subtle.digest('SHA-512', buf)
    ]);
    self.postMessage({ md5: md5(new Uint8Array(buf)), sha1: toHex(r[0]), sha256: toHex(r[1]), sha512: toHex(r[2]) });
};
`;
        _hashWorkerUrl = URL.createObjectURL(new Blob([script], { type: 'application/javascript' }));
        return _hashWorkerUrl;
    }

    // Returns a transferable copy of the data buffer (does not detach the stored original)
    async function getBufCopy(dataOrFile) {
        if (dataOrFile instanceof File) return dataOrFile.arrayBuffer();
        const u8 = dataOrFile instanceof Uint8Array ? dataOrFile : new Uint8Array(dataOrFile);
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }

    // Send a transferable ArrayBuffer to a fresh worker, resolve with hash results
    function hashInWorker(buf) {
        return new Promise((resolve, reject) => {
            const w = new Worker(getHashWorkerUrl());
            w.onmessage = (e) => { w.terminate(); resolve(e.data); };
            w.onerror  = (e) => { w.terminate(); reject(new Error(e.message || 'Hash worker error')); };
            w.postMessage({ buffer: buf }, [buf]);
        });
    }

    // ---- Hash modal ----
    async function showHashModal(filename, filetype, dataOrFile) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="modal-box" style="max-width:700px; width:95%;">
                <button class="modal-close" id="hash-modal-close" title="Close">&times;</button>
                <h2 style="font-size:16px; margin-bottom:4px; color:var(--text-primary);">&#35; Hashes</h2>
                <p style="font-size:12px; color:var(--text-muted); margin-bottom:16px;">${escapeHtml(filename)} &mdash; ${escapeHtml(filetype)}</p>
                <div id="hash-modal-content" style="font-size:12px; color:var(--text-muted); padding:20px; text-align:center;">Computing hashes…</div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = () => { overlay.remove(); };
        overlay.querySelector('#hash-modal-close').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        try {
            const hashes = await computeHashes(dataOrFile);
            const content = overlay.querySelector('#hash-modal-content');
            content.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-family:monospace; font-size:11px;">
                    <thead><tr style="border-bottom:1px solid var(--border);">
                        <th style="text-align:left; padding:6px 8px; color:var(--text-secondary); font-family:inherit;">Algorithm</th>
                        <th style="text-align:left; padding:6px 8px; color:var(--text-secondary); font-family:inherit;">Hash</th>
                    </tr></thead>
                    <tbody>
                        ${Object.entries(hashes).map(([k,v]) => `
                            <tr style="border-bottom:1px solid var(--border-subtle, #333);">
                                <td style="padding:6px 8px; color:var(--text-secondary); white-space:nowrap;">${escapeHtml(k)}</td>
                                <td style="padding:6px 8px; color:var(--text-primary); word-break:break-all;">${escapeHtml(v)}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            `;
        } catch (e) {
            overlay.querySelector('#hash-modal-content').textContent = 'Error: ' + e.message;
        }
    }

    // ---- Hash TSV export ----
    function exportHashesTsv() {
        // Build complete entry list: source archive/standalone files + all files inside archives
        const allEntries = [];
        for (const [name, { data, filetype }] of state.sourceFiles) {
            const _data = data;
            allEntries.push({ name, filetype, getData: () => Promise.resolve(_data) });
        }
        for (const [archName, { archive, type }] of state.archives) {
            if (typeof archive.getFilelist !== 'function') continue;
            const filelist = archive.getFilelist();
            const ftLabel = type.toUpperCase() + ' entry';
            for (const fname of filelist) {
                const _arch = archive, _fn = fname;
                allEntries.push({ name: archName + '/' + fname, filetype: ftLabel, getData: () => _arch.getFile(_fn) });
            }
        }
        if (allEntries.length === 0) { toast('No files loaded to hash.', 'warning'); return; }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="modal-box" style="max-width:460px; width:90%;">
                <h2 style="font-size:16px; margin-bottom:8px; color:var(--text-primary);">&#35; Export Hashes</h2>
                <p style="font-size:13px; color:var(--text-secondary); margin-bottom:6px;">Compute MD5 / SHA-1 / SHA-256 / SHA-512 for <strong>${allEntries.length}</strong> file(s) (archives + contents) and export as TSV.</p>
                <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">This may take a while for large archives with many files.</p>
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button id="hash-confirm-cancel" style="padding:6px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-tertiary);color:var(--text-secondary);font:inherit;font-size:13px;cursor:pointer;">Cancel</button>
                    <button id="hash-confirm-ok" style="padding:6px 16px;border:1px solid var(--accent,#58a6ff);border-radius:var(--radius-sm);background:var(--accent,#58a6ff);color:#fff;font:inherit;font-size:13px;cursor:pointer;font-weight:600;">Hash &amp; Export</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#hash-confirm-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('#hash-confirm-ok').addEventListener('click', async () => {
            overlay.remove();
            await _doExportHashesTsv(allEntries);
        });
    }

    async function _doExportHashesTsv(allEntries) {
        const total = allEntries.length;
        const rows = [['Filename', 'Filetype', 'MD5', 'SHA-1', 'SHA-256', 'SHA-512']];

        showLoading('Computing hashes…', 0);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Run up to CONCURRENCY files in parallel, each in its own worker
        const CONCURRENCY = Math.min(navigator.hardwareConcurrency || 4, 16);
        const results = new Array(total);
        let completedCount = 0;
        let nextIdx = 0;

        async function runSlot() {
            while (nextIdx < total) {
                const i = nextIdx++;
                const { name, filetype, getData } = allEntries[i];
                showLoading(`Hashing ${name}…`, completedCount / total);
                const data = await getData();
                if (data == null) {
                    results[i] = [name, filetype, 'N/A', 'N/A', 'N/A', 'N/A'];
                    completedCount++;
                    showLoading(`Hashing… (${completedCount}/${total})`, completedCount / total);
                    continue;
                }
                const buf = await getBufCopy(data);
                const h = await hashInWorker(buf);  // buf is transferred (zero-copy)
                results[i] = [name, filetype, h.md5, h.sha1, h.sha256, h.sha512];
                completedCount++;
                showLoading(`Hashing… (${completedCount}/${total})`, completedCount / total);
            }
        }

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, runSlot));

        for (const row of results) rows.push(row);
        hideLoading();
        const tsv = rows.map(r => r.map(c => (c || '').replace(/\t/g, ' ')).join('\t')).join('\n');
        exportBlob(new Blob([tsv], { type: 'text/tab-separated-values' }), 'hashes.tsv');
        toast(`Exported hashes for ${total} entries`, 'success');
    }

    // ---- Mode switching ----
    function updateArchiveSelector() {
        if (state.archives.size <= 1) {
            els.archiveSelect.style.display = 'none';
            els.archiveName.style.display = '';
            return;
        }
        els.archiveSelect.style.display = '';
        els.archiveName.style.display = 'none';
        els.archiveSelect.innerHTML = '';
        for (const name of state.archives.keys()) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === state.archiveName) opt.selected = true;
            els.archiveSelect.appendChild(opt);
        }
    }

    async function switchArchive(name) {
        const info = state.archives.get(name);
        if (!info) return;
        state.archive = info.archive;
        state.archiveName = name;
        state.archiveType = info.type;
        state.thumbCache.clear();
        if (info.type === 'lod' || info.type === 'snd' || info.type === 'vid' || info.type === 'mp3' || info.type === 'maps') buildFileList();
        else if (info.type === 'pak') buildPakFileList();
    }

    function isStandaloneOnly() {
        return !state.archive && state.standaloneFiles.size > 0;
    }

    function updateStandaloneUI() {
        const standalone = isStandaloneOnly();
        // Hide/show nav tabs
        document.querySelector('.header-nav').style.display = standalone ? 'none' : '';
        // Hide/show explorer sidebar + resize handle
        const sidebar = document.querySelector('.explorer-sidebar');
        const resizeHandle = document.getElementById('explorer-resize-handle');
        if (sidebar) sidebar.style.display = standalone ? 'none' : '';
        if (resizeHandle) resizeHandle.style.display = standalone ? 'none' : '';
        // Hide/show defviewer sidebar + resize handle
        const defSidebar = document.querySelector('.defviewer-sidebar');
        const defResizeHandles = document.querySelectorAll('[data-resize="defviewer"]');
        if (defSidebar) defSidebar.style.display = standalone ? 'none' : '';
        defResizeHandles.forEach(h => h.style.display = standalone ? 'none' : '');
    }

    function setMode(mode) {
        state.mode = mode;
        $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        $$('.screen').forEach(s => s.classList.remove('active'));

        // If nothing loaded, show welcome
        if (!state.archive && state.standaloneFiles.size === 0) {
            els.welcomeScreen.classList.add('active');
            return;
        }

        switch (mode) {
            case 'explorer':
                els.explorerScreen.classList.add('active');
                // Auto-select if standalone only
                if (isStandaloneOnly() && state.fileList.length > 0) {
                    updateStandaloneUI();
                    setTimeout(() => selectFile(state.fileList[0]), 50);
                }
                break;
            case 'defviewer':
                els.defviewerScreen.classList.add('active');
                if (isStandaloneOnly()) {
                    updateStandaloneUI();
                    // Auto-open the single standalone DEF
                    for (const [name, info] of state.standaloneFiles) {
                        if (info.type === 'def' && info.parsed) {
                            setTimeout(() => openDefInViewer(name, info.parsed), 50);
                            break;
                        }
                    }
                } else {
                    populateDefList();
                }
                break;
        }
    }

    // ---- File input handling ----
    // Virtual archive wrapping a Map<name, Uint8Array> — used for MP3 folders
    // Virtual archive for MP3 folders — files are extracted lazily on first access
    function createMp3Archive(entries) {
        // entries: [{name, extract: async () => Uint8Array}]
        const cache = new Map();
        return {
            getFilelist: () => entries.map(e => e.name).sort((a, b) => a.localeCompare(b)),
            getFile: async name => {
                if (cache.has(name)) return cache.get(name);
                const entry = entries.find(e => e.name === name);
                if (!entry) return null;
                const data = await entry.extract();
                if (data && data.length > 0) cache.set(name, data);
                return data ?? null;
            }
        };
    }

    function resetState() {
        // Stop active audio/video playback and revoke blob URLs
        if (state.activeVideoCleanup) {
            state.activeVideoCleanup();
            state.activeVideoCleanup = null;
        }
        // Cancel all running thumbnail animation timers
        clearThumbAnimTimers();

        // Clear archive and file data
        state.archive = null;
        state.archiveName = '';
        state.archiveType = '';
        state.archives.clear();
        state.fileList = [];
        state.selectedFile = null;
        state.standaloneFiles.clear();
        state.defFiles = [];
        state.pcxFiles = [];
        state.thumbCache.clear();
        state.lastTextData = null;
        state.sourceFiles.clear();

        // Clear UI
        if (els.explorerPreview) els.explorerPreview.innerHTML = '';
        if (els.fileList) els.fileList.innerHTML = '';
        if (els.fileSearch) els.fileSearch.value = '';
        if (els.archiveName) els.archiveName.textContent = '';
        if (els.archiveSelect) {
            els.archiveSelect.innerHTML = '';
            els.archiveSelect.style.display = 'none';
        }

        // Show welcome screen — setMode detects empty state and routes there
        setMode('explorer');
    }

    async function processFiles(files) {
        if (!files.length) return;
        resetState();

        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();

            // ISO files are too large to read entirely — use File.slice() random access
            if (ext === 'iso') {
                try {
                    await processIsoFile(file);
                } catch (err) {
                    console.error(err);
                    toast(`Error loading ${file.name}: ${err.message}`, 'error');
                    hideLoading();
                }
                continue;
            }

            // SIT (StuffIt 5) archives — read fully then extract game files
            if (ext === 'sit') {
                try {
                    await processSitFile(file);
                } catch (err) {
                    console.error(err);
                    toast(`Error loading ${file.name}: ${err.message}`, 'error');
                    hideLoading();
                }
                continue;
            }

            const data = new Uint8Array(await file.arrayBuffer());

                try {
                    if (ext === 'lod') {
                        showLoading('Parsing LOD archive...');
                        state.archive = await H3.LodFile.open(data);
                        state.archiveName = file.name;
                        state.archiveType = 'lod';
                        state.archives.set(file.name, { archive: state.archive, type: 'lod', data });
                        state.sourceFiles.set(file.name, { data, filetype: 'LOD Archive' });
                        updateArchiveSelector();
                        buildFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name} (${state.fileList.length} files)`, 'success');
                    } else if (ext === 'pak') {
                        showLoading('Parsing PAK archive...', 0);
                        state.archive = await H3.PakFile.open(data, p => showLoading('Parsing PAK archive...', p));
                        state.archiveName = file.name;
                        state.archiveType = 'pak';
                        state.archives.set(file.name, { archive: state.archive, type: 'pak', data });
                        state.sourceFiles.set(file.name, { data, filetype: 'PAK Archive' });
                        updateArchiveSelector();
                        buildPakFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name}`, 'success');
                    } else if (ext === 'def') {
                        showLoading('Parsing DEF file...');
                        const def = H3.DefFile.open(data);
                        state.standaloneFiles.set(file.name, { data, type: 'def', parsed: def });
                        state.sourceFiles.set(file.name, { data, filetype: 'DEF File' });
                        if (!state.archive) {
                            buildStandaloneFileList();
                            setMode('defviewer');
                        }
                        toast(`Loaded DEF: ${file.name}`, 'success');
                    } else if (ext === 'pcx' || ext === 'p32') {
                        showLoading('Parsing image file...');
                        if (H3.PCX.isPcx(data)) {
                            const img = H3.PCX.readPcx(data);
                            state.standaloneFiles.set(file.name, { data, type: 'pcx', parsed: img });
                            state.sourceFiles.set(file.name, { data, filetype: 'PCX Image' });
                            if (!state.archive) {
                                buildStandaloneFileList();
                                setMode('explorer');
                            }
                            toast(`Loaded PCX: ${file.name}`, 'success');
                        } else {
                            toast(`Not a valid PCX file: ${file.name}`, 'error');
                        }
                    } else if (ext === 'run') {
                        // HoMM3 demo .run file — process to extract LODs
                        await processRunFile(file);
                        continue;
                    } else if (ext === 'exe') {
                        await processExeFile(file);
                        continue;
                    } else if (ext === 'pac') {
                        showLoading('Parsing PAC archive...');
                        state.archive = await H3.LodFile.open(data);
                        state.archiveName = file.name;
                        state.archiveType = 'lod';
                        state.archives.set(file.name, { archive: state.archive, type: 'lod', data });
                        state.sourceFiles.set(file.name, { data, filetype: 'PAC Archive' });
                        updateArchiveSelector();
                        buildFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name} (${state.fileList.length} files)`, 'success');
                    } else if (ext === 'snd') {
                        showLoading('Parsing SND archive...');
                        state.archive = await H3.SndFile.open(data);
                        state.archiveName = file.name;
                        state.archiveType = 'snd';
                        state.archives.set(file.name, { archive: state.archive, type: 'snd', data });
                        state.sourceFiles.set(file.name, { data, filetype: 'SND Archive' });
                        updateArchiveSelector();
                        buildFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name} (${state.fileList.length} files)`, 'success');
                    } else if (ext === 'vid') {
                        showLoading('Parsing VID archive...');
                        state.archive = await H3.VidFile.open(data);
                        state.archiveName = file.name;
                        state.archiveType = 'vid';
                        state.archives.set(file.name, { archive: state.archive, type: 'vid', data });
                        state.sourceFiles.set(file.name, { data, filetype: 'VID Archive' });
                        updateArchiveSelector();
                        buildFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name} (${state.fileList.length} files)`, 'success');
                    } else if (ext === 'd32') {
                        showLoading('Parsing D32 file...');
                        const def = H3.DefFile.open(data);
                        state.standaloneFiles.set(file.name, { data, type: 'def', parsed: def });
                        state.sourceFiles.set(file.name, { data, filetype: 'D32 File' });
                        if (!state.archive) {
                            buildStandaloneFileList();
                            setMode('defviewer');
                        }
                        toast(`Loaded D32: ${file.name}`, 'success');
                    } else if (ext === 'fnt') {
                        showLoading('Parsing FNT file...');
                        if (H3.FNT.isFnt(data)) {
                            const font = H3.FNT.readFnt(data);
                            state.standaloneFiles.set(file.name, { data, type: 'fnt', parsed: font });
                            state.sourceFiles.set(file.name, { data, filetype: 'FNT Font' });
                            if (!state.archive) {
                                buildStandaloneFileList();
                                setMode('explorer');
                            }
                            toast(`Loaded FNT: ${file.name}`, 'success');
                        } else {
                            toast(`Not a valid FNT file: ${file.name}`, 'error');
                        }
                    } else if (ext === 'h3m') {
                        showLoading('Parsing H3M map...');
                        try {
                            const mapData = H3Map.parseH3M(data);
                            state.standaloneFiles.set(file.name, { data, type: 'map', parsed: mapData });
                            state.sourceFiles.set(file.name, { data, filetype: 'H3M Map' });
                            if (!state.archive) {
                                buildStandaloneFileList();
                                setMode('explorer');
                            }
                            toast(`Loaded H3M: ${file.name} — ${mapData.name}`, 'success');
                        } catch (err) {
                            console.error(err);
                            toast(`Error parsing H3M ${file.name}: ${err.message}`, 'error');
                        }
                    } else if (ext === 'h3c') {
                        showLoading('Parsing H3C campaign...');
                        try {
                            const campaign = await H3Map.parseH3C(data);
                            state.standaloneFiles.set(file.name, { data, type: 'campaign', parsed: campaign });
                            state.sourceFiles.set(file.name, { data, filetype: 'H3C Campaign' });
                            if (!state.archive) {
                                buildStandaloneFileList();
                                setMode('explorer');
                            }
                            toast(`Loaded H3C: ${file.name} — ${campaign.name} (${campaign.mapCount} maps)`, 'success');
                        } catch (err) {
                            console.error(err);
                            toast(`Error parsing H3C ${file.name}: ${err.message}`, 'error');
                        }
                    }
                } catch (err) {
                    console.error(err);
                    toast(`Error loading ${file.name}: ${err.message}`, 'error');
                }
            }
            hideLoading();
    }

    function setupFileInput() {
        els.fileInput.addEventListener('change', async (e) => {
            await processFiles(e.target.files);
            e.target.value = '';
        });
    }

    // ---- Build file list from LOD ----
    function buildFileList() {
        const list = state.archive.getFilelist();
        state.fileList = list.map(name => {
            const ext = H3.getFileExtension(name);
            const category = H3.getFileCategory(name);
            // SND archives contain wav entries without file extensions
            const isAudio = (state.archiveType === 'snd' && !ext) || ext === 'mp3';
            return { name, ext, category, isAudio };
        });
        state.fileList.sort((a, b) => a.name.localeCompare(b.name));
        updateExtFilter();
        renderFileList();
    }

    function buildPakFileList() {
        const sheets = state.archive.getSheetnames();
        state.fileList = [];
        for (const sheet of sheets) {
            const filenames = state.archive.getFilenamesForSheet(sheet);
            if (filenames) {
                for (const fname of filenames) {
                    state.fileList.push({ name: `${sheet}/${fname}`, ext: 'pak', category: 'image', sheet, imageName: fname });
                }
            }
            state.fileList.push({ name: sheet, ext: 'pak-sheet', category: 'sheet', sheet });
        }
        state.fileList.sort((a, b) => a.name.localeCompare(b.name));
        updateExtFilter();
        renderFileList();
    }

    function buildStandaloneFileList() {
        state.fileList = [];
        for (const [name, info] of state.standaloneFiles) {
            const ext = H3.getFileExtension(name) || info.type;
            const category = H3.getFileCategory(name);
            state.fileList.push({ name, ext, category, standalone: true });
        }
        state.fileList.sort((a, b) => a.name.localeCompare(b.name));
        updateExtFilter();
        renderFileList();
    }

    // ---- Render file list ----
    function updateExtFilter() {
        const exts = new Set();
        for (const f of state.fileList) { if (f.ext) exts.add(f.ext); }
        const sorted = [...exts].sort();
        els.extFilter.innerHTML = '<option value="">All</option>';
        for (const ext of sorted) {
            const opt = document.createElement('option');
            opt.value = ext;
            opt.textContent = '.' + ext.toUpperCase();
            els.extFilter.appendChild(opt);
        }
    }

    function renderFileList(filter = '') {
        const container = els.fileList;
        container.innerHTML = '';
        const filterLower = filter.toLowerCase();
        const extFilterVal = els.extFilter ? els.extFilter.value : '';
        const filtered = state.fileList.filter(f => {
            if (filterLower && !f.name.toLowerCase().includes(filterLower)) return false;
            if (extFilterVal && f.ext !== extFilterVal) return false;
            return true;
        });

        els.fileCount.textContent = `${filtered.length} files`;
        els.archiveName.textContent = state.archiveName || 'Files';

        const isGrid = state.viewMode === 'grid';
        container.className = `file-list ${isGrid ? 'grid-view' : 'list-view'}`;

        if (isGrid) {
            container.style.setProperty('--icon-size', state.iconSize + 'px');
        }

        // PAK tree view: group sprites under their sheet when in list mode and no ext filter
        const usePakTree = state.archiveType === 'pak' && !isGrid && !extFilterVal;

        if (usePakTree) {
            // Group files by sheet
            const sheets = new Map(); // sheetName -> {sheetFile, sprites[]}
            for (const file of filtered) {
                if (file.category === 'sheet') {
                    if (!sheets.has(file.sheet)) sheets.set(file.sheet, { sheetFile: file, sprites: [] });
                    else sheets.get(file.sheet).sheetFile = file;
                } else if (file.sheet) {
                    if (!sheets.has(file.sheet)) sheets.set(file.sheet, { sheetFile: null, sprites: [] });
                    sheets.get(file.sheet).sprites.push(file);
                }
            }
            // Also include sheets that only matched via sprite search
            for (const file of filtered) {
                if (file.category !== 'sheet' && file.sheet && sheets.has(file.sheet) && !sheets.get(file.sheet).sheetFile) {
                    const sf = state.fileList.find(f => f.category === 'sheet' && f.sheet === file.sheet);
                    if (sf) sheets.get(file.sheet).sheetFile = sf;
                }
            }

            for (const [sheetName, { sheetFile, sprites }] of sheets) {
                // Sheet header (collapsible)
                const group = document.createElement('div');
                group.className = 'pak-tree-group';

                const header = document.createElement('div');
                header.className = 'file-item pak-tree-header';
                if (sheetFile) header.dataset.filename = sheetFile.name;
                const isExpanded = !filterLower; // auto-collapse when not searching, expand when searching
                header.innerHTML = `
                    <span class="pak-tree-toggle">${sprites.length > 0 ? (filterLower ? '▼' : '▶') : ' '}</span>
                    <span class="file-item-icon">${getFileIcon('pak-sheet')}</span>
                    <span class="file-item-name">${escapeHtml(sheetName)}</span>
                    <span class="file-item-ext ext-pak-sheet">${sprites.length} sprites</span>
                `;

                const spriteContainer = document.createElement('div');
                spriteContainer.className = 'pak-tree-children';
                spriteContainer.style.display = filterLower ? '' : 'none';

                if (sprites.length > 0) {
                    header.addEventListener('click', (e) => {
                        const toggle = header.querySelector('.pak-tree-toggle');
                        const isOpen = spriteContainer.style.display !== 'none';
                        spriteContainer.style.display = isOpen ? 'none' : '';
                        toggle.textContent = isOpen ? '▶' : '▼';
                        if (sheetFile) {
                            $$('.file-item', els.fileList).forEach(el => el.classList.remove('selected'));
                            header.classList.add('selected');
                            selectFile(sheetFile);
                        }
                    });
                } else if (sheetFile) {
                    header.addEventListener('click', () => {
                        $$('.file-item', els.fileList).forEach(el => el.classList.remove('selected'));
                        header.classList.add('selected');
                        selectFile(sheetFile);
                    });
                }

                for (const sprite of sprites) {
                    const item = document.createElement('div');
                    item.className = 'file-item pak-tree-child';
                    item.dataset.filename = sprite.name;
                    item.innerHTML = `
                        <span class="file-item-icon">${getFileIcon('pak')}</span>
                        <span class="file-item-name">${escapeHtml(sprite.imageName || sprite.name)}</span>
                    `;
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        $$('.file-item', els.fileList).forEach(el => el.classList.remove('selected'));
                        item.classList.add('selected');
                        selectFile(sprite);
                    });
                    spriteContainer.appendChild(item);
                }

                group.appendChild(header);
                group.appendChild(spriteContainer);
                container.appendChild(group);
            }
            return;
        }

        for (const file of filtered) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.dataset.filename = file.name;

            if (isGrid) {
                item.style.width = Math.max(state.iconSize + 16, 72) + 'px';
                const iconDiv = document.createElement('div');
                iconDiv.className = 'file-item-icon';
                iconDiv.style.height = state.iconSize + 'px';

                // Show thumbnail for image types in grid view (lazy loaded)
                if ((file.ext === 'pcx' || file.ext === 'p32' || file.ext === 'def') && state.archiveType === 'lod') {
                    iconDiv.textContent = getFileIcon(file.ext);
                    iconDiv.dataset.lazyThumb = file.name;
                } else {
                    iconDiv.textContent = file.isAudio ? '🔊' : getFileIcon(file.ext);
                }

                const nameDiv = document.createElement('div');
                nameDiv.className = 'file-item-name';
                nameDiv.textContent = file.name;

                item.appendChild(iconDiv);
                item.appendChild(nameDiv);
            } else {
                const icon = file.isAudio ? '🔊' : getFileIcon(file.ext);
                item.innerHTML = `
                    <span class="file-item-icon">${icon}</span>
                    <span class="file-item-name">${escapeHtml(file.name)}</span>
                    <span class="file-item-ext ext-${file.ext}">${file.ext}</span>
                `;
            }

            item.addEventListener('click', () => selectFile(file));
            container.appendChild(item);
        }

        // Lazy load thumbnails using IntersectionObserver
        if (isGrid) {
            const lazyEls = container.querySelectorAll('[data-lazy-thumb]');
            if (lazyEls.length > 0) {
                const observer = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            const el = entry.target;
                            const fname = el.dataset.lazyThumb;
                            if (fname) {
                                loadThumbnail(fname, el);
                                delete el.dataset.lazyThumb;
                            }
                            observer.unobserve(el);
                        }
                    }
                }, { root: container, rootMargin: '200px' });
                lazyEls.forEach(el => observer.observe(el));
            }
        }
    }

    async function loadThumbnail(filename, container) {
        if (state.thumbCache.has(filename)) {
            const cached = state.thumbCache.get(filename);
            if (cached) {
                const c = document.createElement('canvas');
                c.width = cached.width;
                c.height = cached.height;
                c.getContext('2d').drawImage(cached, 0, 0);
                container.textContent = '';
                container.appendChild(c);
            } else {
                container.textContent = getFileIcon(H3.getFileExtension(filename));
            }
            return;
        }

        try {
            const data = await state.archive.getFile(filename);
            if (!data) { container.textContent = '❓'; return; }

            const ext = H3.getFileExtension(filename);
            if ((ext === 'pcx' || ext === 'p32') && H3.PCX.isPcx(data)) {
                const img = H3.PCX.readPcx(data);
                if (img) {
                    state.thumbCache.set(filename, img.canvas);
                    const c = document.createElement('canvas');
                    c.width = img.canvas.width;
                    c.height = img.canvas.height;
                    c.getContext('2d').drawImage(img.canvas, 0, 0);
                    container.textContent = '';
                    container.appendChild(c);
                    return;
                }
            }
            if (ext === 'def') {
                const def = H3.DefFile.open(data);
                const groups = def.getGroups();
                if (groups.length > 0) {
                    const canvas = def.readImage('combined', groups[0], 0);
                    if (canvas) {
                        state.thumbCache.set(filename, canvas);
                        const c = document.createElement('canvas');
                        c.width = canvas.width;
                        c.height = canvas.height;
                        c.getContext('2d').drawImage(canvas, 0, 0);
                        container.textContent = '';
                        container.appendChild(c);
                        return;
                    }
                }
            }
        } catch (e) {
            // ignore
        }
        state.thumbCache.set(filename, null);
        container.textContent = getFileIcon(H3.getFileExtension(filename));
    }

    // ---- Select file in explorer ----
    async function selectFile(file) {
        state.selectedFile = file;

        // Stop any playing video/audio from the previous preview
        if (state.activeVideoCleanup) {
            state.activeVideoCleanup();
            state.activeVideoCleanup = null;
        }

        // Highlight selection
        $$('.file-item', els.fileList).forEach(el => {
            el.classList.toggle('selected', el.dataset.filename === file.name);
        });

        const preview = els.explorerPreview;
        state.lastTextData = null; // clear until a text file is actually rendered

        try {
            if (file.standalone) {
                const info = state.standaloneFiles.get(file.name);
                if (info.type === 'pcx') {
                    showImagePreview(preview, info.parsed.canvas, file.name, `${info.parsed.width}×${info.parsed.height}`, info.parsed.type);
                } else if (info.type === 'def') {
                    showDefPreview(preview, info.parsed, file.name, info.data);
                } else if (info.type === 'fnt') {
                    showFntPreview(preview, info.parsed, file.name, info.data);
                } else if (info.type === 'map') {
                    let mapParsed = info.parsed;
                    if (state.mapEncoding !== 'auto' && info.data) {
                        try { mapParsed = H3Map.parseH3M(info.data, { encoding: state.mapEncoding }); } catch { /* fallback to cached */ }
                    }
                    showH3MPreview(preview, mapParsed, file.name, info.data);
                } else if (info.type === 'campaign') {
                    let campaignParsed = info.parsed;
                    if (state.mapEncoding !== 'auto' && info.data) {
                        try { campaignParsed = await H3Map.parseH3C(info.data, { encoding: state.mapEncoding }); } catch { /* fallback to cached */ }
                    }
                    showH3CPreview(preview, campaignParsed, file.name, info.data);
                }
                return;
            }

            if (state.archiveType === 'lod') {
                showLoading('Loading file...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }

                const ext = file.ext;

                if ((ext === 'pcx' || ext === 'p32') && H3.PCX.isPcx(data)) {
                    const img = H3.PCX.readPcx(data);
                    if (img) {
                        showImagePreview(preview, img.canvas, file.name, `${img.width}×${img.height}`, img.type, data);
                    } else {
                        showPreviewError(preview, 'Failed to decode PCX');
                    }
                } else if (ext === 'def') {
                    const def = H3.DefFile.open(data);
                    showDefPreview(preview, def, file.name, data);
                } else if (ext === 'fnt' && H3.FNT.isFnt(data)) {
                    const font = H3.FNT.readFnt(data);
                    showFntPreview(preview, font, file.name, data);
                } else if (ext === 'pal') {
                    try {
                        const pal = H3.PAL.parse(data);
                        showPalPreview(preview, pal, file.name, data);
                    } catch (_) {
                        showBinaryPreview(preview, data, file.name);
                    }
                } else if (ext === 'ifr') {
                    try {
                        const effects = H3.IFR.parse(data);
                        showIfrPreview(preview, effects, file.name, data);
                    } catch (_) {
                        showBinaryPreview(preview, data, file.name);
                    }
                } else if (ext === 'txt' || ext === 'xls' || ext === 'csv') {
                    showTextPreview(preview, data, file.name);
                } else if (ext === 'wav' || (ext === '' && isWavData(data))) {
                    showAudioPreview(preview, data, file.name);
                } else if (ext === 'h3m') {
                    try {
                        const mapData = H3Map.parseH3M(data, { encoding: state.mapEncoding !== 'auto' ? state.mapEncoding : null });
                        showH3MPreview(preview, mapData, file.name, data);
                    } catch (e) {
                        showMapPreviewFallback(preview, file.name, data, e);
                    }
                } else if (ext === 'h3c') {
                    try {
                        const campaign = await H3Map.parseH3C(data, { encoding: state.mapEncoding !== 'auto' ? state.mapEncoding : null });
                        showH3CPreview(preview, campaign, file.name, data);
                    } catch (e) {
                        showMapPreviewFallback(preview, file.name, data, e);
                    }
                } else {
                    showBinaryPreview(preview, data, file.name);
                }
            } else if (state.archiveType === 'snd') {
                showLoading('Loading file...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }
                showAudioPreview(preview, data, file.name);
            } else if (state.archiveType === 'mp3') {
                showLoading('Loading file...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }
                showAudioPreview(preview, data, file.name, 'audio/mpeg');
            } else if (state.archiveType === 'maps') {
                showLoading('Loading map...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }
                const ext = file.ext || file.name.split('.').pop().toLowerCase();
                if (ext === 'h3c') {
                    try {
                        const campaign = await H3Map.parseH3C(data, { encoding: state.mapEncoding !== 'auto' ? state.mapEncoding : null });
                        showH3CPreview(preview, campaign, file.name, data);
                    } catch (e) {
                        showMapPreviewFallback(preview, file.name, data, e);
                    }
                } else {
                    try {
                        const mapData = H3Map.parseH3M(data, { encoding: state.mapEncoding !== 'auto' ? state.mapEncoding : null });
                        showH3MPreview(preview, mapData, file.name, data);
                    } catch (e) {
                        showMapPreviewFallback(preview, file.name, data, e);
                    }
                }
            } else if (state.archiveType === 'vid') {
                showLoading('Loading file...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }
                const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
                // Detect video format by magic bytes
                if (u8.length >= 4 && u8[0] === 0x53 && u8[1] === 0x4D && u8[2] === 0x4B) {
                    // SMK file (SMK2 or SMK4)
                    showSmkPreview(preview, u8, file.name);
                } else if (u8.length >= 4 && u8[0] === 0x42 && u8[1] === 0x49 && u8[2] === 0x4B) {
                    // BIK file
                    await showBikPreview(preview, u8, file.name);
                } else {
                    showBinaryPreview(preview, data, file.name);
                }
            } else if (state.archiveType === 'pak') {
                if (file.imageName && file.sheet) {
                    showLoading('Loading image...');
                    const result = await state.archive.getImage(file.sheet, file.imageName);
                    const rawChunks = state.archive.getRawChunks(file.sheet);
                    hideLoading();
                    if (result) {
                        showImagePreview(preview, result.image, file.name, `${result.image.width}×${result.image.height}`, 'pak');
                        // Add raw DDS export for sprite's sheet chunk
                        const cfg = state.archive.getSheetConfig(file.sheet);
                        if (cfg && rawChunks) {
                            const entry = Object.entries(cfg).find(([k]) => k.toUpperCase() === file.imageName.toUpperCase());
                            if (entry) {
                                const chunkIdx = entry[1].no;
                                if (rawChunks[chunkIdx]) {
                                    addRawExportButton(preview, rawChunks[chunkIdx], `${file.sheet}_sheet${chunkIdx}.dds`);
                                }
                            }
                        }
                    } else {
                        showPreviewError(preview, 'Failed to load PAK image');
                    }
                } else if (file.category === 'sheet') {
                    showLoading('Loading sheet...');
                    const sheets = await state.archive.getSheets(file.sheet);
                    const rawChunks = state.archive.getRawChunks(file.sheet);
                    hideLoading();
                    if (sheets && sheets.length > 0) {
                        showPakSheetPreview(preview, sheets, rawChunks, file.sheet);
                    }
                }
            }
        } catch (err) {
            hideLoading();
            console.error(err);
            showPreviewError(preview, err.message);
        }
    }

    // ---- Scroll-zoom + pinch + pan for preview areas ----
    // body: container element (overflow set to hidden); getEl: returns current content element
    // Returns { setZoom(scale), doFit(), reapply(), recentre() }
    function attachZoomPan(body, getEl) {
        let scale = 1, tx = 0, ty = 0;
        const ptrs = new Map(); // pointerId -> {x, y}
        body.style.overflow = 'hidden';
        body.style.touchAction = 'none';
        body.style.alignItems = 'flex-start';
        body.style.justifyContent = 'flex-start';

        function applyTransform() {
            const el = getEl();
            if (!el) return;
            el.style.maxWidth = el.style.maxHeight = 'none';
            el.style.transformOrigin = '0 0';
            el.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
            body.style.cursor = ptrs.size > 0 ? 'grabbing' : 'grab';
        }
        function getSize() {
            const el = getEl();
            if (!el) return [0, 0];
            return [el.width || el.offsetWidth || 1, el.height || el.offsetHeight || 1];
        }
        function zoomAt(cx, cy, factor) {
            const r = body.getBoundingClientRect();
            const bx = cx - r.left, by = cy - r.top;
            const px = (bx - tx) / scale, py = (by - ty) / scale;
            scale = Math.min(64, Math.max(0.05, scale * factor));
            tx = bx - px * scale; ty = by - py * scale;
            applyTransform();
        }

        body.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });

        body.addEventListener('pointerdown', e => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            body.setPointerCapture(e.pointerId);
            applyTransform();
        });
        body.addEventListener('pointermove', e => {
            if (!ptrs.has(e.pointerId)) return;
            const prev = ptrs.get(e.pointerId);
            ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (ptrs.size === 1) {
                // Pan
                tx += e.clientX - prev.x;
                ty += e.clientY - prev.y;
                applyTransform();
            } else if (ptrs.size === 2) {
                // Pinch zoom — use the other pointer's last known position
                const otherId = [...ptrs.keys()].find(id => id !== e.pointerId);
                const other = ptrs.get(otherId);
                const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
                const newDist  = Math.hypot(e.clientX - other.x, e.clientY - other.y);
                if (prevDist > 1) zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, newDist / prevDist);
            }
        });
        body.addEventListener('pointerup',     e => { ptrs.delete(e.pointerId); applyTransform(); });
        body.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); applyTransform(); });

        function doFit() {
            const [ew, eh] = getSize();
            const bw = body.clientWidth, bh = body.clientHeight;
            if (!bw || !bh || !ew || !eh) return;
            const s = Math.min((bw - 40) / ew, (bh - 40) / eh);
            scale = Math.min(1, s);
            tx = (bw - ew * scale) / 2; ty = (bh - eh * scale) / 2;
            applyTransform();
        }
        function setZoom(newScale) {
            const [ew, eh] = getSize();
            const bw = body.clientWidth, bh = body.clientHeight;
            scale = newScale;
            tx = (bw - ew * scale) / 2; ty = (bh - eh * scale) / 2;
            applyTransform();
        }
        // Recentre without fitting (called when canvas size changes mid-animation)
        function recentre() {
            const [ew, eh] = getSize();
            const bw = body.clientWidth, bh = body.clientHeight;
            if (!bw || !bh || !ew || !eh) return;
            tx = (bw - ew * scale) / 2; ty = (bh - eh * scale) / 2;
            applyTransform();
        }
        // Initial fit: ResizeObserver fires as soon as the container gets real dimensions
        // (more reliable than rAF on mobile where layout may not be complete in 2 frames)
        let initFitDone = false;
        const _ro = new ResizeObserver(() => {
            if (!initFitDone && body.clientWidth > 0 && body.clientHeight > 0) {
                initFitDone = true;
                doFit();
                _ro.disconnect();
            }
        });
        _ro.observe(body);
        // rAF fallback in case ResizeObserver doesn't fire (e.g. already sized)
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!initFitDone) { initFitDone = true; doFit(); _ro.disconnect(); }
        }));
        return { setZoom, doFit, reapply: applyTransform, recentre };
    }

    // Creates a GIF-ready frame: composites on black (shadow pixels render correctly),
    // then replaces fully-transparent source pixels with the GIF transparent key (magenta).
    function makeGifFrame(srcCanvas, w, h) {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(srcCanvas, 0, 0);
        const sw = Math.min(srcCanvas.width, w), sh = Math.min(srcCanvas.height, h);
        const srcD = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
        const dstImg = ctx.getImageData(0, 0, w, h);
        const dd = dstImg.data;
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                if (srcD[(y * sw + x) * 4 + 3] === 0) {
                    const di = (y * w + x) * 4;
                    dd[di] = 0xFF; dd[di + 1] = 0x00; dd[di + 2] = 0xFF; dd[di + 3] = 0xFF;
                }
            }
        }
        ctx.putImageData(dstImg, 0, 0);
        return cv;
    }

    function applyBgState(bodyEl) {
        bodyEl.classList.toggle('bg-white', state.whiteBg);
    }

    function setupBgToggle(btnEl, bodyEl) {
        if (!btnEl || !bodyEl) return;
        btnEl.classList.toggle('active', state.whiteBg);
        btnEl.addEventListener('click', () => {
            state.whiteBg = !state.whiteBg;
            btnEl.classList.toggle('active', state.whiteBg);
            bodyEl.classList.toggle('bg-white', state.whiteBg);
        });
    }

    // ---- Preview renderers ----
    function showImagePreview(container, canvas, filename, dimensions, type, rawData) {
        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${dimensions}</span>
                        <span>${type.toUpperCase()}</span>
                    </div>
                    <button class="preview-toolbar-toggle" title="More options">☰</button>
                    <div class="preview-toolbar">
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Toggle white background" class="toggle-btn${state.whiteBg ? ' active' : ''}" id="bg-toggle-btn"><svg width="12" height="12" viewBox="0 0 4 4" fill="currentColor"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg></button>
                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="border-toggle-btn">□</button>
                        ${rawData ? '<button title="Show file hashes" id="hash-img-btn"># Hash</button>' : ''}
                        <button title="Export as PNG" id="export-png-btn">💾 PNG</button>
                        ${rawData ? '<button title="Export original" id="export-orig-btn">💾 Orig</button>' : ''}
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-img-body"></div>
            </div>
        `;

        const body = $('#preview-img-body', container);
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d').drawImage(canvas, 0, 0);
        body.appendChild(c);
        if (state.showBorders) c.classList.add('img-border');

        // Border toggle
        const borderBtn = container.querySelector('#border-toggle-btn');
        if (borderBtn) {
            borderBtn.addEventListener('click', () => {
                state.showBorders = !state.showBorders;
                borderBtn.classList.toggle('active', state.showBorders);
                c.classList.toggle('img-border', state.showBorders);
            });
        }

        // Zoom controls + pan
        const zp = attachZoomPan(body, () => c);
        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const z = btn.dataset.zoom;
                if (z === 'fit') zp.doFit();
                else if (z === 'actual') zp.setZoom(1);
                else if (z === '2x') zp.setZoom(2);
                else if (z === '4x') zp.setZoom(4);
            });
        });

        applyBgState(body);
        setupBgToggle(container.querySelector('#bg-toggle-btn'), body);
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));

        // Export PNG
        const pngBtn = container.querySelector('#export-png-btn');
        if (pngBtn) pngBtn.addEventListener('click', () => exportCanvasAsPng(c, filename.replace(/\.[^.]+$/, '.png')));
        // Export original
        const origBtn = container.querySelector('#export-orig-btn');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
        // Hash
        const hashImgBtn = container.querySelector('#hash-img-btn');
        if (hashImgBtn && rawData) hashImgBtn.addEventListener('click', () => showHashModal(filename, type.toUpperCase(), rawData));
    }

    function showPakSheetPreview(container, sheets, rawChunks, sheetName) {
        let currentIdx = 0;
        const sheetCount = sheets.length;
        // Build sheet selector options
        let sheetOptions = '';
        for (let i = 0; i < sheetCount; i++) {
            sheetOptions += `<option value="${i}">Sheet ${i} (${sheets[i].width}×${sheets[i].height})</option>`;
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(sheetName)}</span>
                    <div class="preview-meta">
                        <span id="pak-sheet-dims">${sheets[0].width}×${sheets[0].height}</span>
                        <span>PAK-SHEET</span>
                    </div>
                    <button class="preview-toolbar-toggle" title="More options">☰</button>
                    <div class="preview-toolbar">
                        ${sheetCount > 1 ? `<select id="pak-sheet-select" title="Select sheet">${sheetOptions}</select>` : `<span style="font-size:12px;color:var(--text-muted)">Sheet 0</span>`}
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Toggle white background" class="toggle-btn${state.whiteBg ? ' active' : ''}" id="bg-toggle-btn"><svg width="12" height="12" viewBox="0 0 4 4" fill="currentColor"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg></button>
                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="border-toggle-btn">□</button>
                        <button title="Export as PNG" id="export-png-btn">💾 PNG</button>
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-img-body"></div>
            </div>
        `;

        const body = container.querySelector('#preview-img-body');
        const dimsEl = container.querySelector('#pak-sheet-dims');
        const c = document.createElement('canvas');
        body.appendChild(c);

        function showSheet(idx) {
            currentIdx = idx;
            const sheet = sheets[idx];
            c.width = sheet.width;
            c.height = sheet.height;
            c.getContext('2d').drawImage(sheet, 0, 0);
            if (state.showBorders) c.classList.add('img-border');
            else c.classList.remove('img-border');
            dimsEl.textContent = `${sheet.width}×${sheet.height}`;
        }
        showSheet(0);

        // Sheet selector
        const sel = container.querySelector('#pak-sheet-select');
        if (sel) {
            sel.addEventListener('change', () => showSheet(parseInt(sel.value)));
        }

        // Border toggle
        const borderBtn = container.querySelector('#border-toggle-btn');
        if (borderBtn) {
            borderBtn.addEventListener('click', () => {
                state.showBorders = !state.showBorders;
                borderBtn.classList.toggle('active', state.showBorders);
                c.classList.toggle('img-border', state.showBorders);
            });
        }

        // Zoom controls + pan
        const zp = attachZoomPan(body, () => c);
        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const z = btn.dataset.zoom;
                if (z === 'fit') zp.doFit();
                else if (z === 'actual') zp.setZoom(1);
                else if (z === '2x') zp.setZoom(2);
                else if (z === '4x') zp.setZoom(4);
            });
        });

        applyBgState(body);
        setupBgToggle(container.querySelector('#bg-toggle-btn'), body);
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));

        // Export PNG
        const pngBtn = container.querySelector('#export-png-btn');
        if (pngBtn) pngBtn.addEventListener('click', () => exportCanvasAsPng(c, `${sheetName}_sheet${currentIdx}.png`));

        // Raw DDS export buttons
        if (rawChunks) {
            const toolbar = container.querySelector('.preview-toolbar');
            if (toolbar) {
                const ddsBtn = document.createElement('button');
                ddsBtn.title = 'Export raw DDS';
                ddsBtn.textContent = '💾 DDS';
                ddsBtn.addEventListener('click', () => exportBlob(new Blob([rawChunks[currentIdx]]), `${sheetName}_sheet${currentIdx}.dds`));
                toolbar.appendChild(ddsBtn);
                if (rawChunks.length > 1) {
                    addRawExportAllButton(container, rawChunks, sheetName);
                }
            }
        }
    }

    function addRawExportButton(container, rawData, filename) {
        const toolbar = container.querySelector('.preview-toolbar');
        if (!toolbar) return;
        const btn = document.createElement('button');
        btn.className = 'pak-dds-export';
        btn.title = 'Export raw DDS';
        btn.textContent = '💾 DDS';
        btn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
        toolbar.appendChild(btn);
    }

    function addRawExportAllButton(container, chunks, sheetName) {
        const toolbar = container.querySelector('.preview-toolbar');
        if (!toolbar) return;
        const btn = document.createElement('button');
        btn.title = 'Export all DDS sheets';
        btn.textContent = '💾 All DDS';
        btn.addEventListener('click', () => {
            for (let i = 0; i < chunks.length; i++) {
                exportBlob(new Blob([chunks[i]]), `${sheetName}_sheet${i}.dds`);
            }
        });
        toolbar.appendChild(btn);
    }

    function showDefPreview(container, def, filename, rawData = null) {
        const groups = def.getGroups();
        const size = def.getSize();
        const typeName = def.getTypeName() || 'UNKNOWN';
        const totalFrames = groups.reduce((s, g) => s + def.getFrameCount(g), 0);
        const groupOptions = groups.map(g =>
            `<option value="${g}">Group ${g} (${def.getFrameCount(g)} fr.)</option>`).join('');

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${size[0]}×${size[1]}</span>
                        <span>Type: ${typeName}</span>
                        <span>${groups.length} groups</span>
                        <span>${totalFrames} frames</span>
                    </div>
                    <button class="preview-toolbar-toggle" title="More options">&#9776;</button>
                    <button class="preview-open-btn" title="Open in Animation Viewer" id="btn-open-def-viewer">&#9654;</button>
                    <div class="preview-toolbar">
                        ${groups.length > 1 ? `<select id="def-preview-group" title="Select group">${groupOptions}</select>` : ''}
                        <button title="Zoom fit" data-zoom="fit">&#8862;</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2&times;" data-zoom="2x">2&times;</button>
                        <button title="4&times;" data-zoom="4x">4&times;</button>
                        <button title="Toggle white background" class="toggle-btn${state.whiteBg ? ' active' : ''}" id="def-preview-bg-btn"><svg width="12" height="12" viewBox="0 0 4 4" fill="currentColor"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg></button>
                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="def-preview-border-btn">&#9633;</button>
                        <button title="Export all frames as PNG sequence" id="def-preview-seq">&#128190; Seq</button>
                        <button title="Export animation as GIF" id="def-preview-gif">&#128190; GIF</button>
                        ${rawData ? '<button title="Export original DEF file" id="def-preview-orig">&#128190; DEF</button>' : ''}
                        <button title="Show file hashes" id="def-preview-hash"># Hash</button>
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-def-body"></div>
            </div>
        `;

        const body = $('#preview-def-body', container);
        let currentGroup = groups.length > 0 ? groups[0] : 0;
        let frameIdx = 0;
        let previewTimer = null;

        const c = document.createElement('canvas');
        body.appendChild(c);
        if (state.showBorders) c.classList.add('img-border');

        // Declare zpDef before drawFrame so the closure can call recentre()
        const zpDef = attachZoomPan(body, () => body.querySelector('canvas'));
        applyBgState(body);
        setupBgToggle(container.querySelector('#def-preview-bg-btn'), body);
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));

        function drawFrame() {
            const frameCount = def.getFrameCount(currentGroup);
            if (frameCount === 0) return;
            const canvas = def.readImage('combined', currentGroup, frameIdx);
            if (canvas) {
                if (c.width !== canvas.width || c.height !== canvas.height) {
                    c.width = canvas.width;
                    c.height = canvas.height;
                    zpDef.recentre();
                }
                const ctx2d = c.getContext('2d');
                ctx2d.clearRect(0, 0, c.width, c.height);
                ctx2d.drawImage(canvas, 0, 0);
            }
            frameIdx = (frameIdx + 1) % frameCount;
        }

        function restartAnim() {
            if (previewTimer) clearInterval(previewTimer);
            if (def.getFrameCount(currentGroup) > 1) {
                previewTimer = setInterval(drawFrame, 150);
            }
        }

        drawFrame();
        restartAnim();

        const obs = new MutationObserver(() => {
            if (!container.contains(body)) {
                if (previewTimer) clearInterval(previewTimer);
                obs.disconnect();
            }
        });
        obs.observe(container, { childList: true, subtree: true });

        // Group selector
        const groupSel = container.querySelector('#def-preview-group');
        if (groupSel) {
            groupSel.addEventListener('change', () => {
                currentGroup = parseInt(groupSel.value);
                frameIdx = 0;
                if (previewTimer) clearInterval(previewTimer);
                drawFrame();
                restartAnim();
            });
        }

        // Border toggle
        const borderBtn = container.querySelector('#def-preview-border-btn');
        if (borderBtn) {
            borderBtn.addEventListener('click', () => {
                state.showBorders = !state.showBorders;
                borderBtn.classList.toggle('active', state.showBorders);
                c.classList.toggle('img-border', state.showBorders);
            });
        }

        // Zoom controls + pan
        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const z = btn.dataset.zoom;
                if (z === 'fit') zpDef.doFit();
                else if (z === 'actual') zpDef.setZoom(1);
                else if (z === '2x') zpDef.setZoom(2);
                else if (z === '4x') zpDef.setZoom(4);
            });
        });

        let _defPrevSize = [0, 0];  // to detect canvas size change between frames

        // Sequence export
        const seqBtn = container.querySelector('#def-preview-seq');
        if (seqBtn) {
            seqBtn.addEventListener('click', () => {
                const fc = def.getFrameCount(currentGroup);
                for (let i = 0; i < fc; i++) {
                    const canvas = def.readImage('combined', currentGroup, i);
                    if (canvas) exportCanvasAsPng(canvas, `${filename.replace(/\.[^.]+$/, '')}_g${currentGroup}_${String(i).padStart(4, '0')}.png`);
                }
                toast(`Exported ${fc} frames`, 'success');
            });
        }

        // GIF export
        const gifBtn = container.querySelector('#def-preview-gif');
        if (gifBtn) {
            gifBtn.addEventListener('click', async () => {
                if (typeof GIF === 'undefined') { toast('gif.js not loaded', 'error'); return; }
                const fc = def.getFrameCount(currentGroup);
                if (fc === 0) return;
                let workerBlob = window._gifWorkerBlob;
                if (!workerBlob) {
                    try {
                        const resp = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
                        const text = await resp.text();
                        workerBlob = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
                        window._gifWorkerBlob = workerBlob;
                    } catch (e) { toast('Failed to load GIF worker: ' + e.message, 'error'); return; }
                }
                const gif = new GIF({ workers: 2, quality: 10, width: size[0], height: size[1], workerScript: workerBlob, transparent: 0xFF00FF });
                for (let i = 0; i < fc; i++) {
                    const canvas = def.readImage('combined', currentGroup, i);
                    if (canvas) gif.addFrame(makeGifFrame(canvas, size[0], size[1]), { delay: 150, copy: true });
                }
                toast('Encoding GIF...', 'info');
                gif.on('finished', blob => {
                    exportBlob(blob, `${filename.replace(/\.[^.]+$/, '')}_g${currentGroup}.gif`);
                    toast('GIF exported!', 'success');
                });
                gif.render();
            });
        }

        // Orig export
        const origBtn = container.querySelector('#def-preview-orig');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));

        // Hash modal
        const hashBtn = container.querySelector('#def-preview-hash');
        if (hashBtn) {
            if (rawData) {
                hashBtn.addEventListener('click', () => showHashModal(filename, 'DEF', rawData));
            } else {
                hashBtn.style.display = 'none';
            }
        }

        // Open in full viewer
        const btn = $('#btn-open-def-viewer', container);
        if (btn) {
            btn.addEventListener('click', () => {
                if (!state.standaloneFiles.has(filename)) {
                    state.standaloneFiles.set(filename, { data: rawData, type: 'def', parsed: def });
                }
                setMode('defviewer');
                setTimeout(() => openDefInViewer(filename, def), 50);
            });
        }
    }

    function showFntPreview(container, font, filename, rawData) {
        let borders = state.showBorders;
        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>256 glyphs</span>
                        <span>Height: ${font.height}px</span>
                        <span>FNT</span>
                    </div>
                    <button class="preview-toolbar-toggle" title="More options">☰</button>
                    <div class="preview-toolbar">
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Toggle white background" class="toggle-btn${state.whiteBg ? ' active' : ''}" id="bg-toggle-btn"><svg width="12" height="12" viewBox="0 0 4 4" fill="currentColor"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg></button>
                        <button title="Show glyph borders" class="toggle-btn${state.showBorders ? ' active' : ''}" id="fnt-border-btn">□</button>
                        ${rawData ? '<button title="Show file hashes" id="hash-fnt-btn"># Hash</button>' : ''}
                        <button title="Export as PNG" id="export-fnt-png-btn">💾 PNG</button>
                        ${rawData ? '<button title="Export original FNT" id="export-fnt-orig-btn">💾 FNT</button>' : ''}
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-fnt-body"></div>
            </div>
        `;
        const body = container.querySelector('#preview-fnt-body');
        let sheet = H3.FNT.renderSheet(font, borders);
        body.appendChild(sheet);
        const zpFnt = attachZoomPan(body, () => body.querySelector('canvas'));

        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const z = btn.dataset.zoom;
                if (z === 'fit') zpFnt.doFit();
                else if (z === 'actual') zpFnt.setZoom(1);
                else if (z === '2x') zpFnt.setZoom(2);
                else if (z === '4x') zpFnt.setZoom(4);
            });
        });

        applyBgState(body);
        setupBgToggle(container.querySelector('#bg-toggle-btn'), body);
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));

        const borderBtn = container.querySelector('#fnt-border-btn');
        if (borderBtn) {
            borderBtn.addEventListener('click', () => {
                borders = !borders;
                state.showBorders = borders;
                borderBtn.classList.toggle('active', borders);
                const next = H3.FNT.renderSheet(font, borders);
                sheet.replaceWith(next);
                sheet = next;
                zpFnt.reapply();
            });
        }

        const hashFntBtn = container.querySelector('#hash-fnt-btn');
        if (hashFntBtn && rawData) hashFntBtn.addEventListener('click', () => showHashModal(filename, 'FNT', rawData));
        const pngBtn = container.querySelector('#export-fnt-png-btn');
        if (pngBtn) pngBtn.addEventListener('click', () => exportCanvasAsPng(sheet, filename.replace(/\.[^.]+$/, '_sheet.png')));
        const origBtn = container.querySelector('#export-fnt-orig-btn');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
    }

    // ---- Encoding detection ----
    function detectEncoding(data) {
        // BOM detection
        if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) return 'utf-8';
        if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) return 'utf-16le';
        if (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) return 'utf-16be';

        // Strict UTF-8 validation
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(data);
            return 'utf-8';
        } catch { /* not valid UTF-8 */ }

        // Byte-frequency scoring
        const freq = new Uint32Array(256);
        for (let i = 0; i < data.length; i++) freq[data[i]]++;

        let highTotal = 0;
        for (let b = 0x80; b <= 0xFF; b++) highTotal += freq[b];
        if (highTotal === 0) return 'utf-8'; // pure ASCII

        // --- CP1250 Polish/Czech/Central-European score ---
        // These bytes are diagnostic for Central European languages and have
        // different or rare mappings in CP1251/CP1252.
        const cp1250Score =
            freq[0xB9] * 8 +  // ą (Polish)
            freq[0xB3] * 8 +  // ł (Polish)
            freq[0xBF] * 4 +  // ż (Polish)
            freq[0xA5] * 3 +  // Ą (Polish)
            freq[0xA3] * 3 +  // Ł (Polish)
            freq[0xCA] * 2 +  // Ę (Polish)
            freq[0xAF] * 2 +  // Ż (Polish)
            freq[0x9A] * 6 +  // š (Czech/Slovak)
            freq[0x9E] * 6 +  // ž (Czech/Slovak)
            freq[0x8A] * 4 +  // Š (Czech/Slovak)
            freq[0x8E] * 4 +  // Ž (Czech/Slovak)
            freq[0x9D] * 3 +  // ť (Czech)
            freq[0xF8] * 3 +  // ř (Czech — ø in CP1252, rare in FR/DE)
            freq[0xEC] * 2;   // ě (Czech — ì in CP1252, rare in FR/DE)

        // --- CP1251 vs CP1252 structural analysis ---
        // Per-byte scoring fails because 0xC0-0xFF bytes map to BOTH Cyrillic
        // letters (CP1251) and accented Latin letters (CP1252).
        // Instead, use structural features of the text:
        //
        // Russian (CP1251): entire words are Cyrillic → high bytes make up ~40-65%
        //   of all bytes, and they appear in long consecutive runs (word interiors).
        // French/German (CP1252): only scattered accented chars → high bytes are
        //   ~1-10% of all bytes, appearing as isolated single bytes.

        // 1) High-byte ratio: fraction of ALL bytes that are >= 0x80
        const highRatio = highTotal / data.length;

        // 2) Average run length of high bytes (>=0x80)
        //    Russian words: runs of 3-10+; Western accents: runs of 1-2
        let runs = 0, inRun = false;
        for (let i = 0; i < data.length; i++) {
            if (data[i] >= 0x80) {
                if (!inRun) { runs++; inRun = true; }
            } else {
                inRun = false;
            }
        }
        const avgRunLen = runs > 0 ? highTotal / runs : 0;

        // Polish uses unique bytes in 0xA0-0xBF; check it first
        if (cp1250Score > 0 && avgRunLen < 2.5) return 'windows-1250';

        // Cyrillic: needs BOTH high overall density AND clustered high bytes
        // highRatio > 0.2 rules out Western text (typically <0.10)
        // avgRunLen > 2.0 rules out isolated accented chars
        if (highRatio > 0.2 && avgRunLen > 2.0) return 'windows-1251';

        return 'windows-1252';
    }

    function buildEncodingSelectHtml(detectedEnc, currentVal, selectId = 'text-encoding-select') {
        const opts = [
            ['auto',          `Auto (${detectedEnc})`],
            // Unicode
            ['utf-8',         'UTF-8'],
            // Western European
            ['windows-1252',  'CP1252 – Western EU'],
            ['iso-8859-1',    'ISO-8859-1 – Latin-1'],
            ['iso-8859-15',   'ISO-8859-15 – Latin-9 (€)'],
            // Central European
            ['windows-1250',  'CP1250 – Central EU'],
            ['iso-8859-2',    'ISO-8859-2 – Central EU'],
            // Cyrillic
            ['windows-1251',  'CP1251 – Cyrillic'],
            ['koi8-r',        'KOI8-R – Russian'],
            ['koi8-u',        'KOI8-U – Ukrainian'],
            ['iso-8859-5',    'ISO-8859-5 – Cyrillic'],
            // Greek
            ['windows-1253',  'CP1253 – Greek'],
            ['iso-8859-7',    'ISO-8859-7 – Greek'],
            // Turkish
            ['windows-1254',  'CP1254 – Turkish'],
            ['iso-8859-9',    'ISO-8859-9 – Turkish'],
            // Baltic
            ['windows-1257',  'CP1257 – Baltic'],
            ['iso-8859-4',    'ISO-8859-4 – Baltic'],
            // Vietnamese
            ['windows-1258',  'CP1258 – Vietnamese'],
            // Arabic
            ['windows-1256',  'CP1256 – Arabic'],
            ['iso-8859-6',    'ISO-8859-6 – Arabic'],
            // Hebrew
            ['windows-1255',  'CP1255 – Hebrew'],
            ['iso-8859-8',    'ISO-8859-8 – Hebrew'],
            // CJK
            ['shift-jis',     'Shift-JIS – Japanese'],
            ['euc-jp',        'EUC-JP – Japanese'],
            ['gbk',           'GBK / GB18030 – Chinese Simplified'],
            ['big5',          'Big5 – Chinese Traditional'],
            ['euc-kr',        'EUC-KR – Korean'],
            // Other Latin
            ['iso-8859-3',    'ISO-8859-3 – South EU'],
        ];
        return `<select id="${selectId}" title="Text encoding">${
            opts.map(([v, l]) =>
                `<option value="${v}"${currentVal === v ? ' selected' : ''}>${escapeHtml(l)}</option>`
            ).join('')
        }</select>`;
    }

    function showTextPreview(container, data, filename) {
        // Persist for re-render on encoding change
        state.lastTextData = { data, filename };

        const detectedEnc = detectEncoding(data);
        const enc = state.textEncoding === 'auto' ? detectedEnc : state.textEncoding;
        let text;
        try {
            text = new TextDecoder(enc, { fatal: true }).decode(data);
        } catch {
            text = new TextDecoder('windows-1252').decode(data);
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${formatSize(data.length)}</span>
                    </div>
                    <div class="preview-toolbar">
                        ${buildEncodingSelectHtml(detectedEnc, state.textEncoding)}
                        <button id="text-hash-btn" title="Show file hashes"># Hash</button>
                        <button id="text-save-btn" title="Save file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="align-items:flex-start; justify-content:flex-start;">
                    <div class="preview-text">${escapeHtml(text)}</div>
                </div>
            </div>
        `;

        container.querySelector('#text-encoding-select').addEventListener('change', (e) => {
            state.textEncoding = e.target.value;
            showTextPreview(container, data, filename);
        });
        container.querySelector('#text-hash-btn').addEventListener('click', () => {
            const ext = filename.split('.').pop().toUpperCase();
            showHashModal(filename, ext, data);
        });
        container.querySelector('#text-save-btn').addEventListener('click', () => {
            exportBlob(new Blob([data], { type: 'text/plain' }), filename);
        });
    }

    // ---- PAL Preview ----
    function showPalPreview(container, pal, filename, rawData) {
        const swatchSize = pal.count <= 32 ? 48 : 24;
        const cols = pal.count <= 32 ? 8 : 16;
        const rows = Math.ceil(pal.count / cols);

        // Build the swatch canvas
        function buildCanvas(zoom) {
            const sz = swatchSize * zoom;
            const cv = document.createElement('canvas');
            cv.width = cols * sz;
            cv.height = rows * sz;
            cv.style.imageRendering = 'pixelated';
            const ctx = cv.getContext('2d');
            pal.colors.forEach(([r, g, b], idx) => {
                const col = idx % cols;
                const row = Math.floor(idx / cols);
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(col * sz, row * sz, sz, sz);
            });
            return cv;
        }

        // Tooltip canvas (1px per swatch absolute coords)
        let currentZoom = 2;
        let currentCanvas = buildCanvas(currentZoom);

        // Info table rows
        const tableRows = pal.colors.map(([r, g, b], idx) => {
            const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
            const flag = pal.flags ? pal.flags[idx] : '';
            return `<tr>
                <td style="width:24px;"><div style="width:20px;height:14px;background:${hex};border:1px solid var(--border);border-radius:2px;"></div></td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${idx}</td>
                <td style="font-family:var(--font-mono);font-size:11px;">${hex}</td>
                <td style="font-family:var(--font-mono);font-size:11px;">R=${r} G=${g} B=${b}</td>
                ${pal.flags !== null ? `<td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">flags=0x${flag.toString(16).padStart(2,'0')}</td>` : ''}
            </tr>`;
        }).join('');

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${pal.count} colors</span>
                        <span>${pal.type.toUpperCase()} PAL</span>
                    </div>
                    <div class="preview-toolbar">
                        <button data-zoom="1" title="1×">1×</button>
                        <button data-zoom="2" title="2×">2×</button>
                        <button data-zoom="4" title="4×">4×</button>
                        <button id="pal-view-toggle" title="Toggle table view">≡ Table</button>
                        ${rawData ? '<button id="pal-hash-btn" title="Show file hashes"># Hash</button>' : ''}
                        <button id="pal-export-png" title="Export as PNG">💾 PNG</button>
                        ${rawData ? '<button id="pal-export-orig" title="Export original PAL">💾 PAL</button>' : ''}
                    </div>
                </div>
                <div id="pal-body" class="preview-body checkerboard" style="flex-direction:column;gap:0;align-items:flex-start;justify-content:flex-start;padding:16px;overflow:auto;"></div>
                <div id="pal-table-body" class="preview-body" style="display:none;flex-direction:column;padding:0;align-items:flex-start;justify-content:flex-start;overflow:auto;">
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead><tr style="position:sticky;top:0;background:var(--bg-secondary);z-index:1;">
                            <th style="padding:6px 10px;text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">Swatch</th>
                            <th style="padding:6px 10px;text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">#</th>
                            <th style="padding:6px 10px;text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">Hex</th>
                            <th style="padding:6px 10px;text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">RGB</th>
                            ${pal.flags !== null ? '<th style="padding:6px 10px;text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">Flags</th>' : ''}
                        </tr></thead>
                        <tbody id="pal-tbody">${tableRows}</tbody>
                    </table>
                </div>
                <div id="pal-tooltip" style="display:none;position:fixed;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:11px;font-family:var(--font-mono);pointer-events:none;z-index:999;box-shadow:var(--shadow-lg);"></div>
            </div>
        `;

        const body = container.querySelector('#pal-body');
        const tableBody = container.querySelector('#pal-table-body');
        const tooltip = container.querySelector('#pal-tooltip');
        let showTable = false;

        body.appendChild(currentCanvas);

        // Zoom buttons
        container.querySelectorAll('.preview-toolbar button[data-zoom]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentZoom = parseInt(btn.dataset.zoom);
                const next = buildCanvas(currentZoom);
                currentCanvas.replaceWith(next);
                currentCanvas = next;
                attachCanvasEvents(next);
            });
        });

        // Table toggle
        container.querySelector('#pal-view-toggle').addEventListener('click', () => {
            showTable = !showTable;
            body.style.display = showTable ? 'none' : 'flex';
            tableBody.style.display = showTable ? 'flex' : 'none';
        });

        // Export PNG
        container.querySelector('#pal-export-png').addEventListener('click', () => {
            const cv = buildCanvas(4);
            exportCanvasAsPng(cv, filename.replace(/\.[^.]+$/, '_palette.png'));
        });
        const hashPalBtn = container.querySelector('#pal-hash-btn');
        if (hashPalBtn && rawData) hashPalBtn.addEventListener('click', () => showHashModal(filename, 'PAL', rawData));
        const origBtn = container.querySelector('#pal-export-orig');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));

        // Hover tooltip on canvas
        function attachCanvasEvents(cv) {
            const sz = swatchSize * currentZoom;
            cv.addEventListener('mousemove', (e) => {
                const rect = cv.getBoundingClientRect();
                const col = Math.floor((e.clientX - rect.left) / sz);
                const row = Math.floor((e.clientY - rect.top) / sz);
                const idx = row * cols + col;
                if (idx < 0 || idx >= pal.count) { tooltip.style.display = 'none'; return; }
                const [r, g, b] = pal.colors[idx];
                const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
                const flagStr = pal.flags !== null ? `  flags=0x${pal.flags[idx].toString(16).padStart(2,'0')}` : '';
                tooltip.textContent = `#${idx}  ${hex}  R=${r} G=${g} B=${b}${flagStr}`;
                tooltip.style.display = 'block';
                tooltip.style.left = (e.clientX + 14) + 'px';
                tooltip.style.top = (e.clientY - 10) + 'px';
            });
            cv.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
        }
        attachCanvasEvents(currentCanvas);
    }

    // ---- IFR Preview ----
    function showIfrPreview(container, effects, filename, rawData) {
        const typeBadgeColor = { 'Periodic': '#3fb950', 'Vector Force': '#d29922', 'Damper': '#a371f7', 'Compound': '#58a6ff' };

        // Build a map: GUID → effect name for compound resolution
        const guidMap = {};
        effects.forEach(e => { if (e.id) guidMap[e.id] = e.name; });

        function renderProps(props) {
            return Object.entries(props).map(([k, v]) =>
                `<tr><td style="padding:2px 8px 2px 0;color:var(--text-muted);white-space:nowrap;font-size:11px;">${escapeHtml(k)}</td>
                     <td style="padding:2px 0;font-family:var(--font-mono);font-size:11px;">${escapeHtml(v)}</td></tr>`
            ).join('');
        }

        const rows = effects.map((e, idx) => {
            const color = typeBadgeColor[e.type] || '#8b949e';
            const badge = `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;background:${color}22;color:${color};border:1px solid ${color}44;white-space:nowrap;">${escapeHtml(e.type)}</span>`;
            const children = e.containedObjects
                ? `<div style="margin-top:4px;color:var(--text-muted);font-size:11px;">Contains: ${e.containedObjects.map(g => escapeHtml(guidMap[g] || g)).join(', ')}</div>`
                : '';
            const propTable = Object.keys(e.props).length
                ? `<table style="margin-top:4px;border-collapse:collapse;">${renderProps(e.props)}</table>`
                : '';
            return `<div class="ifr-effect" data-idx="${idx}" style="padding:8px 14px;border-bottom:1px solid var(--border);cursor:pointer;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:12px;font-weight:600;flex:1;">${escapeHtml(e.name)}</span>
                    ${badge}
                    <span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">#${idx}</span>
                </div>
                <div class="ifr-details" style="display:none;margin-top:6px;">${children}${propTable}</div>
            </div>`;
        }).join('');

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${effects.length} effects</span>
                        <span>iFeel IFR</span>
                    </div>
                    <div class="preview-toolbar">
                        <input id="ifr-search" type="text" placeholder="Search…" style="width:120px;padding:3px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font:inherit;font-size:12px;outline:none;">
                        ${rawData ? '<button id="ifr-hash-btn" title="Show file hashes"># Hash</button>' : ''}
                        ${rawData ? '<button id="ifr-export-orig" title="Export original IFR">💾 IFR</button>' : ''}
                    </div>
                </div>
                <div class="preview-body" style="padding:0;align-items:flex-start;justify-content:flex-start;flex-direction:column;overflow:auto;">
                    <div id="ifr-list" style="width:100%;">${rows}</div>
                </div>
            </div>
        `;

        // Expand/collapse on click
        container.querySelector('#ifr-list').addEventListener('click', (e) => {
            const row = e.target.closest('.ifr-effect');
            if (!row) return;
            const details = row.querySelector('.ifr-details');
            details.style.display = details.style.display === 'none' ? 'block' : 'none';
        });

        // Search filter
        container.querySelector('#ifr-search').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            container.querySelectorAll('.ifr-effect').forEach(row => {
                const idx = parseInt(row.dataset.idx);
                const ef = effects[idx];
                const match = !q || ef.name.toLowerCase().includes(q) || ef.type.toLowerCase().includes(q);
                row.style.display = match ? '' : 'none';
            });
        });

        const hashIfrBtn = container.querySelector('#ifr-hash-btn');
        if (hashIfrBtn && rawData) hashIfrBtn.addEventListener('click', () => showHashModal(filename, 'IFR', rawData));
        const origBtn = container.querySelector('#ifr-export-orig');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
    }

    function showBinaryPreview(container, data, filename) {
        const CHUNK = 4096; // lines rendered per batch
        const totalLines = Math.ceil(data.length / 16);

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${formatSize(data.length)}</span>
                        <span>Binary · ${totalLines} lines</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="hex-hash-btn" title="Show file hashes"># Hash</button>
                        <button id="hex-export-btn" title="Export original file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="align-items:flex-start; justify-content:flex-start; padding:0;">
                    <div class="preview-text" id="hex-view" style="padding:12px; tab-size:1;"></div>
                </div>
            </div>
        `;

        const hexView = container.querySelector('#hex-view');
        let rendered = 0;

        function renderHexChunk() {
            const end = Math.min(rendered + CHUNK, totalLines);
            let html = '';
            for (let lineIdx = rendered; lineIdx < end; lineIdx++) {
                const i = lineIdx * 16;
                let line = i.toString(16).padStart(8, '0') + '  ';
                let ascii = '';
                for (let j = 0; j < 16; j++) {
                    if (i + j < data.length) {
                        line += data[i + j].toString(16).padStart(2, '0') + ' ';
                        ascii += (data[i + j] >= 32 && data[i + j] < 127) ? String.fromCharCode(data[i + j]) : '.';
                    } else {
                        line += '   ';
                        ascii += ' ';
                    }
                    if (j === 7) line += ' ';
                }
                html += line + ' |' + ascii + '|\n';
            }
            hexView.textContent += html;
            rendered = end;
        }

        renderHexChunk();

        // Lazy render more on scroll
        const scrollParent = hexView.parentElement;
        scrollParent.addEventListener('scroll', () => {
            if (rendered < totalLines && scrollParent.scrollTop + scrollParent.clientHeight > scrollParent.scrollHeight - 500) {
                renderHexChunk();
            }
        });

        // Hash
        const hexHashBtn = container.querySelector('#hex-hash-btn');
        if (hexHashBtn) hexHashBtn.addEventListener('click', () => showHashModal(filename, filename.split('.').pop().toUpperCase() || 'BIN', data));
        // Export original
        const exportBtn = container.querySelector('#hex-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => exportBlob(new Blob([data]), filename));
        }
    }

    function showPreviewError(container, msg) {
        container.innerHTML = `
            <div class="preview-placeholder">
                <span style="font-size:32px; opacity:.5">⚠️</span>
                <p>${escapeHtml(msg)}</p>
            </div>
        `;
    }

    function isWavData(data) {
        return data.length >= 12 &&
            data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
            data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45;
    }

    function buildPcmWav(pcmData, sampleRate, channels, bitsPerSample) {
        const dataSize = pcmData.byteLength;
        const blockAlign = channels * bitsPerSample / 8;
        const byteRate = sampleRate * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const out = new Uint8Array(buffer);
        out[0]=0x52; out[1]=0x49; out[2]=0x46; out[3]=0x46;
        view.setUint32(4, 36 + dataSize, true);
        out[8]=0x57; out[9]=0x41; out[10]=0x56; out[11]=0x45;
        out[12]=0x66; out[13]=0x6D; out[14]=0x74; out[15]=0x20;
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        out[36]=0x64; out[37]=0x61; out[38]=0x74; out[39]=0x61;
        view.setUint32(40, dataSize, true);
        out.set(new Uint8Array(pcmData instanceof ArrayBuffer ? pcmData : pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength)), 44);
        return out;
    }

    // IMA ADPCM decoder for HoMM3 SND files (WAV format 17)
    function decodeImaAdpcmWav(wavData) {
        const v = new DataView(wavData.buffer, wavData.byteOffset, wavData.byteLength);
        // Parse WAV header to find fmt and data chunks
        let pos = 12; // skip RIFF + size + WAVE
        let audioFormat = 0, channels = 0, sampleRate = 0, blockAlign = 0;
        let dataOffset = 0, dataSize = 0, numSamples = 0;
        while (pos < wavData.length - 8) {
            const chunkId = String.fromCharCode(wavData[pos], wavData[pos+1], wavData[pos+2], wavData[pos+3]);
            const chunkSize = v.getUint32(pos + 4, true);
            if (chunkId === 'fmt ') {
                audioFormat = v.getUint16(pos + 8, true);
                channels = v.getUint16(pos + 10, true);
                sampleRate = v.getUint32(pos + 12, true);
                blockAlign = v.getUint16(pos + 20, true);
            } else if (chunkId === 'fact') {
                numSamples = v.getUint32(pos + 8, true);
            } else if (chunkId === 'data') {
                dataOffset = pos + 8;
                dataSize = chunkSize;
            }
            pos += 8 + chunkSize;
            if (chunkSize % 2 !== 0) pos++; // word-align
        }
        if (audioFormat !== 0x11) return null; // not IMA ADPCM

        // IMA ADPCM step table
        const stepTable = [
            7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,
            118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,
            963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,
            5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,
            24623,27086,29794,32767
        ];
        const indexTable = [-1,-1,-1,-1,2,4,6,8];

        const samplesPerBlock = (blockAlign - 4 * channels) * 2 / channels + 1;
        const totalBlocks = Math.ceil(dataSize / blockAlign);
        if (!numSamples) numSamples = totalBlocks * samplesPerBlock;

        const pcm = new Int16Array(numSamples * channels);
        let outIdx = 0;

        for (let b = 0; b < totalBlocks && outIdx < pcm.length; b++) {
            const blockStart = dataOffset + b * blockAlign;
            const blockBytes = Math.min(blockAlign, dataSize - b * blockAlign);
            if (blockBytes < 4 * channels) break;

            const predictors = [], indices = [];
            for (let ch = 0; ch < channels; ch++) {
                const hOff = blockStart + ch * 4;
                predictors.push(v.getInt16(hOff, true));
                indices.push(Math.min(Math.max(wavData[hOff + 2], 0), 88));
            }
            for (let ch = 0; ch < channels; ch++) {
                if (outIdx < pcm.length) pcm[outIdx++] = predictors[ch];
            }

            const dataStart = blockStart + 4 * channels;
            const nibbleBytes = blockBytes - 4 * channels;

            function decodeNibble(nibble, ch) {
                const step = stepTable[indices[ch]];
                let diff = step >> 3;
                if (nibble & 1) diff += step >> 2;
                if (nibble & 2) diff += step >> 1;
                if (nibble & 4) diff += step;
                if (nibble & 8) diff = -diff;
                predictors[ch] = Math.max(-32768, Math.min(32767, predictors[ch] + diff));
                indices[ch] = Math.max(0, Math.min(88, indices[ch] + indexTable[nibble & 7]));
                return predictors[ch];
            }

            if (channels === 1) {
                for (let i = 0; i < nibbleBytes && outIdx < pcm.length; i++) {
                    const byte = wavData[dataStart + i];
                    pcm[outIdx++] = decodeNibble(byte & 0x0F, 0);
                    if (outIdx < pcm.length) pcm[outIdx++] = decodeNibble((byte >> 4) & 0x0F, 0);
                }
            } else {
                let byteOff = 0;
                const blockSamples = (nibbleBytes * 2) / channels;
                for (let s = 0; s < blockSamples; s += 8) {
                    for (let ch = 0; ch < channels; ch++) {
                        for (let n = 0; n < 8 && (s + n) < blockSamples; n++) {
                            const bPos = dataStart + byteOff + Math.floor(n / 2);
                            if (bPos >= wavData.length) break;
                            const byte = wavData[bPos];
                            const nibble = (n % 2 === 0) ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
                            const sample = decodeNibble(nibble, ch);
                            const outPos = (b * samplesPerBlock + 1 + s + n) * channels + ch;
                            if (outPos < pcm.length) pcm[outPos] = sample;
                        }
                        byteOff += 4;
                    }
                }
                outIdx = Math.min((b + 1) * samplesPerBlock * channels, pcm.length);
            }
        }

        return buildPcmWav(pcm.subarray(0, Math.min(outIdx, numSamples * channels)), sampleRate, channels, 16);
    }

    // Decode AIFF-C ima4 (IMA ADPCM 4:1) to PCM WAV.
    // Used for Mac HoMM3 music files inside StuffIt archives.
    function decodeAiffcIma4ToWav(data) {
        if (!data || data.length < 12) return null;
        // Verify FORM/AIFC signature
        if (data[0] !== 0x46 || data[1] !== 0x4F || data[2] !== 0x52 || data[3] !== 0x4D) return null;
        if (data[8] !== 0x41 || data[9] !== 0x49 || data[10] !== 0x46 || data[11] !== 0x43) return null;

        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let channels = 2, numPackets = 0, sampleRate = 44100;
        let ssndStart = 0;
        let pos = 12;

        while (pos + 8 <= data.length) {
            const id = String.fromCharCode(data[pos], data[pos+1], data[pos+2], data[pos+3]);
            const chunkSize = v.getUint32(pos + 4, false);
            if (id === 'COMM') {
                channels   = v.getUint16(pos + 8, false);
                numPackets = v.getUint32(pos + 10, false);
                // 80-bit IEEE extended big-endian sample rate at pos+16
                const exp  = (v.getUint16(pos + 16, false) & 0x7FFF) - 16383;
                const mant = v.getUint32(pos + 18, false); // top 32 bits of 64-bit mantissa
                sampleRate = Math.round(mant * Math.pow(2, exp - 31));
            } else if (id === 'SSND') {
                const ssndOffset = v.getUint32(pos + 8, false);  // bytes to skip after 8-byte fields
                ssndStart = pos + 16 + ssndOffset;               // skip ID(4)+size(4)+offset(4)+blockSize(4)+padding
            }
            pos += 8 + chunkSize + (chunkSize & 1); // word-align
        }
        if (!numPackets || !ssndStart) return null;

        const STEP_TABLE = [
            7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,
            66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,
            371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,
            1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,
            6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,
            20350,22385,24623,27086,29794,32767
        ];
        const INDEX_TABLE = [-1,-1,-1,-1,2,4,6,8];

        const PACKET_BYTES    = 34; // header(2) + data(32) per channel per packet
        const SAMPLES_PER_PKT = 64; // 32 bytes × 2 nibbles = 64 samples
        const totalSamples    = numPackets * SAMPLES_PER_PKT;
        const pcm = new Int16Array(totalSamples * channels);

        const predictors  = new Int32Array(channels);
        const stepIndices = new Int32Array(channels);
        let outIdx = 0;

        for (let p = 0; p < numPackets; p++) {
            // Read per-channel headers (interleaved: ch0_pkt, ch1_pkt, ...)
            for (let ch = 0; ch < channels; ch++) {
                const hdrPos = ssndStart + (p * channels + ch) * PACKET_BYTES;
                if (hdrPos + 2 > data.length) break;
                const hdr = v.getInt16(hdrPos, false);       // big-endian signed
                predictors[ch]  = hdr & ~0x7F;               // signed, low 7 bits cleared
                stepIndices[ch] = Math.max(0, Math.min(88, hdr & 0x7F));
            }

            // Decode 64 samples per channel, output interleaved [L0,R0,L1,R1,...]
            for (let s = 0; s < SAMPLES_PER_PKT && outIdx < pcm.length; s++) {
                for (let ch = 0; ch < channels; ch++) {
                    const dataBase = ssndStart + (p * channels + ch) * PACKET_BYTES + 2;
                    const byteIdx  = s >> 1;
                    const b        = data[dataBase + byteIdx];
                    const nibble   = (s & 1) ? (b >> 4) : (b & 0xF); // low nibble first

                    const step = STEP_TABLE[stepIndices[ch]];
                    let diff   = step >> 3;
                    if (nibble & 1) diff += step >> 2;
                    if (nibble & 2) diff += step >> 1;
                    if (nibble & 4) diff += step;
                    if (nibble & 8) diff = -diff;

                    predictors[ch]  = Math.max(-32768, Math.min(32767, predictors[ch] + diff));
                    stepIndices[ch] = Math.max(0, Math.min(88, stepIndices[ch] + INDEX_TABLE[nibble & 7]));
                    pcm[outIdx + s * channels + ch] = predictors[ch];
                }
            }
            outIdx += SAMPLES_PER_PKT * channels;
        }

        return buildPcmWav(pcm.buffer, sampleRate, channels, 16);
    }

    function ensurePlayableWav(data) {
        if (!isWavData(data)) {
            // Raw PCM fallback
            return buildPcmWav(data, 22050, 1, 8);
        }
        // Check WAV audio format
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let pos = 12;
        while (pos < data.length - 8) {
            const id = String.fromCharCode(data[pos], data[pos+1], data[pos+2], data[pos+3]);
            const sz = v.getUint32(pos + 4, true);
            if (id === 'fmt ') {
                const fmt = v.getUint16(pos + 8, true);
                if (fmt === 0x11) {
                    // IMA ADPCM - decode to PCM
                    return decodeImaAdpcmWav(data);
                }
                // PCM (1) or other browser-supported format - pass through
                return data;
            }
            pos += 8 + sz;
            if (sz % 2 !== 0) pos++;
        }
        return data; // couldn't parse, pass through
    }

    // ---- H3M / H3C Map Preview (uses H3Map parser from h3mparser.js) ----

    function showMapPreviewFallback(container, filename, rawData, error) {
        const isH3C = filename.toLowerCase().endsWith('.h3c');
        const icon = isH3C ? '⚔️' : '🗺️';
        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta"><span>${isH3C ? 'H3C Campaign' : 'H3M Map'}</span></div>
                    <div class="preview-toolbar">
                        ${rawData ? `<button title="Show file hashes" id="map-hash-btn"># Hash</button>` : ''}
                        ${rawData ? `<button title="Export original" id="map-export-btn">💾 Export</button>` : ''}
                    </div>
                </div>
                <div class="preview-body">
                    <div style="text-align:center;color:var(--text-muted);">
                        <div style="font-size:40px;margin-bottom:12px;">${icon}</div>
                        <div>Could not parse: ${escapeHtml(error?.message || 'Unknown error')}</div>
                    </div>
                </div>
            </div>`;
        const hashBtn = container.querySelector('#map-hash-btn');
        if (hashBtn && rawData) hashBtn.addEventListener('click', () => showHashModal(filename, 'Map', rawData));
        const exportBtn = container.querySelector('#map-export-btn');
        if (exportBtn && rawData) exportBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
    }

    // Render a simple bar chart using divs
    function renderBarChart(entries, maxBarWidth = 200) {
        if (!entries || entries.length === 0) return '';
        const maxVal = Math.max(...entries.map(e => e.value));
        return `<div class="map-chart">${entries.map(e => {
            const pct = maxVal > 0 ? (e.value / maxVal * 100) : 0;
            const color = e.color || 'var(--accent, #58a6ff)';
            return `<div class="map-chart-row">
                <span class="map-chart-label">${escapeHtml(e.label)}</span>
                <div class="map-chart-bar-bg"><div class="map-chart-bar" style="width:${pct}%;background:${color};"></div></div>
                <span class="map-chart-value">${e.value.toLocaleString()}</span>
            </div>`;
        }).join('')}</div>`;
    }

    function terrainColorCSS(name) {
        const idx = H3Map.TERRAIN_NAMES.indexOf(name);
        if (idx >= 0 && H3Map.TERRAIN_COLORS[idx]) {
            const c = H3Map.TERRAIN_COLORS[idx];
            return `rgb(${c[0]},${c[1]},${c[2]})`;
        }
        return 'var(--accent)';
    }

    function playerColorCSS(name) {
        const idx = H3Map.PLAYER_COLOR_NAMES.indexOf(name);
        if (idx >= 0) {
            const c = H3Map.PLAYER_COLORS[idx];
            return `rgb(${c[0]},${c[1]},${c[2]})`;
        }
        return '#888';
    }

    function showH3MPreview(container, map, filename, rawData) {
        const detectedMapEnc = map._rawStringBytes?.length
            ? detectEncoding(map._rawStringBytes) : 'utf-8';
        const sizeLabel = `${map.mapSize}×${map.mapSize}`;
        const ugLabel = map.hasUnderground ? ' + Underground' : '';
        const levels = map.hasUnderground ? 2 : 1;

        // Render minimaps
        let minimapHtml = '';
        if (map.terrain) {
            for (let z = 0; z < levels; z++) {
                const label = z === 0 ? 'Surface' : 'Underground';
                minimapHtml += `<div class="minimap-container">
                    <div class="minimap-label">${label}</div>
                    <canvas class="minimap-canvas" data-level="${z}" width="${map.mapSize}" height="${map.mapSize}" style="width:256px;height:256px;image-rendering:pixelated;image-rendering:crisp-edges"></canvas>
                </div>`;
            }
        }

        // Player info
        const activePlayers = map.players.filter(p => p.canHumanPlay || p.canComputerPlay);
        let playerHtml = '';
        if (activePlayers.length > 0) {
            playerHtml = `<div class="map-section"><h3 class="map-section-title">Players (${activePlayers.length})</h3><div class="map-players-grid">`;
            for (const p of activePlayers) {
                const color = playerColorCSS(p.colorName);
                const typeLabel = p.canHumanPlay && p.canComputerPlay ? 'Human/AI' : p.canHumanPlay ? 'Human' : 'AI';
                const factions = p.factions?.length ? p.factions.join(', ') : (p.isFactionRandom ? 'Random' : '—');
                const townInfo = p.hasMainTown ? ` · Town at (${p.mainTownX},${p.mainTownY})` : '';
                const heroName = p.mainHeroName ? ` · Hero: ${p.mainHeroName}` : '';
                playerHtml += `<div class="map-player-card">
                    <div class="map-player-color" style="background:${color}"></div>
                    <div class="map-player-info">
                        <div class="map-player-name">${escapeHtml(p.colorName)}</div>
                        <div class="map-player-detail">${typeLabel} · ${escapeHtml(factions)}${townInfo}${heroName}</div>
                    </div>
                </div>`;
            }
            playerHtml += '</div></div>';
        }

        // Teams
        let teamHtml = '';
        if (map.teamCount > 0 && map.teams) {
            const teamGroups = {};
            for (let i = 0; i < 8; i++) {
                if (map.teams[i] !== undefined) {
                    const active = map.players[i]?.canHumanPlay || map.players[i]?.canComputerPlay;
                    if (active) {
                        const t = map.teams[i];
                        if (!teamGroups[t]) teamGroups[t] = [];
                        teamGroups[t].push(H3Map.PLAYER_COLOR_NAMES[i]);
                    }
                }
            }
            if (Object.keys(teamGroups).length > 0) {
                teamHtml = '<div class="map-section"><h3 class="map-section-title">Teams</h3><div class="map-teams">';
                for (const [tid, members] of Object.entries(teamGroups)) {
                    teamHtml += `<div class="map-team-badge">Team ${parseInt(tid)+1}: ${members.map(n => `<span style="color:${playerColorCSS(n)}">${escapeHtml(n)}</span>`).join(', ')}</div>`;
                }
                teamHtml += '</div></div>';
            }
        }

        // Terrain chart
        let terrainChartHtml = '';
        if (map.stats?.terrainCounts) {
            const entries = Object.entries(map.stats.terrainCounts)
                .filter(([n]) => n !== 'Rock')
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: terrainColorCSS(name) }));
            if (entries.length > 0) {
                terrainChartHtml = `<div class="map-section"><h3 class="map-section-title">Terrain Distribution</h3>${renderBarChart(entries)}</div>`;
            }
        }

        // Object stats
        let objectStatsHtml = '';
        if (map.stats) {
            const s = map.stats;
            const items = [];
            if (s.towns?.length) items.push({ label: 'Towns', value: s.towns.length, color: '#e6b422' });
            if (s.heroes?.length) items.push({ label: 'Heroes', value: s.heroes.length, color: '#58a6ff' });
            if (s.monsters?.length) items.push({ label: 'Monsters', value: s.monsters.length, color: '#f85149' });
            if (s.mines?.length) items.push({ label: 'Mines', value: s.mines.length, color: '#8b949e' });
            if (s.artifacts?.length) items.push({ label: 'Artifacts', value: s.artifacts.length, color: '#d2a8ff' });
            if (s.roadTiles > 0) items.push({ label: 'Road Tiles', value: s.roadTiles, color: '#8b6914' });
            if (s.riverTiles > 0) items.push({ label: 'River Tiles', value: s.riverTiles, color: '#1f6feb' });
            if (items.length > 0) {
                objectStatsHtml = `<div class="map-section"><h3 class="map-section-title">Map Objects</h3>${renderBarChart(items)}</div>`;
            }
        }

        // Towns per player chart
        let townPlayerHtml = '';
        if (map.stats?.townsPerPlayer && Object.keys(map.stats.townsPerPlayer).length > 0) {
            const entries = Object.entries(map.stats.townsPerPlayer)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: playerColorCSS(name) }));
            townPlayerHtml = `<div class="map-section"><h3 class="map-section-title">Towns per Player</h3>${renderBarChart(entries)}</div>`;
        }

        // Mine type chart
        let mineChartHtml = '';
        if (map.stats?.minesByType && Object.keys(map.stats.minesByType).length > 0) {
            const mineColors = { Wood: '#7ec850', Mercury: '#c06030', Ore: '#888', Sulfur: '#e8d040', Crystal: '#40c0e0', Gems: '#a060e8', Gold: '#e6b422' };
            const entries = Object.entries(map.stats.minesByType)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: mineColors[name] || '#aaa' }));
            mineChartHtml = `<div class="map-section"><h3 class="map-section-title">Mines by Resource</h3>${renderBarChart(entries)}</div>`;
        }

        // Town faction chart
        let factionChartHtml = '';
        if (map.stats?.townsByFaction && Object.keys(map.stats.townsByFaction).length > 0) {
            const factionColors = { Castle: '#e0d090', Rampart: '#70c070', Tower: '#80c0d0', Inferno: '#e06030', Necropolis: '#9090c0', Dungeon: '#8050a0', Stronghold: '#c08050', Fortress: '#60a060', Conflux: '#80d0d0', Cove: '#4090c0', Factory: '#c0c060', Random: '#aaa' };
            const entries = Object.entries(map.stats.townsByFaction)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: factionColors[name] || '#aaa' }));
            factionChartHtml = `<div class="map-section"><h3 class="map-section-title">Town Factions</h3>${renderBarChart(entries)}</div>`;
        }

        // Monster level chart
        let monsterChartHtml = '';
        if (map.stats?.monstersByLevel && Object.keys(map.stats.monstersByLevel).length > 0) {
            const lvlColors = { Specific: '#8b949e', 'Any Level': '#58a6ff', 'Level 1': '#3fb950', 'Level 2': '#7ee787', 'Level 3': '#e6b422', 'Level 4': '#f0883e', 'Level 5': '#f85149', 'Level 6': '#d2a8ff', 'Level 7': '#ff7b72' };
            const entries = Object.entries(map.stats.monstersByLevel)
                .map(([name, count]) => ({ label: name, value: count, color: lvlColors[name] || '#aaa' }));
            monsterChartHtml = `<div class="map-section"><h3 class="map-section-title">Monsters by Level</h3>${renderBarChart(entries)}</div>`;
        }

        // Artifact type chart
        let artifactChartHtml = '';
        if (map.stats?.artifactsByType && Object.keys(map.stats.artifactsByType).length > 0) {
            const artColors = { Specific: '#8b949e', 'Random (any)': '#58a6ff', Treasure: '#3fb950', Minor: '#e6b422', Major: '#f0883e', Relic: '#d2a8ff', 'Spell Scroll': '#79c0ff' };
            const entries = Object.entries(map.stats.artifactsByType)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: artColors[name] || '#aaa' }));
            artifactChartHtml = `<div class="map-section"><h3 class="map-section-title">Artifacts by Type</h3>${renderBarChart(entries)}</div>`;
        }

        // Specific artifact list (artifacts with known names + position + trigger info)
        let artifactListHtml = '';
        if (map.stats?.artifacts?.length > 0) {
            const specificArts = map.stats.artifacts.filter(a =>
                a.objClass === H3Map.getObjectClassName ? true : true // include all tracked artifacts
            );
            if (specificArts.length > 0) {
                const rows = specificArts.map(a => {
                    const name = H3Map.getArtifactName(a);
                    const pos = `(${a.x},${a.y}${a.z ? ',U' : ''})`;
                    let trigger = '';
                    if (a.message && a.hasGuard) trigger = '⚔️ Guard+Msg';
                    else if (a.hasGuard) trigger = '⚔️ Guard';
                    else if (a.message) trigger = '💬 Message';
                    const tipAttr = a.message ? ` data-tip="${escapeAttr(a.message)}"` : '';
                    return `<tr${tipAttr}><td>${escapeHtml(name)}</td><td class="art-pos">${pos}</td><td>${trigger}</td></tr>`;
                }).join('');
                artifactListHtml = `<div class="map-section"><h3 class="map-section-title">Artifacts on Map</h3><div class="map-artifact-list-wrap"><table class="map-artifact-table"><thead><tr><th>Artifact</th><th>Position</th><th>Trigger</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
            }
        }

        // Resources on map
        let resourcesHtml = '';
        if (map.stats?.resourcesOnMap && Object.keys(map.stats.resourcesOnMap).length > 0) {
            const resColors = { Wood: '#7ec850', Mercury: '#c06030', Ore: '#888', Sulfur: '#e8d040', Crystal: '#40c0e0', Gems: '#a060e8', Gold: '#e6b422', Random: '#aaa' };
            const entries = Object.entries(map.stats.resourcesOnMap)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: resColors[name] || '#aaa' }));
            resourcesHtml = `<div class="map-section"><h3 class="map-section-title">Resources on Map</h3>${renderBarChart(entries)}</div>`;
        }

        // Key locations
        const klLabels = { seerHuts: 'Seer Huts', questGuards: 'Quest Guards', witchHuts: 'Witch Huts', scholars: 'Scholars', garrisons: 'Garrisons', pandorasBoxes: "Pandora's Boxes", events: 'Events', creatureBanks: 'Creature Banks', dwellings: 'Dwellings', shrines: 'Shrines' };
        let keyLocationsHtml = '';
        if (map.stats?.keyLocations) {
            const kl = map.stats.keyLocations;
            const items = Object.entries(klLabels)
                .map(([key, label]) => ({ label, value: kl[key] || 0 }))
                .filter(item => item.value > 0);
            if (items.length > 0) {
                keyLocationsHtml = `<div class="map-section"><h3 class="map-section-title">Key Locations</h3><div class="map-key-locations">${items.map(item => `<div class="map-kl-badge"><span class="map-kl-count">${item.value}</span><span class="map-kl-label">${escapeHtml(item.label)}</span></div>`).join('')}</div></div>`;
            }
        }

        // Top object types
        let topObjectsHtml = '';
        if (map.stats?.topObjectTypes?.length > 0) {
            topObjectsHtml = `<div class="map-section"><h3 class="map-section-title">Top Object Types</h3><div class="map-top-objects">${map.stats.topObjectTypes.map(([name, count]) => `<div class="map-top-obj-row"><span class="map-top-obj-name">${escapeHtml(name)}</span><span class="map-top-obj-count">${count}</span></div>`).join('')}</div></div>`;
        }

        // Heroes per player
        let heroesPlayerHtml = '';
        if (map.stats?.heroesPerPlayer && Object.keys(map.stats.heroesPerPlayer).length > 0) {
            const entries = Object.entries(map.stats.heroesPerPlayer)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ label: name, value: count, color: playerColorCSS(name) }));
            heroesPlayerHtml = `<div class="map-section"><h3 class="map-section-title">Heroes per Player</h3>${renderBarChart(entries)}</div>`;
        }

        // Extended key locations
        let extKeyLocationsHtml = '';
        if (map.stats?.extKeyLocations && Object.keys(map.stats.extKeyLocations).length > 0) {
            const items = Object.entries(map.stats.extKeyLocations).sort((a, b) => b[1] - a[1]);
            extKeyLocationsHtml = `<div class="map-section"><h3 class="map-section-title">Special Locations</h3><div class="map-key-locations">${items.map(([label, value]) => `<div class="map-kl-badge"><span class="map-kl-count">${value}</span><span class="map-kl-label">${escapeHtml(label)}</span></div>`).join('')}</div></div>`;
        }

        // Surface vs Underground objects
        let surfaceSplitHtml = '';
        if (map.hasUnderground && map.stats?.objectsBySurface) {
            const s = map.stats.objectsBySurface;
            const entries = [
                { label: 'Surface', value: s.surface || 0, color: '#3fb950' },
                { label: 'Underground', value: s.underground || 0, color: '#8b6914' },
            ];
            surfaceSplitHtml = `<div class="map-section"><h3 class="map-section-title">Objects by Level</h3>${renderBarChart(entries)}</div>`;
        }


        let rumorsHtml = '';
        if (map.rumors?.length > 0) {
            rumorsHtml = `<div class="map-section"><h3 class="map-section-title">Rumors (${map.rumors.length})</h3>
                <div class="map-rumors">${map.rumors.map(r => `<div class="map-rumor" data-tip="${escapeAttr(r.text)}"><strong>${formatH3Text(r.name)}</strong><p>${formatH3Text(r.text)}</p></div>`).join('')}</div></div>`;
        }

        // Win/loss conditions
        let conditionsHtml = '';
        if (map.victoryCondition || map.lossCondition) {
            conditionsHtml = '<div class="map-section"><h3 class="map-section-title">Victory &amp; Loss Conditions</h3><div class="map-conditions">';
            if (map.victoryCondition) {
                conditionsHtml += `<div class="map-condition win"><span class="map-cond-icon">🏆</span><span>${escapeHtml(map.victoryCondition.name)}</span></div>`;
            }
            if (map.lossCondition) {
                conditionsHtml += `<div class="map-condition loss"><span class="map-cond-icon">💀</span><span>${escapeHtml(map.lossCondition.name)}</span></div>`;
            }
            conditionsHtml += '</div></div>';
        }

        // Events
        let eventsHtml = '';
        if (map.events?.length > 0) {
            const RES_NAMES = H3Map.RESOURCE_NAMES;
            const MAX_EVENTS = 30;
            const renderEvItem = (ev) => {
                const timing = `Day ${ev.firstOccurrence + 1}${ev.nextOccurrence > 0 ? ` · repeats every ${ev.nextOccurrence} days` : ' · one-time'}`;
                let grantsHtml = '';
                if (ev.resources) {
                    const grants = ev.resources.map((v, i) => v !== 0 ? `<span class="ev-res${v > 0 ? ' pos' : ' neg'}">${v > 0 ? '+' : ''}${v} ${escapeHtml(RES_NAMES[i] || String(i))}</span>` : null).filter(Boolean);
                    if (grants.length) grantsHtml = `<div class="ev-grants">${grants.join('')}</div>`;
                }
                const msgHtml = ev.message
                    ? `<div class="ev-msg">${formatH3Text(ev.message.length > 120 ? ev.message.slice(0, 117).replace(/\s+\S*$/, '') + '\u2026' : ev.message)}</div>`
                    : '';
                const tipAttr = ev.message ? ` data-tip="${escapeAttr(ev.message)}"` : '';
                const PLAYER_NAMES = ['Red','Blue','Tan','Green','Orange','Purple','Teal','Pink'];
                const PLAYER_COLORS = ['#c00','#00c','#9b7','#0a0','#f80','#80f','#0cc','#f0a'];
                let playersHtml = '';
                if (ev.players != null && ev.players !== 0xFF) {
                    const dots = PLAYER_NAMES.map((n,i) => (ev.players >> i) & 1
                        ? `<span class="ev-player-dot" style="background:${PLAYER_COLORS[i]}" title="${n}"></span>` : '').join('');
                    playersHtml = `<span class="ev-players">${dots}</span>`;
                }
                return `<div class="map-event-item"${tipAttr}>
                    <div class="ev-header"><strong class="ev-name">${escapeHtml(ev.name)}</strong><span class="ev-timing">${timing}</span>${playersHtml}</div>
                    ${grantsHtml}${msgHtml}
                </div>`;
            };
            const evVisible = map.events.slice(0, MAX_EVENTS).map(renderEvItem).join('');
            const evOverflow = map.events.length > MAX_EVENTS
                ? `<div id="evts-overflow" style="display:none">${map.events.slice(MAX_EVENTS).map(renderEvItem).join('')}</div><div class="map-event-item map-show-more-btn" data-show-more="evts-overflow" style="color:var(--accent);cursor:pointer;">\u2026and ${map.events.length - MAX_EVENTS} more (click to show)</div>`
                : '';
            eventsHtml = `<div class="map-section"><h3 class="map-section-title">Timed Events (${map.events.length})</h3>
                <div class="map-events-list">${evVisible}${evOverflow}</div></div>`;
        }

        // Quests (Seer Huts + Quest Guards with mission data)
        let questsHtml = '';
        if (map.stats?.quests?.length > 0) {
            const PRIMARY_SKILLS = ['Attack', 'Defense', 'Spell Power', 'Knowledge'];
            const RES_NAMES = H3Map.RESOURCE_NAMES;
            const MAX_QUESTS = 50;
            const renderQuestItem = (qe) => {
                const q = qe.quest;
                let desc = q.typeName || 'Quest';
                if (q.missionType === 1 && q.level != null) desc += ` ${q.level}`;
                if (q.missionType === 2 && q.primarySkills) {
                    desc += ': ' + q.primarySkills.map((v, i) => v ? `${PRIMARY_SKILLS[i]} ${v}` : null).filter(Boolean).join(', ');
                }
                if (q.missionType === 5 && q.artifacts?.length) {
                    const names = q.artifacts.map(id => (H3Map.ARTIFACT_NAMES[id] || `Art #${id}`));
                    desc += ': ' + names.join(', ');
                }
                if (q.missionType === 7 && q.resources) {
                    const res = q.resources.map((v, i) => v ? `${v} ${RES_NAMES[i]}` : null).filter(Boolean);
                    desc += ': ' + res.join(', ');
                }
                const posLabel = `(${qe.x},${qe.y}${qe.z ? ',u' : ''})`;
                const tipText = q.firstVisitText || '';
                const tipAttr = tipText ? ` data-tip="${escapeAttr(tipText)}"` : '';
                const deadline = q.deadline != null ? `<span class="ev-timing">deadline day ${q.deadline + 1}</span>` : '';
                const msgHtml = tipText
                    ? `<div class="ev-msg">${formatH3Text(tipText.length > 120 ? tipText.slice(0, 117).replace(/\s+\S*$/, '') + '\u2026' : tipText)}</div>`
                    : '';
                return `<div class="map-event-item"${tipAttr}>
                    <div class="ev-header"><strong class="ev-name">${escapeHtml(qe.type)}</strong><span class="ev-pos">${posLabel}</span>${deadline}</div>
                    <div class="ev-desc">${formatH3Text(desc)}</div>
                    ${msgHtml}
                </div>`;
            };
            const qVisible = map.stats.quests.slice(0, MAX_QUESTS).map(renderQuestItem).join('');
            const qOverflow = map.stats.quests.length > MAX_QUESTS
                ? `<div id="quests-overflow" style="display:none">${map.stats.quests.slice(MAX_QUESTS).map(renderQuestItem).join('')}</div><div class="map-event-item map-show-more-btn" data-show-more="quests-overflow" style="color:var(--accent);cursor:pointer;">\u2026and ${map.stats.quests.length - MAX_QUESTS} more (click to show)</div>`
                : '';
            questsHtml = `<div class="map-section"><h3 class="map-section-title">Quests (${map.stats.quests.length})</h3>
                <div class="map-events-list">${qVisible}${qOverflow}</div></div>`;
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>H3M Map</span>
                        <span>${escapeHtml(map.versionName)}</span>
                        <span>${sizeLabel}${ugLabel}</span>
                    </div>
                    <div id="h3m-float-tip" style="display:none;position:fixed;max-width:360px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 11px;font-size:12px;line-height:1.5;pointer-events:none;z-index:9999;box-shadow:var(--shadow-lg);word-break:break-word;white-space:pre-wrap;"></div>
                    <button class="preview-toolbar-toggle" title="More options">&#9776;</button>
                    <div class="preview-toolbar">
                        ${map._rawStringBytes?.length ? buildEncodingSelectHtml(detectedMapEnc, state.mapEncoding, 'map-encoding-select') : ''}
                        ${rawData ? `<button title="Show file hashes" id="map-hash-btn"># Hash</button>` : ''}
                        ${rawData ? `<button title="Export original" id="map-export-btn">💾 H3M</button>` : ''}
                    </div>
                </div>
                <div class="preview-body map-preview-body">
                    <div class="map-preview-card map-preview-full">
                        <div class="map-header-row">
                            <div class="map-header-info">
                                <div class="map-preview-icon">🗺️</div>
                                <h2 class="map-preview-name">${escapeHtml(map.name || '(unnamed)')}</h2>
                            </div>
                            ${minimapHtml ? `<div class="map-minimaps">${minimapHtml}</div>` : ''}
                        </div>
                        <div class="map-preview-meta-grid">
                            <div class="map-meta-item"><span class="map-meta-label">Version</span><span class="map-meta-value">${escapeHtml(map.versionName)}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Size</span><span class="map-meta-value">${sizeLabel}${ugLabel}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Difficulty</span><span class="map-meta-value">${escapeHtml(map.difficultyName)}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Players</span><span class="map-meta-value">${map.playerCount}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Objects</span><span class="map-meta-value">${map.stats?.objectCount ?? map.objects?.length ?? 0}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">File Size</span><span class="map-meta-value">${formatSize(rawData?.length || 0)}</span></div>
                            ${map.levelLimit ? `<div class="map-meta-item"><span class="map-meta-label">Level Limit</span><span class="map-meta-value">${map.levelLimit === 0 ? 'None' : map.levelLimit}</span></div>` : ''}
                            ${map.stats?.objectDensity != null ? `<div class="map-meta-item"><span class="map-meta-label">Obj. Density</span><span class="map-meta-value">${map.stats.objectDensity.toFixed(1)}/100 tiles</span></div>` : ''}
                        </div>
                        ${map.description ? `<p class="map-preview-desc">${formatH3Text(map.description)}</p>` : ''}
                        ${conditionsHtml}
                        ${playerHtml}
                        ${teamHtml}
                        ${terrainChartHtml}
                        ${objectStatsHtml}
                        ${townPlayerHtml}
                        ${heroesPlayerHtml}
                        ${surfaceSplitHtml}
                        ${mineChartHtml}
                        ${factionChartHtml}
                        ${monsterChartHtml}
                        ${artifactChartHtml}
                        ${artifactListHtml}
                        ${resourcesHtml}
                        ${keyLocationsHtml}
                        ${extKeyLocationsHtml}
                        ${topObjectsHtml}
                        ${rumorsHtml}
                        ${eventsHtml}
                        ${questsHtml}
                    </div>
                </div>
            </div>
        `;

        // Render minimap canvases
        if (map.terrain) {
            for (let z = 0; z < levels; z++) {
                const canvas = H3Map.renderMinimap(map, z, 256);
                if (canvas) {
                    const target = container.querySelector(`.minimap-canvas[data-level="${z}"]`);
                    if (target) {
                        target.getContext('2d').drawImage(canvas, 0, 0);
                    }
                }
            }
        }

        // Tooltip for data-tip elements
        const h3mTipEl = container.querySelector('#h3m-float-tip');
        const previewFullEl = container.querySelector('.map-preview-full');
        if (h3mTipEl && previewFullEl) {
            previewFullEl.addEventListener('mousemove', e => {
                const el = e.target.closest('[data-tip]');
                if (el?.dataset.tip) {
                    h3mTipEl.innerHTML = formatH3Text(el.dataset.tip);
                    h3mTipEl.style.display = 'block';
                    const cx = e.clientX + 16, cy = e.clientY + 14;
                    const tw = h3mTipEl.offsetWidth || 280, th = h3mTipEl.offsetHeight || 60;
                    h3mTipEl.style.left = (cx + tw > window.innerWidth ? cx - tw - 28 : cx) + 'px';
                    h3mTipEl.style.top  = (cy + th > window.innerHeight ? cy - th - 24 : cy) + 'px';
                } else {
                    h3mTipEl.style.display = 'none';
                }
            });
            previewFullEl.addEventListener('mouseleave', () => { h3mTipEl.style.display = 'none'; });
        }

        // "…and N more" show-all buttons
        container.querySelectorAll('.map-show-more-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = container.querySelector('#' + btn.dataset.showMore);
                if (target) { target.style.display = ''; btn.style.display = 'none'; }
            });
        });

        // Event handlers
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));
        container.querySelector('#map-encoding-select')?.addEventListener('change', (e) => {
            state.mapEncoding = e.target.value;
            if (rawData) {
                const enc = state.mapEncoding === 'auto' ? null : state.mapEncoding;
                try {
                    const reparsed = H3Map.parseH3M(rawData, { encoding: enc });
                    showH3MPreview(container, reparsed, filename, rawData);
                } catch { /* ignore parse errors on encoding switch */ }
            }
        });
        const hashBtn = container.querySelector('#map-hash-btn');
        if (hashBtn && rawData) hashBtn.addEventListener('click', () => showHashModal(filename, 'H3M Map', rawData));
        const exportBtn = container.querySelector('#map-export-btn');
        if (exportBtn && rawData) exportBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
    }

    function showH3CPreview(container, campaign, filename, rawData) {
        const detectedMapEnc = campaign._rawStringBytes?.length
            ? detectEncoding(campaign._rawStringBytes) : 'utf-8';
        // Aggregate stats from all parsed maps
        let totalArea = 0, totalObjects = 0, totalTowns = 0, totalMonsters = 0;
        const allFactions = {};
        if (campaign.maps) {
            for (const m of campaign.maps) {
                if (!m || m.parseError) continue;
                totalArea += (m.mapSize || 0) * (m.mapSize || 0) * (m.hasUnderground ? 2 : 1);
                totalObjects += m.stats?.objectCount ?? (m.objects?.length || 0);
                totalTowns += m.stats?.towns?.length || 0;
                totalMonsters += m.stats?.monsters?.length || 0;
                if (m.stats?.townsByFaction) {
                    for (const [f, c] of Object.entries(m.stats.townsByFaction)) allFactions[f] = (allFactions[f] || 0) + c;
                }
            }
        }
        const aggHtml = `
            <div class="map-meta-item"><span class="map-meta-label">Total Area</span><span class="map-meta-value">${totalArea.toLocaleString()} tiles</span></div>
            <div class="map-meta-item"><span class="map-meta-label">Total Objects</span><span class="map-meta-value">${totalObjects.toLocaleString()}</span></div>
            <div class="map-meta-item"><span class="map-meta-label">Total Towns</span><span class="map-meta-value">${totalTowns}</span></div>
            <div class="map-meta-item"><span class="map-meta-label">Total Monsters</span><span class="map-meta-value">${totalMonsters}</span></div>`;

        // Faction summary
        let factionSummaryHtml = '';
        if (Object.keys(allFactions).length > 0) {
            const factionColors = { Castle: '#e0d090', Rampart: '#70c070', Tower: '#80c0d0', Inferno: '#e06030', Necropolis: '#9090c0', Dungeon: '#8050a0', Stronghold: '#c08050', Fortress: '#60a060', Conflux: '#80d0d0', Cove: '#4090c0', Factory: '#c0c060', Random: '#aaa' };
            const entries = Object.entries(allFactions).sort((a,b)=>b[1]-a[1]).map(([n,c]) => ({ label: n, value: c, color: factionColors[n] || '#aaa' }));
            factionSummaryHtml = `<div class="map-section"><h3 class="map-section-title">Town Factions (Campaign Total)</h3>${renderBarChart(entries)}</div>`;
        }

        // Scenario cards
        let scenarioHtml = '';
        if (campaign.scenarios?.length > 0) {
            scenarioHtml = '<div class="map-section"><h3 class="map-section-title">Scenarios</h3><div class="h3c-scenarios">';
            for (let i = 0; i < campaign.scenarios.length; i++) {
                const sc = campaign.scenarios[i];
                const mapData = campaign.maps?.[i];
                const mapName = mapData?.name || sc.mapName || `Scenario ${i + 1}`;
                const mapSizeLabel = mapData?.mapSize ? `${mapData.mapSize}×${mapData.mapSize}` : '';
                const hasUg = mapData?.hasUnderground ? ' + UG' : '';
                const diffName = sc.difficultyName || mapData?.difficultyName || '';
                const playerCount = mapData?.playerCount || '?';

                // Minimap for embedded map
                let minimapTag = '';
                if (mapData?.terrain) {
                    minimapTag = `<canvas class="h3c-minimap-canvas" data-scenario="${i}" width="${mapData.mapSize}" height="${mapData.mapSize}" style="width:120px;height:120px;image-rendering:pixelated;image-rendering:crisp-edges"></canvas>`;
                }

                const precondBits = typeof sc.preconditions === 'number' ? sc.preconditions : 0;
                const precondText = precondBits > 0
                    ? Array.from({length: 16}, (_, b) => (precondBits & (1 << b)) ? `<span class="h3c-precond-badge">${b+1}</span>` : null).filter(Boolean).join(' ')
                    : '<span class="h3c-precond-start">Start</span>';

                const bonusHtml = sc.bonuses?.length
                    ? `<div class="h3c-bonus-list">${sc.bonuses.map(b => `<span class="h3c-bonus-badge">${escapeHtml(b.type || 'Bonus')}</span>`).join('')}</div>`
                    : '';
                const vcHtml = mapData?.victoryCondition ? `<div class="h3c-vc">🏆 ${escapeHtml(mapData.victoryCondition.name)}</div>` : '';
                const lcHtml = mapData?.lossCondition ? `<div class="h3c-lc">💀 ${escapeHtml(mapData.lossCondition.name)}</div>` : '';
                const townFactions = mapData?.stats?.townsByFaction ? Object.entries(mapData.stats.townsByFaction).sort((a,b)=>b[1]-a[1]).map(([f,c]) => `${escapeHtml(f)}:${c}`).join(', ') : '';

                scenarioHtml += `<div class="h3c-scenario-card" data-scenario="${i}">
                    <div class="h3c-scenario-header">
                        <span class="h3c-scenario-number">${i + 1}</span>
                        <span class="h3c-scenario-name">${escapeHtml(mapName)}</span>
                        ${mapData?.parseError ? '<span class="h3c-scenario-error" title="Parse error">⚠️</span>' : ''}
                    </div>
                    <div class="h3c-scenario-body">
                        ${minimapTag}
                        <div class="h3c-scenario-info">
                            ${mapSizeLabel ? `<div>${mapSizeLabel}${hasUg}</div>` : ''}
                            ${diffName ? `<div>Difficulty: ${escapeHtml(diffName)}</div>` : ''}
                            <div>Players: ${playerCount}</div>
                            ${townFactions ? `<div class="h3c-factions">${townFactions}</div>` : ''}
                            ${vcHtml}${lcHtml}
                            <div class="h3c-precond">${precondText}</div>
                            ${bonusHtml}
                        </div>
                    </div>
                    ${sc.regionText ? `<div class="h3c-scenario-region">${formatH3Text(sc.regionText)}</div>` : ''}
                    <div class="h3c-scenario-actions">
                        <button class="h3c-open-map" data-idx="${i}" title="Open this map in H3M viewer">🗺️ Open Map</button>
                        ${campaign.rawMaps?.[i] ? `<button class="h3c-export-map" data-idx="${i}" title="Export as H3M">💾 Export H3M</button>` : ''}
                    </div>
                </div>`;
            }
            scenarioHtml += '</div></div>';
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>H3C Campaign</span>
                        <span>${escapeHtml(campaign.versionName)}</span>
                        <span>${campaign.scenarioCount} scenarios</span>
                    </div>
                    <button class="preview-toolbar-toggle" title="More options">&#9776;</button>
                    <div class="preview-toolbar">
                        ${campaign._rawStringBytes?.length ? buildEncodingSelectHtml(detectedMapEnc, state.mapEncoding, 'map-encoding-select') : ''}
                        ${rawData ? `<button title="Show file hashes" id="map-hash-btn"># Hash</button>` : ''}
                        ${rawData ? `<button title="Export original" id="map-export-btn">💾 H3C</button>` : ''}
                    </div>
                </div>
                <div class="preview-body map-preview-body">
                    <div class="map-preview-card map-preview-full">
                        <div class="map-header-row">
                            <div class="map-header-info">
                                <div class="map-preview-icon">⚔️</div>
                                <h2 class="map-preview-name">${escapeHtml(campaign.name || '(unnamed campaign)')}</h2>
                            </div>
                        </div>
                        <div class="map-preview-meta-grid">
                            <div class="map-meta-item"><span class="map-meta-label">Version</span><span class="map-meta-value">${escapeHtml(campaign.versionName)}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Scenarios</span><span class="map-meta-value">${campaign.scenarioCount}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">Maps</span><span class="map-meta-value">${campaign.mapCount}</span></div>
                            <div class="map-meta-item"><span class="map-meta-label">File Size</span><span class="map-meta-value">${formatSize(rawData?.length || 0)}</span></div>
                            ${aggHtml}
                        </div>
                        ${campaign.description ? `<p class="map-preview-desc">${formatH3Text(campaign.description)}</p>` : ''}
                        ${factionSummaryHtml}
                        ${scenarioHtml}
                    </div>
                </div>
            </div>
        `;

        // Render scenario minimaps
        if (campaign.maps) {
            for (let i = 0; i < campaign.maps.length; i++) {
                const mapData = campaign.maps[i];
                if (mapData && mapData.terrain) {
                    const canvas = H3Map.renderMinimap(mapData, 0, 120);
                    if (canvas) {
                        const target = container.querySelector(`.h3c-minimap-canvas[data-scenario="${i}"]`);
                        if (target) target.getContext('2d').drawImage(canvas, 0, 0);
                    }
                }
            }
        }

        // Event handlers
        container.querySelector('.preview-toolbar-toggle')?.addEventListener('click', () =>
            container.querySelector('.preview-header').classList.toggle('toolbar-expanded'));
        container.querySelector('#map-encoding-select')?.addEventListener('change', async (e) => {
            state.mapEncoding = e.target.value;
            if (rawData) {
                const enc = state.mapEncoding === 'auto' ? null : state.mapEncoding;
                try {
                    const reparsed = await H3Map.parseH3C(rawData, { encoding: enc });
                    showH3CPreview(container, reparsed, filename, rawData);
                } catch { /* ignore parse errors on encoding switch */ }
            }
        });
        const hashBtn = container.querySelector('#map-hash-btn');
        if (hashBtn && rawData) hashBtn.addEventListener('click', () => showHashModal(filename, 'H3C Campaign', rawData));
        const exportBtn = container.querySelector('#map-export-btn');
        if (exportBtn && rawData) exportBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));

        // Open embedded map buttons
        container.querySelectorAll('.h3c-open-map').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const mapData = campaign.maps?.[idx];
                if (mapData && !mapData.parseError) {
                    const scenName = campaign.scenarios?.[idx]?.mapName || `Scenario ${idx + 1}`;
                    showH3MPreview(container, mapData, `${filename} → ${scenName}`, campaign.rawMaps?.[idx]);
                } else {
                    toast('Could not parse embedded map', 'error');
                }
            });
        });

        // Export embedded map buttons
        container.querySelectorAll('.h3c-export-map').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const raw = campaign.rawMaps?.[idx];
                if (raw) {
                    const scenName = campaign.scenarios?.[idx]?.mapName || `scenario_${idx + 1}`;
                    const exportName = scenName.endsWith('.h3m') ? scenName : scenName + '.h3m';
                    exportBlob(new Blob([raw]), exportName);
                }
            });
        });
    }

    function showAudioPreview(container, data, filename, mimeType = 'audio/wav') {
        let audioData, decoded = false;
        if (mimeType === 'audio/wav') {
            audioData = ensurePlayableWav(data instanceof Uint8Array ? data : new Uint8Array(data));
            decoded = audioData !== data;
        } else {
            audioData = data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        const metaLabel = mimeType === 'audio/mpeg' ? 'MP3' : decoded ? 'IMA ADPCM → PCM' : 'WAV Audio';
        const icon = mimeType === 'audio/mpeg' ? '🎵' : '🔊';
        const blob = new Blob([audioData], { type: mimeType });
        const url = URL.createObjectURL(blob);

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${formatSize(data.length)}</span>
                        <span>${metaLabel}</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="audio-hash-btn" title="Show file hashes"># Hash</button>
                        <button id="audio-export-btn" title="Export file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="align-items:center; justify-content:center;">
                    <div style="text-align:center;">
                        <div style="font-size:48px; margin-bottom:16px;">${icon}</div>
                        <audio controls autoplay src="${url}" style="width:100%; max-width:400px;"></audio>
                    </div>
                </div>
            </div>
        `;

        const audioEl = container.querySelector('audio');

        const hashAudioBtn = container.querySelector('#audio-hash-btn');
        if (hashAudioBtn) {
            const ft = mimeType === 'audio/mpeg' ? 'MP3' : 'WAV';
            hashAudioBtn.addEventListener('click', () => showHashModal(filename, ft, data));
        }
        const exportBtn = container.querySelector('#audio-export-btn');
        if (exportBtn) {
            const exportName = !filename.includes('.') ? filename + '.wav' : filename;
            exportBtn.addEventListener('click', () => exportBlob(new Blob([data]), exportName));
        }

        // Register cleanup for file switching (stop audio immediately)
        state.activeVideoCleanup = () => {
            if (audioEl) { audioEl.pause(); audioEl.src = ''; }
            URL.revokeObjectURL(url);
        };

        // Clean up blob URL when preview changes
        const obs = new MutationObserver(() => {
            if (!container.querySelector('audio')) {
                if (audioEl) { audioEl.pause(); audioEl.src = ''; }
                URL.revokeObjectURL(url);
                state.activeVideoCleanup = null;
                obs.disconnect();
            }
        });
        obs.observe(container, { childList: true, subtree: true });
    }

    // ---- Video Preview (SMK / BIK) ----
    async function showSmkPreview(container, data, filename) {
        showLoading('Decoding video...', 0);
        let decoded;
        try {
            decoded = await H3.SmackerDecoder.decode(data, p => showLoading('Decoding video...', p));
        } catch (e) {
            hideLoading();
            console.error('SMK decode error:', e);
            showBinaryPreview(container, data, filename);
            toast('SMK decode failed: ' + e.message, 'error');
            return;
        }
        hideLoading();

        const { width, height, fps, frameDuration, nframes, indexedFrames, palettes, audio } = decoded;

        // Build audio WAV blob
        let audioUrl = null;
        if (audio) {
            const wavData = buildPcmWav(audio.samples, audio.sampleRate, audio.channels, audio.bitsPerSample);
            const blob = new Blob([wavData], { type: 'audio/wav' });
            audioUrl = URL.createObjectURL(blob);
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${width}×${height}</span>
                        <span>${nframes} frames</span>
                        <span>${fps.toFixed(1)} fps</span>
                        <span>${decoded.isSMK4 ? 'SMK4' : 'SMK2'}</span>
                        <span>${formatSize(data.length)}</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="video-export-btn" title="Export original file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;">
                    <canvas id="video-canvas" width="${width}" height="${height}" style="image-rendering:pixelated; max-width:100%; border:1px solid var(--border);"></canvas>
                    <div class="video-controls">
                        <button id="video-prev-btn" title="Previous frame">⏮</button>
                        <button id="video-play-btn" title="Play/Pause">▶</button>
                        <button id="video-next-btn" title="Next frame">⏭</button>
                        <input type="range" id="video-slider" min="0" max="${nframes - 1}" value="0" style="flex:1;">
                        <span id="video-frame-label" style="min-width:80px; text-align:right; font-size:12px; color:var(--text-muted);">1 / ${nframes}</span>
                    </div>
                </div>
            </div>
        `;

        const canvas = container.querySelector('#video-canvas');
        const ctx2d = canvas.getContext('2d');
        const playBtn = container.querySelector('#video-play-btn');
        const prevBtn = container.querySelector('#video-prev-btn');
        const nextBtn = container.querySelector('#video-next-btn');
        const slider = container.querySelector('#video-slider');
        const frameLabel = container.querySelector('#video-frame-label');
        const exportBtn = container.querySelector('#video-export-btn');

        let currentFrame = 0;
        let playing = false;
        let timer = null;
        let audioEl = null;

        if (audioUrl) {
            audioEl = new Audio(audioUrl);
            audioEl.volume = 1;
        }

        function renderFrame(idx) {
            if (idx < 0 || idx >= nframes) return;
            currentFrame = idx;
            const indexed = indexedFrames[idx];
            const pal = palettes[idx];
            const imgData = ctx2d.createImageData(width, height);
            const rgba = imgData.data;
            for (let i = 0; i < width * height; i++) {
                const c = indexed[i];
                rgba[i * 4] = pal[c * 3];
                rgba[i * 4 + 1] = pal[c * 3 + 1];
                rgba[i * 4 + 2] = pal[c * 3 + 2];
                rgba[i * 4 + 3] = 255;
            }
            ctx2d.putImageData(imgData, 0, 0);
            slider.value = idx;
            frameLabel.textContent = `${idx + 1} / ${nframes}`;
        }

        function play() {
            if (playing) return;
            playing = true;
            playBtn.textContent = '⏸';
            if (audioEl) {
                audioEl.currentTime = currentFrame * frameDuration / 1000;
                audioEl.play().catch(() => {});
            }
            const startTime = performance.now() - currentFrame * frameDuration;
            function tick() {
                if (!playing) return;
                const elapsed = performance.now() - startTime;
                const targetFrame = Math.floor(elapsed / frameDuration);
                if (targetFrame >= nframes) {
                    stop();
                    renderFrame(0);
                    return;
                }
                if (targetFrame !== currentFrame) {
                    renderFrame(targetFrame);
                }
                timer = requestAnimationFrame(tick);
            }
            timer = requestAnimationFrame(tick);
        }

        function stop() {
            playing = false;
            playBtn.textContent = '▶';
            if (timer) { cancelAnimationFrame(timer); timer = null; }
            if (audioEl) audioEl.pause();
        }

        playBtn.addEventListener('click', () => { playing ? stop() : play(); });
        prevBtn.addEventListener('click', () => { stop(); renderFrame(Math.max(0, currentFrame - 1)); });
        nextBtn.addEventListener('click', () => { stop(); renderFrame(Math.min(nframes - 1, currentFrame + 1)); });
        slider.addEventListener('input', () => { stop(); renderFrame(parseInt(slider.value)); });
        exportBtn.addEventListener('click', () => exportBlob(new Blob([data]), filename));

        renderFrame(0);
        play();

        // Register cleanup for file switching
        state.activeVideoCleanup = () => {
            stop();
            if (audioUrl) URL.revokeObjectURL(audioUrl);
        };

        // Cleanup on preview change
        const obs = new MutationObserver(() => {
            if (!container.querySelector('#video-canvas')) {
                stop();
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                state.activeVideoCleanup = null;
                obs.disconnect();
            }
        });
        obs.observe(container, { childList: true, subtree: true });
    }

    async function showBikPreview(container, data, filename) {
        showLoading('Decoding Bink video...', 0);
        let decoded;
        try {
            decoded = await H3.BinkDecoder.decode(data, p => showLoading('Decoding Bink video...', p));
        } catch (e) {
            hideLoading();
            console.error('BIK decode error:', e);
            // Fallback to header-only preview
            showBikFallbackPreview(container, data, filename, e.message);
            return;
        }
        hideLoading();

        const { width, height, fps, frameDuration, nframes, rgbaFrames, audio } = decoded;

        // Build audio WAV blob
        let audioUrl = null;
        if (audio) {
            const wavData = buildPcmWav(audio.samples, audio.sampleRate, audio.channels, audio.bitsPerSample);
            const blob = new Blob([wavData], { type: 'audio/wav' });
            audioUrl = URL.createObjectURL(blob);
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${width}×${height}</span>
                        <span>${nframes} frames</span>
                        <span>${fps.toFixed(1)} fps</span>
                        <span>Bink ${decoded.version || 'b'}</span>
                        <span>${formatSize(data.length)}</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="video-export-btn" title="Export original file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;">
                    <canvas id="video-canvas" width="${width}" height="${height}" style="image-rendering:pixelated; max-width:100%; border:1px solid var(--border);"></canvas>
                    <div class="video-controls">
                        <button id="video-prev-btn" title="Previous frame">⏮</button>
                        <button id="video-play-btn" title="Play/Pause">▶</button>
                        <button id="video-next-btn" title="Next frame">⏭</button>
                        <input type="range" id="video-slider" min="0" max="${nframes - 1}" value="0" style="flex:1;">
                        <span id="video-frame-label" style="min-width:80px; text-align:right; font-size:12px; color:var(--text-muted);">1 / ${nframes}</span>
                    </div>
                </div>
            </div>
        `;

        const canvas = container.querySelector('#video-canvas');
        const ctx2d = canvas.getContext('2d');
        const playBtn = container.querySelector('#video-play-btn');
        const prevBtn = container.querySelector('#video-prev-btn');
        const nextBtn = container.querySelector('#video-next-btn');
        const slider = container.querySelector('#video-slider');
        const frameLabel = container.querySelector('#video-frame-label');
        const exportBtn = container.querySelector('#video-export-btn');

        let currentFrame = 0;
        let playing = false;
        let timer = null;
        let audioEl = null;

        if (audioUrl) {
            audioEl = new Audio(audioUrl);
            audioEl.volume = 1;
        }

        function renderFrame(idx) {
            if (idx < 0 || idx >= nframes) return;
            currentFrame = idx;
            const rgba = rgbaFrames[idx];
            const imgData = ctx2d.createImageData(width, height);
            imgData.data.set(rgba);
            ctx2d.putImageData(imgData, 0, 0);
            slider.value = idx;
            frameLabel.textContent = `${idx + 1} / ${nframes}`;
        }

        function play() {
            if (playing) return;
            playing = true;
            playBtn.textContent = '⏸';
            if (audioEl) {
                audioEl.currentTime = currentFrame * frameDuration / 1000;
                audioEl.play().catch(() => {});
            }
            const startTime = performance.now() - currentFrame * frameDuration;
            function tick() {
                if (!playing) return;
                const elapsed = performance.now() - startTime;
                const targetFrame = Math.floor(elapsed / frameDuration);
                if (targetFrame >= nframes) {
                    stop();
                    renderFrame(0);
                    return;
                }
                if (targetFrame !== currentFrame) {
                    renderFrame(targetFrame);
                }
                timer = requestAnimationFrame(tick);
            }
            timer = requestAnimationFrame(tick);
        }

        function stop() {
            playing = false;
            playBtn.textContent = '▶';
            if (timer) { cancelAnimationFrame(timer); timer = null; }
            if (audioEl) audioEl.pause();
        }

        playBtn.addEventListener('click', () => { playing ? stop() : play(); });
        prevBtn.addEventListener('click', () => { stop(); renderFrame(Math.max(0, currentFrame - 1)); });
        nextBtn.addEventListener('click', () => { stop(); renderFrame(Math.min(nframes - 1, currentFrame + 1)); });
        slider.addEventListener('input', () => { stop(); renderFrame(parseInt(slider.value)); });
        exportBtn.addEventListener('click', () => exportBlob(new Blob([data]), filename));

        renderFrame(0);
        play();

        renderFrame(0);
        play();

        // Register cleanup for file switching
        state.activeVideoCleanup = () => {
            stop();
            if (audioUrl) URL.revokeObjectURL(audioUrl);
        };

        // Cleanup on preview change
        const obs = new MutationObserver(() => {
            if (!container.querySelector('#video-canvas')) {
                stop();
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                state.activeVideoCleanup = null;
                obs.disconnect();
            }
        });
        obs.observe(container, { childList: true, subtree: true });
    }

    function showBikFallbackPreview(container, data, filename, errorMsg) {
        let info;
        try {
            info = H3.BinkHeader.parse(data instanceof Uint8Array ? data : new Uint8Array(data));
        } catch (e) {
            showBinaryPreview(container, data, filename);
            return;
        }
        const audioDesc = info.audioTracks.length > 0
            ? info.audioTracks.map((t, i) => `Track ${i + 1}: ${t.sampleRate}Hz ${t.stereo ? 'Stereo' : 'Mono'} (${t.useDCT ? 'DCT' : 'RDFT'})`).join(', ')
            : 'No audio';
        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${info.width}×${info.height}</span>
                        <span>${info.nframes} frames</span>
                        <span>${info.fps.toFixed(1)} fps</span>
                        <span>Bink Video</span>
                        <span>${formatSize(data.length)}</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="bik-export-btn" title="Export original file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px;">
                    <div style="font-size:64px;">🎥</div>
                    <div style="text-align:center; color:var(--text-muted); font-size:13px;">
                        <p><strong>Bink Video</strong> — decode failed: ${escapeHtml(errorMsg)}</p>
                        <p>${info.width}×${info.height} • ${info.nframes} frames • ${info.fps.toFixed(1)} fps</p>
                        <p style="margin-top:8px;">${escapeHtml(audioDesc)}</p>
                        <p style="margin-top:8px;">Use the export button to save and play with VLC or ffplay.</p>
                    </div>
                </div>
            </div>
        `;
        const exportBtn = container.querySelector('#bik-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => exportBlob(new Blob([data]), filename));
        }
    }

    // ---- DEF Animation Viewer ----
    function clearThumbAnimTimers() {
        for (const t of state.thumbAnimTimers) clearInterval(t);
        state.thumbAnimTimers = [];
    }

    function populateDefList() {
        clearThumbAnimTimers();
        const container = els.defList;
        container.innerHTML = '';

        const defs = [];

        // From archive
        if (state.archive && state.archiveType === 'lod') {
            for (const f of state.fileList) {
                if (f.ext === 'def') defs.push(f);
            }
        }

        // Standalone (skip if already in archive file list)
        for (const [name, info] of state.standaloneFiles) {
            if (info.type === 'def' && !defs.some(d => d.name === name)) {
                defs.push({ name, ext: 'def', standalone: true });
            }
        }

        if (defs.length === 0) {
            container.innerHTML = '<div class="preview-placeholder" style="padding:20px;"><p>No DEF files found</p></div>';
            return;
        }

        const isGrid = state.defViewMode === 'grid';
        container.className = `file-list ${isGrid ? 'grid-view' : 'list-view'}`;
        if (isGrid) container.style.setProperty('--icon-size', state.defIconSize + 'px');

        for (const def of defs) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.dataset.filename = def.name;

            if (isGrid) {
                item.style.width = Math.max(state.defIconSize + 16, 72) + 'px';
                const iconDiv = document.createElement('div');
                iconDiv.className = 'file-item-icon';
                iconDiv.style.height = state.defIconSize + 'px';
                iconDiv.textContent = '🎬';

                const nameDiv = document.createElement('div');
                nameDiv.className = 'file-item-name';
                nameDiv.textContent = def.name;

                item.appendChild(iconDiv);
                item.appendChild(nameDiv);

                if (def.standalone) {
                    const info = state.standaloneFiles.get(def.name);
                    if (info && info.parsed) {
                        if (state.defAnimThumbs) {
                            startAnimatedThumb(iconDiv, info.parsed);
                        } else {
                            // Static first frame
                            const groups = info.parsed.getGroups();
                            if (groups.length > 0) {
                                const canvas = info.parsed.readImage('combined', groups[0], 0);
                                if (canvas) {
                                    iconDiv.textContent = '';
                                    const c = document.createElement('canvas');
                                    c.width = canvas.width;
                                    c.height = canvas.height;
                                    c.getContext('2d').drawImage(canvas, 0, 0);
                                    iconDiv.appendChild(c);
                                }
                            }
                        }
                    }
                } else if (state.archiveType === 'lod') {
                    iconDiv.dataset.lazyThumb = def.name;
                    if (state.defAnimThumbs) iconDiv.dataset.animated = '1';
                }
            } else {
                item.innerHTML = `
                    <span class="file-item-icon">🎬</span>
                    <span class="file-item-name">${escapeHtml(def.name)}</span>
                `;
            }

            item.addEventListener('click', () => selectDefFile(def));
            container.appendChild(item);
        }

        // Lazy load thumbnails via IntersectionObserver
        if (isGrid) {
            const lazyEls = container.querySelectorAll('[data-lazy-thumb]');
            if (lazyEls.length > 0) {
                const observer = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            const el = entry.target;
                            const fname = el.dataset.lazyThumb;
                            const animated = el.dataset.animated;
                            if (fname) {
                                if (animated) {
                                    loadAnimatedThumbnail(fname, el);
                                } else {
                                    loadThumbnail(fname, el);
                                }
                                delete el.dataset.lazyThumb;
                                delete el.dataset.animated;
                            }
                            observer.unobserve(el);
                        }
                    }
                }, { root: container, rootMargin: '200px' });
                lazyEls.forEach(el => observer.observe(el));
            }
        }

        // Search
        const search = $('#def-search');
        search.oninput = () => {
            const q = search.value.toLowerCase();
            $$('.file-item', container).forEach(el => {
                el.style.display = el.dataset.filename.toLowerCase().includes(q) ? '' : 'none';
            });
        };
    }

    function startAnimatedThumb(iconDiv, def) {
        const groups = def.getGroups();
        if (groups.length === 0) return;
        const frameCount = def.getFrameCount(groups[0]);
        const canvas = def.readImage('combined', groups[0], 0);
        if (!canvas) return;

        iconDiv.textContent = '';
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d').drawImage(canvas, 0, 0);
        iconDiv.appendChild(c);

        if (frameCount > 1) {
            let fi = 0;
            const timer = setInterval(() => {
                fi = (fi + 1) % frameCount;
                const frame = def.readImage('combined', groups[0], fi);
                if (frame) {
                    c.width = frame.width;
                    c.height = frame.height;
                    c.getContext('2d').drawImage(frame, 0, 0);
                }
            }, 200);
            state.thumbAnimTimers.push(timer);
        }
    }

    async function loadAnimatedThumbnail(filename, container) {
        try {
            const data = await state.archive.getFile(filename);
            if (!data) { container.textContent = '🎬'; return; }
            const def = H3.DefFile.open(data);
            // Cache for later
            if (!state.standaloneFiles.has(filename)) {
                state.standaloneFiles.set(filename, { data, type: 'def', parsed: def });
            }
            startAnimatedThumb(container, def);
        } catch (e) {
            container.textContent = '🎬';
        }
    }

    async function selectDefFile(file) {
        // Highlight
        $$('.file-item', els.defList).forEach(el => {
            el.classList.toggle('selected', el.dataset.filename === file.name);
        });

        try {
            let def;
            if (file.standalone) {
                def = state.standaloneFiles.get(file.name).parsed;
            } else {
                showLoading('Parsing DEF...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { toast('File not found', 'error'); return; }
                def = H3.DefFile.open(data);
                // Cache
                state.standaloneFiles.set(file.name, { data, type: 'def', parsed: def });
            }
            openDefInViewer(file.name, def);
        } catch (err) {
            hideLoading();
            console.error(err);
            toast('Error loading DEF: ' + err.message, 'error');
        }
    }

    function openDefInViewer(filename, def) {
        // Stop any running animation
        if (state.defAnim.timer) {
            clearInterval(state.defAnim.timer);
            state.defAnim.timer = null;
        }

        state.currentDef = def;
        state.defAnim.playing = false;
        state.defAnim.frameIdx = 0;

        const groups = def.getGroups();
        const size = def.getSize();
        const typeName = def.getTypeName() || 'UNKNOWN';
        state.defAnim.groupId = groups[0] || 0;

        const main = els.defviewerMain;
        main.innerHTML = `
            <div class="def-info-panel">
                <div class="def-info-header">
                    <h3>${escapeHtml(filename)}</h3>
                    <div class="def-info-grid">
                        <div class="def-info-item">
                            <span class="def-info-label">Type</span>
                            <span class="def-info-value">${typeName} (0x${(def.getType() || 0).toString(16)})</span>
                        </div>
                        <div class="def-info-item">
                            <span class="def-info-label">Size</span>
                            <span class="def-info-value">${size[0]}×${size[1]}</span>
                        </div>
                        <div class="def-info-item">
                            <span class="def-info-label">Groups</span>
                            <span class="def-info-value">${groups.length}</span>
                        </div>
                        <div class="def-info-item">
                            <span class="def-info-label">Total Frames</span>
                            <span class="def-info-value">${groups.reduce((s, g) => s + def.getFrameCount(g), 0)}</span>
                        </div>
                    </div>
                </div>

                <div class="def-animation-area">
                    <div class="def-player" id="def-player"></div>

                    <div class="def-controls">
                        <button class="def-mobile-toggle" id="def-mobile-expand" title="Show info &amp; controls">☰</button>
                        <button id="def-play" title="Play/Pause">▶</button>
                        <button id="def-prev" title="Previous Frame">⏮</button>
                        <button id="def-next" title="Next Frame">⏭</button>
                        <span class="def-frame-badge" id="def-frame-info"></span>

                        <div class="speed-control">
                            <label>Speed</label>
                            <input type="range" id="def-speed" min="16" max="500" value="${state.defAnim.speed}" step="1">
                            <span class="speed-value" id="def-speed-val">${state.defAnim.speed}ms</span>
                        </div>

                        <div class="group-select">
                            <label>Group</label>
                            <select id="def-group">
                                ${groups.map(g => `<option value="${g}"${g === state.defAnim.groupId ? ' selected' : ''}>Group ${g} (${def.getFrameCount(g)} frames)</option>`).join('')}
                            </select>
                        </div>

                        <div class="render-mode">
                            <label>Mode</label>
                            <select id="def-how">
                                <option value="combined"${state.defAnim.how === 'combined' ? ' selected' : ''}>Combined</option>
                                <option value="normal"${state.defAnim.how === 'normal' ? ' selected' : ''}>Normal</option>
                                <option value="shadow"${state.defAnim.how === 'shadow' ? ' selected' : ''}>Shadow</option>
                                <option value="overlay"${state.defAnim.how === 'overlay' ? ' selected' : ''}>Overlay</option>
                            </select>
                        </div>

                        <div class="def-export-btns">
                            <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="def-border-toggle">□</button>
                            <button title="Toggle white background" class="toggle-btn${state.whiteBg ? ' active' : ''}" id="def-bg-toggle"><svg width="12" height="12" viewBox="0 0 4 4" fill="currentColor"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg></button>
                            <button id="def-zoom-fit" title="Zoom fit">⊡</button>
                            <button id="def-zoom-1" title="Actual size">1:1</button>
                            <button id="def-zoom-2" title="2×">2×</button>
                            <button id="def-zoom-4" title="4×">4×</button>
                            <button id="def-export-orig" title="Export original DEF file">💾 Orig</button>
                            <button id="def-export-png" title="Export current frame as PNG">💾 PNG</button>
                            <button id="def-export-seq" title="Export all frames as PNG sequence">💾 Seq</button>
                            <button id="def-export-gif" title="Export animation as GIF">💾 GIF</button>
                        </div>
                    </div>

                    <div class="def-frames-panel">
                        <div class="def-frames-header">Frames</div>
                        <div class="def-frames-strip" id="def-frames-strip"></div>
                    </div>
                </div>
            </div>
        `;

        // Setup controls
        const zpAnim = setupDefControls(def, filename);

        // Initial render — hide player until doFit fires to avoid top-left flash
        const _initPlayer = $('#def-player');
        if (_initPlayer) _initPlayer.style.visibility = 'hidden';
        renderDefFrames(def);
        renderDefFrame(def);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (zpAnim) zpAnim.doFit();
            if (_initPlayer) _initPlayer.style.visibility = '';
        }));

        // Auto-play if animated
        const autoFrames = def.getFrameCount(state.defAnim.groupId);
        if (autoFrames > 1) {
            state.defAnim.playing = true;
            const playBtn = $('#def-play');
            if (playBtn) {
                playBtn.textContent = '⏸';
                playBtn.classList.add('active');
            }
            startDefAnimation(def);
        }
    }

    function setupDefControls(def, filename) {
        const player = $('#def-player');
        const playBtn = $('#def-play');
        const prevBtn = $('#def-prev');
        const nextBtn = $('#def-next');
        const speedSlider = $('#def-speed');
        const speedVal = $('#def-speed-val');
        const groupSelect = $('#def-group');
        const howSelect = $('#def-how');

        playBtn.addEventListener('click', () => {
            state.defAnim.playing = !state.defAnim.playing;
            playBtn.textContent = state.defAnim.playing ? '⏸' : '▶';
            playBtn.classList.toggle('active', state.defAnim.playing);

            if (state.defAnim.playing) {
                startDefAnimation(def);
            } else {
                if (state.defAnim.timer) {
                    clearInterval(state.defAnim.timer);
                    state.defAnim.timer = null;
                }
            }
        });

        prevBtn.addEventListener('click', () => {
            const frames = def.getFrameCount(state.defAnim.groupId);
            if (frames > 0) {
                state.defAnim.frameIdx = (state.defAnim.frameIdx - 1 + frames) % frames;
                renderDefFrame(def);
                highlightDefFrameThumb();
            }
        });

        nextBtn.addEventListener('click', () => {
            const frames = def.getFrameCount(state.defAnim.groupId);
            if (frames > 0) {
                state.defAnim.frameIdx = (state.defAnim.frameIdx + 1) % frames;
                renderDefFrame(def);
                highlightDefFrameThumb();
            }
        });

        speedSlider.addEventListener('input', () => {
            state.defAnim.speed = parseInt(speedSlider.value);
            speedVal.textContent = state.defAnim.speed + 'ms';
            if (state.defAnim.playing) {
                clearInterval(state.defAnim.timer);
                startDefAnimation(def);
            }
        });

        groupSelect.addEventListener('change', () => {
            state.defAnim.groupId = parseInt(groupSelect.value);
            state.defAnim.frameIdx = 0;
            renderDefFrames(def);
            renderDefFrame(def);
        });

        howSelect.addEventListener('change', () => {
            state.defAnim.how = howSelect.value;
            renderDefFrames(def);
            renderDefFrame(def);
        });

        // Border toggle
        const defBorderToggle = $('#def-border-toggle');
        if (defBorderToggle) {
            defBorderToggle.addEventListener('click', () => {
                state.showBorders = !state.showBorders;
                defBorderToggle.classList.toggle('active', state.showBorders);
                renderDefFrame(def);
            });
        }

        // Export buttons
        const exportOrig = $('#def-export-orig');
        const exportPng = $('#def-export-png');
        const exportSeq = $('#def-export-seq');
        const exportGif = $('#def-export-gif');

        if (exportOrig) {
            exportOrig.addEventListener('click', () => {
                const info = state.standaloneFiles.get(filename);
                if (info && info.data) {
                    exportBlob(new Blob([info.data]), filename);
                } else {
                    toast('Original data not available', 'warning');
                }
            });
        }

        if (exportPng) {
            exportPng.addEventListener('click', () => {
                const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, state.defAnim.frameIdx);
                if (canvas) exportCanvasAsPng(canvas, `frame_${state.defAnim.groupId}_${state.defAnim.frameIdx}.png`);
            });
        }

        if (exportSeq) {
            exportSeq.addEventListener('click', () => {
                const frameCount = def.getFrameCount(state.defAnim.groupId);
                for (let i = 0; i < frameCount; i++) {
                    const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, i);
                    if (canvas) exportCanvasAsPng(canvas, `frame_${state.defAnim.groupId}_${String(i).padStart(4, '0')}.png`);
                }
                toast(`Exported ${frameCount} frames`, 'success');
            });
        }

        if (exportGif) {
            exportGif.addEventListener('click', async () => {
                if (typeof GIF === 'undefined') {
                    toast('gif.js not loaded', 'error');
                    return;
                }
                const frameCount = def.getFrameCount(state.defAnim.groupId);
                if (frameCount === 0) return;

                const size = def.getSize();
                // Fetch worker script as blob to avoid CORS issues
                let workerBlob = window._gifWorkerBlob;
                if (!workerBlob) {
                    try {
                        const resp = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
                        const text = await resp.text();
                        workerBlob = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
                        window._gifWorkerBlob = workerBlob;
                    } catch (e) {
                        toast('Failed to load GIF worker: ' + e.message, 'error');
                        return;
                    }
                }

                const gif = new GIF({
                    workers: 2,
                    quality: 10,
                    width: size[0],
                    height: size[1],
                    workerScript: workerBlob,
                    transparent: 0xFF00FF
                });

                for (let i = 0; i < frameCount; i++) {
                    const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, i);
                    if (canvas) gif.addFrame(makeGifFrame(canvas, size[0], size[1]), { delay: state.defAnim.speed, copy: true });
                }

                toast('Encoding GIF...', 'info');
                gif.on('finished', blob => {
                    exportBlob(blob, `animation_group${state.defAnim.groupId}.gif`);
                    toast('GIF exported!', 'success');
                });
                gif.render();
            });
        }

        // Zoom controls + pan for animation player
        const zpAnim = player ? attachZoomPan(player, () => player.querySelector('canvas')) : null;
        const defZoomFit = $('#def-zoom-fit');
        const defZoom1 = $('#def-zoom-1');
        const defZoom2 = $('#def-zoom-2');
        const defZoom4 = $('#def-zoom-4');
        if (zpAnim) {
            if (defZoomFit) defZoomFit.addEventListener('click', () => zpAnim.doFit());
            if (defZoom1) defZoom1.addEventListener('click', () => zpAnim.setZoom(1));
            if (defZoom2) defZoom2.addEventListener('click', () => zpAnim.setZoom(2));
            if (defZoom4) defZoom4.addEventListener('click', () => zpAnim.setZoom(4));
        }
        const defBgToggle = $('#def-bg-toggle');
        if (player) applyBgState(player);
        if (defBgToggle && player) setupBgToggle(defBgToggle, player);
        const mobileExpand = $('#def-mobile-expand');
        if (mobileExpand) {
            mobileExpand.addEventListener('click', () => {
                const panel = mobileExpand.closest('.def-info-panel');
                if (panel) {
                    panel.classList.toggle('mobile-expanded');
                    mobileExpand.classList.toggle('active', panel.classList.contains('mobile-expanded'));
                }
            });
        }
        return zpAnim;
    }

    function startDefAnimation(def) {
        state.defAnim.timer = setInterval(() => {
            const frames = def.getFrameCount(state.defAnim.groupId);
            if (frames > 0) {
                state.defAnim.frameIdx = (state.defAnim.frameIdx + 1) % frames;
                renderDefFrame(def);
                highlightDefFrameThumb();
            }
        }, state.defAnim.speed);
    }

    function renderDefFrame(def) {
        const player = $('#def-player');
        if (!player) return;

        const frameInfo = $('#def-frame-info');
        const frameCount = def.getFrameCount(state.defAnim.groupId);
        if (frameInfo) {
            frameInfo.textContent = `Frame ${state.defAnim.frameIdx + 1}/${frameCount}`;
        }

        const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, state.defAnim.frameIdx);
        if (canvas) {
            const existingMsg = player.querySelector('p');
            if (existingMsg) existingMsg.remove();
            let c = player.querySelector('canvas');
            const sizeChanged = !c || c.width !== canvas.width || c.height !== canvas.height;
            if (!c) { c = document.createElement('canvas'); player.appendChild(c); }
            if (sizeChanged) { c.width = canvas.width; c.height = canvas.height; }
            c.getContext('2d').clearRect(0, 0, c.width, c.height);
            c.getContext('2d').drawImage(canvas, 0, 0);
            c.classList.toggle('img-border', state.showBorders);
        } else {
            player.innerHTML = '<p style="color:var(--text-muted);">No image for this mode</p>';
        }
    }

    function renderDefFrames(def) {
        const strip = $('#def-frames-strip');
        if (!strip) return;
        strip.innerHTML = '';

        const frameCount = def.getFrameCount(state.defAnim.groupId);
        for (let i = 0; i < frameCount; i++) {
            const thumb = document.createElement('div');
            thumb.className = 'def-frame-thumb' + (i === state.defAnim.frameIdx ? ' active' : '');
            thumb.dataset.frame = i;

            const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, i);
            if (canvas) {
                const c = document.createElement('canvas');
                c.width = canvas.width;
                c.height = canvas.height;
                c.getContext('2d').drawImage(canvas, 0, 0);
                thumb.appendChild(c);
            }

            const num = document.createElement('span');
            num.className = 'frame-number';
            num.textContent = i;
            thumb.appendChild(num);

            thumb.addEventListener('click', () => {
                state.defAnim.frameIdx = i;
                renderDefFrame(def);
                highlightDefFrameThumb();
            });

            strip.appendChild(thumb);
        }
    }

    function highlightDefFrameThumb() {
        const strip = $('#def-frames-strip');
        if (!strip) return;
        $$('.def-frame-thumb', strip).forEach(t => {
            t.classList.toggle('active', parseInt(t.dataset.frame) === state.defAnim.frameIdx);
        });
        // Scroll active thumb into view
        const active = $('.def-frame-thumb.active', strip);
        if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // ---- Demo download (100% client-side) ----
    const DEMO_URL = 'https://web.archive.org/web/20150506062114if_/http://updates.lokigames.com/loki_demos/heroes3-demo.run';

    function downloadDemo() {
        const overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.style.display = 'flex';
        overlay.style.cursor = 'default';
        overlay.innerHTML = `
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:28px 32px; max-width:520px; width:90%; box-shadow:var(--shadow-lg); text-align:center;">
                <div style="font-size:40px; margin-bottom:12px;">🏰</div>
                <h2 style="font-size:18px; margin-bottom:6px; color:var(--text-primary);">Load HoMM3 Demo</h2>
                <p style="color:var(--text-secondary); font-size:13px; line-height:1.6; margin-bottom:20px;">
                    Downloads the free Linux demo (~100 MB) and loads it directly — nothing is saved to disk.
                    Or open a <code style="background:var(--bg-tertiary); padding:1px 5px; border-radius:4px;">.run</code> file you already have.
                </p>
                <div id="demo-buttons" style="display:flex; flex-direction:column; gap:10px; align-items:center;">
                    <button id="demo-fetch" class="welcome-btn primary" style="width:100%; justify-content:center;">
                        ⬇️&nbsp; Download &amp; Load Demo
                    </button>
                    <button id="demo-load-run" class="welcome-btn secondary" style="width:100%; justify-content:center;">
                        📂&nbsp; Open local .run file
                    </button>
                    <button id="demo-cancel" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; padding:8px;">
                        Cancel
                    </button>
                </div>
                <div id="demo-progress-area" style="display:none; margin-top:4px;">
                    <p id="demo-progress-label" style="color:var(--text-secondary); font-size:13px; margin-bottom:10px;">Downloading…</p>
                    <div style="width:100%; height:6px; background:var(--bg-tertiary); border-radius:3px; overflow:hidden;">
                        <div id="demo-progress-bar" style="height:100%; width:0%; background:linear-gradient(90deg,var(--accent),var(--gold)); border-radius:3px; transition:width .2s;"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const runInput = document.createElement('input');
        runInput.type = 'file';
        runInput.accept = '.run';
        runInput.style.display = 'none';
        document.body.appendChild(runInput);

        overlay.querySelector('#demo-cancel').addEventListener('click', () => {
            overlay.remove();
            runInput.remove();
        });

        overlay.querySelector('#demo-load-run').addEventListener('click', () => {
            runInput.click();
        });

        runInput.addEventListener('change', async (e) => {
            overlay.remove();
            const file = e.target.files[0];
            runInput.remove();
            if (!file) return;
            await processRunFile(file);
        });

        overlay.querySelector('#demo-fetch').addEventListener('click', async () => {
            overlay.querySelector('#demo-buttons').style.display = 'none';
            const progressArea = overlay.querySelector('#demo-progress-area');
            const progressBar = overlay.querySelector('#demo-progress-bar');
            const progressLabel = overlay.querySelector('#demo-progress-label');
            progressArea.style.display = 'block';
            progressLabel.textContent = 'Connecting…';

            try {
                const resp = await fetch(DEMO_URL);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

                const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
                const reader = resp.body.getReader();
                const chunks = [];
                let received = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    if (total > 0) {
                        const pct = Math.round(received / total * 100);
                        progressBar.style.width = pct + '%';
                        progressLabel.textContent = `Downloading… ${pct}% (${(received / 1048576).toFixed(1)} MB)`;
                    } else {
                        progressLabel.textContent = `Downloading… ${(received / 1048576).toFixed(1)} MB`;
                    }
                }

                progressBar.style.width = '100%';
                progressLabel.textContent = 'Download complete, loading…';
                overlay.remove();
                runInput.remove();

                const blob = new Blob(chunks, { type: 'application/octet-stream' });
                await processRunFile(blob);

            } catch (_corsErr) {
                // CORS blocked — show manual save-as instructions
                progressArea.style.display = 'none';
                const box = overlay.querySelector('div');
                box.innerHTML = `
                    <div style="font-size:32px; margin-bottom:10px;">⬇️</div>
                    <h2 style="font-size:17px; margin-bottom:8px; color:var(--text-primary);">Manual download required</h2>
                    <p style="color:var(--text-secondary); font-size:13px; line-height:1.7; margin-bottom:16px;">
                        The server blocks direct browser access (CORS).<br>
                        Please save the file manually, then load it here.
                    </p>
                    <p style="color:var(--text-muted); font-size:12px; background:var(--bg-tertiary); border-radius:var(--radius); padding:10px 14px; margin-bottom:18px; text-align:left; line-height:1.7;">
                        1. Click the link below<br>
                        2. If the file opens as text in a new tab:<br>
                        &nbsp;&nbsp;&nbsp;<b>right-click the link → "Save link as…"</b><br>
                        3. Then click "Open .run file" below
                    </p>
                    <div style="display:flex; flex-direction:column; gap:10px; align-items:center;">
                        <a href="${DEMO_URL}" target="_blank" rel="noopener" class="welcome-btn secondary" style="text-decoration:none; justify-content:center; width:100%;">
                            🔗&nbsp; Open demo link (~100 MB)
                        </a>
                        <button id="demo-load-run2" class="welcome-btn primary" style="width:100%; justify-content:center;">
                            📂&nbsp; Open downloaded .run file
                        </button>
                        <button id="demo-cancel2" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; padding:8px;">
                            Cancel
                        </button>
                    </div>
                `;
                overlay.querySelector('#demo-cancel2').addEventListener('click', () => {
                    overlay.remove();
                    runInput.remove();
                });
                overlay.querySelector('#demo-load-run2').addEventListener('click', () => {
                    runInput.click();
                });
            }
        });
    }

    // ---- ISO CD Image processing ----
    async function processIsoFile(file) {
        showLoading('Reading ISO...', 0);

        try {
            if (!(await ISOExtract.isIsoFile(file))) {
                hideLoading();
                toast('Not a valid ISO 9660 image.', 'error');
                return;
            }

            // Track the source ISO file for hash computation
            state.sourceFiles.set(file.name, { data: file, filetype: 'ISO Image' });
            showLoading('Scanning ISO filesystem...', -1);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const { directGameFiles, cabSetups, directMp3Files, directMapFiles } = await ISOExtract.scanIso(file);

            const totalDirect = directGameFiles.length;
            let totalCab = 0;
            for (const setup of cabSetups) totalCab += setup.targetFiles.length;
            const totalFiles = totalDirect + totalCab;

            if (totalFiles === 0) {
                hideLoading();
                toast('No HoMM3 game files found in ISO.', 'error');
                return;
            }

            let extracted = 0;

            // 1) Extract direct game files from ISO (no decompression needed)
            for (const gf of directGameFiles) {
                const basename = gf.name.replace(/;.*$/, '');
                showLoading(`Extracting ${basename}...`, extracted / totalFiles);
                const data = await ISOExtract.extractIsoFile(file, gf.lba, gf.size);
                await registerGameFile(basename, data, 'ISO');
                extracted++;
            }

            // 2) Extract files from InstallShield CABs
            for (const setup of cabSetups) {
                for (const fileDesc of setup.targetFiles) {
                    const displayName = fileDesc.directory
                        ? fileDesc.directory + '/' + fileDesc.name
                        : fileDesc.name;
                    showLoading(`Extracting ${fileDesc.name} (CAB)...`, extracted / totalFiles);

                    const data = await ISOExtract.extractIsCabFile(
                        file, fileDesc, setup.volumeHeaders,
                        (done, total) => {
                            showLoading(`Extracting ${fileDesc.name} (CAB)...`,
                                (extracted + done / total) / totalFiles);
                        }
                    );

                    if (data && data.length > 0) {
                        await registerGameFile(fileDesc.name, data, 'ISO');
                    }
                    extracted++;
                }
            }

            // 3) Collect mp3 folder entries (lazy — extracted on demand when clicked)
            const mp3Entries = [];
            for (const mp3f of directMp3Files) {
                const { name, lba, size } = mp3f;
                mp3Entries.push({ name, extract: () => ISOExtract.extractIsoFile(file, lba, size) });
            }
            for (const setup of cabSetups) {
                for (const fileDesc of (setup.cabMp3Files || [])) {
                    const name = fileDesc.name;
                    const vols = setup.volumeHeaders;
                    mp3Entries.push({ name, extract: () => ISOExtract.extractIsCabFile(file, fileDesc, vols) });
                }
            }
            if (mp3Entries.length > 0) {
                state.archives.set('MP3 (ISO)', { archive: createMp3Archive(mp3Entries), type: 'mp3', data: null });
            }

            // 4) Collect map entries (lazy — extracted on demand when clicked)
            const mapEntries = [];
            for (const mf of directMapFiles) {
                const { name, lba, size } = mf;
                mapEntries.push({ name, extract: () => ISOExtract.extractIsoFile(file, lba, size) });
            }
            for (const setup of cabSetups) {
                for (const fileDesc of (setup.cabMapFiles || [])) {
                    const name = fileDesc.name;
                    const vols = setup.volumeHeaders;
                    mapEntries.push({ name, extract: () => ISOExtract.extractIsCabFile(file, fileDesc, vols) });
                }
            }
            if (mapEntries.length > 0) {
                state.archives.set('Maps (ISO)', { archive: createMp3Archive(mapEntries), type: 'maps', data: null });
            }

            // Auto-open first bitmap LOD, then first archive
            const bitmapKey = [...state.archives.keys()].find(k => k.toLowerCase().includes('bitmap'));
            if (bitmapKey) {
                const entry = state.archives.get(bitmapKey);
                state.archive = entry.archive;
                state.archiveName = bitmapKey;
                state.archiveType = 'lod';
            } else if (state.archives.size > 0) {
                const [firstName, firstEntry] = state.archives.entries().next().value;
                state.archive = firstEntry.archive;
                state.archiveName = firstName;
                state.archiveType = firstEntry.type;
            }

            updateArchiveSelector();
            buildFileList();
            hideLoading();
            setMode('explorer');
            toast(`Extracted ${extracted} files from ISO!`, 'success');

        } catch (err) {
            hideLoading();
            console.error(err);
            toast('ISO extraction error: ' + err.message, 'error');
        }
    }

    // Register an extracted game file (LOD/SND/VID) into state
    async function registerGameFile(name, data, source) {
        const ext = name.split('.').pop().toLowerCase();
        const displayName = name + ' (' + source + ')';

        if (ext === 'lod') {
            const archive = await H3.LodFile.open(data);
            state.archives.set(displayName, { archive, type: 'lod', data });
            state.sourceFiles.set(displayName, { data, filetype: 'LOD (' + source + ')' });
        } else if (ext === 'snd') {
            const archive = await H3.SndFile.open(data);
            state.archives.set(displayName, { archive, type: 'snd', data });
            state.sourceFiles.set(displayName, { data, filetype: 'SND (' + source + ')' });
        } else if (ext === 'vid') {
            const archive = await H3.VidFile.open(data);
            state.archives.set(displayName, { archive, type: 'vid', data });
            state.sourceFiles.set(displayName, { data, filetype: 'VID (' + source + ')' });
        } else {
            state.standaloneFiles.set(displayName, { data, type: ext });
        }
    }

    async function processRunFile(file) {
        showLoading('Reading file...', 0);

        try {
            const arrayBuf = await file.arrayBuffer();
            let allData = new Uint8Array(arrayBuf);

            // Find END_OF_STUB\n marker
            const marker = new TextEncoder().encode('END_OF_STUB\n');
            let markerPos = -1;
            for (let i = 0; i < allData.length - marker.length; i++) {
                let found = true;
                for (let j = 0; j < marker.length; j++) {
                    if (allData[i + j] !== marker[j]) { found = false; break; }
                }
                if (found) { markerPos = i + marker.length; break; }
            }

            if (markerPos === -1) throw new Error('Invalid demo file format');

            // Decompress tar.gz
            showLoading('Decompressing...', -1);
            const gzData = allData.slice(markerPos);
            allData = null; // free memory

            const tarData = await H3.gzipDecompress(gzData);

            // Parse tar to find LOD files
            showLoading('Extracting files...', -1);
            const files = parseTar(tarData);

            let loadedCount = 0;
            for (const [name, fileData] of files) {
                if (name.endsWith('h3bitmap.lod') || name.endsWith('h3sprite.lod')) {
                    const basename = name.split('/').pop();
                    const lodData = new Uint8Array(fileData);
                    state.standaloneFiles.set(basename, { data: lodData, type: 'lod-archive' });
                    loadedCount++;

                    // Parse and register
                    showLoading(`Parsing ${basename}...`, -1);
                    const archive = await H3.LodFile.open(lodData);
                    const displayName = basename + ' (Demo)';
                    state.archives.set(displayName, { archive, type: 'lod', data: lodData });
                }
            }

            // Auto-open h3bitmap.lod
            const bitmapEntry = state.archives.get('h3bitmap.lod (Demo)');
            if (bitmapEntry) {
                state.archive = bitmapEntry.archive;
                state.archiveName = 'h3bitmap.lod (Demo)';
                state.archiveType = 'lod';
                updateArchiveSelector();
                buildFileList();
            } else if (state.archives.size > 0) {
                const [firstName, firstEntry] = state.archives.entries().next().value;
                state.archive = firstEntry.archive;
                state.archiveName = firstName;
                state.archiveType = firstEntry.type;
                updateArchiveSelector();
                buildFileList();
            }

            hideLoading();
            setMode('explorer');
            toast(`Demo loaded! Found ${loadedCount} LOD archives.`, 'success');

        } catch (err) {
            hideLoading();
            console.error(err);
            toast('Demo download failed: ' + err.message, 'error');
        }
    }

    // ---- StuffIt 5 (.sit) processing ----
    async function processSitFile(file) {
        showLoading('Reading SIT archive...', 0);

        try {
            const data = new Uint8Array(await file.arrayBuffer());

            if (!SITExtract.isSitFile(data)) {
                hideLoading();
                toast('Not a valid StuffIt archive.', 'error');
                return;
            }

            state.sourceFiles.set(file.name, { data: file, filetype: 'StuffIt Archive' });

            showLoading('Parsing StuffIt archive...', -1);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const allEntries = SITExtract.listFiles(data);

            const GAME_EXTS  = new Set(['lod', 'snd', 'vid']);
            const MAP_EXTS   = new Set(['h3m', 'h3c']);

            const gameTargets  = allEntries.filter(e => GAME_EXTS.has(e.name.split('.').pop().toLowerCase()));
            const mapEntries   = allEntries.filter(e => MAP_EXTS.has(e.name.split('.').pop().toLowerCase()));
            const musicEntries = allEntries.filter(e => /\/music\//i.test('/' + e.path + '/'));
            const toastEntries = allEntries.filter(e => e.name.toLowerCase().endsWith('.toast'));

            if (gameTargets.length === 0 && toastEntries.length === 0) {
                hideLoading();
                toast('No HoMM3 game files found in StuffIt archive.', 'error');
                return;
            }

            let extracted = 0;
            const total = gameTargets.length;

            // 1. Extract LOD/SND/VID archives eagerly
            for (const entry of gameTargets) {
                showLoading(`Extracting ${entry.name}...`, extracted / Math.max(total, 1));
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                try {
                    const fileData = SITExtract.extractFile(data, entry);
                    await registerGameFile(entry.name, fileData, 'SIT');
                } catch (err) {
                    toast(`Skipped ${entry.name}: ${err.message}`, 'error');
                }
                extracted++;
            }

            // 2. Music folder — lazy AIFF-C → WAV conversion
            if (musicEntries.length > 0) {
                const musicLazy = musicEntries.map(entry => ({
                    name: entry.name,
                    extract: async () => {
                        const raw = SITExtract.extractFile(data, entry);
                        return decodeAiffcIma4ToWav(raw) || raw;
                    }
                }));
                state.archives.set('Music (SIT)', {
                    archive: createMp3Archive(musicLazy),
                    type: 'snd',
                    data: null,
                });
            }

            // 3. Maps folder — lazy extraction
            if (mapEntries.length > 0) {
                const mapsLazy = mapEntries.map(entry => ({
                    name: entry.name,
                    extract: async () => SITExtract.extractFile(data, entry),
                }));
                state.archives.set('Maps (SIT)', {
                    archive: createMp3Archive(mapsLazy),
                    type: 'maps',
                    data: null,
                });
            }

            // 4. Toast disc images — Arsenic-decompress, then treat as ISO 9660
            for (const entry of toastEntries) {
                const sizeMB = (entry.uncompressedSize / 1e6).toFixed(0);
                showLoading(`Decompressing disc image ${entry.name} (${sizeMB} MB) — this may take a while...`, -1);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                try {
                    const toastData = SITExtract.extractFile(data, entry);
                    const blob = new Blob([toastData]);

                    if (await ISOExtract.isIsoFile(blob)) {
                        showLoading('Scanning disc image for game files...', -1);
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const { directGameFiles, cabSetups, directMp3Files, directMapFiles } =
                            await ISOExtract.scanIso(blob);

                        for (const gf of directGameFiles) {
                            const basename = gf.name.replace(/;.*$/, '');
                            const gameData = await ISOExtract.extractIsoFile(blob, gf.lba, gf.size);
                            await registerGameFile(basename, gameData, 'SIT');
                            extracted++;
                        }

                        const isoMp3 = directMp3Files.map(f => ({
                            name: f.name,
                            extract: () => ISOExtract.extractIsoFile(blob, f.lba, f.size),
                        }));
                        if (isoMp3.length > 0) {
                            state.archives.set('Music (Disc)', {
                                archive: createMp3Archive(isoMp3),
                                type: 'mp3',
                                data: null,
                            });
                        }

                        const isoMaps = directMapFiles.map(f => ({
                            name: f.name,
                            extract: () => ISOExtract.extractIsoFile(blob, f.lba, f.size),
                        }));
                        if (isoMaps.length > 0) {
                            state.archives.set('Maps (Disc)', {
                                archive: createMp3Archive(isoMaps),
                                type: 'maps',
                                data: null,
                            });
                        }
                    } else if (HFSExtract.isHfsImage(toastData)) {
                        // Apple HFS disc image
                        showLoading(`Scanning HFS volume in ${entry.name}...`, -1);
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const hfsFiles = HFSExtract.listFiles(toastData);
                        if (!hfsFiles) {
                            toast(`${entry.name}: Could not parse Apple HFS volume.`, 'error');
                        } else {
                            const gameExts = new Set(['lod', 'snd', 'vid', 'pac', 'pk']);
                            const hfsMp3Files = [];
                            const hfsMapFiles = [];
                            for (const hf of hfsFiles) {
                                if (hf.dfLen === 0) continue;
                                const ext = hf.name.includes('.')
                                    ? hf.name.slice(hf.name.lastIndexOf('.') + 1).toLowerCase()
                                    : '';

                                // ── VISE installer detection ──────────────────────────
                                // The Mac CD carries the game as a VISE 3.6 Lite installer
                                // ("Install Heroes 3 Complete") rather than loose game files.
                                // Detect it by name and SVCT magic bytes, then extract
                                // game files (LOD, SND, VID) via VISEExtract.
                                const isViseInstaller = !ext &&
                                    /install\s+heroes/i.test(hf.name) &&
                                    typeof VISEExtract !== 'undefined';

                                if (isViseInstaller) {
                                    showLoading(`Reading VISE installer "${hf.name}" (${(hf.dfLen / 1e6).toFixed(0)} MB)…`, -1);
                                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                                    const instData = HFSExtract.extractFile(toastData, hf);
                                    if (!VISEExtract.isViseInstaller(instData)) {
                                        toast(`${hf.name}: Not a VISE installer (missing SVCT magic).`, 'warning');
                                        continue;
                                    }
                                    try {
                                        let viseCount = 0;
                                        const viseMusicFiles = [];
                                        const viseMapFiles   = [];
                                        await VISEExtract.extractGameFiles(instData, {
                                            onProgress(done, total, name) {
                                                showLoading(
                                                    `Extracting VISE: ${name} (${done}/${total})…`,
                                                    done / Math.max(total, 1)
                                                );
                                            },
                                            async onGameFile(name, fileData) {
                                                await registerGameFile(name, fileData, 'VISE');
                                                viseCount++;
                                                extracted++;
                                            },
                                            onMapFile(name, fileData) {
                                                viseMapFiles.push({ name, data: fileData });
                                            },
                                            onMusicFile(name, fileData) {
                                                viseMusicFiles.push({ name, data: fileData });
                                            },
                                        });
                                        if (viseMusicFiles.length > 0) {
                                            state.archives.set('Music (VISE)', {
                                                archive: createMp3Archive(viseMusicFiles.map(f => ({
                                                    name: f.name,
                                                    extract: async () => decodeAiffcIma4ToWav(f.data) || f.data,
                                                }))),
                                                type: 'snd',
                                                data: null,
                                            });
                                        }
                                        if (viseMapFiles.length > 0) {
                                            state.archives.set('Maps (VISE)', {
                                                archive: createMp3Archive(viseMapFiles.map(f => ({
                                                    name: f.name,
                                                    extract: async () => f.data,
                                                }))),
                                                type: 'maps',
                                                data: null,
                                            });
                                        }
                                        if (viseCount === 0 && viseMusicFiles.length === 0 && viseMapFiles.length === 0) {
                                            toast(`VISE installer "${hf.name}": no game files found.`, 'warning');
                                        }
                                    } catch (err) {
                                        toast(`VISE extraction failed: ${err.message}`, 'error');
                                        console.error(err);
                                    }
                                } else if (gameExts.has(ext)) {
                                    showLoading(`Extracting ${hf.name} from HFS disc...`, -1);
                                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                                    const fileData = HFSExtract.extractFile(toastData, hf);
                                    await registerGameFile(hf.name, fileData, 'SIT');
                                    extracted++;
                                } else if (ext === 'mp3') {
                                    hfsMp3Files.push(hf);
                                } else if (ext === 'h3m' || ext === 'h3c') {
                                    hfsMapFiles.push(hf);
                                }
                            }
                            if (hfsMp3Files.length > 0) {
                                state.archives.set('Music (HFS)', {
                                    archive: createMp3Archive(hfsMp3Files.map(hf => ({
                                        name: hf.name,
                                        extract: () => Promise.resolve(HFSExtract.extractFile(toastData, hf)),
                                    }))),
                                    type: 'snd',
                                    data: null,
                                });
                            }
                            if (hfsMapFiles.length > 0) {
                                state.archives.set('Maps (HFS)', {
                                    archive: createMp3Archive(hfsMapFiles.map(hf => ({
                                        name: hf.name,
                                        extract: () => Promise.resolve(HFSExtract.extractFile(toastData, hf)),
                                    }))),
                                    type: 'maps',
                                    data: null,
                                });
                            }
                            if (extracted === 0 && hfsMp3Files.length === 0 && hfsMapFiles.length === 0) {
                                const volName = HFSExtract.getVolumeName(toastData) || entry.name;
                                toast(`HFS volume "${volName}": no game files found (${hfsFiles.length} files on disc).`, 'warning');
                            }
                        }
                    } else {
                        toast(`${entry.name}: Unknown disc image format — neither ISO 9660 nor Apple HFS.`, 'error');
                    }
                } catch (err) {
                    toast(`Error processing ${entry.name}: ${err.message}`, 'error');
                    console.error(err);
                }
            }

            // If nothing was extracted and no archives were created, the relevant
            // error toasts have already been shown — just close the loading overlay.
            if (extracted === 0 && state.archives.size === 0) {
                hideLoading();
                return;
            }

            // Auto-open h3bitmap.lod if present, else first archive
            const bitmapKey = [...state.archives.keys()].find(k => k.toLowerCase().includes('h3bitmap'));
            if (bitmapKey) {
                const entry = state.archives.get(bitmapKey);
                state.archive     = entry.archive;
                state.archiveName = bitmapKey;
                state.archiveType = entry.type;
            } else if (state.archives.size > 0) {
                const [firstName, firstEntry] = state.archives.entries().next().value;
                state.archive     = firstEntry.archive;
                state.archiveName = firstName;
                state.archiveType = firstEntry.type;
            }

            updateArchiveSelector();
            buildFileList();
            hideLoading();
            setMode('explorer');
            toast(`Extracted ${extracted} files from StuffIt archive!`, 'success');

        } catch (err) {
            hideLoading();
            console.error(err);
            toast('StuffIt extraction error: ' + err.message, 'error');
        }
    }

    // ---- GOG EXE Installer processing ----
    async function processExeFile(file) {
        showLoading('Reading EXE...', 0);

        try {
            const exeData = new Uint8Array(await file.arrayBuffer());

            if (typeof ISExtract !== 'undefined' && ISExtract.isInstallShieldExe(exeData)) {
                await processIsInstaller(exeData, file.name);
                return;
            }

            if (!InnoExtract.isHeroes3Installer(exeData)) {
                hideLoading();
                toast('Not a recognized HoMM3 installer.', 'error');
                return;
            }

            // Track the source EXE file for hash computation
            state.sourceFiles.set(file.name, { data: file, filetype: 'EXE Installer' });
            // Fast check: is data embedded in EXE or in external BIN?
            // Done before the slow LZMA parse so the BIN dialog appears instantly.
            const quickDataOffset = InnoExtract.getDataOffset(exeData);

            let sourceFile;
            let effectiveDataOffset;

            if (quickDataOffset > 0) {
                // Self-contained: data is inside the EXE
                sourceFile = file;
                effectiveDataOffset = quickDataOffset;
            } else {
                // External BIN needed — ask immediately, before the slow parse
                hideLoading();
                const binFile = await askForBinFile(file.name);
                if (!binFile) return;
                sourceFile = binFile;
                state.sourceFiles.set(binFile.name, { data: binFile, filetype: 'BIN Data' });
                effectiveDataOffset = 0;
            }

            showLoading('Analyzing installer...', -1);
            // Double rAF: guarantees the loading bar is actually painted before
            // parseExe blocks the main thread with synchronous LZMA work.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const { dataEntries, fileMap } = InnoExtract.parseExe(exeData);

            // Collect all target files (LOD, SND, VID)
            const targetFiles = [];
            for (const [key, info] of fileMap) {
                // Derive display name from path: strip {app}\ prefix, use path components
                const path = info.path || key;
                const basename = path.split('\\').pop();
                // Include parent dir if there are duplicate basenames
                const parts = path.replace(/^\{app\}\\/, '').split('\\');
                const displayName = parts.length > 2
                    ? parts[parts.length - 3] + '/' + basename  // e.g. "Warlords of the Wasteland/xBitmap.lod"
                    : basename;
                targetFiles.push({ name: displayName, info });
            }

            if (targetFiles.length === 0) {
                hideLoading();
                toast('No game files found in installer.', 'error');
                return;
            }

            // Extract files
            let extracted = 0;
            const totalFiles = targetFiles.length;
            const gogMp3Files = [];
            const gogMapFiles = [];

            for (const { name, info } of targetFiles) {
                showLoading(`Extracting ${name}...`, extracted / totalFiles);

                const data = await InnoExtract.extractFile(sourceFile, effectiveDataOffset, dataEntries, info, (done, total) => {
                    showLoading(`Extracting ${name}...`, (extracted + done / total) / totalFiles);
                });

                if (data.length === 0) {
                    extracted++;
                    continue;
                }

                // Parse based on extension
                const ext = name.split('.').pop().toLowerCase();
                showLoading(`Parsing ${name}...`, extracted / totalFiles);

                if (ext === 'lod') {
                    const archive = await H3.LodFile.open(data);
                    const displayName = name + ' (GOG)';
                    state.archives.set(displayName, { archive, type: 'lod', data });
                    state.sourceFiles.set(displayName, { data, filetype: 'LOD (GOG)' });
                } else if (ext === 'snd') {
                    const archive = await H3.SndFile.open(data);
                    const displayName = name + ' (GOG)';
                    state.archives.set(displayName, { archive, type: 'snd', data });
                    state.sourceFiles.set(displayName, { data, filetype: 'SND (GOG)' });
                } else if (ext === 'vid') {
                    const archive = await H3.VidFile.open(data);
                    const displayName = name + ' (GOG)';
                    state.archives.set(displayName, { archive, type: 'vid', data });
                    state.sourceFiles.set(displayName, { data, filetype: 'VID (GOG)' });
                } else if (ext === 'mp3') {
                    // Collect mp3 files into a dedicated virtual archive
                    const mp3name = name.split('/').pop() || name;
                    const mp3data = data;
                    gogMp3Files.push({ name: mp3name, extract: async () => mp3data });
                } else if (ext === 'h3m' || ext === 'h3c') {
                    // Collect map files into a dedicated virtual archive
                    const mapname = name.split('/').pop() || name;
                    const mapdata = data;
                    gogMapFiles.push({ name: mapname, extract: async () => mapdata });
                } else {
                    const displayName = name + ' (GOG)';
                    state.standaloneFiles.set(displayName, { data, type: ext });
                }
                extracted++;
            }

            if (gogMp3Files.length > 0) {
                state.archives.set('MP3 (GOG)', { archive: createMp3Archive(gogMp3Files), type: 'mp3', data: null });
            }
            if (gogMapFiles.length > 0) {
                state.archives.set('Maps (GOG)', { archive: createMp3Archive(gogMapFiles), type: 'maps', data: null });
            }

            // Auto-open first bitmap LOD
            const bitmapKey = [...state.archives.keys()].find(k => k.toLowerCase().includes('bitmap'));
            if (bitmapKey) {
                const entry = state.archives.get(bitmapKey);
                state.archive = entry.archive;
                state.archiveName = bitmapKey;
                state.archiveType = 'lod';
            } else if (state.archives.size > 0) {
                const [firstName, firstEntry] = state.archives.entries().next().value;
                state.archive = firstEntry.archive;
                state.archiveName = firstName;
                state.archiveType = firstEntry.type;
            }

            updateArchiveSelector();
            buildFileList();
            hideLoading();
            setMode('explorer');
            toast(`Extracted ${extracted} files from GOG installer!`, 'success');

        } catch (err) {
            hideLoading();
            console.error(err);
            toast('Extraction error: ' + err.message, 'error');
        }
    }

    async function processIsInstaller(exeData, filename) {
        state.sourceFiles.set(filename, { data: exeData, filetype: 'EXE Installer' });
        showLoading('Decompressing installer cabinet…', -1);
        // Yield so the loading indicator paints before the synchronous heavy work.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        let hdrInfo, cabData;
        try {
            ({ hdrInfo, cabData } = ISExtract.processExe(exeData));
        } catch (err) {
            hideLoading();
            toast('Failed to extract installer: ' + err.message, 'error');
            return;
        }

        const TARGET_EXTS = ISExtract.TARGET_EXTS;
        const targetFiles = hdrInfo.files.filter(f =>
            !(f.flags & 8) && f.dataOffset > 0 &&
            TARGET_EXTS.some(ext => f.name.toLowerCase().endsWith(ext))
        );

        if (targetFiles.length === 0) {
            hideLoading();
            toast('No game files found in InstallShield installer.', 'error');
            return;
        }

        let extracted = 0;
        const isMp3Files  = [];
        const isMapFiles  = [];

        for (const fd of targetFiles) {
            const name = fd.name;
            const ext  = name.split('.').pop().toLowerCase();
            showLoading(`Extracting ${name}…`, 0.5 + extracted / targetFiles.length * 0.5);
            // Yield between files so the UI can breathe
            await new Promise(r => setTimeout(r, 0));

            if (ext === 'mp3') {
                const _fd = fd;
                isMp3Files.push({ name, extract: async () => ISExtract.extractFile(cabData, _fd) });
                extracted++;
                continue;
            }
            if (ext === 'h3m' || ext === 'h3c') {
                const _fd = fd;
                isMapFiles.push({ name, extract: async () => ISExtract.extractFile(cabData, _fd) });
                extracted++;
                continue;
            }

            const data = ISExtract.extractFile(cabData, fd);
            if (!data || data.length === 0) { extracted++; continue; }

            showLoading(`Parsing ${name}…`, 0.5 + extracted / targetFiles.length * 0.5);
            const displayName = name + ' (Demo)';

            if (ext === 'lod') {
                const archive = await H3.LodFile.open(data);
                state.archives.set(displayName, { archive, type: 'lod', data });
                state.sourceFiles.set(displayName, { data, filetype: 'LOD (Demo)' });
            } else if (ext === 'snd') {
                const archive = await H3.SndFile.open(data);
                state.archives.set(displayName, { archive, type: 'snd', data });
                state.sourceFiles.set(displayName, { data, filetype: 'SND (Demo)' });
            } else if (ext === 'vid') {
                const archive = await H3.VidFile.open(data);
                state.archives.set(displayName, { archive, type: 'vid', data });
                state.sourceFiles.set(displayName, { data, filetype: 'VID (Demo)' });
            } else {
                state.standaloneFiles.set(displayName, { data, type: ext });
            }
            extracted++;
        }

        if (isMp3Files.length > 0) {
            state.archives.set('MP3 (Demo)', { archive: createMp3Archive(isMp3Files), type: 'mp3', data: null });
        }
        if (isMapFiles.length > 0) {
            state.archives.set('Maps (Demo)', { archive: createMp3Archive(isMapFiles), type: 'maps', data: null });
        }

        // Auto-open the bitmap LOD if present, otherwise the first archive
        const bitmapKey = [...state.archives.keys()].find(k => k.toLowerCase().includes('bitmap'));
        if (bitmapKey) {
            const entry = state.archives.get(bitmapKey);
            state.archive = entry.archive;
            state.archiveName = bitmapKey;
            state.archiveType = 'lod';
        } else if (state.archives.size > 0) {
            const [firstName, firstEntry] = state.archives.entries().next().value;
            state.archive = firstEntry.archive;
            state.archiveName = firstName;
            state.archiveType = firstEntry.type;
        }

        updateArchiveSelector();
        buildFileList();
        hideLoading();
        setMode('explorer');
        toast(`Extracted ${extracted} files from InstallShield installer!`, 'success');
    }

    function askForBinFile(exeName) {
        return new Promise((resolve) => {
            // Derive expected BIN name
            const baseName = exeName.replace(/\.exe$/i, '');
            const expectedBin = baseName + '-1.bin';

            const overlay = document.createElement('div');
            overlay.className = 'loading-overlay';
            overlay.style.display = 'flex';
            overlay.style.cursor = 'default';
            overlay.innerHTML = `
                <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:28px 32px; max-width:520px; width:90%; box-shadow:var(--shadow-lg); text-align:center;">
                    <div style="font-size:40px; margin-bottom:12px;">⚔️</div>
                    <h2 style="font-size:18px; margin-bottom:6px; color:var(--text-primary);">HoMM3 GOG installer detected!</h2>
                    <p style="color:var(--text-secondary); font-size:13px; line-height:1.6; margin-bottom:20px;">
                        The associated BIN file is needed to extract the game data.<br>
                        Please select <code style="background:var(--bg-tertiary); padding:1px 5px; border-radius:4px; word-break:break-all;">${escapeHtml(expectedBin)}</code> from the same directory.
                    </p>
                    <div style="display:flex; flex-direction:column; gap:10px; align-items:center;">
                        <button id="bin-select-btn" class="welcome-btn primary" style="width:100%; justify-content:center;">
                            📂&nbsp; Select BIN file
                        </button>
                        <button id="bin-cancel" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; padding:8px;">
                            Cancel
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelector('#bin-cancel').addEventListener('click', () => {
                overlay.remove();
                resolve(null);
            });

            overlay.querySelector('#bin-select-btn').addEventListener('click', () => {
                els.binInput.click();
            });

            const handler = (e) => {
                overlay.remove();
                els.binInput.removeEventListener('change', handler);
                const f = e.target.files[0];
                els.binInput.value = '';
                resolve(f || null);
            };
            els.binInput.addEventListener('change', handler);
        });
    }

    // Simple tar parser
    function parseTar(data) {
        const files = [];
        let offset = 0;
        const td = new TextDecoder('ascii');

        while (offset + 512 <= data.length) {
            const header = data.slice(offset, offset + 512);

            // Check for empty block
            let allZero = true;
            for (let i = 0; i < 512; i++) {
                if (header[i] !== 0) { allZero = false; break; }
            }
            if (allZero) break;

            // Filename at offset 0, 100 bytes
            let filename = td.decode(header.slice(0, 100));
            const nullIdx = filename.indexOf('\0');
            if (nullIdx >= 0) filename = filename.substring(0, nullIdx);

            // Size at offset 124, 12 bytes (octal)
            let sizeStr = td.decode(header.slice(124, 136)).trim();
            sizeStr = sizeStr.replace(/\0/g, '');
            const fileSize = parseInt(sizeStr, 8) || 0;

            // Type at offset 156
            const type = header[156];

            offset += 512;

            if (fileSize > 0 && (type === 0 || type === 48)) { // regular file
                files.push([filename, data.slice(offset, offset + fileSize)]);
            }

            // Advance past file data (padded to 512)
            offset += Math.ceil(fileSize / 512) * 512;
        }

        return files;
    }

    // ---- Resize handle ----
    function setupResizeHandle() {
        document.querySelectorAll('.resize-handle').forEach(handle => {
            const sidebar = handle.previousElementSibling;
            const layout = handle.parentElement;
            if (!sidebar || !layout) return;

            let startX, startWidth;

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startX = e.clientX;
                startWidth = sidebar.getBoundingClientRect().width;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';

                function onMouseMove(e) {
                    const newWidth = Math.max(180, Math.min(startWidth + e.clientX - startX, layout.clientWidth - 200));
                    sidebar.style.width = newWidth + 'px';
                    sidebar.style.minWidth = newWidth + 'px';
                    sidebar.style.maxWidth = newWidth + 'px';
                }

                function onMouseUp() {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    }

    // ---- Event wiring ----
    function init() {
        initRefs();
        setupFileInput();

        // Keep --app-height in sync with the real visible viewport (fixes Android 100vh issue)
        function updateAppHeight() {
            const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            document.documentElement.style.setProperty('--app-height', h + 'px');
        }
        updateAppHeight();
        window.addEventListener('resize', updateAppHeight);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateAppHeight);
            window.visualViewport.addEventListener('scroll', updateAppHeight);
        }

        // Drag & drop on the whole page
        const mainContent = $('#main-content');
        mainContent.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            mainContent.classList.add('drag-over');
        });
        mainContent.addEventListener('dragleave', (e) => {
            if (!mainContent.contains(e.relatedTarget)) {
                mainContent.classList.remove('drag-over');
            }
        });
        mainContent.addEventListener('drop', async (e) => {
            e.preventDefault();
            mainContent.classList.remove('drag-over');
            await processFiles(e.dataTransfer.files);
        });

        // Nav buttons
        $$('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => setMode(btn.dataset.mode));
        });

        // Logo click: back to welcome / reset
        $('.logo').addEventListener('click', () => {
            state.archive = null;
            state.archiveName = '';
            state.archiveType = '';
            state.archives.clear();
            state.fileList = [];
            state.selectedFile = null;
            state.defFiles = [];
            state.pcxFiles = [];
            state.standaloneFiles.clear();
            state.thumbCache.clear();
            clearThumbAnimTimers();
            if (state.activeVideoCleanup) { state.activeVideoCleanup(); state.activeVideoCleanup = null; }
            state.lastTextData = null;
            state.textEncoding = 'auto';
            state.mapEncoding = 'auto';
            updateArchiveSelector();
            setMode('explorer');
        });

        // Open file buttons
        const triggerFileInput = () => els.fileInput.click();
        $('#btn-open-file').addEventListener('click', triggerFileInput);
        $('#welcome-open').addEventListener('click', triggerFileInput);

        // Demo download
        $('#btn-download-demo').addEventListener('click', downloadDemo);
        $('#welcome-demo').addEventListener('click', downloadDemo);

        // About modal
        const aboutModal = $('#about-modal');
        $('#btn-about').addEventListener('click', () => { aboutModal.style.display = 'flex'; });
        $('#about-close').addEventListener('click', () => { aboutModal.style.display = 'none'; });
        aboutModal.addEventListener('click', e => { if (e.target === aboutModal) aboutModal.style.display = 'none'; });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && aboutModal.style.display !== 'none') aboutModal.style.display = 'none'; });

        // Archive download buttons
        els.btnDownloadOriginal.addEventListener('click', downloadArchiveOriginal);
        els.btnDownloadZip.addEventListener('click', downloadArchiveAsZip);
        els.btnDownloadHashes.addEventListener('click', exportHashesTsv);

        // Archive switcher
        els.archiveSelect.addEventListener('change', async () => {
            const name = els.archiveSelect.value;
            await switchArchive(name);
            setMode(state.mode);
        });

        // View toggle
        $$('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.viewMode = btn.dataset.view;
                $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.viewMode));
                els.iconSizeControl.style.display = state.viewMode === 'grid' ? 'flex' : 'none';
                renderFileList(els.fileSearch.value);
            });
        });

        // Icon size slider
        els.iconSizeSlider.addEventListener('input', () => {
            state.iconSize = parseInt(els.iconSizeSlider.value);
            renderFileList(els.fileSearch.value);
        });

        // File search
        els.fileSearch.addEventListener('input', () => {
            renderFileList(els.fileSearch.value);
        });

        // Extension filter
        els.extFilter.addEventListener('change', () => {
            renderFileList(els.fileSearch.value);
        });

        // Resize handles for all sidebars
        setupResizeHandle();

        // Def viewer sidebar: view toggle + size slider
        $$('.view-btn[data-target="def"]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.defViewMode = btn.dataset.view;
                $$('.view-btn[data-target="def"]').forEach(b => b.classList.toggle('active', b.dataset.view === state.defViewMode));
                document.querySelector('.def-size-control').style.display = state.defViewMode === 'grid' ? 'flex' : 'none';
                populateDefList();
            });
        });
        const defSizeSlider = $('#def-icon-size-slider');
        if (defSizeSlider) {
            defSizeSlider.addEventListener('input', () => {
                state.defIconSize = parseInt(defSizeSlider.value);
                populateDefList();
            });
        }

        // Animated thumbnail toggle
        const animThumbToggle = $('#def-anim-thumb-toggle');
        if (animThumbToggle) {
            animThumbToggle.addEventListener('click', () => {
                state.defAnimThumbs = !state.defAnimThumbs;
                animThumbToggle.classList.toggle('active', state.defAnimThumbs);
                populateDefList();
            });
        }

        // Sync UI with initial state
        $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.viewMode));
        els.iconSizeControl.style.display = state.viewMode === 'grid' ? 'flex' : 'none';
        const animThumbToggleInit = $('#def-anim-thumb-toggle');
        if (animThumbToggleInit) animThumbToggleInit.classList.toggle('active', state.defAnimThumbs);

        // Start at welcome
        setMode('explorer');

        // Add pulse animation for loading bar
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%,100% { opacity: .5; }
                50% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
