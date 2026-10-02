// ============================================================
// HoMM3 Savegame Parser (h3savparser.js)
//
// Supports: .GM1 (singleplayer), .GM2 (hotseat/multiplayer),
//           .TGM (timed), .CGM (campaign)
//
// Format research based on:
//   - heroescommunity.com/viewthread.php3?TID=18817
//   - https://github.com/suurjaak/h3sed
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

const H3Sav = (() => {
    'use strict';

    // ---- Version detection ----

    // Version name based on version_major byte at offset 8 of decompressed data.
    // Ranges taken from h3sed (version modules) and HotA community research.
    function versionName(major, minor) {
        if (major >= 16 && major <= 27) return 'RoE';          // Restoration of Erathia
        if (major >= 28 && major <= 41) return 'AB';           // Armageddon's Blade
        if (major === 42 || major === 43) return 'SoD';        // Shadow of Death
        if (major === 44) {
            // HotA distinguishes sub-versions via minor
            if (minor >= 6) return 'HotA 1.7+';
            if (minor >= 5) return 'HotA 1.6';
            return 'HotA';
        }
        if (major === 51) return 'WoG';                        // Wake of Gods / ERA
        if (major > 44 && major < 51) return 'HotA';
        if (major > 51) return 'ERA';
        return `Unknown (v${major}.${minor})`;
    }

    // ---- Gzip / raw-deflate decompression ----
    //
    // HoMM3 savegames are stored as gzip streams but with an invalid/
    // truncated CRC checksum.  Standard gzip decompressors (including
    // pako in inflate mode) therefore reject the stream.
    //
    // Work-around: skip the gzip header manually, then use pako.inflateRaw
    // which performs raw DEFLATE decoding without validating the gzip footer.

    function skipGzipHeader(data) {
        if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('Not a gzip stream');
        const flags = data[3];
        let pos = 10;
        if (flags & 4) { // FEXTRA
            const xlen = data[pos] | (data[pos + 1] << 8);
            pos += 2 + xlen;
        }
        if (flags & 8) { // FNAME – null-terminated
            while (data[pos] !== 0) pos++;
            pos++;
        }
        if (flags & 16) { // FCOMMENT – null-terminated
            while (data[pos] !== 0) pos++;
            pos++;
        }
        if (flags & 2) pos += 2; // FHCRC
        return pos;
    }

    function decompressSave(data) {
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
        const payloadStart = skipGzipHeader(data);
        // pako.inflateRaw does raw DEFLATE without gzip wrapper → no CRC check
        return pako.inflateRaw(data.subarray(payloadStart));
    }

    // ---- String extraction helpers ----

    function readLeU16(buf, off) {
        return buf[off] | (buf[off + 1] << 8);
    }

    function readString(buf, off) {
        const len = readLeU16(buf, off);
        if (len === 0) return { str: '', next: off + 2 };
        const bytes = buf.subarray(off + 2, off + 2 + len);
        let str;
        try { str = new TextDecoder('windows-1252').decode(bytes); } catch { str = new TextDecoder('latin1').decode(bytes); }
        return { str, next: off + 2 + len };
    }

    // Check whether a uint8 is printable Latin-1.
    function isPrintable(b) {
        return (b >= 0x20 && b < 0x7f) || b >= 0xa0;
    }

    // Locate the map-name/description strings in the decompressed savegame.
    //
    // The layout of the savegame header differs slightly between game versions,
    // so we use a heuristic scanner rather than hard-coded offsets.
    //
    // Pattern: scan bytes 20–300 for a LE uint16 (1–200) followed by exactly
    // that many printable-Latin-1 bytes, directly followed by another LE uint16
    // (0–2000) that can be 0.  The first hit is the name; the next field is the
    // description.
    function findNameDesc(buf) {
        const searchEnd = Math.min(buf.length - 10, 400);
        for (let i = 20; i < searchEnd; i++) {
            const nlen = readLeU16(buf, i);
            if (nlen < 1 || nlen > 200) continue;
            if (i + 2 + nlen + 2 > buf.length) continue;
            // All name bytes must be printable
            let ok = true;
            for (let j = 0; j < nlen; j++) {
                if (!isPrintable(buf[i + 2 + j])) { ok = false; break; }
            }
            if (!ok) continue;
            // Followed by a plausible description length
            const dpos = i + 2 + nlen;
            const dlen = readLeU16(buf, dpos);
            if (dlen > 4000) continue;
            // Validate description bytes (allow 0-length)
            if (dlen > 0) {
                let dok = true;
                for (let j = 0; j < Math.min(dlen, 30); j++) {
                    if (dpos + 2 + j >= buf.length) { dok = false; break; }
                    // Allow a wider range for descriptions (may contain special chars)
                    const b = buf[dpos + 2 + j];
                    if (b < 0x09) { dok = false; break; } // no control chars except tab/LF/CR
                }
                if (!dok) continue;
            }
            // Found!
            let name = '';
            try { name = new TextDecoder('windows-1252').decode(buf.subarray(i + 2, i + 2 + nlen)); }
            catch { name = new TextDecoder('latin1').decode(buf.subarray(i + 2, i + 2 + nlen)); }
            let desc = '';
            if (dlen > 0) {
                try { desc = new TextDecoder('windows-1252').decode(buf.subarray(dpos + 2, dpos + 2 + dlen)); }
                catch { desc = new TextDecoder('latin1').decode(buf.subarray(dpos + 2, dpos + 2 + dlen)); }
            }
            return { name, desc };
        }
        return { name: '', desc: '' };
    }

    // ---- Savegame map-header extraction ----
    //
    // The savegame binary contains map metadata (version, size, name, etc.)
    // starting at a fixed offset within the first decompressed stream.
    // The layout DIFFERS from a standalone .h3m file: there are 12 extra
    // savegame-specific bytes between the version uint32 and the mapSize uint32.
    //
    // Known H3M version codes: 14 (RoE), 21 (AB), 28 (SoD), 29 (Chr), 32 (HotA), 51 (WoG)
    const H3M_VERSIONS = new Set([14, 21, 28, 29, 32, 51]);

    // H3M version code → human-readable name
    const H3M_VERSION_NAMES = { 14: 'RoE', 21: 'AB', 28: 'SoD', 29: 'SoD/Chr', 32: 'HotA', 51: 'WoG/ERA' };

    // Map size code → label
    const MAP_SIZE_LABELS = { 36: 'S', 72: 'M', 108: 'L', 144: 'XL', 216: 'H', 252: 'XH' };

    /**
     * Parse the embedded map header from a decompressed savegame buffer.
     *
     * Layout (confirmed empirically for 111.GM1 HotA):
     *   dec[0x34..0x38]  h3mVersion (4 bytes LE) — same as standalone .h3m
     *   dec[0x38..0x3e]  6 savegame-specific bytes (turn counter, speed, etc.)
     *   dec[0x3e..0x40]  2 more savegame bytes
     *   dec[0x40..0x44]  mapSize (4 bytes LE) — e.g. 72 for Medium
     *   dec[0x44]        hasUnderground (1 byte)
     *   dec[0x45..0x49]  nameLen (4 bytes LE) — length of the GERMAN/localised map name
     *   dec[0x49..]      name string (nameLen bytes, windows-1252)
     *   (then descLen + desc)
     *
     * The base offset 0x34 is invariant for all SoD/HotA savegames tested; it
     * may differ for RoE/AB saves (which use 0x30).
     *
     * @param {Uint8Array} dec  Decompressed savegame data.
     * @returns {object|null}  Map header fields or null on parse error.
     */
    function parseSavegameMapHeader(dec, enc = 'windows-1252') {
        // Embedded map header: [i32 version][u8 areAnyPlayers][i32 size][u8 twoLevels]
        //   [str16 name][str16 description][u8 difficulty][u8 maxHeroLevel (>=27)]…
        // Its offset moves between game versions (HotA inserts extra data before
        // it), so locate it by shape instead of a fixed offset.
        for (let q = 40; q < 260 && q + 12 < dec.length; q++) {
            const size = rdI32(dec, q);
            if (!MAP_SIZE_LABELS[size] || dec[q + 4] > 1) continue;
            const nlen = readLeU16(dec, q + 5);
            if (nlen < 1 || nlen > 100 || q + 7 + nlen + 2 > dec.length) continue;
            let ok = true;
            for (let j = 0; j < nlen; j++) if (!isPrintable(dec[q + 7 + j])) { ok = false; break; }
            if (!ok) continue;
            const dpos = q + 7 + nlen;
            const dlen = readLeU16(dec, dpos);
            if (dlen > 4000 || dpos + 2 + dlen + 2 > dec.length) continue;
            const diff = dec[dpos + 2 + dlen];
            if (diff > 4) continue;
            const h3mVersion = rdI32(dec, q - 5);
            const tail = dpos + 2 + dlen;
            return {
                h3mVersion,
                h3mVersionName: H3M_VERSION_NAMES[h3mVersion] || '',
                mapSize: size,
                mapSizeLabel: MAP_SIZE_LABELS[size] || `${size}×${size}`,
                hasUnderground: dec[q + 4] !== 0,
                mapName: decodeStr(dec, q + 7, q + 7 + nlen, enc),
                description: decodeStr(dec, dpos + 2, dpos + 2 + dlen, enc),
                difficulty: diff,
                difficultyName: DIFFICULTY_NAMES[diff],
                maxHeroLevel: dec[tail + 1] || null,
            };
        }
        return null;
    }

    // Legacy: find offset of H3M version code (kept for backward compat)
    function findEmbeddedOffset(dec) {
        for (let i = 0x28; i <= 0x44; i++) {
            const v = dec[i] | (dec[i+1] << 8) | (dec[i+2] << 16) | (dec[i+3] << 24);
            if (H3M_VERSIONS.has(v >>> 0)) return i;
        }
        return null;
    }

    // ---- Map filename extraction ----
    //
    // The original map/campaign filename (e.g. "[HotA] Air Supremacy.h3m") is
    // stored as a null-terminated ASCII string in the first ~2000 bytes of the
    // decompressed savegame.  We search for the extension pattern.

    function findMapFilename(dec) {
        const head = new TextDecoder('latin1').decode(dec.subarray(0, Math.min(dec.length, 2000)));
        const m = head.match(/([\[A-Za-z0-9][^\x00-\x1f\x7f]{2,}\.h3[mc])/i);
        return m ? m[1].trim() : null;
    }

    // ---- Hero game-data constants ----

    const PLAYER_COLORS = ['Red', 'Blue', 'Tan', 'Green', 'Orange', 'Purple', 'Teal', 'Pink'];

    const SKILL_NAMES = [
        'Pathfinding','Archery','Logistics','Scouting','Diplomacy','Navigation','Leadership',
        'Wisdom','Mysticism','Luck','Ballistics','Eagle Eye','Necromancy','Estates',
        'Fire Magic','Air Magic','Water Magic','Earth Magic','Scholar','Tactics',
        'Artillery','Learning','Offense','Armorer','Intelligence','Sorcery',
        'Resistance','First Aid'
    ];
    const ARTIFACT_SLOT_NAMES = [
        'Helm','Shoulders','Neck','Right hand','Left hand','Torso','Right ring','Left ring','Feet',
        'Misc 1','Misc 2','Misc 3','Misc 4','Ballista','Ammo cart','First aid tent','Catapult',
        'Spellbook','Misc 5'
    ];
    const SKILL_LEVEL_NAMES = ['', 'Basic', 'Advanced', 'Expert'];

    // Creature IDs (index = creature ID; SoD / WoG ordering, 7 per tier pair per town)
    const CREATURE_NAMES = [
        'Pikeman','Halberdier','Archer','Marksman','Griffin','Royal Griffin','Swordsman','Crusader',
        'Monk','Zealot','Cavalier','Champion','Angel','Archangel',                                   // Castle 0-13
        'Centaur','Centaur Captain','Dwarf','Battle Dwarf','Wood Elf','Grand Elf','Pegasus','Silver Pegasus',
        'Dendroid Guard','Dendroid Soldier','Unicorn','War Unicorn','Green Dragon','Gold Dragon',      // Rampart 14-27
        'Gremlin','Master Gremlin','Stone Gargoyle','Obsidian Gargoyle','Stone Golem','Iron Golem',
        'Mage','Arch Mage','Genie','Master Genie','Naga','Naga Queen','Giant','Titan',               // Tower 28-41
        'Imp','Familiar','Gog','Magog','Hell Hound','Cerberus','Demon','Horned Demon',
        'Pit Fiend','Pit Lord','Efreet','Efreet Sultan','Devil','Arch Devil',                        // Inferno 42-55
        'Skeleton','Skeleton Warrior','Walking Dead','Zombie','Wight','Wraith','Vampire','Vampire Lord',
        'Lich','Power Lich','Black Knight','Dread Knight','Bone Dragon','Ghost Dragon',              // Necropolis 56-69
        'Troglodyte','Infernal Troglodyte','Harpy','Harpy Hag','Beholder','Evil Eye',
        'Medusa','Medusa Queen','Minotaur','Minotaur King','Manticore','Scorpicore',
        'Red Dragon','Black Dragon',                                                                  // Dungeon 70-83
        'Goblin','Hobgoblin','Wolf Rider','Wolf Raider','Orc','Orc Chieftain',
        'Ogre','Ogre Mage','Roc','Thunderbird','Cyclops','Cyclops King','Behemoth','Ancient Behemoth', // Stronghold 84-97
        'Gnoll','Gnoll Marauder','Lizardman','Lizard Warrior','Serpent Fly','Dragon Fly',
        'Basilisk','Greater Basilisk','Gorgon','Mighty Gorgon','Wyvern','Wyvern Monarch',
        'Hydra','Chaos Hydra',                                                                        // Fortress 98-111
        'Pixie','Sprite','Air Elemental','Storm Elemental','Water Elemental','Ice Elemental',
        'Fire Elemental','Energy Elemental','Earth Elemental','Magma Elemental',
        'Psychic Elemental','Magic Elemental','Firebird','Phoenix',                                   // Conflux 112-125
        'Azure Dragon','Crystal Dragon','Faerie Dragon','Rust Dragon','Enchanter','Sharpshooter',     // 126-131
        'Halfling','Peasant','Boar','Mummy','Nomad','Rogue','Troll',                                  // Neutral 132-138
        'Catapult','Ballista','First Aid Tent','Ammo Cart','Arrow Tower',                            // War machines 139-143
    ];
    function artifactName(id) {
        const n = typeof H3Map !== 'undefined' && H3Map.ARTIFACT_NAMES;
        return (n && n[id]) || `Artifact#${id}`;
    }
    function spellName(id) {
        const n = typeof H3Map !== 'undefined' && H3Map.SPELL_NAMES;
        return (n && n[id]) || `Spell#${id}`;
    }
    function creatureName(id) {
        if (id === 0xFFFFFFFF || id < 0) return null;
        return CREATURE_NAMES[id] || `Creature#${id}`;
    }

    // ---- Hero struct scanner ----
    //
    // Hero structs are stored in the decompressed savegame (all heroes in the
    // game, including neutral/unowned ones).  Each struct is ~1154 bytes.
    // Key offsets (from h3sed metadata.py, HERO_BYTE_POSITIONS):
    //
    //   0:   faction (0-7 = Red..Pink, 255 = neutral/not hired)
    //  31:   movement_total  (4 bytes LE)
    //  35:   movement_left   (4 bytes LE)
    //  39:   experience      (4 bytes LE)
    //  43:   skills_count    (4 bytes LE)
    //  47:   mana_left       (2 bytes LE)
    //  49:   level           (1 byte)
    // 113:   army_types      (7 × 4-byte LE creature IDs)
    // 141:   army_counts     (7 × 4-byte LE counts)
    // 169:   name            (13 bytes, first byte printable ASCII, null-padded)
    // 182:   skill_levels    (28 bytes, values 0-3)
    // 210:   skill_slots     (28 bytes, values 0-27)
    // 238:   attack          (1 byte)
    // 239:   defense         (1 byte)
    // 240:   spell_power     (1 byte)
    // 241:   knowledge       (1 byte)
    // 242:   spells_in_book  (70 bytes, 0/1)
    // 312:   spells_avail    (70 bytes, 0/1)

    function scanHeroes(dec, encoding = 'windows-1252') {
        const heroes = [];
        // Pattern: find candidate hero-name positions (13 bytes: capital letter + ≤12 chars + null)
        // then validate the struct fields around it.
        for (let namePos = 169; namePos < dec.length - 600; namePos++) {
            const b0 = dec[namePos];
            // First byte must be uppercase letter or common name start
            if (b0 < 0x41 || b0 > 0x5a) continue;
            // 13th byte must be null
            if (dec[namePos + 12] !== 0x00) continue;
            // Bytes 1-11 must be alpha (A-Za-z) or null; at least one lowercase.
            // HoMM3 hero names are purely alphabetic — no digits, dots, hyphens, etc.
            let nameOk = false, hasLower = false;
            for (let j = 1; j < 12; j++) {
                const c = dec[namePos + j];
                if (c === 0) break;  // null terminator
                const isUpper = c >= 0x41 && c <= 0x5a;
                const isLower = c >= 0x61 && c <= 0x7a;
                if (!isUpper && !isLower) { nameOk = false; break; }
                if (isLower) hasLower = true;
                nameOk = true;
            }
            if (!nameOk || !hasLower) continue;

            // This is a candidate name.  Derive struct start.
            const s = namePos - 169;
            if (s < 0) continue;
            if (s + 382 > dec.length) continue;

            // Validate skill_levels[182..209] (all 0-3) and skill_slots[210..237] (all 0-27)
            let skillOk = true;
            for (let j = 0; j < 28; j++) {
                if (dec[s + 182 + j] > 3 || dec[s + 210 + j] > 27) { skillOk = false; break; }
            }
            if (!skillOk) continue;

            // Faction at offset 0 (0-7 = active player, 255 = neutral)
            const faction = dec[s + 0];
            if (faction !== 0xff && faction > 7) continue;

            // Extract name
            let nameEnd = namePos;
            while (nameEnd < namePos + 13 && dec[nameEnd] !== 0) nameEnd++;
            const nameStr = new TextDecoder(encoding).decode(dec.subarray(namePos, nameEnd));

            // Primary stats
            const level  = dec[s + 49];
            const attack = dec[s + 238];
            const defense= dec[s + 239];
            const power  = dec[s + 240];
            const knowledge= dec[s + 241];
            const exp    = (dec[s+39] | (dec[s+40]<<8) | (dec[s+41]<<16) | (dec[s+42]<<24)) >>> 0;
            const mana   = dec[s+47] | (dec[s+48]<<8);
            const movTotal  = (dec[s+31]|(dec[s+32]<<8)|(dec[s+33]<<16)|(dec[s+34]<<24))>>>0;
            const movLeft   = (dec[s+35]|(dec[s+36]<<8)|(dec[s+37]<<16)|(dec[s+38]<<24))>>>0;

            // Reject implausible primary stats (sane game caps)
            if (attack > 99 || defense > 99 || power > 99 || knowledge > 99) continue;
            if (level > 108) continue; // max level in any mod
            if (exp > 2_000_000_000) continue; // unsigned wrap or garbage

            // Army
            const army = [];
            for (let slot = 0; slot < 7; slot++) {
                const tid = (dec[s+113+slot*4]|(dec[s+114+slot*4]<<8)|(dec[s+115+slot*4]<<16)|(dec[s+116+slot*4]<<24))>>>0;
                const cnt = (dec[s+141+slot*4]|(dec[s+142+slot*4]<<8)|(dec[s+143+slot*4]<<16)|(dec[s+144+slot*4]<<24))>>>0;
                // cnt sanity: 0 = empty, >500000 = garbage (no sane army that large)
                if (tid < 0xFFFFFFFE && cnt > 0 && cnt <= 500_000) army.push({ id: tid, name: creatureName(tid), count: cnt });
            }

            // Skills: skill_levels[182..209] is indexed by skill ID (0-27),
            // value = Stufe (0=keine, 1=Basic, 2=Advanced, 3=Expert).
            // skill_slots[210..237] enthalten in Savegames nur Nullen → ignorieren.
            const skills = [];
            for (let i = 0; i < 28; i++) {
                const lvl = dec[s + 182 + i];
                if (lvl > 0 && lvl <= 3) {
                    skills.push({ name: SKILL_NAMES[i], level: SKILL_LEVEL_NAMES[lvl] || String(lvl) });
                }
            }

            // Spellbook: spells_in_book[242..311], indexed by spell ID
            const spells = [];
            for (let i = 0; i < 70; i++) if (dec[s + 242 + i] === 1) spells.push(spellName(i));

            // Artifacts: 19 equipped slots × 8 bytes (id, sub-id) at 382,
            // then 64 backpack slots × 8 bytes at 534.  0xFFFFFFFF = empty.
            const readArt = (off) => {
                if (s + off + 8 > dec.length) return undefined;
                const id = (dec[s+off]|(dec[s+off+1]<<8)|(dec[s+off+2]<<16)|(dec[s+off+3]<<24))>>>0;
                const sub = (dec[s+off+4]|(dec[s+off+5]<<8)|(dec[s+off+6]<<16)|(dec[s+off+7]<<24))|0;
                if (id === 0xFFFFFFFF) return null;
                if (id > 1000) return undefined; // implausible → layout differs
                return { id, name: artifactName(id), spell: id === 1 && sub >= 0 ? spellName(sub) : null };
            };
            let artifacts = [], backpack = [], artOk = true;
            for (let i = 0; i < 19 && artOk; i++) {
                const a = readArt(382 + i * 8);
                if (a === undefined) artOk = false;
                else if (a) artifacts.push({ slot: ARTIFACT_SLOT_NAMES[i], ...a });
            }
            for (let i = 0; i < 64 && artOk; i++) {
                const a = readArt(534 + i * 8);
                if (a === undefined) artOk = false;
                else if (a) backpack.push(a);
            }
            if (!artOk) { artifacts = null; backpack = null; }

            heroes.push({
                structOffset: s,
                spells, artifacts, backpack,
                name: nameStr,
                faction,
                factionName: faction < 8 ? PLAYER_COLORS[faction] : 'Neutral',
                level, attack, defense, power, knowledge,
                exp, mana, movTotal, movLeft,
                army, skills,
            });

            // Skip to avoid re-matching inside same struct (struct ~1154 bytes)
            namePos += 1153;
        }
        return heroes;
    }


    // ---- Anchored structure parsing ----
    //
    // Layout notes, derived empirically from real saves (RoE, SoD, HotA 1.6,
    // HotA 1.7+) and cross-checked with the homm3-decomp structures:
    //
    //  * The hero table is a contiguous array of fixed-size records (plus a
    //    4-byte-length "custom name" string for save version >= 25).  The record
    //    size grows with HotA (SoD 1094, HotA 1.6 +53, HotA 1.7 +66) but the
    //    field offsets before the artifact block are identical.  We find the
    //    array by locating the default names of heroes 0..3 and measuring the
    //    stride between them.
    //  * Player records (8 per game) and town records sit right before the hero
    //    table: [8 players][u8 townCount][towns...][heroes...].
    //  * The game setup block begins with the colour/position bytes 00..07
    //    twice, which makes it easy to find.

    const FACTION_NAMES = ['Castle','Rampart','Tower','Inferno','Necropolis','Dungeon','Stronghold','Fortress','Conflux','Cove','Factory','Bulwark'];
    const RESOURCE_NAMES = ['Wood','Mercury','Ore','Sulfur','Crystal','Gems','Gold'];
    const DIFFICULTY_NAMES = ['Easy','Normal','Hard','Expert','Impossible'];

    function rdI32(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) | 0; }
    function rdU32(b, o) { return rdI32(b, o) >>> 0; }
    function rdI16(b, o) { return ((b[o] | (b[o+1] << 8)) << 16) >> 16; }
    function decodeStr(b, a, e, enc) {
        try { return new TextDecoder(enc).decode(b.subarray(a, e)); }
        catch { return new TextDecoder('latin1').decode(b.subarray(a, e)); }
    }
    function cstr(b, a, max, enc) {
        let e = a;
        while (e < a + max && b[e] !== 0) e++;
        return decodeStr(b, a, e, enc);
    }
    function indexOfStr(b, str, from) {
        const n = str.length;
        outer: for (let i = from; i <= b.length - n - 1; i++) {
            if (b[i + n] !== 0) continue;
            for (let j = 0; j < n; j++) if (b[i + j] !== str.charCodeAt(j)) continue outer;
            return i;
        }
        return -1;
    }

    // Returns { first (name offset of hero 0), stride } or null.
    function findHeroTable(dec) {
        let from = 0;
        for (;;) {
            const o = indexOfStr(dec, 'Orrin', from);
            if (o < 0) return null;
            from = o + 1;
            const v = indexOfStr(dec, 'Valeska', o + 1);
            if (v < 0) return null;
            const stride = v - o;
            if (stride < 900 || stride > 1600) continue;
            if (indexOfStr(dec, 'Edric', o + 2 * stride - 1) !== o + 2 * stride) continue;
            if (indexOfStr(dec, 'Sylvia', o + 3 * stride - 1) !== o + 3 * stride) continue;
            return { first: o, stride };
        }
    }

    function validHeroName(b, o) {
        if (b[o] < 0x41 || b[o + 12] !== 0) return false;
        let n = 0;
        for (let j = 0; j < 12; j++) {
            const c = b[o + j];
            if (c === 0) break;
            const ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x20 || c === 0x27 || c === 0x2d || c >= 0xc0;
            if (!ok) return false;
            n++;
        }
        return n >= 3;
    }

    function readArtifactSlot(b, off) {
        const id = rdU32(b, off);
        if (id === 0xFFFFFFFF) return null;
        if (id > 1000) return undefined;          // implausible → layout differs
        const sub = rdI32(b, off + 4);
        return { id, name: artifactName(id), spell: id === 1 && sub >= 0 ? spellName(sub) : null };
    }

    function parseHeroAt(dec, s, verMajor, enc, id) {
        if (s + 382 > dec.length) return null;
        const u32 = (o) => rdU32(dec, s + o);
        const owner = dec[s];
        const army = [];
        for (let slot = 0; slot < 7; slot++) {
            const tid = u32(113 + slot * 4), cnt = u32(141 + slot * 4);
            if (tid < 0xFFFFFFFE && cnt > 0 && cnt <= 1_000_000) army.push({ id: tid, name: creatureName(tid), count: cnt });
        }
        const skills = [];
        for (let i = 0; i < 28; i++) {
            const lvl = dec[s + 182 + i];
            if (lvl > 0 && lvl <= 3) skills.push({ name: SKILL_NAMES[i], level: SKILL_LEVEL_NAMES[lvl] });
        }
        const spells = [];
        for (let i = 0; i < 70; i++) if (dec[s + 242 + i] === 1) spells.push(spellName(i));

        const equipSlots = verMajor >= 31 ? 19 : 18;
        let artifacts = [], backpack = [], artOk = true;
        for (let i = 0; i < equipSlots && artOk; i++) {
            const a = readArtifactSlot(dec, s + 382 + i * 8);
            if (a === undefined) artOk = false; else if (a) artifacts.push({ slot: ARTIFACT_SLOT_NAMES[i], ...a });
        }
        const packOff = 382 + equipSlots * 8;
        for (let i = 0; i < 64 && artOk; i++) {
            const a = readArtifactSlot(dec, s + packOff + i * 8);
            if (a === undefined) artOk = false; else if (a) backpack.push(a);
        }
        if (!artOk) { artifacts = null; backpack = null; }

        return {
            id,
            structOffset: s,
            name: cstr(dec, s + 169, 13, enc),
            faction: owner,
            factionName: owner < 8 ? PLAYER_COLORS[owner] : 'Neutral',
            owner,
            level: dec[s + 49],
            attack: dec[s + 238], defense: dec[s + 239], power: dec[s + 240], knowledge: dec[s + 241],
            exp: u32(39), mana: dec[s + 47] | (dec[s + 48] << 8),
            movTotal: u32(31), movLeft: u32(35),
            army, skills, spells, artifacts, backpack,
        };
    }

    // Walk the hero array. Returns { heroes, tableStart } or null.
    function parseHeroTable(dec, verMajor, enc) {
        const tbl = findHeroTable(dec);
        if (!tbl) return null;
        const hasCustom = verMajor >= 25;
        const pre = hasCustom ? 26 : 20;
        const body = tbl.stride - pre;              // bytes from after custom name to next record
        let s = tbl.first - 169;
        const tableStart = s - pre;
        const heroes = [];
        for (let i = 0; i < 400; i++) {
            if (s < 0 || s + 382 > dec.length) break;
            const blank = dec[s + 169] === 0 && dec[s + 170] === 0;   // unused slot (campaign saves)
            if (!blank && !validHeroName(dec, s + 169)) break;
            if (!blank) {
                const h = parseHeroAt(dec, s, verMajor, enc, i);
                if (!h) break;
                const h0 = s - pre;                 // record start (custom name length 0)
                h.x = rdI16(dec, h0); h.y = rdI16(dec, h0 + 2); h.z = rdI16(dec, h0 + 4);
                heroes.push(h);
            }
            let next = s + body;                    // start of next record (before custom name)
            if (hasCustom) {
                const len = rdI32(dec, next + 22);
                if (len < 0 || len > 64) break;
                next += 26 + len;
            } else next += 20;
            s = next;
        }
        if (heroes.length < 4) return null;
        return { heroes, tableStart, stride: tbl.stride };
    }

    function parsePlayersAndTowns(dec, tableStart, enc, legacy) {
        const b = dec;
        // Scan backwards from the hero table for 8 player records.
        // Record: [colour][numHeroes][curHero][hero ids ×8]… with colour == slot index.
        for (let S = 140; S <= 170; S++) {
            for (let gap = 1; gap < 40000; gap++) {
                const E = tableStart - gap;          // position of town-count byte
                const p = E - 8 * S;
                if (p < 0) break;
                let ok = true;
                for (let k = 0; k < 8; k++) {
                    const r = p + k * S;
                    if (b[r] !== k || b[r + 1] > 8) { ok = false; break; }
                }
                if (!ok) continue;
                const nt = b[E];
                if (nt === 0) {
                    if (E + 1 === tableStart) return buildPlayers(b, p, S, [], enc);
                    continue;
                }
                // Town record = 70 bytes + str16 name + F fixed bytes (F depends on the game version):
                // find the F for which ids run 0..nt-1 and the chain ends exactly at the hero table.
                for (let F = 250; F <= 700; F++) {
                    let q = E + 1, tw = [], valid = true;
                    for (let t = 0; t < nt; t++) {
                        if (q + 72 > tableStart || b[q] !== t) { valid = false; break; }
                        // RoE saves (<25) store the name as a fixed 13-byte field
                        const nl = legacy ? 13 : (b[q + 70] | (b[q + 71] << 8));
                        if (nl > 64) { valid = false; break; }
                        tw.push({ q, nl });
                        q += (legacy ? 70 : 72) + nl + F;
                    }
                    if (valid && q === tableStart) {
                        const towns2 = tw.map((t, id) => ({
                            id,
                            owner: b[t.q + 1],
                            ownerName: b[t.q + 1] < 8 ? PLAYER_COLORS[b[t.q + 1]] : 'Neutral',
                            type: b[t.q + 4],
                            typeName: FACTION_NAMES[b[t.q + 4]] || `Town#${b[t.q + 4]}`,
                            x: b[t.q + 5], y: b[t.q + 6], z: b[t.q + 7],
                            name: legacy ? cstr(b, t.q + 70, 13, enc) : decodeStr(b, t.q + 72, t.q + 72 + t.nl, enc),
                        }));
                        return buildPlayers(b, p, S, towns2, enc);
                    }
                }
            }
        }
        return null;
    }

    function buildPlayers(b, p, S, towns, enc) {
        const players = [];
        for (let k = 0; k < 8; k++) {
            const r = p + k * S;
            const numHeroes = b[r + 1];
            const heroIds = [];
            for (let i = 0; i < Math.min(numHeroes, 8); i++) if (b[r + 3 + i] !== 0xff) heroIds.push(b[r + 3 + i]);
            const numTowns = b[r + 25];
            const townIds = [];
            for (let i = 0; i < numTowns && i < 72; i++) if (b[r + 27 + i] !== 0xff) townIds.push(b[r + 27 + i]);
            const resources = [];
            for (let i = 0; i < 7; i++) resources.push(rdI32(b, r + 98 + i * 4));
            players.push({ color: k, colorName: PLAYER_COLORS[k], numHeroes, heroIds, townIds, resources });
        }
        return { players, towns, recordSize: S, offset: p };
    }

    // Game setup block (SGameSetupOptions): starts with the colour bytes 00..07,
    // then 8 handicap/type bytes, 8 × int32 faction picks (-1 = random), 8 bytes,
    // difficulty, and the 251-byte map filename.
    function parseSetup(dec, enc) {
        const lim = Math.min(dec.length - 460, 6000);
        outer: for (let i = 16; i < lim; i++) {
            if (dec[i] !== 0 || dec[i + 1] !== 1) continue;
            for (let k = 0; k < 8; k++) if (dec[i + k] !== k) continue outer;
            const alignment = [];
            for (let k = 0; k < 8; k++) alignment.push(rdI32(dec, i + 16 + k * 4));
            if (alignment.some(a => a < -1 || a > 20)) continue;
            const difficulty = dec[i + 56];
            if (difficulty > 4) continue;
            let printable = true;
            for (let k = 0; k < 4; k++) if (dec[i + 57 + k] !== 0 && !isPrintable(dec[i + 57 + k])) printable = false;
            if (!printable) continue;
            return {
                offset: i, alignment, difficulty,
                difficultyName: DIFFICULTY_NAMES[difficulty] || `#${difficulty}`,
                filename: cstr(dec, i + 57, 251, enc),
                mapPath: cstr(dec, i + 308, 100, enc),
            };
        }
        return null;
    }


    // ---- Embedded map (terrain + objects) ----
    //
    // A savegame does not embed a standalone .h3m, but it does carry the full
    // map state: per-cell terrain records followed by the object type table
    // and the object instance list.
    //   cell        : 18 bytes [terrain, tileIdx, riverSet, riverIdx, roadSet, roadIdx, flags…]
    //                 + i32 refCount + refCount × u32 object references
    //   object type : str16 defName, 26 bytes, u16 objectClass, 5 bytes
    //   object      : u8 x, u8 y, u8 z, u16 typeIndex
    // Cells are stored z-major, then y, then x.
    function parseEmbeddedMap(dec, header) {
        if (!header) return null;
        const S = header.mapSize, L = header.hasUnderground ? 2 : 1, N = S * S * L;
        const lim = Math.min(dec.length - 100, 9000);
        for (let st = 300; st < lim; st++) {
            // quick reject: first few cells must look like cells
            let p = st, ok = true;
            for (let i = 0; i < N; i++) {
                if (p + 22 > dec.length || dec[p] > 12) { ok = false; break; }
                const n = rdI32(dec, p + 18);
                if (n < 0 || n > 40) { ok = false; break; }
                p += 22 + 4 * n;
            }
            if (!ok) continue;
            const tc = rdI32(dec, p);
            const nl = readLeU16(dec, p + 4);
            if (tc <= 0 || tc > 20000 || nl < 4 || nl > 40) continue;
            if (!/\.def$/i.test(new TextDecoder('latin1').decode(dec.subarray(p + 6, p + 6 + nl)))) continue;

            // Cells validated – extract terrain.
            const terrain = [], roads = [], blocked = [];
            let q = st;
            for (let z = 0; z < L; z++) {
                const t = new Uint8Array(S * S), r = new Uint8Array(S * S), bl = new Uint8Array(S * S);
                for (let i = 0; i < S * S; i++) {
                    t[i] = dec[q]; r[i] = dec[q + 4] ? 1 : 0;
                    const n = rdI32(dec, q + 18);
                    bl[i] = n > 0 ? 1 : 0;
                    q += 22 + 4 * n;
                }
                terrain.push(t); roads.push(r); blocked.push(bl);
            }
            const map = { mapSize: S, levels: L, terrain, roads, blocked, objects: null, objectTypes: null };

            // Object type table + instances (best effort).
            try {
                let o = q + 4;
                const types = [];
                for (let i = 0; i < tc; i++) {
                    const len = readLeU16(dec, o);
                    const def = decodeStr(dec, o + 2, o + 2 + len, 'latin1');
                    o += 2 + len + 2 + 24;
                    types.push({ def, cls: readLeU16(dec, o) });
                    o += 2 + 4 + 1;
                }
                const oc = rdI32(dec, o); o += 4;
                if (oc < 0 || oc > 200000 || o + oc * 5 > dec.length) throw new Error('bad object count');
                const objects = [];
                for (let i = 0; i < oc; i++) {
                    const ti = readLeU16(dec, o + 3);
                    if (ti >= tc) throw new Error('bad type index');
                    objects.push({ x: dec[o], y: dec[o + 1], z: dec[o + 2], cls: types[ti].cls, def: types[ti].def });
                    o += 5;
                }
                map.objects = objects; map.objectTypes = types;
            } catch { /* terrain alone is still useful */ }
            return map;
        }
        return null;
    }

    // Everything the viewer can show beyond the header.
    function parseDetails(dec, encoding = 'windows-1252') {
        const verMajor = rdI32(dec, 8);
        const out = { heroes: null, players: null, towns: null, setup: null };
        try { out.setup = parseSetup(dec, encoding); } catch { /* optional */ }
        let ht = null;
        try { ht = parseHeroTable(dec, verMajor, encoding); } catch { /* fallback below */ }
        if (ht) {
            out.heroes = ht.heroes;
            try {
                const pt = parsePlayersAndTowns(dec, ht.tableStart, encoding, verMajor < 25);
                if (pt) { out.players = pt.players; out.towns = pt.towns; }
            } catch { /* optional */ }
        } else {
            out.heroes = scanHeroes(dec, encoding).map(h => ({ ...h, owner: h.faction }));
        }
        if (out.players) {
            // The per-player id lists differ between versions; the owner byte of
            // each hero / town record is the reliable link.
            for (const pl of out.players) {
                pl.heroNames = out.heroes.filter(h => h.owner === pl.color).map(h => h.name);
                pl.townNames = out.towns.filter(t => t.owner === pl.color).map(t => `${t.name} (${t.typeName})`);
                pl.townIds = out.towns.filter(t => t.owner === pl.color).map(t => t.id);
                const al = out.setup ? out.setup.alignment[pl.color] : -1;
                pl.faction = al >= 0 ? (FACTION_NAMES[al] || `#${al}`) : null;
                pl.active = pl.heroNames.length > 0 || pl.townIds.length > 0 || pl.numHeroes > 0;
            }
        }
        return out;
    }

    function extractHeroes(dec, encoding = 'windows-1252') {
        return parseDetails(dec, encoding).heroes;
    }

    /**
     * Filter a hero list to only include heroes that appear to be genuinely
     * active/hired (not slot-filler / uninitialized entries or map-name false positives).
     *
     * A hero is considered "active" when:
     *  - faction is a valid player (0-7)
     *  - AND at least one of: exp > 0, level > 0, movTotal > 0, army not empty,
     *    skills not empty.  (All-zero entries are uninitialized database slots.)
     */
    function filterActiveHeroes(heroes) {
        return heroes.filter(h => {
            return h.faction < 8;   // owned by a player
        });
    }

    // ---- Main parse entry point ----

    /**
     * Parse a HoMM3 savegame file.
     *
     * @param {Uint8Array} data  Raw (compressed) savegame bytes.
     * @param {string}     ext   File extension lowercase: 'gm1','gm2','tgm','cgm'.
     * @returns {object}  Parsed savegame metadata.
     */
    function parseSavegame(data, ext) {
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);

        let dec;
        try {
            dec = decompressSave(data);
        } catch (e) {
            throw new Error(`Failed to decompress savegame: ${e.message}`);
        }

        if (dec.length < 16) throw new Error('Decompressed data too short');

        // Magic
        const magic = String.fromCharCode(dec[0], dec[1], dec[2], dec[3], dec[4]);
        if (magic !== 'H3SVG' && magic !== 'H3SVC') {
            throw new Error(`Invalid savegame magic: ${magic}`);
        }

        const isCampaignSave = (magic === 'H3SVC');
        const saveType = ext === 'cgm' ? 'Campaign Save (.CGM)'
                       : ext === 'gm2' ? 'Multiplayer Save (.GM2)'
                       : ext === 'tgm' ? 'Timed Game Save (.TGM)'
                       : 'Singleplayer Save (.GM1)';

        const versionMajor = dec[8];
        const versionMinor = dec[12];
        const verName = versionName(versionMajor, versionMinor);

        // Name + description (heuristic scan)
        const mapHeaderEarly = parseSavegameMapHeader(dec);
        const heur = mapHeaderEarly ? { name: '', desc: '' } : findNameDesc(dec);
        const name = mapHeaderEarly ? mapHeaderEarly.mapName : heur.name;
        const desc = mapHeaderEarly ? mapHeaderEarly.description : heur.desc;

        // Embedded map / campaign data
        // NOTE: embeddedMapData is NOT a standalone .h3m file — the savegame
        // interleaves extra state bytes with the H3M header.  Use mapHeader
        // (below) to get the map metadata, and embeddedMapData only when you
        // have a custom savegame-aware parser.
        const embeddedOffset = findEmbeddedOffset(dec);
        const embeddedMapData = embeddedOffset != null ? dec.subarray(embeddedOffset) : null;

        // Parse the embedded map header directly from the savegame buffer.
        const mapHeader = mapHeaderEarly;

        // Map filename (null-terminated, found in first ~2000 decompressed bytes)
        const mapFilename = findMapFilename(dec);

        // Hero list (scans full decompressed data; may be slow for huge saves)
        const details = parseDetails(dec, 'windows-1252');
        const heroes = details.heroes;
        let embeddedMap = null;
        try { embeddedMap = parseEmbeddedMap(dec, mapHeader); } catch { /* optional */ }

        return {
            magic,
            isCampaignSave,
            saveType,
            ext: ext || '',
            versionMajor,
            versionMinor,
            versionName: verName,
            name: name || '',
            description: desc || '',
            compressedSize: data.length,
            decompressedSize: dec.length,
            embeddedMapData,   // Uint8Array — NOT directly parseable as .h3m (has extra savegame bytes)
            embeddedOffset,    // numeric byte offset or null
            mapHeader,         // parsed map metadata: { h3mVersion, mapSize, mapSizeLabel, hasUnderground, mapName }
            mapFilename,       // e.g. "[HotA] Air Supremacy.h3m" or null
            details,
            embeddedMap,       // { mapSize, levels, terrain[z] (Uint8Array y*size+x), roads, blocked, objects }
            heroes,            // array of hero objects (all heroes in the game database)
            activeHeroes: filterActiveHeroes(heroes),
            _decompressed: dec,
        };
    }

    // ---- Public API ----
    return {
        /** Parse a HoMM3 savegame Uint8Array.  Returns a savegame metadata object. */
        parseSavegame,
        /** Decompress a savegame (raw-deflate, ignores invalid CRC). */
        decompressSave,
        /** Detect version name from major/minor bytes. */
        versionName,
        /** Extract hero list from a decompressed savegame buffer. */
        extractHeroes,
        /** Parse players, towns, heroes and setup (re-run to change text encoding). */
        parseDetails,
        parseEmbeddedMap,
        FACTION_NAMES, RESOURCE_NAMES,
        /** Filter hero list to only genuinely active/hired heroes. */
        filterActiveHeroes,
        /** Parse the embedded map header from a decompressed savegame buffer. */
        parseSavegameMapHeader,
        /** Human-readable player color names indexed 0-7. */
        PLAYER_COLORS,
        SKILL_NAMES,
        SKILL_LEVEL_NAMES,
        creatureName, artifactName, spellName,
        ARTIFACT_SLOT_NAMES,
    };
})();
