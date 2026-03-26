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
        viewMode: 'list', // 'list' | 'grid'
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
        defAnimThumbs: false,

        // Thumbnail cache
        thumbCache: new Map(),

        // Active thumbnail animation timers
        thumbAnimTimers: [],

        // Show image borders
        showBorders: false,

        // Active video/audio cleanup callback
        activeVideoCleanup: null
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
    }

    // ---- Utilities ----
    function toast(message, type = 'info') {
        const container = $('#toast-container');
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${escapeHtml(message)}</span>`;
        container.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(30px)'; setTimeout(() => el.remove(), 300); }, 4000);
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
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
            case 'smk': case 'bik': return '🎥';
            case 'msk': return '🎭';
            case 'fnt': return '🔤';
            case 'pal': return '🎨';
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
        if (info.type === 'lod' || info.type === 'snd' || info.type === 'vid') buildFileList();
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
    async function processFiles(files) {
        if (!files.length) return;

        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();
            const data = new Uint8Array(await file.arrayBuffer());

                try {
                    if (ext === 'lod') {
                        showLoading('Parsing LOD archive...');
                        state.archive = await H3.LodFile.open(data);
                        state.archiveName = file.name;
                        state.archiveType = 'lod';
                        state.archives.set(file.name, { archive: state.archive, type: 'lod', data });
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
                        updateArchiveSelector();
                        buildPakFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name}`, 'success');
                    } else if (ext === 'def') {
                        showLoading('Parsing DEF file...');
                        const def = H3.DefFile.open(data);
                        state.standaloneFiles.set(file.name, { data, type: 'def', parsed: def });
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
                        updateArchiveSelector();
                        buildFileList();
                        updateStandaloneUI();
                        setMode('explorer');
                        toast(`Loaded ${file.name} (${state.fileList.length} files)`, 'success');
                    } else if (ext === 'd32') {
                        showLoading('Parsing D32 file...');
                        const def = H3.DefFile.open(data);
                        state.standaloneFiles.set(file.name, { data, type: 'def', parsed: def });
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
                            if (!state.archive) {
                                buildStandaloneFileList();
                                setMode('explorer');
                            }
                            toast(`Loaded FNT: ${file.name}`, 'success');
                        } else {
                            toast(`Not a valid FNT file: ${file.name}`, 'error');
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
            return { name, ext, category };
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
                    iconDiv.textContent = getFileIcon(file.ext);
                }

                const nameDiv = document.createElement('div');
                nameDiv.className = 'file-item-name';
                nameDiv.textContent = file.name;

                item.appendChild(iconDiv);
                item.appendChild(nameDiv);
            } else {
                item.innerHTML = `
                    <span class="file-item-icon">${getFileIcon(file.ext)}</span>
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

        try {
            if (file.standalone) {
                const info = state.standaloneFiles.get(file.name);
                if (info.type === 'pcx') {
                    showImagePreview(preview, info.parsed.canvas, file.name, `${info.parsed.width}×${info.parsed.height}`, info.parsed.type);
                } else if (info.type === 'def') {
                    showDefPreview(preview, info.parsed, file.name);
                } else if (info.type === 'fnt') {
                    showFntPreview(preview, info.parsed, file.name, info.data);
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
                    showDefPreview(preview, def, file.name);
                } else if (ext === 'fnt' && H3.FNT.isFnt(data)) {
                    const font = H3.FNT.readFnt(data);
                    showFntPreview(preview, font, file.name, data);
                } else if (ext === 'txt' || ext === 'xls' || ext === 'csv') {
                    showTextPreview(preview, data, file.name);
                } else if (ext === 'wav' || (ext === '' && isWavData(data))) {
                    showAudioPreview(preview, data, file.name);
                } else {
                    showBinaryPreview(preview, data, file.name);
                }
            } else if (state.archiveType === 'snd') {
                showLoading('Loading file...');
                const data = await state.archive.getFile(file.name);
                hideLoading();
                if (!data) { showPreviewError(preview, 'File not found'); return; }
                showAudioPreview(preview, data, file.name);
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
                    <div class="preview-toolbar">
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="border-toggle-btn">□ Border</button>
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

        // Zoom controls
        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const zoom = btn.dataset.zoom;
                if (zoom === 'fit') {
                    body.classList.remove('zoom-actual');
                    c.style.transform = '';
                } else if (zoom === 'actual') {
                    body.classList.add('zoom-actual');
                    c.style.transform = '';
                } else if (zoom === '2x') {
                    body.classList.add('zoom-actual');
                    c.style.transform = 'scale(2)';
                    c.style.transformOrigin = 'center';
                } else if (zoom === '4x') {
                    body.classList.add('zoom-actual');
                    c.style.transform = 'scale(4)';
                    c.style.transformOrigin = 'center';
                }
            });
        });

        // Export PNG
        const pngBtn = container.querySelector('#export-png-btn');
        if (pngBtn) pngBtn.addEventListener('click', () => exportCanvasAsPng(c, filename.replace(/\.[^.]+$/, '.png')));
        // Export original
        const origBtn = container.querySelector('#export-orig-btn');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
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
                    <div class="preview-toolbar">
                        ${sheetCount > 1 ? `<select id="pak-sheet-select" title="Select sheet">${sheetOptions}</select>` : `<span style="font-size:12px;color:var(--text-muted)">Sheet 0</span>`}
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="border-toggle-btn">□ Border</button>
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

        // Zoom controls
        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const zoom = btn.dataset.zoom;
                if (zoom === 'fit') {
                    body.classList.remove('zoom-actual');
                    c.style.transform = '';
                } else if (zoom === 'actual') {
                    body.classList.add('zoom-actual');
                    c.style.transform = '';
                } else if (zoom === '2x') {
                    body.classList.add('zoom-actual');
                    c.style.transform = 'scale(2)';
                    c.style.transformOrigin = 'center';
                } else if (zoom === '4x') {
                    body.classList.add('zoom-actual');
                    c.style.transform = 'scale(4)';
                    c.style.transformOrigin = 'center';
                }
            });
        });

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

    function showDefPreview(container, def, filename) {
        const groups = def.getGroups();
        const size = def.getSize();
        const typeName = def.getTypeName() || 'UNKNOWN';
        const totalFrames = groups.reduce((s, g) => s + def.getFrameCount(g), 0);

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
                    <div class="preview-toolbar">
                        <button title="Open in Animation Viewer" id="btn-open-def-viewer">▶</button>
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-def-body"></div>
            </div>
        `;

        // Auto-play animation loop in preview
        const body = $('#preview-def-body', container);
        if (groups.length > 0) {
            const frameCount = def.getFrameCount(groups[0]);
            const c = document.createElement('canvas');
            body.appendChild(c);

            let frameIdx = 0;
            function drawFrame() {
                const canvas = def.readImage('combined', groups[0], frameIdx);
                if (canvas) {
                    c.width = canvas.width;
                    c.height = canvas.height;
                    c.getContext('2d').drawImage(canvas, 0, 0);
                }
                frameIdx = (frameIdx + 1) % frameCount;
            }
            drawFrame();

            if (frameCount > 1) {
                const previewTimer = setInterval(drawFrame, 150);
                // Clean up when container is replaced
                const obs = new MutationObserver(() => {
                    if (!container.contains(body)) {
                        clearInterval(previewTimer);
                        obs.disconnect();
                    }
                });
                obs.observe(container, { childList: true, subtree: true });
            }
        }

        // Open in full viewer
        const btn = $('#btn-open-def-viewer', container);
        if (btn) {
            btn.addEventListener('click', () => {
                // Store DEF file as standalone for the viewer
                if (!state.standaloneFiles.has(filename)) {
                    state.standaloneFiles.set(filename, { data: null, type: 'def', parsed: def });
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
                    <div class="preview-toolbar">
                        <button title="Zoom fit" data-zoom="fit">⊡</button>
                        <button title="Actual size" data-zoom="actual">1:1</button>
                        <button title="2x" data-zoom="2x">2×</button>
                        <button title="4x" data-zoom="4x">4×</button>
                        <button title="Show glyph borders" class="toggle-btn${state.showBorders ? ' active' : ''}" id="fnt-border-btn">□ Border</button>
                        <button title="Export as PNG" id="export-fnt-png-btn">💾 PNG</button>
                        ${rawData ? '<button title="Export original FNT" id="export-fnt-orig-btn">💾 FNT</button>' : ''}
                    </div>
                </div>
                <div class="preview-body checkerboard" id="preview-fnt-body"></div>
            </div>
        `;
        const body = container.querySelector('#preview-fnt-body');
        let currentTransform = '';
        let sheet = H3.FNT.renderSheet(font, borders);
        body.appendChild(sheet);

        $$('.preview-toolbar button[data-zoom]', container).forEach(btn => {
            btn.addEventListener('click', () => {
                const zoom = btn.dataset.zoom;
                if (zoom === 'fit') { body.classList.remove('zoom-actual'); currentTransform = ''; sheet.style.transform = ''; }
                else if (zoom === 'actual') { body.classList.add('zoom-actual'); currentTransform = ''; sheet.style.transform = ''; }
                else if (zoom === '2x') { body.classList.add('zoom-actual'); currentTransform = 'scale(2)'; sheet.style.transform = 'scale(2)'; sheet.style.transformOrigin = 'center'; }
                else if (zoom === '4x') { body.classList.add('zoom-actual'); currentTransform = 'scale(4)'; sheet.style.transform = 'scale(4)'; sheet.style.transformOrigin = 'center'; }
            });
        });

        const borderBtn = container.querySelector('#fnt-border-btn');
        if (borderBtn) {
            borderBtn.addEventListener('click', () => {
                borders = !borders;
                state.showBorders = borders;
                borderBtn.classList.toggle('active', borders);
                const next = H3.FNT.renderSheet(font, borders);
                if (currentTransform) { next.style.transform = currentTransform; next.style.transformOrigin = 'center'; }
                sheet.replaceWith(next);
                sheet = next;
            });
        }

        const pngBtn = container.querySelector('#export-fnt-png-btn');
        if (pngBtn) pngBtn.addEventListener('click', () => exportCanvasAsPng(sheet, filename.replace(/\.[^.]+$/, '_sheet.png')));
        const origBtn = container.querySelector('#export-fnt-orig-btn');
        if (origBtn && rawData) origBtn.addEventListener('click', () => exportBlob(new Blob([rawData]), filename));
    }

    function showTextPreview(container, data, filename) {
        let text;
        try {
            text = new TextDecoder('utf-8').decode(data);
        } catch {
            text = new TextDecoder('latin1').decode(data);
        }

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${formatSize(data.length)}</span>
                    </div>
                </div>
                <div class="preview-body" style="align-items:flex-start; justify-content:flex-start;">
                    <div class="preview-text">${escapeHtml(text)}</div>
                </div>
            </div>
        `;
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

    function showAudioPreview(container, data, filename) {
        const audioData = ensurePlayableWav(data instanceof Uint8Array ? data : new Uint8Array(data));
        const decoded = audioData !== data;
        const blob = new Blob([audioData], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);

        container.innerHTML = `
            <div class="preview-wrapper">
                <div class="preview-header">
                    <span class="preview-filename">${escapeHtml(filename)}</span>
                    <div class="preview-meta">
                        <span>${formatSize(data.length)}</span>
                        <span>${decoded ? 'IMA ADPCM → PCM' : 'WAV Audio'}</span>
                    </div>
                    <div class="preview-toolbar">
                        <button id="audio-export-btn" title="Export file">💾</button>
                    </div>
                </div>
                <div class="preview-body" style="align-items:center; justify-content:center;">
                    <div style="text-align:center;">
                        <div style="font-size:48px; margin-bottom:16px;">🔊</div>
                        <audio controls src="${url}" style="width:100%; max-width:400px;"></audio>
                        <div id="audio-error-msg" style="display:none; margin-top:12px; color:var(--text-muted); font-size:12px;">
                            Playback not supported. Use the export button to download the file.
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Error handler for unsupported audio codecs
        const audioEl = container.querySelector('audio');
        if (audioEl) {
            audioEl.addEventListener('error', () => {
                const errMsg = container.querySelector('#audio-error-msg');
                if (errMsg) errMsg.style.display = '';
            });
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
                        <button id="def-play" title="Play/Pause">▶</button>
                        <button id="def-prev" title="Previous Frame">⏮</button>
                        <button id="def-next" title="Next Frame">⏭</button>

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

                        <span class="frame-info" id="def-frame-info">Frame 0/0</span>

                        <button title="Show border" class="toggle-btn${state.showBorders ? ' active' : ''}" id="def-border-toggle">□ Border</button>

                        <div class="def-export-btns">
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
        setupDefControls(def, filename);

        // Initial render
        renderDefFrames(def);
        renderDefFrame(def);

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
                    workerScript: workerBlob
                });

                for (let i = 0; i < frameCount; i++) {
                    const canvas = def.readImage(state.defAnim.how, state.defAnim.groupId, i);
                    if (canvas) {
                        const c = document.createElement('canvas');
                        c.width = size[0];
                        c.height = size[1];
                        const ctx = c.getContext('2d');
                        ctx.drawImage(canvas, 0, 0);
                        gif.addFrame(c, { delay: state.defAnim.speed, copy: true });
                    }
                }

                toast('Encoding GIF...', 'info');
                gif.on('finished', blob => {
                    exportBlob(blob, `animation_group${state.defAnim.groupId}.gif`);
                    toast('GIF exported!', 'success');
                });
                gif.render();
            });
        }
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
        player.innerHTML = '';
        if (canvas) {
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            c.getContext('2d').drawImage(canvas, 0, 0);
            if (state.showBorders) c.classList.add('img-border');
            player.appendChild(c);
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
        // Show modal dialog with instructions
        const overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.style.display = 'flex';
        overlay.style.cursor = 'default';
        overlay.innerHTML = `
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:28px 32px; max-width:520px; width:90%; box-shadow:var(--shadow-lg); text-align:center;">
                <div style="font-size:40px; margin-bottom:12px;">🏰</div>
                <h2 style="font-size:18px; margin-bottom:6px; color:var(--text-primary);">Load HoMM3 Demo</h2>
                <p style="color:var(--text-secondary); font-size:13px; line-height:1.6; margin-bottom:20px;">
                    The demo must be downloaded manually (browser security prevents direct download from archive.org).<br>
                    Then load the <code style="background:var(--bg-tertiary); padding:1px 5px; border-radius:4px;">.run</code> file here — everything is processed locally in the browser.
                </p>
                <div style="display:flex; flex-direction:column; gap:10px; align-items:center;">
                    <a href="${DEMO_URL}" download="heroes3-demo.run" target="_blank" rel="noopener" class="welcome-btn secondary" style="text-decoration:none; justify-content:center; width:100%;">
                        ⬇️&nbsp; 1. Download demo (~100 MB)
                    </a>
                    <button id="demo-load-run" class="welcome-btn primary" style="width:100%; justify-content:center;">
                        📂&nbsp; 2. Open downloaded .run file
                    </button>
                    <button id="demo-cancel" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; padding:8px;">
                        Cancel
                    </button>
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

    // ---- GOG EXE Installer processing ----
    async function processExeFile(file) {
        showLoading('Reading EXE...', 0);

        try {
            const exeData = new Uint8Array(await file.arrayBuffer());

            if (!InnoExtract.isHeroes3Installer(exeData)) {
                hideLoading();
                toast('Not a HoMM3 GOG installer.', 'error');
                return;
            }

            showLoading('Analyzing installer...', -1);
            const { dataEntries, fileMap, dataOffset } = InnoExtract.parseExe(exeData);

            // Determine source file: self-contained EXE (dataOffset > 0) or external BIN
            let sourceFile;
            let effectiveDataOffset;

            if (dataOffset > 0) {
                // Self-contained: data is inside the EXE
                sourceFile = file;
                effectiveDataOffset = dataOffset;
            } else {
                // External BIN needed
                hideLoading();
                const binFile = await askForBinFile(file.name);
                if (!binFile) return;
                sourceFile = binFile;
                effectiveDataOffset = 0;
                showLoading('Analyzing installer...', -1);
            }

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
                toast('No LOD/SND/VID files found in installer.', 'error');
                return;
            }

            // Extract files
            let extracted = 0;
            const totalFiles = targetFiles.length;

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
                } else if (ext === 'snd') {
                    const archive = await H3.SndFile.open(data);
                    const displayName = name + ' (GOG)';
                    state.archives.set(displayName, { archive, type: 'snd', data });
                } else if (ext === 'vid') {
                    const archive = await H3.VidFile.open(data);
                    const displayName = name + ' (GOG)';
                    state.archives.set(displayName, { archive, type: 'vid', data });
                } else {
                    const displayName = name + ' (GOG)';
                    state.standaloneFiles.set(displayName, { data, type: ext });
                }
                extracted++;
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
                        Please select <code style="background:var(--bg-tertiary); padding:1px 5px; border-radius:4px;">${escapeHtml(expectedBin)}</code> from the same directory.
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
