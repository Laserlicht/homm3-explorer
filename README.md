# HoMM3 Explorer

A pure browser-based file explorer for **Heroes of Might and Magic III** game archives. No server, no installation — just open `index.html` and start exploring.

## Features

- **Drag & drop** game files directly onto the page, or use the file picker
- **GOG installer support** — open `.exe` or `.bin` GOG installers directly; HoMM3 data is extracted on the fly
- **Archive browsing** — navigate the contents of any supported container
- **Rich preview** for all major asset types:
  - Images: `.PCX`, `.D32` (raw RGBA), `.DDS`
  - Animations: `.DEF` sprite sheets with frame-by-frame playback
  - Audio: `.SND` archives containing WAV samples (in-browser playback)
  - Video: `.VID` archives with `.SMK` (Smacker) and `.BIK` (Bink) videos — decoded entirely in JavaScript
- **Export** any file from an archive to disk
- **Grid / List view** toggle for file browsers
- Works fully offline after the page has loaded

## Supported Formats

| Extension | Description |
|-----------|-------------|
| `.LOD` | Main game archives (sprites, data) |
| `.PAK` | Palette and resource packages |
| `.SND` | Sound archives (WAV samples) |
| `.VID` | Video archives (SMK / BIK clips) |
| `.DEF` | Sprite / animation definitions |
| `.PCX` | Paletted or 24-bit images |
| `.PAC` | Packed resource files |
| `.D32` | Raw 32-bit RGBA images |
| `.EXE` | GOG installer (Inno Setup, LZMA2 / zlib) |

## Usage

1. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari).
2. Drag a HoMM3 archive (e.g. `H3bitmap.lod`, `VIDEO.VID`) onto the page — or click **Open File**.
3. Browse the file list. Click any entry to preview it.
4. Use the **Export** button to save individual files.

> No files are uploaded anywhere. Everything runs locally in your browser.

## Architecture

| File | Role | License |
|------|------|---------|
| `index.html` | Shell / entry point | MIT |
| `style.css` | UI styles | MIT |
| `app.js` | Application logic, UI, drag & drop, preview | MIT |
| `parsers.js` | HoMM3 format parsers (LOD, PAK, SND, VID, DEF, PCX, D32) | MIT |
| `innoextract.js` | GOG / Inno Setup installer extractor | MIT |
| `lzma2.js` | LZMA2 decompressor (based on 7-Zip SDK by Igor Pavlov) | MIT |
| `video-decoders.js` | SMK and BIK video decoders (derived from FFmpeg) | **LGPL-2.1-or-later** |

## License

Most of this project is released under the **MIT License** — see [LICENSE-MIT](LICENSE-MIT).

`video-decoders.js` is licensed under the **GNU Lesser General Public License v2.1 or later** because it contains algorithms and data tables derived from [FFmpeg](https://ffmpeg.org) (`libavcodec/smacker.c`, `bink.c`, `binkb.c`) — see [LICENSE-LGPL](LICENSE-LGPL).

---

*Heroes of Might and Magic III is a trademark of Ubisoft. This project is not affiliated with or endorsed by Ubisoft.*
