# HoMM3 Explorer

A pure browser-based file explorer for **Heroes of Might and Magic III** game archives. No server, no installation — just open `index.html` and start exploring.

## Features

- **Drag & drop** game files directly onto the page, or use the file picker
- **GOG installer support** — open `.exe` or `.bin` GOG installers directly; HoMM3 data is extracted on the fly
- **ISO CD image support** — open original HoMM3 CD images (`.iso`); game files are extracted directly or from InstallShield CABs
- **Archive browsing** — navigate the contents of any supported container
- **Rich preview** for all major asset types:
  - Images: `.PCX`, `.D32` (raw RGBA), `.DDS`
  - Animations: `.DEF` sprite sheets with frame-by-frame playback
  - Fonts: `.FNT` bitmap fonts rendered as a full 16×16 character sheet
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
| `.FNT` | Bitmap fonts (256-glyph indexed format) |
| `.EXE` | GOG installer (Inno Setup, LZMA2 / zlib) |
| `.ISO` | Original CD image (ISO 9660, InstallShield CABs) |

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
| `parsers.js` | HoMM3 format parsers (LOD, PAK, SND, VID, DEF, PCX, D32, FNT) | MIT |
| `innoextract.js` | GOG / Inno Setup installer extractor | MIT |
| `isoextract.js` | ISO 9660 + InstallShield CAB extractor | MIT |
| `lzma2.js` | LZMA2 decompressor (based on 7-Zip SDK by Igor Pavlov) | MIT |
| `video-decoders.js` | SMK and BIK video decoders (derived from FFmpeg) | **LGPL-2.1-or-later** |

## License

| Component | License |
|-----------|--------|
| This project (all files except below) | [MIT](LICENSE-MIT) |
| `video-decoders.js` (FFmpeg-derived SMK/BIK decoders) | [LGPL-2.1-or-later](LICENSE-LGPL) |
| [pako](https://github.com/nodeca/pako) (zlib/deflate) | MIT |
| [gif.js](https://github.com/jnordberg/gif.js) | MIT |
| `lzma2.js` (based on 7-Zip SDK by Igor Pavlov) | Public Domain |

`video-decoders.js` contains algorithms and data tables derived from [FFmpeg](https://ffmpeg.org) (`libavcodec/smacker.c`, `bink.c`, `binkb.c`) and is therefore licensed under the **GNU Lesser General Public License v2.1 or later** — see [LICENSE-LGPL](LICENSE-LGPL).

HoMM3 format documentation and research courtesy of the [VCMI Project](https://vcmi.eu).

Inno Setup installer format structure based on research from [innoextract](https://github.com/dscharrer/innoextract) by Daniel Scharrer (zlib/libpng license).

InstallShield CAB format structure based on research from [unshield](https://github.com/twogood/unshield) by David Eriksson (LGPL-2.1 license).

---

*Heroes of Might and Magic III is a trademark of Ubisoft. This project is not affiliated with or endorsed by Ubisoft.*
