// ============================================================
// HoMM3 Map & Campaign Parser (H3M / H3C)
//
// Independent reimplementation based on format documentation.
// Designed for extensibility (new HotA versions, etc.)
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 HoMM3 Explorer Contributors
// ============================================================

/* exported H3Map */
const H3Map = (() => {
    'use strict';

    // ----------------------------------------------------------------
    // Binary reader helper
    // ----------------------------------------------------------------
    class BinaryReader {
        constructor(data) {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.data = u8;
            this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            this.pos = 0;
            this.length = u8.byteLength;
        }
        u8()  { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
        i8()  { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
        u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
        i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
        u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
        i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
        bool(){ return this.u8() !== 0; }
        bytes(n) { const s = this.data.subarray(this.pos, this.pos + n); this.pos += n; return new Uint8Array(s); }
        skip(n) { this.pos += n; }
        str() {
            const len = this.u32();
            if (len === 0) return '';
            if (len > 500000 || this.pos + len > this.length) throw new Error(`Invalid string length ${len} at offset ${this.pos - 4}`);
            const bytes = this.data.subarray(this.pos, this.pos + len);
            this.pos += len;
            // Attempt UTF-8 first, fall back to latin1
            try {
                const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                return s;
            } catch {
                return new TextDecoder('latin1').decode(bytes);
            }
        }
        remaining() { return this.length - this.pos; }
        eof() { return this.pos >= this.length; }
    }

    // ----------------------------------------------------------------
    // Constants & Enumerations
    // ----------------------------------------------------------------
    const VERSION = {
        ROE:  0x0E,   // Restoration of Erathia
        AB:   0x15,   // Armageddon's Blade
        SOD:  0x1C,   // Shadow of Death
        CHR:  0x1D,   // Chronicles (same as SoD in practice)
        HOTA: 0x20,   // Horn of the Abyss
        WOG:  0x33,   // Wake of Gods / ERA
    };

    const VERSION_NAMES = {
        [VERSION.ROE]:  'Restoration of Erathia',
        [VERSION.AB]:   "Armageddon's Blade",
        [VERSION.SOD]:  'Shadow of Death',
        [VERSION.CHR]:  'Chronicles',
        [VERSION.HOTA]: 'Horn of the Abyss',
        [VERSION.WOG]:  'Wake of Gods',
    };

    const VERSION_SHORT = {
        [VERSION.ROE]:  'RoE',
        [VERSION.AB]:   'AB',
        [VERSION.SOD]:  'SoD',
        [VERSION.CHR]:  'Chr',
        [VERSION.HOTA]: 'HotA',
        [VERSION.WOG]:  'WoG',
    };

    const TERRAIN = {
        DIRT: 0, SAND: 1, GRASS: 2, SNOW: 3, SWAMP: 4,
        ROUGH: 5, SUBTERRANEAN: 6, LAVA: 7, WATER: 8, ROCK: 9,
        HIGHLANDS: 10, WASTELAND: 11,
    };

    const TERRAIN_NAMES = [
        'Dirt', 'Sand', 'Grass', 'Snow', 'Swamp',
        'Rough', 'Subterranean', 'Lava', 'Water', 'Rock',
        'Highlands', 'Wasteland',
    ];

    // Minimap colors: [unblocked_r,g,b, blocked_r,g,b]
    const TERRAIN_COLORS = [
        [82, 56, 8,    57, 40, 8],     // Dirt
        [222, 207, 140, 165, 158, 107], // Sand
        [0, 65, 0,     0, 48, 0],      // Grass
        [181, 199, 198, 140, 158, 156], // Snow
        [74, 134, 107,  33, 89, 66],    // Swamp
        [132, 113, 49,  99, 81, 33],    // Rough
        [132, 48, 0,    90, 8, 0],      // Subterranean
        [74, 73, 74,    41, 40, 41],    // Lava
        [8, 81, 148,    8, 81, 148],    // Water
        [0, 0, 0,       0, 0, 0],       // Rock
        [105, 100, 48,  68, 64, 32],    // Highlands (HotA)
        [186, 170, 130, 140, 128, 97],  // Wasteland (HotA)
    ];

    const PLAYER_COLORS = [
        [255, 0, 0],      // Red
        [49, 82, 255],     // Blue
        [156, 115, 82],    // Tan
        [66, 148, 41],     // Green
        [255, 132, 0],     // Orange
        [140, 41, 165],    // Purple
        [9, 156, 165],     // Teal
        [198, 123, 140],   // Pink
    ];

    const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Tan', 'Green', 'Orange', 'Purple', 'Teal', 'Pink'];

    const NEUTRAL_COLOR = [132, 132, 132];

    const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Expert', 'Impossible'];

    const TOWN_NAMES_ROE = ['Castle', 'Rampart', 'Tower', 'Inferno', 'Necropolis', 'Dungeon', 'Stronghold', 'Fortress'];
    const TOWN_NAMES_AB  = [...TOWN_NAMES_ROE, 'Conflux'];
    const TOWN_NAMES_HOTA = [...TOWN_NAMES_AB, 'Cove'];
    const TOWN_NAMES_HOTA_FACTORY = [...TOWN_NAMES_HOTA, 'Factory'];

    function getTownNames(ver, hotaSub) {
        if (ver >= VERSION.HOTA) {
            return hotaSub >= 6 ? TOWN_NAMES_HOTA_FACTORY : TOWN_NAMES_HOTA;
        }
        if (ver >= VERSION.AB) return TOWN_NAMES_AB;
        return TOWN_NAMES_ROE;
    }

    const HERO_AI_TYPES = ['No aggression', 'Builder', 'Explorer', 'Warrior', 'Max aggression'];

    // Map victory conditions
    const WIN_COND = {
        NONE: 255,              // Standard
        ACQUIRE_ARTIFACT: 0,
        ACCUMULATE_CREATURES: 1,
        ACCUMULATE_RESOURCES: 2,
        UPGRADE_TOWN: 3,
        BUILD_GRAIL: 4,
        DEFEAT_HERO: 5,
        CAPTURE_TOWN: 6,
        DEFEAT_MONSTER: 7,
        FLAG_DWELLINGS: 8,
        FLAG_MINES: 9,
        TRANSPORT_ARTIFACT: 10,
        ELIMINATE_MONSTERS: 11, // HotA
        SURVIVE_DAYS: 12,       // HotA
    };

    const WIN_COND_NAMES = {
        [WIN_COND.NONE]: 'Standard (defeat all enemies)',
        [WIN_COND.ACQUIRE_ARTIFACT]: 'Acquire artifact',
        [WIN_COND.ACCUMULATE_CREATURES]: 'Accumulate creatures',
        [WIN_COND.ACCUMULATE_RESOURCES]: 'Accumulate resources',
        [WIN_COND.UPGRADE_TOWN]: 'Upgrade town',
        [WIN_COND.BUILD_GRAIL]: 'Build Grail structure',
        [WIN_COND.DEFEAT_HERO]: 'Defeat hero',
        [WIN_COND.CAPTURE_TOWN]: 'Capture town',
        [WIN_COND.DEFEAT_MONSTER]: 'Defeat monster',
        [WIN_COND.FLAG_DWELLINGS]: 'Flag all creature dwellings',
        [WIN_COND.FLAG_MINES]: 'Flag all mines',
        [WIN_COND.TRANSPORT_ARTIFACT]: 'Transport artifact',
        [WIN_COND.ELIMINATE_MONSTERS]: 'Eliminate all monsters',
        [WIN_COND.SURVIVE_DAYS]: 'Survive for N days',
    };

    // Map loss conditions
    const LOSS_COND = {
        NONE: 255,
        LOSE_TOWN: 0,
        LOSE_HERO: 1,
        TIME_LIMIT: 2,
    };

    const LOSS_COND_NAMES = {
        [LOSS_COND.NONE]: 'Standard (lose all towns and heroes)',
        [LOSS_COND.LOSE_TOWN]: 'Lose specific town',
        [LOSS_COND.LOSE_HERO]: 'Lose specific hero',
        [LOSS_COND.TIME_LIMIT]: 'Time limit',
    };

    // Resource names
    const RESOURCE_NAMES = ['Wood', 'Mercury', 'Ore', 'Sulfur', 'Crystal', 'Gems', 'Gold'];

    // Primary skill names
    const PRIMARY_SKILLS = ['Attack', 'Defense', 'Spell Power', 'Knowledge'];

    // Secondary skill names
    const SECONDARY_SKILLS = [
        'Pathfinding', 'Archery', 'Logistics', 'Scouting', 'Diplomacy',
        'Navigation', 'Leadership', 'Wisdom', 'Mysticism', 'Luck',
        'Ballistics', 'Eagle Eye', 'Necromancy', 'Estates', 'Fire Magic',
        'Air Magic', 'Water Magic', 'Earth Magic', 'Scholar', 'Tactics',
        'Artillery', 'Learning', 'Offense', 'Armorer', 'Intelligence',
        'Sorcery', 'Resistance', 'First Aid',
        // HotA
        'Interference',
    ];

    const SECONDARY_SKILL_LEVELS = ['None', 'Basic', 'Advanced', 'Expert'];

    // Object class IDs
    const OBJ = {
        TOWN: 98, RANDOM_TOWN: 77,
        HERO: 34, RANDOM_HERO: 70, PRISON: 62,
        MONSTER: 54, RANDOM_MONSTER: 162, RANDOM_MONSTER_L1: 163,
        RANDOM_MONSTER_L2: 164, RANDOM_MONSTER_L3: 165,
        RANDOM_MONSTER_L4: 166, RANDOM_MONSTER_L5: 167,
        RANDOM_MONSTER_L6: 168, RANDOM_MONSTER_L7: 169,
        MINE: 53,
        GRAIL: 36,
        ARTIFACT: 5, RANDOM_ART: 65, RANDOM_TREASURE: 66,
        RANDOM_MINOR: 67, RANDOM_MAJOR: 68, RANDOM_RELIC: 69,
        PANDORAS_BOX: 6,
        EVENT: 26,
        GARRISON: 33, GARRISON2: 219,
        SIGN: 91, OCEAN_BOTTLE: 92,
        SCHOLAR: 81,
        WITCH_HUT: 113,
        QUEST_GUARD: 215,
        RANDOM_DWELLING: 216, RANDOM_DWELLING_L: 217, RANDOM_DWELLING_LVL: 218,
        SEER_HUT: 83,
        SPELL_SCROLL: 93,
        HERO_PLACEHOLDER: 214,
        RESOURCE: 79, RANDOM_RESOURCE: 76,
        DWELLING: 17, DWELLING_FACTION: 20,
        ABANDONED_MINE: 220,
        CREATURE_BANK: 16,
    };

    // ----------------------------------------------------------------
    // Feature Flags per version (what the format supports)
    // ----------------------------------------------------------------
    function features(ver, hotaSub) {
        const isROE = ver === VERSION.ROE;
        const isAB  = ver >= VERSION.AB;
        const isSOD = ver >= VERSION.SOD;
        const isHOTA = ver >= VERSION.HOTA;

        // Hero count depends on HotA sub-version
        let heroCount = isAB ? 156 : 128;
        if (isHOTA) {
            if (hotaSub >= 7) heroCount = 215;
            else if (hotaSub >= 5) heroCount = 198;
            else if (hotaSub >= 3) heroCount = 179;
            else heroCount = 178;
        }

        // Artifact count depends on version
        let artifactCount = 127;
        if (isAB) artifactCount = 129;
        if (isSOD) artifactCount = 144;
        if (isHOTA) {
            if (hotaSub >= 5) artifactCount = 166;
            else if (hotaSub >= 3) artifactCount = 165;
            else artifactCount = 163;
        }

        return {
            ver, hotaSub,
            isROE, isAB, isSOD, isHOTA,
            levelLimit:      isAB,
            creatureId16:    isAB,    // 2-byte creature IDs (vs 1-byte in RoE)
            artifactId16:    isAB,    // 2-byte artifact IDs
            heroCount,
            artifactCount,
            spellCount:      70,
            townCount:       isHOTA ? (hotaSub >= 6 ? 11 : 10) : (isAB ? 9 : 8),
            secondarySkillCount: isHOTA ? 29 : 28,
            hasConflux:      isAB,
            hasCove:         isHOTA,
            hasFactory:      isHOTA && hotaSub >= 6,
            hasCustomHeroes: isSOD,
            hotaFeatures:    isHOTA,
        };
    }

    // ----------------------------------------------------------------
    // Decompress gzip data (H3M files are gzip-compressed)
    // ----------------------------------------------------------------
    function decompress(data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        // Check for gzip magic
        if (u8[0] === 0x1f && u8[1] === 0x8b) {
            if (typeof pako !== 'undefined') {
                try {
                    return pako.inflate(u8);
                } catch (e) {
                    // Try partial decompression for truncated files
                    try {
                        const inflator = new pako.Inflate();
                        inflator.push(u8, true);
                        if (inflator.result && inflator.result.length > 0) {
                            return inflator.result;
                        }
                    } catch { /* fall through */ }
                    throw e;
                }
            }
            throw new Error('No decompression library available (need pako)');
        }
        // Not compressed, return as-is
        return u8;
    }

    async function decompressAsync(data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (u8[0] === 0x1f && u8[1] === 0x8b) {
            if (typeof pako !== 'undefined') return pako.inflate(u8);
            if (typeof DecompressionStream !== 'undefined') {
                const ds = new DecompressionStream('gzip');
                const writer = ds.writable.getWriter();
                const reader = ds.readable.getReader();
                writer.write(u8);
                writer.close();
                const chunks = [];
                let total = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    total += value.length;
                }
                const result = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { result.set(c, off); off += c.length; }
                return result;
            }
            throw new Error('No decompression available');
        }
        return u8;
    }

    // ----------------------------------------------------------------
    // Reader utility: read allowed bitmask
    // ----------------------------------------------------------------
    function readBitmask(r, byteCount) {
        const bytes = r.bytes(byteCount);
        const result = [];
        for (let i = 0; i < byteCount * 8; i++) {
            result.push(!!(bytes[i >> 3] & (1 << (i & 7))));
        }
        return result;
    }

    // ----------------------------------------------------------------
    // H3M Parser
    // ----------------------------------------------------------------
    function parseH3M(rawData, opts = {}) {
        let data;
        try {
            data = decompress(rawData);
        } catch (e) {
            throw new Error('Failed to decompress H3M: ' + e.message);
        }
        const r = new BinaryReader(data);
        const map = {};
        map._rawCompressedSize = rawData.length;
        map._rawDecompressedSize = data.length;

        // --- Version ---
        map.version = r.u32();
        if (!(map.version in VERSION_NAMES)) {
            // Try treating as unknown but continue
            map.versionName = `Unknown (0x${map.version.toString(16)})`;
            map.versionShort = `v0x${map.version.toString(16)}`;
        } else {
            map.versionName = VERSION_NAMES[map.version];
            map.versionShort = VERSION_SHORT[map.version];
        }

        // HotA sub-version
        map.hotaVersion = 0;
        if (map.version === VERSION.HOTA) {
            map.hotaVersion = r.u32();
            const hv = map.hotaVersion;

            // HotA 8+ has engine version triplet (before mirror/arena!)
            if (hv > 7) {
                map.hotaVersionMajor = r.u32();
                map.hotaVersionMinor = r.u32();
                map.hotaVersionPatch = r.u32();
                map.versionName += ` v${map.hotaVersionMajor}.${map.hotaVersionMinor}.${map.hotaVersionPatch}`;
            } else {
                map.versionName += ` sub${hv}`;
            }

            // HotA 1+ has mirror and arena flags
            if (hv > 0) {
                map.hotaMirror = r.bool();
                map.hotaArena = r.bool();
            }

            // HotA 2+ has terrain types count
            if (hv > 1) {
                map.hotaTerrainTypesCount = r.u32();
            }

            // HotA 5+ has town types count and allowed difficulties
            if (hv > 4) {
                map.hotaTownTypesCount = r.u32();
                map.hotaAllowedDifficulties = r.u8();
            }

            // HotA 7+ has canHireDefeatedHeroes
            if (hv > 6) {
                map.hotaCanHireDefeatedHeroes = r.bool();
            }

            // HotA 8+ has forceMatchingVersion
            if (hv > 7) {
                map.hotaForceMatchingVersion = r.bool();
            }

            // HotA 9+ has unknown int32
            if (hv > 8) {
                map.hotaUnknown9 = r.i32();
            }
        }

        const feat = features(map.version, map.hotaVersion);
        map._features = feat;

        // --- Basic info ---
        map.areAnyPlayers = r.bool();
        map.mapSize = r.u32();
        map.hasUnderground = r.bool();
        map.name = r.str();
        map.description = r.str();
        map.difficulty = r.u8();
        map.difficultyName = DIFFICULTY_NAMES[map.difficulty] || `Unknown (${map.difficulty})`;

        if (feat.levelLimit) {
            map.levelLimit = r.u8();
        }

        // --- Player info ---
        map.players = [];
        for (let i = 0; i < 8; i++) {
            try {
                map.players.push(readPlayerInfo(r, feat, i));
            } catch (e) {
                map.players.push({ id: i, canHumanPlay: false, canComputerPlay: false, parseError: e.message });
            }
        }

        // Count active players
        map.playerCount = map.players.filter(p => p.canHumanPlay || p.canComputerPlay).length;
        map.humanPlayers = map.players.filter(p => p.canHumanPlay);
        map.computerPlayers = map.players.filter(p => p.canComputerPlay && !p.canHumanPlay);

        // --- Victory condition ---
        try {
            map.victoryCondition = readVictoryCondition(r, feat);
        } catch (e) {
            map.victoryCondition = { type: -1, name: 'Parse error', error: e.message };
        }

        // --- Loss condition ---
        try {
            map.lossCondition = readLossCondition(r, feat);
        } catch (e) {
            map.lossCondition = { type: -1, name: 'Parse error', error: e.message };
        }

        // --- Teams ---
        try {
            map.teamCount = r.u8();
            if (map.teamCount > 0) {
                map.teams = [];
                for (let i = 0; i < 8; i++) {
                    map.teams.push(r.u8());
                }
            } else {
                map.teams = null;
            }
        } catch (e) {
            map.teams = null;
        }

        // --- Allowed heroes ---
        try {
            readAllowedHeroes(r, feat, map);
        } catch (e) {
            map._heroParseError = e.message;
        }

        // --- Disposed/placeholder heroes (SoD+) ---
        if (feat.hasCustomHeroes) {
            try {
                readDisposedHeroes(r, feat, map);
            } catch (e) {
                map._disposedHeroError = e.message;
            }
        }

        // --- Map options (31 zero bytes + HotA extensions) ---
        try {
            readMapOptions(r, feat, map);
        } catch (e) {
            map._mapOptionsError = e.message;
        }

        // --- HotA Scripts (v9+ only) ---
        try {
            readHotaScripts(r, feat);
        } catch (e) {
            map._hotaScriptsError = e.message;
        }

        // --- Allowed Artifacts (AB+) ---
        try {
            readAllowedArtifacts(r, feat, map);
        } catch (e) {
            map._allowedArtifactsError = e.message;
        }

        // --- Allowed Spells and Abilities (SoD+) ---
        try {
            readAllowedSpellsAbilities(r, feat, map);
        } catch (e) {
            map._allowedSpellsError = e.message;
        }

        // --- Rumors ---
        try {
            map.rumors = readRumors(r);
        } catch (e) {
            map.rumors = [];
        }

        // --- Hero customizations / Predefined Heroes (SoD+) ---
        if (feat.hasCustomHeroes) {
            try {
                readHeroCustomizations(r, feat, map);
            } catch (e) {
                map._heroCustomError = e.message;
            }
        }

        // --- Terrain ---
        try {
            map.terrain = readTerrain(r, map.mapSize, map.hasUnderground);
        } catch (e) {
            map.terrain = null;
            map._terrainError = e.message;
        }

        // --- Object templates ---
        try {
            map.objectTemplates = readObjectTemplates(r, feat);
        } catch (e) {
            map.objectTemplates = [];
            map._templateError = e.message;
        }

        // --- Objects ---
        try {
            map.objects = readObjects(r, feat, map.objectTemplates);
        } catch (e) {
            map.objects = [];
            map._objectError = e.message;
        }

        // --- Events ---
        try {
            map.events = readMapEvents(r, feat);
        } catch (e) {
            map.events = [];
        }

        // Compute statistics
        map.stats = computeStatistics(map);

        return map;
    }

    // ----------------------------------------------------------------
    // Read Player Info
    // ----------------------------------------------------------------
    function readPlayerInfo(r, feat, playerId) {
        const p = { id: playerId, colorName: PLAYER_COLOR_NAMES[playerId] };
        p.canHumanPlay = r.bool();
        p.canComputerPlay = r.bool();

        if (!p.canHumanPlay && !p.canComputerPlay) {
            // Inactive player — skip fixed amount of bytes
            // RoE always: 6 bytes (aiTactic + factions(1) + isFactionRandom + hasMainTown + hasRandomHero + mainHeroId)
            r.skip(6);
            // AB+: 6 more bytes (factions now 2 bytes = +1, SoD unused = +0 here, extra unknown = +1, heroCount u32 = +4)
            if (feat.isAB) r.skip(6);
            // SoD+: 1 more byte (extra unused "faction selectable" byte)
            if (feat.isSOD || feat.isHOTA) r.skip(1);
            return p;
        }

        // --- Active player ---
        p.aiTactic = r.u8();
        p.aiTacticName = HERO_AI_TYPES[p.aiTactic] || `Custom (${p.aiTactic})`;

        // SoD+: extra unused byte
        if (feat.isSOD || feat.isHOTA) {
            r.skip(1);
        }

        // Allowed factions bitmask
        if (feat.isAB) {
            p.allowedFactions = r.u16();
        } else {
            p.allowedFactions = r.u8();
        }
        p.isFactionRandom = r.bool();

        // Parse which factions are allowed
        p.factions = [];
        const townNames = getTownNames(feat.ver, feat.hotaSub);
        for (let t = 0; t < feat.townCount; t++) {
            if (p.allowedFactions & (1 << t)) {
                p.factions.push(townNames[t] || `Town ${t}`);
            }
        }

        p.hasMainTown = r.bool();
        if (p.hasMainTown) {
            if (feat.isAB) {
                p.generateHeroAtTown = r.bool();
                r.skip(1); // unused town type byte
            }
            p.mainTownX = r.u8();
            p.mainTownY = r.u8();
            p.mainTownZ = r.u8();
        }

        p.hasRandomHero = r.bool();

        // Main hero — ALWAYS u8 (not u16!)
        p.mainHeroId = r.u8();
        if (p.mainHeroId !== 0xFF) {
            p.mainHeroPortrait = r.u8();
            p.mainHeroName = r.str();
        }

        // Additional heroes (AB+ only)
        if (feat.isAB) {
            r.skip(1); // unknown byte
            const heroCount = r.u32();
            p.heroes = [];
            for (let h = 0; h < heroCount; h++) {
                const hero = {};
                hero.id = r.u8(); // hero ID is always u8
                hero.name = r.str();
                p.heroes.push(hero);
            }
        }

        return p;
    }

    // ----------------------------------------------------------------
    // Read Victory Condition
    // ----------------------------------------------------------------
    function readVictoryCondition(r, feat) {
        const type = r.u8();
        const cond = {
            type,
            name: WIN_COND_NAMES[type] || `Unknown (${type})`,
        };

        if (type === 0xFF) return cond; // standard victory

        cond.allowNormalVictory = r.bool();
        cond.appliesToComputer = r.bool();

        switch (type) {
            case WIN_COND.ACQUIRE_ARTIFACT:
                cond.artifactId = feat.isROE ? r.u8() : r.u16();
                break;
            case WIN_COND.ACCUMULATE_CREATURES:
                cond.creatureId = feat.isROE ? r.u8() : r.u16();
                cond.count = r.u32();
                break;
            case WIN_COND.ACCUMULATE_RESOURCES:
                cond.resourceType = r.u8();
                cond.resourceName = RESOURCE_NAMES[cond.resourceType] || `Res ${cond.resourceType}`;
                cond.amount = r.u32();
                break;
            case WIN_COND.UPGRADE_TOWN:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                cond.hallLevel = r.u8();
                cond.castleLevel = r.u8();
                break;
            case WIN_COND.BUILD_GRAIL:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case WIN_COND.DEFEAT_HERO:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case WIN_COND.CAPTURE_TOWN:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case WIN_COND.DEFEAT_MONSTER:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case WIN_COND.FLAG_DWELLINGS:
            case WIN_COND.FLAG_MINES:
                // no extra data
                break;
            case WIN_COND.TRANSPORT_ARTIFACT:
                cond.artifactId = r.u8(); // always 1 byte (readArtifact8)
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case WIN_COND.ELIMINATE_MONSTERS: // HotA
                break;
            case WIN_COND.SURVIVE_DAYS: // HotA
                cond.days = r.u32();
                break;
        }
        return cond;
    }

    // ----------------------------------------------------------------
    // Read Loss Condition
    // ----------------------------------------------------------------
    function readLossCondition(r, feat) {
        const type = r.u8();
        const cond = {
            type,
            name: LOSS_COND_NAMES[type] || `Unknown (${type})`,
        };

        if (type === 0xFF) return cond;

        switch (type) {
            case LOSS_COND.LOSE_TOWN:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case LOSS_COND.LOSE_HERO:
                cond.x = r.u8(); cond.y = r.u8(); cond.z = r.u8();
                break;
            case LOSS_COND.TIME_LIMIT:
                cond.days = r.u16();
                break;
        }
        return cond;
    }

    // ----------------------------------------------------------------
    // Read Allowed Heroes
    // ----------------------------------------------------------------
    function readAllowedHeroes(r, feat, map) {
        if (feat.isHOTA) {
            // HotA: sized bitmask (u32 count + ceil(count/8) bytes)
            const heroCount = r.u32();
            const byteCount = Math.ceil(heroCount / 8);
            map.allowedHeroes = readBitmask(r, byteCount);
        } else if (feat.isAB) {
            map.allowedHeroes = readBitmask(r, 20); // 156 heroes
        } else {
            map.allowedHeroes = readBitmask(r, 16); // 128 heroes (RoE)
        }

        // AB+ has placeholder heroes for campaigns
        if (feat.isAB) {
            const placeholderCount = r.u32();
            map.heroPlaceholders = [];
            for (let i = 0; i < placeholderCount; i++) {
                map.heroPlaceholders.push(r.u8());
            }
        }
    }

    // ----------------------------------------------------------------
    // Read Disposed Heroes (SoD+)
    // ----------------------------------------------------------------
    function readDisposedHeroes(r, feat, map) {
        const count = r.u8();
        map.disposedHeroes = [];
        for (let i = 0; i < count; i++) {
            const hero = {};
            hero.id = r.u8();
            hero.portrait = r.u8();
            hero.name = r.str();
            hero.players = r.u8(); // allowed players bitmask
            map.disposedHeroes.push(hero);
        }
    }

    // ----------------------------------------------------------------
    // Read Map Options (31 zero bytes + HotA extensions)
    // ----------------------------------------------------------------
    function readMapOptions(r, feat, map) {
        r.skip(31); // reserved zero bytes (all versions)

        if (feat.isHOTA) {
            // v0+: special months + padding
            map.hotaAllowSpecialMonths = r.bool();
            r.skip(3);

            // v1+: combined (banned) artifacts bitmask
            if (feat.hotaSub >= 1) {
                const combinedArtCount = r.u32();
                if (combinedArtCount > 0) {
                    const byteCount = Math.ceil(combinedArtCount / 8);
                    map.hotaBannedCombinedArtifacts = readBitmask(r, byteCount);
                }
            }

            // v3+: round limit
            if (feat.hotaSub >= 3) {
                map.hotaRoundLimit = r.i32(); // -1 = no limit
            }

            // v5+: hero recruitment blocked per player
            if (feat.hotaSub >= 5) {
                map.hotaHeroRecruitmentBlocked = [];
                for (let i = 0; i < 8; i++) {
                    map.hotaHeroRecruitmentBlocked.push(r.bool());
                }
            }
        }
    }

    // ----------------------------------------------------------------
    // Read HotA Scripts (v9+ only) - complex recursive event system
    // ----------------------------------------------------------------
    function readHotaScripts(r, feat) {
        if (!feat.isHOTA || feat.hotaSub < 9) return;

        const eventsActive = r.bool();
        if (!eventsActive) return;

        function readExpression() {
            const isExpr = r.bool();
            if (!isExpr) { r.i32(); return; }
            readExpressionInternal();
        }

        function readExpressionInternal() {
            r.bool(); // assert == true
            const code = r.i32();
            switch (code) {
                case 0: r.i32(); break; // INTEGER_VALUE
                case 1: r.i32(); break; // VARIABLE_VALUE
                case 2: r.i32(); readExpression(); break; // NEGATE
                case 3: case 4: case 6: case 7: case 8: // ADD,SUB,MUL,DIV,REM
                    readExpressionInternal(); readExpressionInternal(); break;
                case 5: { // RESOURCE
                    r.u8(); r.i32(); break;
                }
                case 9: r.i32(); break; // CREATURE_COUNT_IN_ARMY
                case 10: break; // CURRENT_DIFFICULTY
                case 11: r.i32(); break; // COMPARE_DIFFICULTY
                case 12: break; // CURRENT_DATE
                case 13: break; // HERO_EXPERIENCE
                case 14: break; // HERO_LEVEL
                case 15: r.i32(); break; // HERO_PRIMARY_SKILL
                case 16: readExpression(); readExpression(); break; // RANDOM_NUMBER
                case 17: r.i32(); r.i32(); break; // HERO_OWNED_ARTIFACTS (artifact32 + spell32)
                default: throw new Error('Unknown HotA expression code: ' + code);
            }
        }

        function readCondition() {
            r.bool(); // assert true
            readConditionInternal();
        }

        function readConditionInternal() {
            const code = r.i32();
            switch (code) {
                case 0: r.bool(); break; // CONSTANT
                case 1: case 2: { // ALL_OF, ANY_OF
                    const cnt = r.i32();
                    for (let i = 0; i < cnt; i++) readConditionInternal();
                    break;
                }
                case 3: case 4: case 5: case 8: case 9: case 10: // comparisons
                    readExpression(); readExpression(); break;
                case 6: readCondition(); break; // NOT
                case 7: r.i32(); r.i32(); break; // HAS_ARTIFACT (artifact32 + spell32)
                case 11: r.i32(); break; // CURRENT_PLAYER
                case 12: r.i32(); r.i32(); break; // HERO_OWNER
                case 14: r.i32(); r.i32(); break; // PLAYER_DEFEATED_MONSTER
                case 15: r.i32(); r.i32(); break; // PLAYER_DEFEATED_HERO
                case 16: r.i32(); r.i32(); break; // HERO_SECONDARY_SKILL
                case 17: r.i32(); break; // PLAYER_DEFEATED
                case 18: r.i32(); r.i32(); break; // PLAYER_OWNS_TOWN
                case 19: r.i32(); break; // PLAYER_IS_HUMAN
                case 20: r.i32(); r.i32(); break; // PLAYER_STARTING_FACTION
                case 21: break; // TOWN_IS_NEUTRAL
                default: throw new Error('Unknown HotA condition code: ' + code);
            }
        }

        function readActions() {
            const unk2 = r.i32(); // event type (assert == 1)
            const unk3 = r.i8(); // assert == 0
            const actionsCount = r.i32();
            for (let j = 0; j < actionsCount; j++) {
                const actionType = r.i32();
                switch (actionType) {
                    case 1: // CONDITIONAL_CHAIN
                        for (;;) {
                            readCondition(); readActions();
                            r.bool(); const more = r.i32();
                            if (more === 0) break;
                        }
                        r.i32();
                        break;
                    case 2: // SET_VARIABLE_CONDITIONAL
                        r.i32(); readCondition(); readExpression(); readExpression();
                        break;
                    case 3: // MODIFY_VARIABLE
                        r.i32(); r.i8(); readExpressionInternal();
                        break;
                    case 4: // RESOURCES
                        r.i8();
                        for (let i = 0; i < 7; i++) readExpression();
                        r.bool();
                        break;
                    case 5: break; // REMOVE_CURRENT_OBJECT
                    case 6: // SHOW_REWARDS_MESSAGE
                        r.str(); readActions();
                        break;
                    case 7: // QUEST_ACTION
                        readCondition(); r.str(); r.str(); r.str(); r.str();
                        readActions(); r.bool();
                        break;
                    case 8: // CREATURES
                        r.bool(); r.i32(); readExpression(); r.bool();
                        break;
                    case 9: // ARTIFACT
                        r.bool(); r.i32(); r.i32(); r.bool();
                        break;
                    case 10: // CONSTRUCT_BUILDING
                        r.i32(); r.i16(); r.i16(); r.bool();
                        break;
                    case 11: { // SET_QUEST_HINT
                        r.str();
                        const numImages = r.i32();
                        for (let i = 0; i < numImages; i++) { r.i32(); r.i32(); readExpression(); }
                        r.bool();
                        break;
                    }
                    case 12: { // SHOW_QUESTION
                        const imageShowType = r.i8();
                        r.str();
                        readActions(); readActions();
                        if (imageShowType === 2) readActions();
                        let numImages = 2;
                        if (imageShowType === 0 || imageShowType === 3) numImages = r.i32();
                        for (let i = 0; i < numImages; i++) { r.i32(); r.i32(); readExpression(); }
                        if (imageShowType === 1 || imageShowType === 2) { r.bool(); r.i32(); }
                        break;
                    }
                    case 13: // CONDITIONAL
                        readCondition(); readActions(); readActions();
                        break;
                    case 14: // CREATURES_TO_HIRE
                        r.i32(); readExpression(); r.i32(); r.bool();
                        break;
                    case 15: // SPELL
                        r.i32(); r.bool();
                        break;
                    case 16: // EXPERIENCE
                        readExpression(); r.bool();
                        break;
                    case 17: // SPELL_POINTS
                        readExpression(); r.i32(); r.bool();
                        break;
                    case 18: // MOVEMENT_POINTS
                        readExpression(); r.i32(); r.bool();
                        break;
                    case 19: // PRIMARY_SKILL
                        readExpression(); r.i32(); r.bool();
                        break;
                    case 20: // SECONDARY_SKILL
                        r.i32(); r.i32(); r.bool();
                        break;
                    case 21: // LUCK
                        r.i32(); r.bool();
                        break;
                    case 22: // MORALE
                        r.i32(); r.bool();
                        break;
                    case 23: // START_COMBAT
                        for (let i = 0; i < 7; i++) { readExpression(); r.i32(); }
                        break;
                    case 24: // EXECUTE_EVENT
                        r.i32(); r.i32();
                        break;
                    case 25: // WAR_MACHINE
                        r.bool(); r.i32(); r.skip(4); r.bool();
                        break;
                    case 26: // SPELLBOOK
                        r.bool(); r.skip(8); r.bool();
                        break;
                    case 27: break; // DISABLE_EVENT
                    case 28: // LOOP_FOR
                        readActions(); readExpression(); readExpression(); r.i32();
                        break;
                    case 29: { // SHOW_MESSAGE
                        r.str();
                        const numImages = r.i32();
                        for (let i = 0; i < numImages; i++) { r.i32(); r.i32(); readExpression(); }
                        break;
                    }
                    default:
                        throw new Error('Unknown HotA script action: ' + actionType);
                }
            }
        }

        function loadEventList() {
            const eventsCount = r.i32();
            for (let i = 0; i < eventsCount; i++) {
                r.i32(); // eventID
                readActions();
                r.str(); // eventName
            }
        }

        function loadEventMap() {
            const mappingSize = r.i32();
            for (let i = 0; i < mappingSize; i++) r.i32();
        }

        // 4 event lists: hero, player, town, quest
        loadEventList();
        loadEventList();
        loadEventList();
        loadEventList();

        // Next IDs
        r.i32(); r.i32(); r.i32(); r.i32(); r.i32();

        // Variables
        const varsCount = r.i32();
        for (let i = 0; i < varsCount; i++) {
            r.i32(); // uniqueID
            r.str(); // variableID
            r.bool(); // save in campaign?
            r.bool(); // import from prev map?
            r.i32(); // initial value
        }

        // 5 event maps: hero, player, town, quest, variable
        loadEventMap();
        loadEventMap();
        loadEventMap();
        loadEventMap();
        loadEventMap();
    }

    // ----------------------------------------------------------------
    // Read Allowed Artifacts (AB+)
    // ----------------------------------------------------------------
    function readAllowedArtifacts(r, feat, map) {
        if (feat.isROE) return; // RoE has no allowed artifacts block

        if (feat.isHOTA) {
            // HotA: sized bitmask
            const artCount = r.u32();
            const byteCount = Math.ceil(artCount / 8);
            map.allowedArtifacts = readBitmask(r, byteCount);
        } else if (feat.isSOD) {
            map.allowedArtifacts = readBitmask(r, 18); // 144 artifacts
        } else {
            map.allowedArtifacts = readBitmask(r, 17); // 129 artifacts (AB)
        }
    }

    // ----------------------------------------------------------------
    // Read Allowed Spells and Abilities (SoD+)
    // ----------------------------------------------------------------
    function readAllowedSpellsAbilities(r, feat, map) {
        if (!feat.isSOD) return; // RoE and AB have no spells/abilities block

        map.allowedSpells = readBitmask(r, 9);   // 70 spells
        map.allowedAbilities = readBitmask(r, 4); // 28-30 secondary skills
    }

    // ----------------------------------------------------------------
    // Read Rumors
    // ----------------------------------------------------------------
    function readRumors(r) {
        const count = r.u32();
        const rumors = [];
        for (let i = 0; i < count; i++) {
            const name = r.str();
            const text = r.str();
            rumors.push({ name, text });
        }
        return rumors;
    }

    // ----------------------------------------------------------------
    // Read Hero Customizations / Predefined Heroes (SoD+)
    // ----------------------------------------------------------------
    function readHeroCustomizations(r, feat, map) {
        map.heroCustomizations = [];

        // HotA: read hero count as u32; SoD: fixed 156
        const heroCount = feat.isHOTA ? r.u32() : 156;

        for (let i = 0; i < heroCount; i++) {
            const hasCustom = r.bool();
            if (!hasCustom) continue;
            const hero = { id: i };
            const hasExp = r.bool();
            if (hasExp) hero.experience = r.u32();

            const hasSecondary = r.bool();
            if (hasSecondary) {
                const cnt = r.u32();
                hero.secondarySkills = [];
                for (let s = 0; s < cnt; s++) {
                    const skillId = r.u8();
                    const skillLvl = r.u8();
                    hero.secondarySkills.push({
                        id: skillId,
                        name: SECONDARY_SKILLS[skillId] || `Skill ${skillId}`,
                        level: SECONDARY_SKILL_LEVELS[skillLvl] || `Lvl ${skillLvl}`,
                    });
                }
            }

            const hasArtifacts = r.bool();
            if (hasArtifacts) {
                readHeroArtifacts(r, feat);
            }

            const hasBio = r.bool();
            if (hasBio) hero.biography = r.str();

            hero.gender = r.i8();

            const hasSpells = r.bool();
            if (hasSpells) {
                hero.spells = readBitmask(r, 9);
            }

            const hasPrimary = r.bool();
            if (hasPrimary) {
                hero.primarySkills = [];
                for (let ps = 0; ps < 4; ps++) {
                    hero.primarySkills.push(r.u8());
                }
            }

            map.heroCustomizations.push(hero);
        }

        // HotA v5+: per-hero extra fields after the main loop
        if (feat.isHOTA && feat.hotaSub >= 5) {
            for (let i = 0; i < heroCount; i++) {
                r.bool(); // alwaysAddSkills
                r.bool(); // cannotGainXP
                r.i32();  // level
            }
        }
    }

    // ----------------------------------------------------------------
    // Read Hero Artifacts
    // ----------------------------------------------------------------
    function readHeroArtifacts(r, feat) {
        // Equipment slots: RoE has 18, SoD+ has 19 (added Spellbook slot)
        // Slots: Head, Shoulders, Neck, RHand, LHand, Torso, RRing, LRing, Feet,
        //        Misc1-5, Ballista, AmmoCart, FirstAid, Catapult = 18 (RoE)
        //        + Spellbook = 19 (SoD+)
        const equipSlots = feat.isSOD ? 19 : 18;
        for (let i = 0; i < equipSlots; i++) {
            readArtifactSlot(r, feat);
        }
        // Backpack
        const backpackCount = r.u16();
        for (let i = 0; i < backpackCount; i++) {
            readArtifactSlot(r, feat);
        }
    }

    // Read artifact in an equipment/backpack slot (HotA v5+ has extra scroll spell ID)
    function readArtifactSlot(r, feat) {
        if (feat.isROE) return r.u8();
        const id = r.u16();
        // HotA v5+: every artifact slot has an extra 2B scroll spell ID
        if (feat.isHOTA && feat.hotaSub >= 5) {
            r.u16(); // scroll spell ID (0xFFFF = none)
        }
        return id;
    }

    // Read artifact ID (in quests, rewards, etc. — no extra scroll bytes)
    function readArtifactId(r, feat) {
        if (feat.isROE) return r.u8();
        return r.u16();
    }

    // ----------------------------------------------------------------
    // Read Terrain
    // ----------------------------------------------------------------
    function readTerrain(r, mapSize, hasUnderground) {
        const levels = hasUnderground ? 2 : 1;
        const terrain = [];

        for (let z = 0; z < levels; z++) {
            const level = [];
            for (let y = 0; y < mapSize; y++) {
                const row = [];
                for (let x = 0; x < mapSize; x++) {
                    const tile = {
                        terrain: r.u8(),
                        terrainSubtype: r.u8(),
                        river: r.u8(),
                        riverDir: r.u8(),
                        road: r.u8(),
                        roadDir: r.u8(),
                        flags: r.u8(),
                    };
                    row.push(tile);
                }
                level.push(row);
            }
            terrain.push(level);
        }
        return terrain;
    }

    // ----------------------------------------------------------------
    // Read Object Templates (DEF entries)
    // ----------------------------------------------------------------
    function readObjectTemplates(r, feat) {
        const count = r.u32();
        const templates = [];
        for (let i = 0; i < count; i++) {
            const t = {};
            t.animFile = r.str();
            t.blockMask = r.bytes(6);
            t.visitMask = r.bytes(6);
            t.terrainMask = r.u16();
            t.terrainMask2 = feat.isHOTA ? r.u16() : 0;
            t.objClass = r.u32();
            t.objSubID = r.u32();
            t.type = r.u8();
            t.printPriority = r.u8();
            r.skip(16); // padding
            templates.push(t);
        }
        return templates;
    }

    // ----------------------------------------------------------------
    // Read Objects
    // ----------------------------------------------------------------
    function readObjects(r, feat, templates) {
        const count = r.u32();
        const objects = [];

        for (let i = 0; i < count; i++) {
            const obj = {};
            obj.x = r.u8();
            obj.y = r.u8();
            obj.z = r.u8();
            obj.templateIdx = r.u32();

            if (obj.templateIdx < templates.length) {
                const tmpl = templates[obj.templateIdx];
                obj.objClass = tmpl.objClass;
                obj.objSubID = tmpl.objSubID;
                obj.animFile = tmpl.animFile;
            } else {
                obj.objClass = -1;
                obj.objSubID = -1;
            }

            // Skip unknown 5 bytes
            r.skip(5);

            // Read object-specific data based on object class
            try {
                readObjectData(r, feat, obj);
            } catch (e) {
                obj._parseError = e.message;
                // Try to continue but may fail for subsequent objects
                objects.push(obj);
                break; // can't reliably continue after a parse error
            }

            objects.push(obj);
        }
        return objects;
    }

    // ----------------------------------------------------------------
    // Read individual object data (complex per-type parsing)
    // ----------------------------------------------------------------
    function readObjectData(r, feat, obj) {
        switch (obj.objClass) {
            case OBJ.TOWN: case OBJ.RANDOM_TOWN:
                readTownObject(r, feat, obj);
                break;
            case OBJ.HERO: case OBJ.RANDOM_HERO: case OBJ.PRISON:
                readHeroObject(r, feat, obj);
                break;
            case OBJ.MONSTER: case OBJ.RANDOM_MONSTER:
            case OBJ.RANDOM_MONSTER_L1: case OBJ.RANDOM_MONSTER_L2:
            case OBJ.RANDOM_MONSTER_L3: case OBJ.RANDOM_MONSTER_L4:
            case OBJ.RANDOM_MONSTER_L5: case OBJ.RANDOM_MONSTER_L6:
            case OBJ.RANDOM_MONSTER_L7:
                readMonsterObject(r, feat, obj);
                break;
            case OBJ.SIGN: case OBJ.OCEAN_BOTTLE:
                readSignObject(r, feat, obj);
                break;
            case OBJ.SEER_HUT:
                readSeerHutObject(r, feat, obj);
                break;
            case OBJ.WITCH_HUT:
                readWitchHutObject(r, feat, obj);
                break;
            case OBJ.SCHOLAR:
                readScholarObject(r, feat, obj);
                break;
            case OBJ.GARRISON: case OBJ.GARRISON2:
                readGarrisonObject(r, feat, obj);
                break;
            case OBJ.ARTIFACT: case OBJ.RANDOM_ART:
            case OBJ.RANDOM_TREASURE: case OBJ.RANDOM_MINOR:
            case OBJ.RANDOM_MAJOR: case OBJ.RANDOM_RELIC:
            case OBJ.SPELL_SCROLL:
                readArtifactObject(r, feat, obj);
                break;
            case OBJ.RESOURCE: case OBJ.RANDOM_RESOURCE:
                readResourceObject(r, feat, obj);
                break;
            case OBJ.QUEST_GUARD:
                readQuestGuardObject(r, feat, obj);
                break;
            case OBJ.PANDORAS_BOX:
                readPandorasBoxObject(r, feat, obj);
                break;
            case OBJ.EVENT:
                readEventObject(r, feat, obj);
                break;
            case OBJ.GRAIL:
                readGrailObject(r, feat, obj);
                break;
            case OBJ.RANDOM_DWELLING:
            case OBJ.RANDOM_DWELLING_L:
            case OBJ.RANDOM_DWELLING_LVL:
                readRandomDwellingObject(r, feat, obj);
                break;
            case OBJ.HERO_PLACEHOLDER:
                readHeroPlaceholderObject(r, feat, obj);
                break;
            case OBJ.ABANDONED_MINE:
                if (feat.isHOTA) r.skip(4); // resource bitmask
                break;
            default:
                // No extra data for most objects
                break;
        }
    }

    // ----------------------------------------------------------------
    // Town Object
    // ----------------------------------------------------------------
    function readTownObject(r, feat, obj) {
        if (feat.isAB) {
            obj.identifier = r.u32();
        }
        obj.owner = r.u8();
        obj.ownerName = obj.owner < 8 ? PLAYER_COLOR_NAMES[obj.owner] : 'Neutral';

        const hasName = r.bool();
        if (hasName) obj.townName = r.str();

        const hasGarrison = r.bool();
        if (hasGarrison) readCreatureSet(r, feat, 7);

        obj.formation = r.u8();

        const hasBuildings = r.bool();
        if (hasBuildings) {
            r.skip(6); // built buildings bitmask (48 bits)
            r.skip(6); // forbidden buildings bitmask (48 bits)
        } else {
            r.skip(1); // hasFort
        }

        if (feat.isAB) {
            // Obligatory spells
            r.skip(9);
        }
        // Possible spells
        if (feat.isSOD || feat.isHOTA) {
            r.skip(9);
        }

        // Town events
        const eventCount = r.u32();
        for (let e = 0; e < eventCount; e++) {
            readTownEvent(r, feat);
        }

        if (feat.isSOD || feat.isHOTA) {
            obj.alignment = r.u8(); // town alignment
        }

        r.skip(3); // padding
    }

    function readTownEvent(r, feat) {
        r.str(); // name
        r.str(); // message
        // resources
        for (let i = 0; i < 7; i++) r.i32();
        r.skip(1); // players
        if (feat.isSOD || feat.isHOTA) r.skip(1); // humanAffected
        r.skip(1); // computerAffected
        r.u16(); // firstOccurrence
        r.u8(); // nextOccurrence
        r.skip(17); // padding
        // buildings
        r.skip(6);
        // creatures
        for (let i = 0; i < 7; i++) r.u16();
        r.skip(4); // padding
    }

    // ----------------------------------------------------------------
    // Hero Object
    // ----------------------------------------------------------------
    function readHeroObject(r, feat, obj) {
        if (feat.isAB) {
            obj.identifier = r.u32();
        }
        obj.owner = r.u8();
        obj.ownerName = obj.owner < 8 ? PLAYER_COLOR_NAMES[obj.owner] : 'Neutral';
        obj.heroType = r.u8();

        const hasName = r.bool();
        if (hasName) obj.heroName = r.str();

        if (feat.isSOD || feat.isHOTA) {
            const hasExp = r.bool();
            if (hasExp) obj.experience = r.u32();
        } else {
            obj.experience = r.u32();
        }

        const hasPortrait = r.bool();
        if (hasPortrait) obj.portrait = r.u8();

        const hasSecondary = r.bool();
        if (hasSecondary) {
            const cnt = r.u32();
            obj.secondarySkills = [];
            for (let s = 0; s < cnt; s++) {
                const id = r.u8();
                const lvl = r.u8();
                obj.secondarySkills.push({
                    id, level: lvl,
                    name: SECONDARY_SKILLS[id] || `Skill ${id}`,
                    levelName: SECONDARY_SKILL_LEVELS[lvl] || `Lvl ${lvl}`,
                });
            }
        }

        const hasGarrison = r.bool();
        if (hasGarrison) readCreatureSet(r, feat, 7);

        obj.formation = r.u8();

        const hasArtifacts = r.bool();
        if (hasArtifacts) readHeroArtifacts(r, feat);

        obj.patrolRadius = r.u8();

        if (feat.isAB) {
            const hasBio = r.bool();
            if (hasBio) obj.biography = r.str();
            obj.gender = r.u8();
        }

        if (feat.isSOD || feat.isHOTA) {
            const hasSpells = r.bool();
            if (hasSpells) r.skip(9); // spell bitmask
        } else if (feat.isAB) {
            r.skip(1); // spell byte
        }

        if (feat.isSOD || feat.isHOTA) {
            const hasPrimary = r.bool();
            if (hasPrimary) {
                for (let i = 0; i < 4; i++) r.u8();
            }
        }

        r.skip(16); // padding
    }

    // ----------------------------------------------------------------
    // Monster Object
    // ----------------------------------------------------------------
    function readMonsterObject(r, feat, obj) {
        if (feat.isAB) {
            obj.identifier = r.u32();
        }
        obj.count = r.u16();
        obj.disposition = r.u8();

        const hasMessage = r.bool();
        if (hasMessage) {
            obj.message = r.str();
            // resources
            for (let i = 0; i < 7; i++) r.i32();
            readArtifactId(r, feat);
        }
        obj.neverFlees = r.bool();
        obj.doesNotGrow = r.bool();
        r.skip(2); // padding
    }

    // ----------------------------------------------------------------
    // Sign / Ocean Bottle
    // ----------------------------------------------------------------
    function readSignObject(r, feat, obj) {
        obj.message = r.str();
        r.skip(4); // padding
    }

    // ----------------------------------------------------------------
    // Seer Hut
    // ----------------------------------------------------------------
    function readSeerHutObject(r, feat, obj) {
        if (feat.isROE) {
            const questArtifact = r.u8();
            if (questArtifact !== 0xFF) {
                readSeerReward(r, feat, obj);
            }
            return;
        }

        // AB+
        readQuest(r, feat, obj);

        const deadline = r.u32();
        readSeerReward(r, feat, obj);
        r.skip(2); // padding
    }

    function readSeerReward(r, feat, obj) {
        const rewardType = r.u8();
        obj.rewardType = rewardType;
        switch (rewardType) {
            case 0: break; // nothing
            case 1: obj.rewardExperience = r.u32(); break;
            case 2: obj.rewardManaPoints = r.u32(); break;
            case 3: obj.rewardMorale = r.u8(); break;
            case 4: obj.rewardLuck = r.u8(); break;
            case 5: r.skip(1 + 4); break; // resource
            case 6: r.skip(1 + 1); break; // primary skill
            case 7: r.skip(1 + 1); break; // secondary skill
            case 8: readArtifactId(r, feat); break;
            case 9: r.skip(1); break; // spell
            case 10: // creature
                if (feat.isROE) { r.skip(1 + 2); }
                else { r.skip(2 + 2); }
                break;
        }
    }

    // ----------------------------------------------------------------
    // Quest
    // ----------------------------------------------------------------
    function readQuest(r, feat, obj) {
        const missionType = r.u8();
        switch (missionType) {
            case 0: break;
            case 1: r.skip(4); break; // level
            case 2: r.skip(4 * 4); break; // primary skills
            case 3: // defeat hero
                r.skip(4); break;
            case 4: // defeat monster
                r.skip(4); break;
            case 5: { // artifacts
                const cnt = r.u8();
                for (let i = 0; i < cnt; i++) readArtifactId(r, feat);
                break;
            }
            case 6: { // creatures
                const cnt = r.u8();
                for (let i = 0; i < cnt; i++) {
                    if (feat.isROE) r.skip(1 + 2);
                    else r.skip(2 + 2);
                }
                break;
            }
            case 7: { // resources
                for (let i = 0; i < 7; i++) r.i32();
                break;
            }
            case 8: r.skip(1); break; // hero
            case 9: r.skip(1); break; // player
        }
        if (missionType > 0) {
            r.u32(); // limit/deadline
            r.str(); // first visit text
            r.str(); // next visit text
            r.str(); // completed text
        }
    }

    // ----------------------------------------------------------------
    // Witch Hut
    // ----------------------------------------------------------------
    function readWitchHutObject(r, feat, obj) {
        if (feat.isSOD || feat.isHOTA) {
            r.skip(4); // allowed skills bitmask
        }
    }

    // ----------------------------------------------------------------
    // Scholar
    // ----------------------------------------------------------------
    function readScholarObject(r, feat, obj) {
        obj.scholarBonus = r.u8();
        obj.scholarValue = r.u8();
        r.skip(6); // padding
    }

    // ----------------------------------------------------------------
    // Garrison
    // ----------------------------------------------------------------
    function readGarrisonObject(r, feat, obj) {
        obj.owner = r.u8();
        r.skip(3); // padding
        readCreatureSet(r, feat, 7);
        if (feat.isAB) {
            obj.removableUnits = r.bool();
        }
        r.skip(8); // padding
    }

    // ----------------------------------------------------------------
    // Artifact Object
    // ----------------------------------------------------------------
    function readArtifactObject(r, feat, obj) {
        const hasMessage = r.bool();
        if (hasMessage) {
            obj.message = r.str();
            const hasGuard = r.bool();
            if (hasGuard) readCreatureSet(r, feat, 7);
            r.skip(4); // padding
        }
        if (obj.objClass === OBJ.SPELL_SCROLL) {
            obj.spellId = r.u32();
        }
    }

    // ----------------------------------------------------------------
    // Resource Object
    // ----------------------------------------------------------------
    function readResourceObject(r, feat, obj) {
        const hasMessage = r.bool();
        if (hasMessage) {
            obj.message = r.str();
            const hasGuard = r.bool();
            if (hasGuard) readCreatureSet(r, feat, 7);
            r.skip(4); // padding
        }
        obj.amount = r.u32();
        r.skip(4); // padding
    }

    // ----------------------------------------------------------------
    // Quest Guard
    // ----------------------------------------------------------------
    function readQuestGuardObject(r, feat, obj) {
        readQuest(r, feat, obj);
    }

    // ----------------------------------------------------------------
    // Pandora's Box
    // ----------------------------------------------------------------
    function readPandorasBoxObject(r, feat, obj) {
        const hasMessage = r.bool();
        if (hasMessage) {
            obj.message = r.str();
            const hasGuard = r.bool();
            if (hasGuard) readCreatureSet(r, feat, 7);
            r.skip(4); // padding
        }
        // Experience
        obj.gainedExp = r.u32();
        obj.manaChange = r.i32();
        obj.moraleChange = r.i8();
        obj.luckChange = r.i8();
        // Resources
        for (let i = 0; i < 7; i++) r.i32();
        // Primary skills
        for (let i = 0; i < 4; i++) r.u8();
        // Secondary skills
        const secCount = r.u8();
        for (let i = 0; i < secCount; i++) {
            r.skip(2); // skillId + level
        }
        // Artifacts
        const artCount = r.u8();
        for (let i = 0; i < artCount; i++) readArtifactId(r, feat);
        // Spells
        const spellCount = r.u8();
        for (let i = 0; i < spellCount; i++) r.u8();
        // Creatures
        const creatureCount = r.u8();
        for (let i = 0; i < creatureCount; i++) {
            if (feat.isROE) r.skip(1 + 2);
            else r.skip(2 + 2);
        }
        r.skip(8); // padding
    }

    // ----------------------------------------------------------------
    // Event Object
    // ----------------------------------------------------------------
    function readEventObject(r, feat, obj) {
        // Same as Pandora's but with extra fields
        readPandorasBoxObject(r, feat, obj);
        obj.eventPlayers = r.u8();
        obj.isComputerActive = r.bool();
        obj.removeAfterVisit = r.bool();
        r.skip(4); // padding
    }

    // ----------------------------------------------------------------
    // Grail Object
    // ----------------------------------------------------------------
    function readGrailObject(r, feat, obj) {
        obj.grailRadius = r.u32();
    }

    // ----------------------------------------------------------------
    // Random Dwelling
    // ----------------------------------------------------------------
    function readRandomDwellingObject(r, feat, obj) {
        obj.owner = r.u32();
        if (obj.objClass === OBJ.RANDOM_DWELLING) {
            obj.identifier = r.u32();
            if (obj.identifier === 0) {
                obj.factionMask = feat.isROE ? r.u8() : r.u16();
            }
        }
        if (obj.objClass === OBJ.RANDOM_DWELLING || obj.objClass === OBJ.RANDOM_DWELLING_L) {
            obj.minLevel = r.u8();
            obj.maxLevel = r.u8();
        }
    }

    // ----------------------------------------------------------------
    // Hero Placeholder (SoD+)
    // ----------------------------------------------------------------
    function readHeroPlaceholderObject(r, feat, obj) {
        obj.owner = r.u8();
        obj.heroTypeId = r.u8();
        if (obj.heroTypeId === 0xFF) {
            obj.power = r.u8();
        }
    }

    // ----------------------------------------------------------------
    // Read Creature Set
    // ----------------------------------------------------------------
    function readCreatureSet(r, feat, slots) {
        const creatures = [];
        for (let i = 0; i < slots; i++) {
            const creatureId = feat.isROE ? r.u8() : r.u16();
            const count = r.u16();
            creatures.push({ id: creatureId, count });
        }
        return creatures;
    }

    // ----------------------------------------------------------------
    // Read Map Events
    // ----------------------------------------------------------------
    function readMapEvents(r, feat) {
        const count = r.u32();
        const events = [];
        for (let i = 0; i < count; i++) {
            const ev = {};
            ev.name = r.str();
            ev.message = r.str();
            for (let j = 0; j < 7; j++) r.i32(); // resources
            ev.players = r.u8();
            if (feat.isSOD || feat.isHOTA) ev.humanAffected = r.u8();
            ev.computerAffected = r.u8();
            ev.firstOccurrence = r.u16();
            ev.nextOccurrence = r.u8();
            r.skip(17); // padding
            events.push(ev);
        }
        return events;
    }

    // ----------------------------------------------------------------
    // Compute Statistics
    // ----------------------------------------------------------------
    function computeStatistics(map) {
        const stats = {};

        // Terrain distribution
        if (map.terrain) {
            stats.terrainCounts = {};
            stats.terrainCountsByLevel = [];
            for (let z = 0; z < map.terrain.length; z++) {
                const levelCounts = {};
                for (let y = 0; y < map.mapSize; y++) {
                    for (let x = 0; x < map.mapSize; x++) {
                        const tile = map.terrain[z][y][x];
                        const name = TERRAIN_NAMES[tile.terrain] || `Unknown(${tile.terrain})`;
                        stats.terrainCounts[name] = (stats.terrainCounts[name] || 0) + 1;
                        levelCounts[name] = (levelCounts[name] || 0) + 1;
                    }
                }
                stats.terrainCountsByLevel.push(levelCounts);
            }

            // Road/river stats
            stats.roadTiles = 0;
            stats.riverTiles = 0;
            for (let z = 0; z < map.terrain.length; z++) {
                for (let y = 0; y < map.mapSize; y++) {
                    for (let x = 0; x < map.mapSize; x++) {
                        const tile = map.terrain[z][y][x];
                        if (tile.road > 0) stats.roadTiles++;
                        if (tile.river > 0) stats.riverTiles++;
                    }
                }
            }
        }

        // Object counts
        if (map.objects) {
            stats.objectCount = map.objects.length;
            stats.objectsByClass = {};
            stats.towns = [];
            stats.heroes = [];
            stats.monsters = [];
            stats.mines = [];
            stats.artifacts = [];

            for (const obj of map.objects) {
                const cls = obj.objClass;
                const clsName = getObjectClassName(cls);
                stats.objectsByClass[clsName] = (stats.objectsByClass[clsName] || 0) + 1;

                if (cls === OBJ.TOWN || cls === OBJ.RANDOM_TOWN) {
                    stats.towns.push(obj);
                } else if (cls === OBJ.HERO || cls === OBJ.RANDOM_HERO || cls === OBJ.PRISON) {
                    stats.heroes.push(obj);
                } else if (isMonsterObj(cls)) {
                    stats.monsters.push(obj);
                } else if (cls === OBJ.MINE) {
                    stats.mines.push(obj);
                } else if (isArtifactObj(cls)) {
                    stats.artifacts.push(obj);
                }
            }

            // Towns per player
            stats.townsPerPlayer = {};
            for (const t of stats.towns) {
                const owner = t.owner !== undefined && t.owner < 8 ? PLAYER_COLOR_NAMES[t.owner] : 'Neutral';
                stats.townsPerPlayer[owner] = (stats.townsPerPlayer[owner] || 0) + 1;
            }

            // Heroes per player
            stats.heroesPerPlayer = {};
            for (const h of stats.heroes) {
                const owner = h.owner !== undefined && h.owner < 8 ? PLAYER_COLOR_NAMES[h.owner] : 'Neutral';
                stats.heroesPerPlayer[owner] = (stats.heroesPerPlayer[owner] || 0) + 1;
            }
        }

        return stats;
    }

    function isMonsterObj(cls) {
        return cls === OBJ.MONSTER || cls === OBJ.RANDOM_MONSTER ||
            (cls >= OBJ.RANDOM_MONSTER_L1 && cls <= OBJ.RANDOM_MONSTER_L7);
    }

    function isArtifactObj(cls) {
        return cls === OBJ.ARTIFACT || cls === OBJ.RANDOM_ART ||
            cls === OBJ.RANDOM_TREASURE || cls === OBJ.RANDOM_MINOR ||
            cls === OBJ.RANDOM_MAJOR || cls === OBJ.RANDOM_RELIC ||
            cls === OBJ.SPELL_SCROLL;
    }

    function getObjectClassName(cls) {
        const names = {
            [OBJ.TOWN]: 'Town', [OBJ.RANDOM_TOWN]: 'Random Town',
            [OBJ.HERO]: 'Hero', [OBJ.RANDOM_HERO]: 'Random Hero', [OBJ.PRISON]: 'Prison',
            [OBJ.MONSTER]: 'Monster', [OBJ.RANDOM_MONSTER]: 'Random Monster',
            [OBJ.MINE]: 'Mine', [OBJ.GRAIL]: 'Grail',
            [OBJ.ARTIFACT]: 'Artifact', [OBJ.RANDOM_ART]: 'Random Artifact',
            [OBJ.RANDOM_TREASURE]: 'Random Treasure', [OBJ.RANDOM_MINOR]: 'Random Minor Art.',
            [OBJ.RANDOM_MAJOR]: 'Random Major Art.', [OBJ.RANDOM_RELIC]: 'Random Relic',
            [OBJ.PANDORAS_BOX]: "Pandora's Box", [OBJ.EVENT]: 'Event',
            [OBJ.SIGN]: 'Sign', [OBJ.OCEAN_BOTTLE]: 'Ocean Bottle',
            [OBJ.GARRISON]: 'Garrison', [OBJ.GARRISON2]: 'Garrison',
            [OBJ.SEER_HUT]: 'Seer Hut', [OBJ.WITCH_HUT]: 'Witch Hut',
            [OBJ.SCHOLAR]: 'Scholar', [OBJ.QUEST_GUARD]: 'Quest Guard',
            [OBJ.RESOURCE]: 'Resource', [OBJ.RANDOM_RESOURCE]: 'Random Resource',
            [OBJ.SPELL_SCROLL]: 'Spell Scroll',
            [OBJ.RANDOM_DWELLING]: 'Random Dwelling',
            [OBJ.RANDOM_DWELLING_L]: 'Random Dwelling (lvl)',
            [OBJ.RANDOM_DWELLING_LVL]: 'Random Dwelling (faction)',
            [OBJ.HERO_PLACEHOLDER]: 'Hero Placeholder',
            [OBJ.ABANDONED_MINE]: 'Abandoned Mine',
            [OBJ.CREATURE_BANK]: 'Creature Bank',
            [OBJ.DWELLING]: 'Dwelling',
            [OBJ.DWELLING_FACTION]: 'Dwelling (faction)',
        };
        return names[cls] || `Object ${cls}`;
    }

    // ----------------------------------------------------------------
    // Minimap rendering
    // ----------------------------------------------------------------
    function renderMinimap(map, level = 0, scale = 1) {
        if (!map.terrain || !map.terrain[level]) return null;

        const size = map.mapSize;
        const pixelSize = size * scale;
        const canvas = document.createElement('canvas');
        canvas.width = pixelSize;
        canvas.height = pixelSize;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(pixelSize, pixelSize);
        const pixels = imgData.data;

        // Build object ownership map for towns/mines
        const ownerMap = new Map(); // "x,y,z" -> ownerIdx
        if (map.objects) {
            for (const obj of map.objects) {
                if (obj.owner !== undefined && obj.owner < 8 && obj.z === level) {
                    if (obj.objClass === OBJ.TOWN || obj.objClass === OBJ.RANDOM_TOWN ||
                        obj.objClass === OBJ.MINE || obj.objClass === OBJ.HERO ||
                        obj.objClass === OBJ.RANDOM_HERO) {
                        ownerMap.set(`${obj.x},${obj.y}`, obj.owner);
                    }
                }
            }
        }

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const tile = map.terrain[level][y][x];
                let r, g, b;

                // Check for owned object at this tile
                const ownerKey = `${x},${y}`;
                if (ownerMap.has(ownerKey)) {
                    const color = PLAYER_COLORS[ownerMap.get(ownerKey)];
                    [r, g, b] = color;
                } else {
                    // Use terrain color
                    const tIdx = tile.terrain;
                    const colors = TERRAIN_COLORS[tIdx] || TERRAIN_COLORS[0];
                    // Check if tile is road/visited (unblocked) or blocked
                    const isBlocked = (tile.flags & 0x01) !== 0;
                    if (isBlocked) {
                        r = colors[3]; g = colors[4]; b = colors[5];
                    } else {
                        r = colors[0]; g = colors[1]; b = colors[2];
                    }

                    // Highlight roads slightly
                    if (tile.road > 0) {
                        r = Math.min(255, r + 20);
                        g = Math.min(255, g + 15);
                        b = Math.min(255, b + 10);
                    }
                }

                // Fill scaled pixels
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        const pi = ((y * scale + sy) * pixelSize + (x * scale + sx)) * 4;
                        pixels[pi] = r;
                        pixels[pi + 1] = g;
                        pixels[pi + 2] = b;
                        pixels[pi + 3] = 255;
                    }
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);
        return canvas;
    }

    // ----------------------------------------------------------------
    // H3C Campaign Parser
    // ----------------------------------------------------------------
    const CAMPAIGN_VERSIONS = {
        4: 'RoE', 5: 'AB', 6: 'SoD', 7: 'Chronicles', 10: 'HotA',
    };

    async function parseH3C(rawData) {
        // H3C files are concatenated gzip blocks.
        // Block 0 = campaign header (scenario definitions)
        // Block 1..N = embedded H3M maps (raw H3M binary, not re-compressed)

        const u8 = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
        const blocks = splitGzipBlocks(u8);

        if (blocks.length === 0) throw new Error('No gzip blocks found in H3C file');

        // Decompress all blocks
        const decompressed = [];
        for (const block of blocks) {
            try {
                const dec = await decompressAsync(block);
                decompressed.push(dec);
            } catch (e) {
                decompressed.push(null);
            }
        }

        // Parse campaign header from first block
        const headerData = decompressed[0];
        if (!headerData) throw new Error('Failed to decompress campaign header');

        const campaign = {};
        const r = new BinaryReader(headerData);

        campaign.version = r.u32();
        campaign.versionName = CAMPAIGN_VERSIONS[campaign.version] || `Unknown (${campaign.version})`;
        const ver = campaign.version;
        const isHotA = ver === 10;

        // HotA-specific header fields
        if (isHotA) {
            campaign.hotaFormatVersion = r.i32();
            if (campaign.hotaFormatVersion === 2) {
                campaign.hotaVersionMajor = r.u32();
                campaign.hotaVersionMinor = r.u32();
                campaign.hotaVersionPatch = r.u32();
                campaign.versionName += ` v${campaign.hotaVersionMajor}.${campaign.hotaVersionMinor}.${campaign.hotaVersionPatch}`;
                campaign.hotaForceMatchingVersion = r.bool();
                r.i8();  // unknownB
                r.i32(); // unknownC
            }
            campaign.scenarioCount = r.i32();
        }

        campaign.campaignRegionId = r.u8();
        campaign.name = r.str();
        campaign.description = r.str();

        // Difficulty choice available for all versions > RoE (version > 4)
        if (ver > 4) {
            campaign.allowDifficultySelection = r.bool();
        }

        campaign.music = r.u8();

        // For non-HotA, determine scenario count from remaining gzip blocks
        if (!isHotA) {
            campaign.scenarioCount = blocks.length - 1;
        }

        // Parse scenario definitions
        campaign.scenarios = [];
        const sc_count = campaign.scenarioCount;

        for (let i = 0; i < sc_count; i++) {
            const sc = { index: i };
            try {
                sc.mapName = r.str();
                sc.packedMapSize = r.u32();

                // Preconditions: bitmask (u8 if <=8 scenarios, u16 if >8)
                sc.preconditions = sc_count > 8 ? r.u16() : r.u8();

                sc.regionColor = r.u8();
                sc.difficulty = r.u8();
                sc.difficultyName = DIFFICULTY_NAMES[sc.difficulty] || `Unknown`;
                sc.regionText = r.str();

                // Prolog
                sc.prologEnabled = r.bool();
                if (sc.prologEnabled) {
                    sc.prologVideo = r.u8();
                    sc.prologMusic = r.u8();
                    sc.prologText = r.str();
                }

                // HotA: prolog2, prolog3
                if (isHotA) {
                    if (r.bool()) { r.u8(); r.u8(); r.str(); }
                    if (r.bool()) { r.u8(); r.u8(); r.str(); }
                }

                // Epilog
                sc.epilogEnabled = r.bool();
                if (sc.epilogEnabled) {
                    sc.epilogVideo = r.u8();
                    sc.epilogMusic = r.u8();
                    sc.epilogText = r.str();
                }

                // HotA: epilog2, epilog3
                if (isHotA) {
                    if (r.bool()) { r.u8(); r.u8(); r.str(); }
                    if (r.bool()) { r.u8(); r.u8(); r.str(); }
                }

                // Travel options
                sc.whatHeroKeeps = r.u8();

                // Creature bitmask
                const creatureBytes = isHotA ? 24 : 19;
                r.skip(creatureBytes);

                // Artifact bitmask
                const artifactBytes = isHotA ? 21 : (ver >= 6 ? 18 : 17);
                r.skip(artifactBytes);

                sc.startOptions = r.u8();

                if (sc.startOptions === 1) {
                    sc.bonusPlayerColor = r.u8();
                }

                if (sc.startOptions !== 0) {
                    const numBonuses = r.u8();
                    sc.bonuses = [];
                    for (let b = 0; b < numBonuses; b++) {
                        const bonus = {};
                        if (sc.startOptions === 1) {
                            bonus.type = r.u8();
                            switch (bonus.type) {
                                case 0: bonus.heroId = r.i16(); bonus.spellId = r.u8(); break;
                                case 1: bonus.heroId = r.i16(); bonus.creatureId = r.u16(); bonus.amount = r.u16(); break;
                                case 2: bonus.buildingId = r.u8(); break;
                                case 3: bonus.heroId = r.i16(); bonus.artifactId = r.u16(); break;
                                case 4: bonus.heroId = r.i16(); bonus.spellId = r.u8(); break;
                                case 5: bonus.heroId = r.i16(); bonus.stats = [r.u8(), r.u8(), r.u8(), r.u8()]; break;
                                case 6: bonus.heroId = r.i16(); bonus.skillId = r.u8(); bonus.mastery = r.u8(); break;
                                case 7: bonus.resourceType = r.i8(); bonus.amount = r.i32(); break;
                            }
                        } else if (sc.startOptions === 2) {
                            bonus.playerColor = r.u8();
                            bonus.scenarioId = r.u8();
                        } else if (sc.startOptions === 3) {
                            bonus.playerColor = r.u8();
                            bonus.heroId = r.i16();
                        }
                        sc.bonuses.push(bonus);
                    }
                }
            } catch (e) {
                sc.parseError = e.message;
            }
            campaign.scenarios.push(sc);
        }

        // Embedded H3M maps (blocks 1..N)
        campaign.maps = [];
        campaign.rawMaps = [];
        let mapBlockIdx = 1;

        for (let i = 0; i < sc_count; i++) {
            const sc = campaign.scenarios[i];
            const isVoid = !sc.mapName || sc.mapName.length === 0;

            if (!isVoid && mapBlockIdx < blocks.length) {
                campaign.rawMaps.push(blocks[mapBlockIdx]);
                const mapDec = decompressed[mapBlockIdx];
                if (mapDec) {
                    try {
                        // Decompressed block is raw H3M binary (not gzip)
                        // parseH3M's decompress() sees no gzip magic and passes through
                        const mapData = parseH3M(mapDec);
                        campaign.maps.push(mapData);
                        sc.mapData = mapData;
                    } catch (e) {
                        campaign.maps.push({ parseError: e.message, index: i });
                    }
                } else {
                    campaign.maps.push({ parseError: 'Failed to decompress', index: i });
                }
                mapBlockIdx++;
            } else {
                campaign.rawMaps.push(null);
                campaign.maps.push(null);
            }
        }

        campaign._rawCompressedSize = rawData.length;
        campaign.mapCount = campaign.maps.filter(m => m && !m.parseError).length;

        return campaign;
    }

    // Split a buffer into individual gzip streams
    function splitGzipBlocks(data) {
        const blocks = [];
        let offset = 0;
        while (offset < data.length - 2) {
            // Look for gzip magic bytes
            if (data[offset] === 0x1f && data[offset + 1] === 0x8b) {
                // Find the next gzip block or end of data
                let nextBlock = offset + 10; // minimum gzip header size
                // Scan for next gzip magic
                let end = data.length;
                for (let i = nextBlock; i < data.length - 1; i++) {
                    if (data[i] === 0x1f && data[i + 1] === 0x8b && data[i + 2] === 0x08) {
                        end = i;
                        break;
                    }
                }
                blocks.push(data.subarray(offset, end));
                offset = end;
            } else {
                offset++;
            }
        }
        return blocks;
    }

    // ----------------------------------------------------------------
    // Get raw H3M data for embedded map (for re-opening with full parser)
    // ----------------------------------------------------------------
    function getEmbeddedMapData(campaign, scenarioIndex) {
        if (scenarioIndex < campaign.rawMaps.length) {
            return campaign.rawMaps[scenarioIndex];
        }
        return null;
    }

    // ----------------------------------------------------------------
    // Public API
    // ----------------------------------------------------------------
    return {
        parseH3M,
        parseH3C,
        renderMinimap,
        getEmbeddedMapData,
        decompressAsync,
        decompress,

        // Constants for external use
        VERSION, VERSION_NAMES, VERSION_SHORT,
        TERRAIN, TERRAIN_NAMES, TERRAIN_COLORS,
        PLAYER_COLORS, PLAYER_COLOR_NAMES, NEUTRAL_COLOR,
        DIFFICULTY_NAMES,
        WIN_COND_NAMES, LOSS_COND_NAMES,
        RESOURCE_NAMES,

        // Helper
        getObjectClassName,
    };
})();
