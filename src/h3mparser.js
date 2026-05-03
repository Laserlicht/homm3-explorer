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
    // Merge an array of Uint8Arrays into a single Uint8Array
    function mergeUint8Arrays(arrays) {
        const total = arrays.reduce((n, a) => n + a.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    class BinaryReader {
        constructor(data, options) {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.data = u8;
            this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            this.pos = 0;
            this.length = u8.byteLength;
            this.encoding = options?.encoding || null;    // null = auto (UTF-8 → latin1)
            this.rawStrings = options?.rawStrings || null; // Array to collect raw string bytes
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
            // Collect raw bytes for encoding detection
            if (this.rawStrings !== null) this.rawStrings.push(new Uint8Array(bytes));
            // Use specified encoding if provided
            if (this.encoding) {
                return new TextDecoder(this.encoding, { fatal: false }).decode(bytes);
            }
            // Auto-detect: attempt UTF-8 first, fall back to latin1
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
    const TOWN_NAMES_HOTA_BULWARK = [...TOWN_NAMES_HOTA_FACTORY, 'Bulwark'];

    function getTownNames(ver, hotaSub) {
        if (ver >= VERSION.HOTA) {
            if (hotaSub >= 7) return TOWN_NAMES_HOTA_BULWARK;
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

    // Artifact names indexed by artifact ID (objSubID for specific artifacts)
    const ARTIFACT_NAMES = [
        // 0-6: Special / war machines
        'Spellbook', 'Spell Scroll', 'Grail', 'Catapult', 'Ballista', 'Ammo Cart', 'First Aid Tent',
        // 7-12: Weapons
        "Centaur's Axe", 'Blackshard of the Dead Knight', "Greater Gnoll's Flail",
        "Ogre's Club of Havoc", 'Sword of Hellfire', "Titan's Gladius",
        // 13-18: Shields
        'Shield of the Dwarven Lords', 'Shield of the Yawning Dead', "Buckler of the Gnoll King",
        'Targ of the Rampaging Ogre', 'Shield of the Damned', "Sentinel's Shield",
        // 19-24: Helmets
        'Helm of the Alabaster Unicorn', 'Skull Helmet', 'Helm of Chaos',
        'Crown of the Supreme Magi', 'Hellstorm Helmet', 'Thunder Helmet',
        // 25-30: Armor
        'Breastplate of Petrified Wood', 'Rib Cage', 'Scales of the Greater Basilisk',
        'Tunic of the Cyclops King', 'Breastplate of Brimstone', "Titan's Cuirass",
        // 31-36: Combinations
        'Armor of Wonder', 'Sandals of the Saint', 'Celestial Necklace of Bliss',
        "Lion's Shield of Courage", 'Sword of Judgement', 'Helm of Heavenly Enlightenment',
        // 37-44: Dragon
        'Quiet Eye of the Dragon', 'Red Dragon Flame Tongue', 'Dragon Scale Shield',
        'Dragon Scale Armor', 'Dragonbone Greaves', 'Dragon Wing Tabard',
        'Necklace of Dragonteeth', 'Crown of Dragontooth',
        // 45-53: Luck/misc
        'Still Eye of the Dragon', 'Clover of Fortune', 'Cards of Prophecy', 'Ladybird of Luck',
        'Badge of Courage', 'Crest of Valor', 'Glyph of Gallantry', 'Speculum', 'Spyglass',
        // 54-59: Undead/neutrality
        'Amulet of the Undertaker', "Vampire's Cowl", "Dead Man's Boots",
        'Garniture of Interference', 'Surcoat of Counterpoise', 'Boots of Polarity',
        // 60-65: Ranged/sight
        'Bow of Elven Cherrywood', "Bowstring of the Unicorn's Mane", 'Angel Feather Arrows',
        'Bird of Perception', 'Stoic Watchman', 'Emblem of Cognizance',
        // 66-71: Diplomacy/movement
        "Statesman's Medal", "Diplomat's Ring", "Ambassador's Sash",
        'Ring of the Wayfarer', "Equestrian's Gloves", 'Necklace of Ocean Guidance',
        // 72-78: Magic power
        'Angel Wings', 'Charm of Mana', 'Talisman of Mana', 'Mystic Orb of Mana',
        'Collar of Conjuring', 'Ring of Conjuring', 'Cape of Conjuring',
        // 79-82: Elemental orbs
        'Orb of the Firmament', 'Orb of Silt', 'Orb of Tempestuous Fire', 'Orb of Driving Rain',
        // 83-89: Magic control / tomes
        "Recanter's Cloak", 'Spirit of Oppression', 'Hourglass of the Evil Hour',
        'Tome of Fire Magic', 'Tome of Air Magic', 'Tome of Water Magic', 'Tome of Earth Magic',
        // 90-97: Speed / protection / resources
        'Boots of Levitation', 'Golden Bow', 'Sphere of Permanence', 'Orb of Vulnerability',
        'Ring of Vitality', 'Ring of Life', 'Vial of Lifeblood', 'Necklace of Swiftness',
        // 98-108: Speed / pendants
        'Boots of Speed', 'Cape of Velocity', 'Pendant of Dispassion', 'Pendant of Second Sight',
        'Pendant of Holiness', 'Pendant of Life', 'Pendant of Death', 'Pendant of Free Will',
        'Pendant of Negativity', 'Pendant of Total Recall', 'Pendant of Courage',
        // 109-117: Resource generators
        'Everflowing Crystal Cloak', 'Ring of Infinite Gems', 'Everpouring Vial of Mercury',
        'Inexhaustible Cart of Ore', 'Eversmoking Ring of Sulfur', 'Inexhaustible Cart of Lumber',
        'Endless Sack of Gold', 'Endless Bag of Gold', 'Endless Purse of Gold',
        // 118-122: Legion set
        'Legs of Legion', 'Loins of Legion', 'Torso of Legion', 'Arms of Legion', 'Head of Legion',
        // 123-126: Naval / special
        "Sea Captain's Hat", "Spellbinder's Hat", 'Shackles of War', 'Orb of Inhibition',
        // 127-128: Armageddon's Blade artifacts (AB)
        'Vial of Dragon Blood', "Armageddon's Blade",
        // 129-140: Combination artifacts (SoD)
        'Angelic Alliance', 'Cloak of the Undead King', 'Elixir of Life', 'Armor of the Damned',
        'Statue of Legion', 'Power of the Dragon Father', "Titan's Thunder", "Admiral's Hat",
        'Bow of the Sharpshooter', "Wizard's Well", 'Ring of the Magi', 'Cornucopia',
        // 141-143: Base game unused / HotA combination artifacts
        "Diplomat's Suit",     // 141 (base game unusedArtifact1)
        "Diplomat's Cloak",    // 142 (HotA combo: overrides base "Mired in Neutrality")
        'Pendant of Reflection', // 143 (HotA combo: overrides base "Ironfist of the Ogre")
        // 144-165: HotA-only artifacts
        'Ironfist of the Ogre', // 144 (HotA combo)
        undefined,              // 145 (unknown HotA artifact)
        undefined,              // 146 (unknown HotA artifact)
        'Trident of Dominion',  // 147
        'Shield of Naval Glory', // 148
        'Royal Armor of Nix',   // 149
        'Crown of the Five Seas', // 150
        "Wayfarer's Boots",     // 151
        'Runes of Imminency',   // 152
        "Demon's Horseshoe",    // 153
        "Shaman's Puppet",      // 154
        'Hideous Mask',         // 155
        'Ring of Suppression',  // 156
        'Pendant of Downfall',  // 157
        'Ring of Oblivion',     // 158
        'Cape of Silence',      // 159
        'Golden Goose',         // 160 (HotA combo)
        'Horn of the Abyss',    // 161
        'Charm of Eclipse',     // 162
        'Seal of Sunset',       // 163
        'Plate of Dying Light', // 164
        'Sleepkeeper',          // 165
    ];

    // Spell names indexed by spell ID
    const SPELL_NAMES = [
        // 0-9: Adventure map spells
        'Summon Boat', 'Scuttle Boat', 'Visions', 'View Earth', 'Disguise',
        'View Air', 'Fly', 'Water Walk', 'Dimension Door', 'Town Portal',
        // 10-26: Offensive combat spells
        'Quicksand', 'Land Mine', 'Force Field', 'Fire Wall', 'Earthquake',
        'Magic Arrow', 'Ice Bolt', 'Lightning Bolt', 'Implosion', 'Chain Lightning',
        'Frost Ring', 'Fireball', 'Inferno', 'Meteor Shower', 'Death Ripple',
        'Destroy Undead', 'Armageddon',
        // 27-36: Defensive / buff
        'Shield', 'Air Shield', 'Fire Shield', 'Protection from Air', 'Protection from Fire',
        'Protection from Water', 'Protection from Earth', 'Anti-Magic', 'Dispel', 'Magic Mirror',
        // 37-48: Healing / summoning
        'Cure', 'Resurrection', 'Animate Dead', 'Sacrifice', 'Bless', 'Curse',
        'Bloodlust', 'Precision', 'Weakness', 'Stone Skin', 'Disrupting Ray', 'Prayer',
        // 49-57: Morale / speed / control
        'Mirth', 'Sorrow', 'Fortune', 'Misfortune', 'Haste', 'Slow', 'Slayer', 'Frenzy',
        "Titan's Lightning Bolt",
        // 58-65: Control
        'Counterstrike', 'Berserk', 'Hypnotize', 'Forgetfulness', 'Blind', 'Teleport',
        'Remove Obstacle', 'Clone',
        // 66-69: Elemental summons
        'Summon Fire Elemental', 'Summon Earth Elemental', 'Summon Water Elemental', 'Summon Air Elemental',
    ];

    // Object class IDs
    const OBJ = {
        TOWN: 98, RANDOM_TOWN: 77,
        HERO: 34, RANDOM_HERO: 70, PRISON: 62,
        MONSTER: 54, RANDOM_MONSTER: 71, RANDOM_MONSTER_L1: 72,
        RANDOM_MONSTER_L2: 73, RANDOM_MONSTER_L3: 74,
        RANDOM_MONSTER_L4: 75, RANDOM_MONSTER_L5: 162,
        RANDOM_MONSTER_L6: 163, RANDOM_MONSTER_L7: 164,
        MINE: 53,
        GRAIL: 36,
        ARTIFACT: 5, RANDOM_ART: 65, RANDOM_TREASURE: 66,
        RANDOM_MINOR: 67, RANDOM_MAJOR: 68, RANDOM_RELIC: 69,
        PANDORAS_BOX: 6,
        EVENT: 26,
        GARRISON: 33, GARRISON2: 219,
        SIGN: 91, OCEAN_BOTTLE: 59, SIRENS: 92,
        LEAN_TO: 39, WAGON: 105, BORDER_GATE: 212,
        SCHOLAR: 81,
        WITCH_HUT: 113,
        QUEST_GUARD: 215,
        RANDOM_DWELLING: 216, RANDOM_DWELLING_L: 217, RANDOM_DWELLING_LVL: 218,
        SEER_HUT: 83,
        SPELL_SCROLL: 93,
        HERO_PLACEHOLDER: 214,
        RESOURCE: 79, RANDOM_RESOURCE: 76,
        DWELLING: 17, DWELLING2: 18, DWELLING3: 19, DWELLING_FACTION: 20,
        LIGHTHOUSE: 42, SHIPYARD: 87,
        ABANDONED_MINE: 220,
        CREATURE_BANK: 16,
    };

    // ----------------------------------------------------------------
    // Feature Flags per version (what the format supports)
    // ----------------------------------------------------------------
    function features(ver, hotaSub) {
        const isROE  = ver === VERSION.ROE;
        const isAB   = ver >= VERSION.AB;
        const isSOD  = ver >= VERSION.SOD;
        const isWOG  = ver === VERSION.WOG;   // Wake of Gods (0x33) — SoD format + WOG extras
        const isHOTA = ver >= VERSION.HOTA && ver < VERSION.WOG; // HotA only (not WOG)

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
            isROE, isAB, isSOD, isWOG, isHOTA,
            levelLimit:      isAB,
            creatureId16:    isAB,    // 2-byte creature IDs (vs 1-byte in RoE)
            artifactId16:    isAB,    // 2-byte artifact IDs
            heroCount,
            artifactCount,
            spellCount:      70,
            townCount:       isHOTA ? (hotaSub >= 7 ? 12 : hotaSub >= 6 ? 11 : 10) : (isAB ? 9 : 8),
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
    // Parse the gzip header and return the byte offset where the deflate stream starts.
    // Handles optional FEXTRA, FNAME, FCOMMENT, FHCRC fields per RFC 1952.
    function gzipDeflateOffset(u8) {
        if (u8[0] !== 0x1f || u8[1] !== 0x8b) return -1;
        const flg = u8[3];
        let offset = 10;
        if (flg & 4) { // FEXTRA
            if (offset + 2 > u8.length) return -1;
            const xlen = u8[offset] | (u8[offset + 1] << 8);
            offset += 2 + xlen;
        }
        if (flg & 8) { // FNAME — null-terminated string
            while (offset < u8.length && u8[offset] !== 0) offset++;
            offset++; // skip null terminator
        }
        if (flg & 16) { // FCOMMENT — null-terminated string
            while (offset < u8.length && u8[offset] !== 0) offset++;
            offset++;
        }
        if (flg & 2) { // FHCRC
            offset += 2;
        }
        return offset;
    }

    function decompress(data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        // Check for gzip magic
        if (u8[0] === 0x1f && u8[1] === 0x8b) {
            if (typeof pako !== 'undefined') {
                // Fast path: strict gzip inflate (validates header + footer CRC)
                try {
                    const result = pako.inflate(u8);
                    if (result && result.length > 0) return result;
                } catch (_) {
                    // Fall through to raw inflate (tolerates corrupt gzip footer)
                }
                // Fallback: skip the gzip header and use inflateRaw.
                // This tolerates files with a corrupt gzip footer (bad CRC/ISIZE) while
                // the deflate payload itself is intact — pako.inflateRaw stops at the
                // DEFLATE end-of-stream marker and ignores any trailing bytes.
                if (typeof pako.inflateRaw !== 'undefined') {
                    const offset = gzipDeflateOffset(u8);
                    if (offset > 0 && offset < u8.length) {
                        const sliced = u8.slice(offset);
                        // First attempt: standard raw inflate (works for corrupt-footer gzip)
                        try {
                            const result = pako.inflateRaw(sliced);
                            if (result && result.length > 0) return result;
                        } catch (_) { /* fall through to streaming inflate */ }
                        // Second attempt: streaming inflate with Z_SYNC_FLUSH (2).
                        // Recovers all available output even from truncated deflate streams.
                        if (typeof pako.Inflate !== 'undefined') {
                            const inf = new pako.Inflate({ raw: true });
                            try { inf.push(sliced, 2); } catch (_) { /* partial data is still in chunks */ }
                            if (inf.chunks && inf.chunks.length > 0) {
                                const total = inf.chunks.reduce((s, c) => s + c.length, 0);
                                if (total > 0) {
                                    const out = new Uint8Array(total);
                                    let off = 0;
                                    for (const c of inf.chunks) { out.set(c, off); off += c.length; }
                                    return out;
                                }
                            }
                        }
                    }
                }
                throw new Error('Failed to decompress H3M: gzip data is corrupt or truncated');
            }
            throw new Error('No decompression library available (need pako)');
        }
        // Not compressed, return as-is
        return u8;
    }

    async function decompressAsync(data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (u8[0] === 0x1f && u8[1] === 0x8b) {
            if (typeof pako !== 'undefined') {
                // Use the synchronous decompress() which already handles corrupt footers
                return decompress(u8);
            }
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
        const rawStrings = [];
        const r = new BinaryReader(data, { encoding: opts.encoding || null, rawStrings });
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
        map._rawStringBytes = rawStrings.length > 0 ? mergeUint8Arrays(rawStrings) : new Uint8Array(0);

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
            t.terrainMask2 = r.u16(); // always present: unused/padding in RoE/AB/SoD, extra terrain flags in HotA
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
            case 88: case 89: case 90: // SHRINE_OF_MAGIC_INCANTATION/GESTURE/THOUGHT
                // Spell ID stored as u32 (readSpell32)
                obj.spellId = r.u32();
                break;
            case OBJ.MINE:
            case OBJ.ABANDONED_MINE:
                // if subid < 7 → readMine (owner u32), else → readAbandonedMine (resource bitmask + HotA5+ guards)
                if (obj.objSubID < 7) {
                    obj.owner = r.u32();
                    obj.ownerName = obj.owner < 8 ? PLAYER_COLOR_NAMES[obj.owner] : 'Neutral';
                } else {
                    r.skip(4); // resource bitmask (resourcesBytes=4 for all versions)
                    if (feat.isHOTA && feat.hotaSub >= 5) {
                        const hasCustomGuards = r.bool();
                        if (hasCustomGuards) {
                            r.i32(); // creature type
                            r.i32(); // min amount
                            r.i32(); // max amount
                        } else {
                            r.skip(12); // skipUnused(12)
                        }
                    }
                }
                break;
            case OBJ.DWELLING: case OBJ.DWELLING2: case OBJ.DWELLING3: case OBJ.DWELLING_FACTION:
                // Creature Generators 1-4: owner as u32
                obj.owner = r.u32();
                obj.ownerName = obj.owner < 8 ? PLAYER_COLOR_NAMES[obj.owner] : 'Neutral';
                break;
            case OBJ.LIGHTHOUSE: case OBJ.SHIPYARD:
                // Flaggable objects: owner as u32
                obj.owner = r.u32();
                obj.ownerName = obj.owner < 8 ? PLAYER_COLOR_NAMES[obj.owner] : 'Neutral';
                break;
            // Banks: HotA3+ additional data (variable length)
            case OBJ.CREATURE_BANK: case 24: case 25: case 84: case 85: // CREATOR_BANK, DERELICT_SHIP, DRAGON_UTOPIA, CRYPT, SHIPWRECK
                if (feat.isHOTA && feat.hotaSub >= 3) {
                    obj.guardsPreset = r.i32();
                    r.skip(1); // upgradedStackPresence (i8)
                    const bankArtCount = r.u32();
                    obj.bankArtifacts = [];
                    for (let i = 0; i < bankArtCount; i++) obj.bankArtifacts.push(r.u32());
                }
                break;
            // Pyramid + objects using readRewardWithGarbage: HotA5+ always 8 bytes
            case 63: case 29: case 102: // PYRAMID, FLOTSAM, TREE_OF_KNOWLEDGE
                if (feat.isHOTA && feat.hotaSub >= 5) r.skip(8);
                break;
            // Objects using readRewardWithArtifact: HotA5+ always 8 bytes
            case 22: case 82: case 86: case 101: case 108: // CORPSE, SEA_CHEST, SHIPWRECK_SURVIVOR, TREASURE_CHEST, WARRIORS_TOMB
                if (feat.isHOTA && feat.hotaSub >= 5) r.skip(8);
                break;
            // Campfire, LeanTo, Wagon: HotA5+ always 18 bytes (4 content + 14 resource data/padding)
            case 12: case 39: case 105: // CAMPFIRE, LEAN_TO, WAGON
                if (feat.isHOTA && feat.hotaSub >= 5) r.skip(18);
                break;
            // Black Market (class 7): HotA5+ 7 artifacts (2-byte artID + 2-byte spell each)
            case 7: // BLACK_MARKET
                if (feat.isHOTA && feat.hotaSub >= 5) r.skip(28); // 7 × (artifact16 + spell16)
                break;
            // University (class 104) + HOTA_CUSTOM_OBJECT_2 sub=0 (class 146): HotA5+ i32 + 4-byte skill bitmask
            case 104: // UNIVERSITY
                if (feat.isHOTA && feat.hotaSub >= 5) r.skip(8); // i32 customized + 4-byte skill bitmask
                break;
            case 146: // HOTA_CUSTOM_OBJECT_2 (Seafaring Academy sub=0, others generic)
                if (feat.isHOTA && feat.hotaSub >= 5 && obj.objSubID === 0) r.skip(8); // readUniversity
                break;
            // HOTA_CUSTOM_OBJECT_1 (class 145):
            // sub=0 (Ancient Lamp): readRewardWithAmount → HotA5+: 18 bytes
            // sub=1 (Sea Barrel): readLeanTo → HotA5+: 18 bytes
            // sub=2 (Jetsam), sub=3 (Vial of Mana): readRewardWithGarbage → HotA5+: 8 bytes
            // sub=4 (Bottle of ...?): readRewardWithGarbage → HotA5+: 8 bytes
            case 145: // HOTA_CUSTOM_OBJECT_1
                if (feat.isHOTA && feat.hotaSub >= 5) {
                    if (obj.objSubID === 0 || obj.objSubID === 1) r.skip(18);
                    else r.skip(8);
                }
                break;
            // HOTA_CUSTOM_OBJECT_3 sub=12 (Trapper Lodge): HotA9+: 16 bytes
            case 144: // HOTA_CUSTOM_OBJECT_3
                if (feat.isHOTA && feat.hotaSub >= 9 && obj.objSubID === 12) r.skip(16);
                break;
            // BORDER_GATE (class 212):
            // sub=1000 (Quest Gate): readQuestGuard
            // sub=1001 (HotA Grave): readHotaGrave, HotA5+: 18 bytes
            case OBJ.BORDER_GATE:
                if (obj.objSubID === 1000) {
                    readQuestGuardObject(r, feat, obj); // Quest Gate = Quest Guard
                } else if (obj.objSubID === 1001 && feat.isHOTA && feat.hotaSub >= 5) {
                    r.skip(18); // readHotaGrave: content(4) + artifact(4) + amount(4) + resource(1) + skip(5) = 18
                }
                break;
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
        // Possible spells (always present in all versions)
        r.skip(9);

        // HotA1+: spell research allowed
        if (feat.isHOTA && feat.hotaSub >= 1) {
            r.bool(); // spellResearchAllowed
        }

        // HotA5+: special buildings customization table
        if (feat.isHOTA && feat.hotaSub >= 5) {
            const specialBuildingsSize = r.u32();
            r.skip(specialBuildingsSize); // 1 byte per entry
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
        r.u16(); // nextOccurrence (u16, not u8!)
        r.skip(16); // padding (16 bytes, not 17!)

        // (readEventCommon) HotA7+: affected difficulties bitmask
        if (feat.isHOTA && feat.hotaSub >= 7) {
            r.i32(); // affectedDifficulties bitmask
        }
        // (readEventCommon) HotA9+: event system link
        if (feat.isHOTA && feat.hotaSub >= 9) {
            const usesEventSystem = r.bool();
            if (usesEventSystem) {
                r.i32();  // eventID
                r.bool(); // synchronizeObjects
            }
        }

        // HotA5+: 8th creature slot growth + special buildings data
        if (feat.isHOTA && feat.hotaSub >= 5) {
            r.i32(); // creatureGrowth8 (8th slot)
            r.i32(); // hotaAmount (always 44)
            r.i32(); // hotaSpecialA (special building bitmask)
            r.i16(); // hotaSpecialB
        }
        // HotA7+: neutral player affected flag
        if (feat.isHOTA && feat.hotaSub >= 7) {
            r.bool(); // neutralAffected
        }

        // buildings (after all HotA extras)
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

        // HotA5+: alwaysAddSkills (bool) + cannotGainXP (bool) + level (i32)
        if (feat.isHOTA && feat.hotaSub >= 5) {
            r.bool(); // alwaysAddSkills
            r.bool(); // cannotGainXP
            r.i32();  // level
        }
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

        // HotA3+: extra monster fields
        if (feat.isHOTA && feat.hotaSub >= 3) {
            r.i32();  // agression (-1..10)
            r.bool(); // joinOnlyForMoney
            r.i32();  // joiningPercentage (100 = default)
            r.i32();  // upgradedStackPresence (-1=random, 0=never, 1=always)
            r.i32();  // stacksCount (-1=default)
        }
        // HotA5+: stack size by AI value
        if (feat.isHOTA && feat.hotaSub >= 5) {
            r.bool(); // sizeByValue
            r.i32();  // targetValue
        }
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
                readSeerReward(r, feat, obj); // RoE: just reward, no quest structure
            } else {
                r.skip(1); // skipZero(1) when no quest (missionType=NONE)
            }
            r.skip(2); // padding
            return;
        }

        // AB+: HotA3+ has questsCount, otherwise 1
        const questsCount = (feat.isHOTA && feat.hotaSub >= 3) ? r.u32() : 1;
        for (let i = 0; i < questsCount; i++) {
            readSeerHutQuest(r, feat, obj);
        }

        if (feat.isHOTA && feat.hotaSub >= 3) {
            const repeatableQuestsCount = r.u32();
            for (let i = 0; i < repeatableQuestsCount; i++) {
                readSeerHutQuest(r, feat, obj);
            }
        }

        r.skip(2); // skipZero(2) at end of seer hut
    }

    function readSeerHutQuest(r, feat, obj) {
        // AB+: read full quest then reward
        const missionType = readQuest(r, feat, obj);
        if (missionType !== 0) {
            readSeerReward(r, feat, obj);
        } else {
            r.skip(1); // skipZero(1) only when missionType==NONE
        }
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
            case 5: r.skip(1); r.u32(); break; // resource type + amount
            case 6: r.skip(1 + 1); break; // primary skill type + value
            case 7: r.skip(1 + 1); break; // secondary skill type + level
            case 8: // artifact
                readArtifactId(r, feat);
                if (feat.isHOTA && feat.hotaSub >= 5) r.u16(); // spell scroll ID
                break;
            case 9: r.skip(1); break; // spell
            case 10: // creature
                if (feat.isROE) { r.skip(1); } else { r.skip(2); } // creature ID
                r.u16(); // amount
                break;
        }
    }

    // ----------------------------------------------------------------
    // Quest
    // Returns missionType (0 = NONE).  Saves parsed data into obj.quest if obj != null.
    // ----------------------------------------------------------------
    const QUEST_TYPE_NAMES = [
        'None', 'Reach Level', 'Primary Skills', 'Defeat Hero', 'Defeat Monster',
        'Return with Artifacts', 'Return with Creatures', 'Return with Resources',
        'Be a Specific Hero', 'Belong to Player',
    ];

    function readQuest(r, feat, obj) {
        const missionType = r.u8();
        if (missionType === 0) return 0; // NONE — no further data

        const quest = obj ? {} : null;
        if (quest) {
            quest.missionType = missionType;
            quest.typeName = QUEST_TYPE_NAMES[missionType] || (missionType === 10 ? 'HotA Special' : `Type ${missionType}`);
        }

        switch (missionType) {
            case 1: { const lvl = r.u32(); if (quest) quest.level = lvl; break; } // level
            case 2: { // primary skills
                if (quest) quest.primarySkills = [r.u8(), r.u8(), r.u8(), r.u8()];
                else r.skip(4);
                break;
            }
            case 3: { const qi = r.u32(); if (quest) quest.questIdentifier = qi; break; } // defeat hero
            case 4: { const qi = r.u32(); if (quest) quest.questIdentifier = qi; break; } // defeat monster
            case 5: { // artifacts
                const cnt = r.u8();
                const arts = [];
                for (let i = 0; i < cnt; i++) {
                    const artId = readArtifactId(r, feat);
                    if (feat.isHOTA && feat.hotaSub >= 5) r.u16(); // spell scroll ID
                    if (quest) arts.push(artId);
                }
                if (quest) quest.artifacts = arts;
                break;
            }
            case 6: { // creatures
                const cnt = r.u8();
                const creatures = [];
                for (let i = 0; i < cnt; i++) {
                    const creId = feat.isROE ? r.u8() : r.u16();
                    const amount = r.u16();
                    if (quest) creatures.push({ creatureId: creId, amount });
                }
                if (quest) quest.creatures = creatures;
                break;
            }
            case 7: { // resources
                const res = [];
                for (let i = 0; i < 7; i++) res.push(r.u32());
                if (quest) quest.resources = res;
                break;
            }
            case 8: { const heroId = r.u8(); if (quest) quest.heroId = heroId; break; }
            case 9: { const player = r.u8(); if (quest) quest.player = player; break; }
            case 10: { // HOTA_MULTI
                const missionSubID = r.u32();
                if (quest) quest.missionSubID = missionSubID;
                if (missionSubID === 0) {
                    const classesCount = r.u32();
                    r.skip(Math.ceil(classesCount / 8));
                    if (quest) quest.typeName = 'Specific Hero Class';
                } else if (missionSubID === 1) {
                    const days = r.u32();
                    if (quest) { quest.daysPassed = days; quest.typeName = 'Reach Date'; }
                } else if (missionSubID === 2) {
                    const mask = r.u32();
                    if (quest) { quest.difficultyMask = mask; quest.typeName = 'Game Difficulty'; }
                } else if (missionSubID === 3) {
                    r.u32(); r.bool();
                    if (quest) quest.typeName = 'Scripted';
                }
                break;
            }
        }
        // After mission data: deadline + 3 strings
        const deadline = r.u32();
        const firstVisitText = r.str();
        r.str(); // nextVisitText
        const completedText = r.str();
        if (quest) {
            quest.deadline = deadline === 0xFFFFFFFF ? null : deadline;
            quest.firstVisitText = firstVisitText;
            quest.completedText = completedText;
            obj.quest = quest;
        }
        return missionType;
    }

    // ----------------------------------------------------------------
    // Witch Hut
    // ----------------------------------------------------------------
    function readWitchHutObject(r, feat, obj) {
        if (feat.isAB) {
            r.skip(4); // allowed skills bitmask (AB+ format)
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
            obj.hasGuard = r.bool();
            if (obj.hasGuard) readCreatureSet(r, feat, 7);
            r.skip(4); // padding
        }
        if (obj.objClass === OBJ.SPELL_SCROLL) {
            obj.spellId = r.u32();
        }
        // HotA5+: pickupMode (u32) + pickupFlags (u8) = 5 bytes (only for ARTIFACT, not SPELL_SCROLL)
        if (feat.isHOTA && feat.hotaSub >= 5 && obj.objClass !== OBJ.SPELL_SCROLL) {
            r.skip(5);
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
    function readPandorasBoxObject(r, feat, obj, includeHotaExtras = true) {
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
        for (let i = 0; i < artCount; i++) {
            readArtifactId(r, feat);
            if (feat.isHOTA && feat.hotaSub >= 5) r.u16(); // spell scroll ID (always present for HotA5+)
        }
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

        // HotA5+: unknown byte + movement mode/amount
        if (includeHotaExtras && feat.isHOTA && feat.hotaSub >= 5) {
            r.skip(1);  // unknown, always 0
            r.i32();    // movementMode (Give/Take/Nullify/Set/Replenish)
            r.i32();    // movementAmount
        }
        // HotA6+: allowed difficulties mask
        if (includeHotaExtras && feat.isHOTA && feat.hotaSub >= 6) {
            r.i32();    // allowedDifficultiesMask
        }
        // HotA9+: event system link
        if (includeHotaExtras && feat.isHOTA && feat.hotaSub >= 9) {
            const usesEventSystem = r.bool();
            if (usesEventSystem) r.i32(); // eventID (+ synchronizeObjects bool omitted for Pandora)
        }
    }

    // ----------------------------------------------------------------
    // Event Object
    // ----------------------------------------------------------------
    function readEventObject(r, feat, obj) {
        // Same core box content as Pandora (without HotA extras – handled below)
        readPandorasBoxObject(r, feat, obj, false);
        obj.eventPlayers = r.u8();
        obj.isComputerActive = r.bool();
        obj.removeAfterVisit = r.bool();
        r.skip(4); // padding

        // HotA3+: humanActivate field
        if (feat.isHOTA && feat.hotaSub >= 3) {
            r.bool(); // humanActivate
        }

        // HotA5+: movement mode/amount
        if (feat.isHOTA && feat.hotaSub >= 5) {
            r.i32(); // movementMode
            r.i32(); // movementAmount
        }
        // HotA6+: allowed difficulties mask
        if (feat.isHOTA && feat.hotaSub >= 6) {
            r.i32(); // allowedDifficultiesMask
        }
        // HotA9+: event system link
        if (feat.isHOTA && feat.hotaSub >= 9) {
            const usesEventSystem = r.bool();
            if (usesEventSystem) { r.i32(); r.bool(); } // eventID + synchronizeObjects
        }
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
        // hasFactionInfo = RANDOM_DWELLING(216) || RANDOM_DWELLING_LVL(217)
        // hasLevelInfo   = RANDOM_DWELLING(216) || RANDOM_DWELLING_FACTION(218)
        // Our naming: RANDOM_DWELLING_L=217 (=RANDOM_DWELLING_LVL), RANDOM_DWELLING_LVL=218 (=RANDOM_DWELLING_FACTION)
        const hasFactionInfo = obj.objClass === OBJ.RANDOM_DWELLING || obj.objClass === OBJ.RANDOM_DWELLING_L;
        const hasLevelInfo   = obj.objClass === OBJ.RANDOM_DWELLING || obj.objClass === OBJ.RANDOM_DWELLING_LVL;
        if (hasFactionInfo) {
            obj.identifier = r.u32();
            if (obj.identifier === 0) {
                obj.factionMask = feat.isROE ? r.u8() : r.u16();
            }
        }
        if (hasLevelInfo) {
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

        // HotA5+: customized starting units and starting artifacts
        if (feat.isHOTA && feat.hotaSub >= 5) {
            const customizedStartingUnits = r.bool();
            if (customizedStartingUnits) {
                for (let i = 0; i < 7; i++) {
                    r.i32(); // unit amount
                    r.i32(); // creature ID (32-bit)
                }
                const artifactsToGive = r.i32();
                for (let i = 0; i < artifactsToGive; i++) {
                    r.i32(); // artifact ID (32-bit)
                }
            }
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
            const resources = [];
            for (let j = 0; j < 7; j++) resources.push(r.i32());
            ev.resources = resources.some(v => v !== 0) ? resources : null;
            ev.players = r.u8();
            if (feat.isSOD || feat.isHOTA) ev.humanAffected = r.u8();
            ev.computerAffected = r.u8();
            ev.firstOccurrence = r.u16();
            ev.nextOccurrence = r.u16(); // u16!
            r.skip(16); // padding (16 bytes)

            // HotA7+: affected difficulties bitmask
            if (feat.isHOTA && feat.hotaSub >= 7) {
                r.i32();
            }
            // HotA9+: event system link
            if (feat.isHOTA && feat.hotaSub >= 9) {
                const usesEventSystem = r.bool();
                if (usesEventSystem) {
                    r.i32();  // eventID
                    r.bool(); // synchronizeObjects
                }
            }
            // HotA5 & HotA6 only (not HotA7+): 14 garbage bytes at end of event
            if (feat.isHOTA && feat.hotaSub >= 5 && feat.hotaSub <= 6) {
                r.skip(14);
            }
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
            const feat = map._features || {};
            const townNames = getTownNames(feat.ver || VERSION.SOD, feat.hotaSub || 0);

            stats.objectCount = map.objects.filter(o => o.objClass !== -1).length;
            stats.objectsByClass = {};
            stats.towns = [];
            stats.heroes = [];
            stats.monsters = [];
            stats.mines = [];
            stats.artifacts = [];

            // Detailed breakdowns
            stats.minesByType = {};
            stats.townsByFaction = {};
            stats.monstersByLevel = { 'Specific': 0, 'Any Level': 0, 'Level 1': 0, 'Level 2': 0, 'Level 3': 0, 'Level 4': 0, 'Level 5': 0, 'Level 6': 0, 'Level 7': 0 };
            stats.artifactsByType = { 'Specific': 0, 'Random (any)': 0, 'Treasure': 0, 'Minor': 0, 'Major': 0, 'Relic': 0, 'Spell Scroll': 0 };
            stats.resourcesOnMap = {};
            stats.keyLocations = {
                seerHuts: 0, questGuards: 0, witchHuts: 0, scholars: 0,
                garrisons: 0, pandorasBoxes: 0, events: 0,
                creatureBanks: 0, dwellings: 0, shrines: 0,
            };

            for (const obj of map.objects) {
                const cls = obj.objClass;
                // Skip invalid/null objects (template index out of range)
                if (cls === -1) continue;
                const clsName = getObjectClassName(cls);
                stats.objectsByClass[clsName] = (stats.objectsByClass[clsName] || 0) + 1;

                if (cls === OBJ.TOWN || cls === OBJ.RANDOM_TOWN) {
                    stats.towns.push(obj);
                    const factionName = cls === OBJ.RANDOM_TOWN ? 'Random' : (townNames[obj.objSubID] || `Town ${obj.objSubID}`);
                    stats.townsByFaction[factionName] = (stats.townsByFaction[factionName] || 0) + 1;
                } else if (cls === OBJ.HERO || cls === OBJ.RANDOM_HERO || cls === OBJ.PRISON) {
                    stats.heroes.push(obj);
                } else if (isMonsterObj(cls)) {
                    stats.monsters.push(obj);
                    if (cls === OBJ.MONSTER) stats.monstersByLevel['Specific']++;
                    else if (cls === OBJ.RANDOM_MONSTER) stats.monstersByLevel['Any Level']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L1) stats.monstersByLevel['Level 1']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L2) stats.monstersByLevel['Level 2']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L3) stats.monstersByLevel['Level 3']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L4) stats.monstersByLevel['Level 4']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L5) stats.monstersByLevel['Level 5']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L6) stats.monstersByLevel['Level 6']++;
                    else if (cls === OBJ.RANDOM_MONSTER_L7) stats.monstersByLevel['Level 7']++;
                } else if (cls === OBJ.MINE || cls === OBJ.ABANDONED_MINE) {
                    stats.mines.push(obj);
                    const resName = cls === OBJ.ABANDONED_MINE ? 'Abandoned' : (RESOURCE_NAMES[obj.objSubID] || `Type ${obj.objSubID}`);
                    stats.minesByType[resName] = (stats.minesByType[resName] || 0) + 1;
                } else if (isArtifactObj(cls)) {
                    stats.artifacts.push(obj);
                    if (cls === OBJ.ARTIFACT) stats.artifactsByType['Specific']++;
                    else if (cls === OBJ.RANDOM_ART) stats.artifactsByType['Random (any)']++;
                    else if (cls === OBJ.RANDOM_TREASURE) stats.artifactsByType['Treasure']++;
                    else if (cls === OBJ.RANDOM_MINOR) stats.artifactsByType['Minor']++;
                    else if (cls === OBJ.RANDOM_MAJOR) stats.artifactsByType['Major']++;
                    else if (cls === OBJ.RANDOM_RELIC) stats.artifactsByType['Relic']++;
                    else if (cls === OBJ.SPELL_SCROLL) stats.artifactsByType['Spell Scroll']++;
                } else if (cls === OBJ.RESOURCE) {
                    const resName = RESOURCE_NAMES[obj.objSubID] || `Type ${obj.objSubID}`;
                    stats.resourcesOnMap[resName] = (stats.resourcesOnMap[resName] || 0) + 1;
                } else if (cls === OBJ.RANDOM_RESOURCE) {
                    stats.resourcesOnMap['Random'] = (stats.resourcesOnMap['Random'] || 0) + 1;
                }

                // Key locations
                if (cls === OBJ.SEER_HUT) { stats.keyLocations.seerHuts++; if (obj.quest) { stats.quests = stats.quests || []; stats.quests.push({ type: 'Seer Hut', x: obj.x, y: obj.y, z: obj.z, quest: obj.quest }); } }
                else if (cls === OBJ.QUEST_GUARD) { stats.keyLocations.questGuards++; if (obj.quest) { stats.quests = stats.quests || []; stats.quests.push({ type: 'Quest Guard', x: obj.x, y: obj.y, z: obj.z, quest: obj.quest }); } }
                else if (cls === OBJ.WITCH_HUT) stats.keyLocations.witchHuts++;
                else if (cls === OBJ.SCHOLAR) stats.keyLocations.scholars++;
                else if (cls === OBJ.GARRISON || cls === OBJ.GARRISON2) stats.keyLocations.garrisons++;
                else if (cls === OBJ.PANDORAS_BOX) stats.keyLocations.pandorasBoxes++;
                else if (cls === OBJ.EVENT) stats.keyLocations.events++;
                else if (cls === OBJ.CREATURE_BANK) stats.keyLocations.creatureBanks++;
                else if (cls === OBJ.DWELLING || cls === OBJ.DWELLING_FACTION ||
                         cls === OBJ.RANDOM_DWELLING || cls === OBJ.RANDOM_DWELLING_L || cls === OBJ.RANDOM_DWELLING_LVL) {
                    stats.keyLocations.dwellings++;
                }
                // Shrines (class 88)
                else if (cls === 88) stats.keyLocations.shrines++;
            }

            // Remove zero entries from monster levels
            for (const k of Object.keys(stats.monstersByLevel)) {
                if (stats.monstersByLevel[k] === 0) delete stats.monstersByLevel[k];
            }
            for (const k of Object.keys(stats.artifactsByType)) {
                if (stats.artifactsByType[k] === 0) delete stats.artifactsByType[k];
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

            // Extended key locations — derived from objectsByClass (name-based)
            const EXT_KL_NAMES = [
                'Lighthouse', 'Shipyard', 'University', 'Tree of Knowledge',
                'Altar of Sacrifice', 'Learning Stone', 'Arena', 'Stables',
                'Subterranean Gate', 'Cartographer', 'Trading Post',
                'Magic Well', 'Magic Spring', 'Obelisk', 'Hill Fort',
                'Redwood Observatory', 'Pillar of Fire', 'Library of Enlightenment',
                'Mercenary Camp', 'Dragon Utopia', 'Shrine of Magic Incantation',
            ];
            stats.extKeyLocations = {};
            for (const name of EXT_KL_NAMES) {
                const count = stats.objectsByClass[name] || 0;
                if (count > 0) stats.extKeyLocations[name] = count;
            }

            // Object density (objects per 100 tiles)
            const totalTiles = map.mapSize * map.mapSize * (map.hasUnderground ? 2 : 1);
            stats.objectDensity = totalTiles > 0 ? (stats.objectCount / totalTiles * 100) : 0;

            // Surface vs underground object split
            stats.objectsBySurface = { surface: 0, underground: 0 };
            for (const obj of map.objects) {
                if (obj.objClass === -1) continue;
                if (obj.z === 1) stats.objectsBySurface.underground++;
                else stats.objectsBySurface.surface++;
            }

            // Top object types for summary
            stats.topObjectTypes = Object.entries(stats.objectsByClass)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12);
        }

        return stats;
    }

    function isMonsterObj(cls) {
        return cls === OBJ.MONSTER || cls === OBJ.RANDOM_MONSTER ||
            cls === OBJ.RANDOM_MONSTER_L1 || cls === OBJ.RANDOM_MONSTER_L2 ||
            cls === OBJ.RANDOM_MONSTER_L3 || cls === OBJ.RANDOM_MONSTER_L4 ||
            cls === OBJ.RANDOM_MONSTER_L5 || cls === OBJ.RANDOM_MONSTER_L6 ||
            cls === OBJ.RANDOM_MONSTER_L7;
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
            [OBJ.RANDOM_MONSTER_L1]: 'Random Monster (L1)', [OBJ.RANDOM_MONSTER_L2]: 'Random Monster (L2)',
            [OBJ.RANDOM_MONSTER_L3]: 'Random Monster (L3)', [OBJ.RANDOM_MONSTER_L4]: 'Random Monster (L4)',
            [OBJ.RANDOM_MONSTER_L5]: 'Random Monster (L5)', [OBJ.RANDOM_MONSTER_L6]: 'Random Monster (L6)',
            [OBJ.RANDOM_MONSTER_L7]: 'Random Monster (L7)',
            [OBJ.MINE]: 'Mine', [OBJ.GRAIL]: 'Grail',
            [OBJ.ARTIFACT]: 'Artifact', [OBJ.RANDOM_ART]: 'Random Artifact',
            [OBJ.RANDOM_TREASURE]: 'Random Treasure', [OBJ.RANDOM_MINOR]: 'Random Minor Art.',
            [OBJ.RANDOM_MAJOR]: 'Random Major Art.', [OBJ.RANDOM_RELIC]: 'Random Relic',
            [OBJ.PANDORAS_BOX]: "Pandora's Box", [OBJ.EVENT]: 'Event',
            [OBJ.SIGN]: 'Sign', [OBJ.OCEAN_BOTTLE]: 'Ocean Bottle', [OBJ.SIRENS]: 'Sirens',
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
            [OBJ.LEAN_TO]: 'Lean-To',
            [OBJ.WAGON]: 'Wagon',
            [OBJ.BORDER_GATE]: 'Border Gate',
            // Static numeric IDs (MapObjectBaseID enum)
            2: 'Altar of Sacrifice',
            3: 'Anchor Point',
            4: 'Arena',
            7: 'Black Market',
            8: 'Boat',
            9: 'Border Guard',
            10: 'Keymaster Tent',
            11: 'Buoy',
            12: 'Campfire',
            13: 'Cartographer',
            14: 'Swan Pond',
            15: 'Cover of Darkness',
            21: 'Cursed Ground',
            22: 'Corpse',
            23: 'Marletto Tower',
            24: 'Derelict Ship',
            25: 'Dragon Utopia',
            27: 'Eye of the Magi',
            28: 'Faerie Ring',
            29: 'Flotsam',
            30: 'Fountain of Fortune',
            31: 'Fountain of Youth',
            32: 'Garden of Revelation',
            35: 'Hill Fort',
            37: 'Hut of Magi',
            38: 'Idol of Fortune',
            41: 'Library of Enlightenment',
            42: 'Lighthouse',
            43: 'Monolith (One-Way In)',
            44: 'Monolith (One-Way Out)',
            45: 'Monolith (Two-Way)',
            46: 'Magic Plains',
            47: 'School of Magic',
            48: 'Magic Spring',
            49: 'Magic Well',
            50: 'Market of Time',
            51: 'Mercenary Camp',
            52: 'Mermaid',
            55: 'Mystical Garden',
            56: 'Oasis',
            57: 'Obelisk',
            58: 'Redwood Observatory',
            60: 'Pillar of Fire',
            61: 'Star Axis',
            63: 'Pyramid',
            64: 'Rally Flag',
            78: 'Refugee Camp',
            80: 'Sanctuary',
            82: 'Sea Chest',
            84: 'Crypt',
            85: 'Shipwreck',
            86: 'Shipwreck Survivor',
            87: 'Shipyard',
            88: 'Shrine of Magic Incantation',
            89: 'Shrine of Magic Gesture',
            90: 'Shrine of Magic Thought',
            94: 'Stables',
            95: 'Tavern',
            96: 'Temple',
            97: 'Den of Thieves',
            99: 'Trading Post',
            100: 'Learning Stone',
            101: 'Treasure Chest',
            102: 'Tree of Knowledge',
            103: 'Subterranean Gate',
            104: 'University',
            106: 'War Machine Factory',
            107: 'School of War',
            108: 'Warriors Tomb',
            109: 'Water Wheel',
            110: 'Watering Hole',
            111: 'Whirlpool',
            112: 'Windmill',
            // Decorations (114–161), MapObjectBaseID enum
            114: 'Brush', 115: 'Bush', 116: 'Cactus', 117: 'Canyon', 118: 'Crater',
            119: 'Dead Vegetation', 120: 'Flowers', 121: 'Frozen Lake', 122: 'Hedge',
            123: 'Hill', 124: 'Hole', 125: 'Kelp', 126: 'Lake', 127: 'Lava Flow',
            128: 'Lava Lake', 129: 'Mushrooms', 130: 'Log', 131: 'Mandrake',
            132: 'Moss', 133: 'Mound', 134: 'Mountain', 135: 'Oak Trees',
            136: 'Outcropping', 137: 'Pine Trees', 138: 'Plant', 143: 'River Delta',
            147: 'Rock', 148: 'Sand Dune', 149: 'Sand Pit', 150: 'Shrub',
            151: 'Skull', 152: 'Stalagmite', 153: 'Stump', 154: 'Tar Pit',
            155: 'Trees', 156: 'Vine', 157: 'Volcanic Vent', 158: 'Volcano',
            159: 'Willow Trees', 160: 'Yucca Trees', 161: 'Reef',
            // IDs 139–142: H3 decorations between Plant(138) and River Delta(143)
            139: 'Decoration',        // mixed: bones, snow, cactus variants, etc.
            140: 'Rock Decoration',    // rocks, mountains, ice crystals
            141: 'Terrain Patch',      // ice/sand zone patches (Zice*, Zsand*)
            142: 'Water Decoration',   // water edge decorations (avwrhs*)
            // HotA internal object class IDs (HOTA_CUSTOM_OBJECT)
            144: 'HotA Decoration', 145: 'HotA Decoration', 146: 'HotA Decoration',
            // IDs 165–211: HotA/SoD adventure map decoration objects
            // (not C++ enum; names derived from animation file prefixes)
            165: 'Decoration', 166: 'Decoration', 167: 'Decoration', 168: 'Decoration',
            169: 'Decoration', 170: 'Decoration', 171: 'Decoration', 172: 'Decoration',
            173: 'Decoration', 174: 'Decoration', 175: 'Decoration', 176: 'Decoration',
            177: 'Lake',                // AVLlk* lake decorations
            178: 'Decoration', 179: 'Decoration', 180: 'Decoration', 181: 'Decoration',
            182: 'Decoration', 183: 'Decoration', 184: 'Decoration', 185: 'Decoration',
            186: 'Decoration', 187: 'Decoration', 188: 'Decoration', 189: 'Decoration',
            190: 'Decoration', 191: 'Decoration', 192: 'Decoration', 193: 'Decoration',
            194: 'Decoration', 195: 'Decoration', 196: 'Decoration', 197: 'Decoration',
            198: 'Decoration',
            199: 'Swamp Water',         // avlswtr* – swamp water trail decorations
            200: 'Decoration', 201: 'Decoration', 202: 'Decoration', 203: 'Decoration',
            204: 'Decoration', 205: 'Decoration',
            206: 'Sand Decoration',     // avlxds* – extra sand/desert decorations
            207: 'Dirt Decoration',     // avlxdt* – extra dirt terrain decorations
            208: 'Grass Decoration',    // avlxgr* – extra grass terrain decorations
            209: 'Rough Decoration',    // avlxro* – extra rough terrain decorations
            210: 'Subterranean Decoration', // avlxsu* – extra subterranean decorations
            211: 'Swamp Decoration',    // avlxsw* – extra swamp terrain decorations
            // Extra SoD/HotA objects
            213: 'Freelancers Guild',
            221: 'Trading Post (Snow)',
            // Terrain overlays (222–231)
            222: 'Clover Field', 223: 'Cursed Ground', 224: 'Evil Fog',
            225: 'Favorable Winds', 226: 'Fiery Fields', 227: 'Holy Grounds',
            228: 'Lucid Pools', 229: 'Magic Clouds', 230: 'Magic Plains',
            231: 'Rocklands',
        };
        return names[cls] || `Object ${cls}`;
    }

    // ----------------------------------------------------------------
    // Minimap rendering
    // ----------------------------------------------------------------
    function renderMinimap(map, level = 0, displaySize = 256) {
        if (!map.terrain || !map.terrain[level]) return null;

        const size = map.mapSize;
        // Always render at 1px per tile; CSS scales to displaySize
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const imgData = ctx.createImageData(size, size);
        if (!imgData || !imgData.data) return null;
        const pixels = imgData.data;

        // Build object ownership map for towns/mines/heroes
        const ownerMap = new Map(); // "x,y" -> ownerIdx
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
                    const tIdx = tile.terrain;
                    const colors = TERRAIN_COLORS[tIdx] || TERRAIN_COLORS[0];
                    const isBlocked = (tile.flags & 0x01) !== 0;
                    if (isBlocked) {
                        r = colors[3]; g = colors[4]; b = colors[5];
                    } else {
                        r = colors[0]; g = colors[1]; b = colors[2];
                    }
                    if (tile.road > 0) {
                        r = Math.min(255, r + 20);
                        g = Math.min(255, g + 15);
                        b = Math.min(255, b + 10);
                    }
                }

                const pi = (y * size + x) * 4;
                pixels[pi] = r;
                pixels[pi + 1] = g;
                pixels[pi + 2] = b;
                pixels[pi + 3] = 255;
            }
        }

        ctx.putImageData(imgData, 0, 0);
        canvas._displaySize = displaySize; // hint to caller for CSS sizing
        return canvas;
    }

    // ----------------------------------------------------------------
    // H3C Campaign Parser
    // ----------------------------------------------------------------
    // Gzip-compressed header format (existing SoD/HotA files): version 4=RoE, 5=AB, 6=SoD, 7=Chronicles, 10=HotA
    // Raw binary header format (old RoE/AB files, first byte < 0x20): version 1=RoE, 2=AB, 3=SoD, 4=Chronicles, 10=HotA
    const CAMPAIGN_VERSIONS_GZIP = { 4: 'RoE', 5: 'AB', 6: 'SoD', 7: 'Chronicles', 10: 'HotA' };
    const CAMPAIGN_VERSIONS_RAW  = { 1: 'RoE', 2: 'AB', 3: 'SoD', 4: 'Chronicles', 10: 'HotA' };
    // Keep single alias for external compat
    const CAMPAIGN_VERSIONS = Object.assign({}, CAMPAIGN_VERSIONS_RAW, CAMPAIGN_VERSIONS_GZIP);

    async function parseH3C(rawData, opts = {}) {
        const u8 = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);

        // Detect format:
        //   Gzip-compressed header: file starts with gzip magic 0x1f 0x8b
        //     → block 0 = compressed header, blocks 1..N = compressed maps
        //   Raw binary header: file starts with version byte (< 0x20)
        //     → header is raw bytes starting at offset 0, all gzip blocks = maps
        const isGzipFormat = u8[0] === 0x1f && u8[1] === 0x8b;
        const mapBlocks = splitGzipBlocks(u8); // all gzip blocks in the file

        let headerData;
        let mapBlocksStart;
        if (isGzipFormat) {
            if (mapBlocks.length === 0) throw new Error('No gzip blocks found in H3C file');
            headerData = await decompressAsync(mapBlocks[0]);
            if (!headerData) throw new Error('Failed to decompress campaign header');
            mapBlocksStart = 1; // blocks[1..N] are map blocks
        } else {
            // Raw binary format: header IS the file data before the first gzip block
            headerData = u8;
            mapBlocksStart = 0; // ALL gzip blocks are map blocks
        }

        // Decompress map blocks
        const decompressedMaps = [];
        for (let i = mapBlocksStart; i < mapBlocks.length; i++) {
            try {
                decompressedMaps.push(await decompressAsync(mapBlocks[i]));
            } catch (e) {
                decompressedMaps.push(null);
            }
        }

        const campaign = {};
        const rawStrings = [];
        const r = new BinaryReader(headerData, { encoding: opts.encoding || null, rawStrings });

        campaign.version = r.u32();
        const ver = campaign.version;
        // Normalize raw-format version numbers to gzip-format equivalents for condition checks
        // Raw: 1=RoE→4, 2=AB→5, 3=SoD→6, 4=Chr→7, 10=HotA→10
        const normVer = (!isGzipFormat && ver >= 1 && ver <= 4) ? ver + 3 : ver;
        const versionTable = isGzipFormat ? CAMPAIGN_VERSIONS_GZIP : CAMPAIGN_VERSIONS_RAW;
        campaign.versionName = versionTable[ver] || `Unknown v${ver}`;
        const isHotA = normVer === 10;

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

        // Difficulty choice available for AB+ (normVer > 4 means AB or newer)
        if (normVer > 4) {
            campaign.allowDifficultySelection = r.bool();
        }

        // Music: present in gzip-format (SoD/HotA) but NOT in raw binary format (RoE v1)
        if (isGzipFormat) {
            campaign.music = r.u8();
        }

        // Scenario count from remaining map blocks (for non-HotA)
        if (!isHotA) {
            campaign.scenarioCount = decompressedMaps.length;
        }

        // Parse scenario definitions
        campaign.scenarios = [];
        const sc_count = campaign.scenarioCount;
        // Raw binary ROE format has minimal scenario info (mapName + packedSize + precond only)
        // Full metadata (regionColor, difficulty, regionText, prolog/epilog, travel) is only in gzip format
        const hasScenarioMeta = isGzipFormat;

        for (let i = 0; i < sc_count; i++) {
            const sc = { index: i };
            try {
                sc.mapName = r.str();
                sc.packedMapSize = r.u32();

                // Preconditions: bitmask (u8 if <=8 scenarios, u16 if >8)
                sc.preconditions = sc_count > 8 ? r.u16() : r.u8();

                if (hasScenarioMeta) {
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

                    // Artifact bitmask: HotA=21, SoD+(normVer>=6)=18, RoE/AB=17
                    const artifactBytes = isHotA ? 21 : (normVer >= 6 ? 18 : 17);
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
                } // end hasScenarioMeta
            } catch (e) {
                sc.parseError = e.message;
            }
            campaign.scenarios.push(sc);
        }

        // Embedded H3M maps
        campaign.maps = [];
        campaign.rawMaps = [];
        let mapBlockIdx = 0;

        for (let i = 0; i < sc_count; i++) {
            const sc = campaign.scenarios[i];
            const isVoid = !sc.mapName || sc.mapName.length === 0;

            if (!isVoid && mapBlockIdx < mapBlocks.length - mapBlocksStart) {
                campaign.rawMaps.push(mapBlocks[mapBlocksStart + mapBlockIdx]);
                const mapDec = decompressedMaps[mapBlockIdx];
                if (mapDec) {
                    try {
                        const mapData = parseH3M(mapDec, { encoding: opts.encoding || null });
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
        campaign._rawStringBytes = rawStrings.length > 0 ? mergeUint8Arrays(rawStrings) : new Uint8Array(0);

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
    // Artifact / Spell name helpers
    // ----------------------------------------------------------------
    function getArtifactName(obj) {
        const cls = obj.objClass;
        if (cls === OBJ.SPELL_SCROLL) {
            const spellName = (obj.spellId != null && SPELL_NAMES[obj.spellId]) ? SPELL_NAMES[obj.spellId] : `Spell #${obj.spellId}`;
            return `Spell Scroll: ${spellName}`;
        }
        if (cls === OBJ.ARTIFACT) {
            return ARTIFACT_NAMES[obj.objSubID] || `Artifact #${obj.objSubID}`;
        }
        if (cls === OBJ.RANDOM_ART) return 'Random Artifact';
        if (cls === OBJ.RANDOM_TREASURE) return 'Random Treasure';
        if (cls === OBJ.RANDOM_MINOR) return 'Random Minor Artifact';
        if (cls === OBJ.RANDOM_MAJOR) return 'Random Major Artifact';
        if (cls === OBJ.RANDOM_RELIC) return 'Random Relic';
        return 'Unknown Artifact';
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
        ARTIFACT_NAMES, SPELL_NAMES,

        // Helpers
        getObjectClassName,
        getArtifactName,
    };
})();
