// StuffIt 5 archive extractor for HoMM3 Explorer
// Method 13 (LZ+Huffman) decompressor derived from The Unarchiver (XADStuffIt13Handle.m)
// The Unarchiver is copyright Dag Ågren / The Unarchiver Project, LGPL 2.1
// https://theunarchiver.com/

const SITExtract = (() => {
    'use strict';

    // ── Preset code-length tables ─────────────────────────────────────────────
    // From XADStuffIt13Handle.m (The Unarchiver, LGPL 2.1)

    /* eslint-disable */
    const FIRST_CODE_LENGTHS = [
        // Set 1
        [ 4, 5, 7, 8, 8, 9, 9, 9, 9, 7, 9, 9, 9, 8, 9, 9,
          9, 9, 9, 9, 9, 9, 9,10, 9, 9,10,10, 9,10, 9, 9,
          5, 9, 9, 9, 9,10, 9, 9, 9, 9, 9, 9, 9, 9, 7, 9,
          9, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
          9, 8, 9, 9, 8, 8, 9, 9, 9, 9, 9, 9, 9, 7, 8, 9,
          7, 9, 9, 7, 7, 9, 9, 9, 9,10, 9,10,10,10, 9, 9,
          9, 5, 9, 8, 7, 5, 9, 8, 8, 7, 9, 9, 8, 8, 5, 5,
          7,10, 5, 8, 5, 8, 9, 9, 9, 9, 9,10, 9, 9,10, 9,
          9,10,10,10,10,10,10,10, 9,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10, 9, 9,10,10,10,10,10,10,
         10,10,10,10,10,10,10,10,10,10, 9,10,10,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
         10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10, 9, 9,10,10,
          9,10,10,10,10,10,10,10, 9,10,10,10, 9,10, 9, 5,
          6, 5, 5, 8, 9, 9, 9, 9, 9, 9,10,10,10, 9,10,10,
         10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
         10,10,10, 9,10, 9, 9, 9,10, 9,10, 9,10, 9,10, 9,
         10,10,10, 9,10, 9,10,10, 9, 9, 9, 6, 9, 9,10, 9,
          5],
        // Set 2
        [ 4, 7, 7, 8, 7, 8, 8, 8, 8, 7, 8, 7, 8, 7, 9, 8,
          8, 8, 9, 9, 9, 9,10,10, 9,10,10,10,10,10, 9, 9,
          5, 9, 8, 9, 9,11,10, 9, 8, 9, 9, 9, 8, 9, 7, 8,
          8, 8, 9, 9, 9, 9, 9,10, 9, 9, 9,10, 9, 9,10, 9,
          8, 8, 7, 7, 7, 8, 8, 9, 8, 8, 9, 9, 8, 8, 7, 8,
          7,10, 8, 7, 7, 9, 9, 9, 9,10,10,11,11,11,10, 9,
          8, 6, 8, 7, 7, 5, 7, 7, 7, 6, 9, 8, 6, 7, 6, 6,
          7, 9, 6, 6, 6, 7, 8, 8, 8, 8, 9,10, 9,10, 9, 9,
          8, 9,10,10, 9,10,10, 9, 9,10,10,10,10,10,10,10,
          9,10,10,11,10,10,10,10,10,10,10,11,10,11,10,10,
          9,11,10,10,10,10,10,10, 9, 9,10,11,10,11,10,11,
         10,12,10,11,10,12,11,12,10,12,10,11,10,11,11,11,
          9,10,11,11,11,12,12,10,10,10,11,11,10,11,10,10,
          9,11,10,11,10,11,11,11,10,11,11,12,11,11,10,10,
         10,11,10,10,11,11,12,10,10,11,11,12,11,11,10,11,
          9,12,10,11,11,11,10,11,10,11,10,11, 9,10, 9, 7,
          3, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 9,11,10,10,10,
         12,13,11,12,12,11,13,12,12,11,12,12,13,12,14,13,
         14,13,15,13,14,15,15,14,13,15,15,14,15,14,15,15,
         14,15,13,13,14,15,15,14,14,16,16,15,15,15,12,15,
         10],
        // Set 3
        [ 6, 6, 6, 6, 6, 9, 8, 8, 4, 9, 8, 9, 8, 9, 9, 9,
          8, 9, 9,10, 8,10,10,10, 9,10,10,10, 9,10,10, 9,
          9, 9, 8,10, 9,10, 9,10, 9,10, 9,10, 9, 9, 8, 9,
          8, 9, 9, 9,10,10,10,10, 9, 9, 9,10, 9,10, 9, 9,
          7, 8, 8, 9, 8, 9, 9, 9, 8, 9, 9,10, 9, 9, 8, 9,
          8, 9, 8, 8, 8, 9, 9, 9, 9, 9,10,10,10,10,10, 9,
          8, 8, 9, 8, 9, 7, 8, 8, 9, 8,10,10, 8, 9, 8, 8,
          8,10, 8, 8, 8, 8, 9, 9, 9, 9,10,10,10,10,10, 9,
          7, 9, 9,10,10,10,10,10, 9,10,10,10,10,10,10, 9,
          9,10,10,10,10,10,10,10,10, 9,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10, 9, 9, 9,10,10,10,10,10,
         10,10,10,10,10,10,10,10,10,10, 9,10,10,10,10, 9,
          8, 9,10,10,10,10,10,10,10,10,10,10, 9,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10,10,10,10, 9,
          9,10,10,10,10,10,10, 9,10,10,10,10,10,10, 9, 9,
          9,10,10,10,10,10,10, 9, 9,10, 9, 9, 8, 9, 8, 9,
          4, 6, 6, 6, 7, 8, 8, 9, 9,10,10,10, 9,10,10,10,
         10,10,10,10,10,10,10,10,10,10,10,10,10,10, 7,10,
         10,10, 7,10,10, 7, 7, 7, 7, 7, 6, 7,10, 7, 7,10,
          7, 7, 7, 6, 7, 6, 6, 7, 7, 6, 6, 9, 6, 9,10, 6,
         10],
        // Set 4
        [ 2, 6, 6, 7, 7, 8, 7, 8, 7, 8, 8, 9, 8, 9, 9, 9,
          8, 8, 9, 9, 9,10,10, 9, 8,10, 9,10, 9,10, 9, 9,
          6, 9, 8, 9, 9,10, 9, 9, 9,10, 9, 9, 9, 9, 8, 8,
          8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,10,10, 9,
          7, 7, 8, 8, 8, 8, 9, 9, 7, 8, 9,10, 8, 8, 7, 8,
          8,10, 8, 8, 8, 9, 8, 9, 9,10, 9,11,10,11, 9, 9,
          8, 7, 9, 8, 8, 6, 8, 8, 8, 7,10, 9, 7, 8, 7, 7,
          8,10, 7, 7, 7, 8, 9, 9, 9, 9,10,11, 9,11,10, 9,
          7, 9,10,10,10,11,11,10,10,11,10,10,10,11,11,10,
          9,10,10,11,10,11,10,11,10,10,10,11,10,11,10,10,
          9,10,10,11,10,10,10,10, 9,10,10,10,10,11,10,11,
         10,11,10,11,11,11,10,12,10,11,10,11,10,11,11,10,
          8,10,10,11,10,11,11,11,10,11,10,11,10,11,11,11,
          9,10,11,11,10,11,11,11,10,11,11,11,10,10,10,10,
         10,11,10,10,11,11,10,10, 9,11,10,10,11,11,10,10,
         10,11,10,10,10,10,10,10, 9,11,10,10, 8,10, 8, 6,
          5, 6, 6, 7, 7, 8, 8, 8, 9,10,11,10,10,11,11,12,
         12,10,11,12,12,12,12,13,13,13,13,13,12,13,13,15,
         14,12,14,15,16,12,12,13,15,14,16,15,17,18,15,17,
         16,15,15,15,15,13,13,10,14,12,13,17,17,18,10,17,
          4],
        // Set 5
        [ 7, 9, 9, 9, 9, 9, 9, 9, 9, 8, 9, 9, 9, 7, 9, 9,
          9, 9, 9, 9, 9, 9, 9,10, 9,10, 9,10, 9,10, 9, 9,
          5, 9, 7, 9, 9, 9, 9, 9, 7, 7, 7, 9, 7, 7, 8, 7,
          8, 8, 7, 7, 9, 9, 9, 9, 7, 7, 7, 9, 9, 9, 9, 9,
          9, 7, 9, 7, 7, 7, 7, 9, 9, 7, 9, 9, 7, 7, 7, 7,
          7, 9, 7, 8, 7, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
          9, 7, 8, 7, 7, 7, 8, 8, 6, 7, 9, 7, 7, 8, 7, 5,
          6, 9, 5, 7, 5, 6, 7, 7, 9, 8, 9, 9, 9, 9, 9, 9,
          9, 9,10, 9,10,10,10, 9, 9,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10, 9,10,10,10,
          9,10,10,10, 9, 9,10, 9, 9, 9, 9,10,10,10,10,10,
         10,10,10,10,10,10, 9,10,10,10,10,10,10,10,10,10,
          9,10,10,10, 9,10,10,10, 9, 9, 9,10,10,10,10,10,
          9,10, 9,10,10, 9,10,10, 9,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
          9,10,10,10,10,10,10,10, 9,10, 9,10, 9,10,10, 9,
          5, 6, 8, 8, 7, 7, 7, 9, 9, 9, 9, 9, 9, 9, 9, 9,
          9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
          9,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
         10,10,10,10,10,10,10,10, 9,10,10, 5,10, 8, 9, 8,
          9]
    ];

    const SECOND_CODE_LENGTHS = [
        // Set 1
        [ 4, 5, 6, 6, 7, 7, 6, 7, 7, 7, 6, 8, 7, 8, 8, 8,
          8, 9, 6, 9, 8, 9, 8, 9, 9, 9, 8,10, 5, 9, 7, 9,
          6, 9, 8,10, 9,10, 8, 8, 9, 9, 7, 9, 8, 9, 8, 9,
          8, 8, 6, 9, 9, 8, 8, 9, 9,10, 8, 9, 9,10, 8,10,
          8, 8, 8, 8, 8, 9, 7,10, 6, 9, 9,11, 7, 8, 8, 9,
          8,10, 7, 8, 6, 9,10, 9, 9,10, 8,11, 9,11, 9,10,
          9, 8, 9, 8, 8, 8, 8,10, 9, 9,10,10, 8, 9, 8, 8,
          8,11, 9, 8, 8, 9, 9,10, 8,11,10,10, 8,10, 9,10,
          8, 9, 9,11, 9,11, 9,10,10,11,10,12, 9,12,10,11,
         10,11, 9,10,10,11,10,11,10,11,10,11,10,10,10, 9,
          9, 9, 8, 7, 6, 8,11,11, 9,12,10,12, 9,11,11,11,
         10,12,11,11,10,12,10,11,10,10,10,11,10,11,11,11,
          9,12,10,12,11,12,10,11,10,12,11,12,11,12,11,12,
         10,12,11,12,11,11,10,12,10,11,10,12,10,12,10,12,
         10,11,11,11,10,11,11,11,10,12,11,12,10,10,11,11,
          9,12,11,12,10,11,10,12,10,11,10,12,10,11,10, 7,
          5, 4, 6, 6, 7, 7, 7, 8, 8, 7, 7, 6, 8, 6, 7, 7,
          9, 8, 9, 9,10,11,11,11,12,11,10,11,12,11,12,11,
         12,12,12,12,11,12,12,11,12,11,12,11,13,11,12,10,
         13,10,14,14,13,14,15,14,16,15,15,18,18,18, 9,18,
          8],
        // Set 2
        [ 5, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 8, 7, 8, 7, 7,
          7, 8, 8, 8, 8, 9, 8, 9, 8, 9, 9, 9, 7, 9, 8, 8,
          6, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 8,
          8, 8, 8, 9, 8, 9, 8, 9, 9,10, 8,10, 8, 9, 9, 8,
          8, 8, 7, 8, 8, 9, 8, 9, 7, 9, 8,10, 8, 9, 8, 9,
          8, 9, 8, 8, 8, 9, 9, 9, 9,10, 9,11, 9,10, 9,10,
          8, 8, 8, 9, 8, 8, 8, 9, 9, 8, 9,10, 8, 9, 8, 8,
          8,11, 8, 7, 8, 9, 9, 9, 9,10, 9,10, 9,10, 9, 8,
          8, 9, 9,10, 9,10, 9,10, 8,10, 9,10, 9,11,10,11,
          9,11,10,10,10,11, 9,11, 9,10, 9,11, 9,11,10,10,
          9,10, 9, 9, 8,10, 9,11, 9, 9, 9,11,10,11, 9,11,
          9,11, 9,11,10,11,10,11,10,11, 9,10,10,11,10,10,
          8,10, 9,10,10,11, 9,11, 9,10,10,11, 9,10,10, 9,
          9,10, 9,10, 9,10, 9,10, 9,11, 9,11,10,10, 9,10,
          9,11, 9,11, 9,11, 9,10, 9,11, 9,11, 9,11, 9,10,
          8,11, 9,10, 9,10, 9,10, 8,10, 8, 9, 8, 9, 8, 7,
          4, 4, 5, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 7, 8, 8,
          9, 9,10,10,10,10,10,10,11,11,10,10,12,11,11,12,
         12,11,12,12,11,12,12,12,12,12,12,11,12,11,13,12,
         13,12,13,14,14,14,15,13,14,13,14,18,18,17, 7,16,
          9],
        // Set 3
        [ 5, 6, 6, 6, 6, 7, 7, 7, 6, 8, 7, 8, 7, 9, 8, 8,
          7, 7, 8, 9, 9, 9, 9,10, 8, 9, 9,10, 8,10, 9, 8,
          6,10, 8,10, 8,10, 9, 9, 9, 9, 9,10, 9, 9, 8, 9,
          8, 9, 8, 9, 9,10, 9,10, 9, 9, 8,10, 9,11,10, 8,
          8, 8, 8, 9, 7, 9, 9,10, 8, 9, 8,11, 9,10, 9,10,
          8, 9, 9, 9, 9, 8, 9, 9,10,10,10,12,10,11,10,10,
          8, 9, 9, 9, 8, 9, 8, 8,10, 9,10,11, 8,10, 9, 9,
          8,12, 8, 9, 9, 9, 9, 8, 9,10, 9,12,10,10,10, 8,
          7,11,10, 9,10,11, 9,11, 7,11,10,12,10,12,10,11,
          9,11, 9,12,10,12,10,12,10, 9,11,12,10,12,10,11,
          9,10, 9,10, 9,11,11,12, 9,10, 8,12,11,12, 9,12,
         10,12,10,13,10,12,10,12,10,12,10, 9,10,12,10, 9,
          8,11,10,12,10,12,10,12,10,11,10,12, 8,12,10,11,
         10,10,10,12, 9,11,10,12,10,12,11,12,10, 9,10,12,
          9,10,10,12,10,11,10,11,10,12, 8,12, 9,12, 8,12,
          8,11,10,11,10,11, 9,10, 8,10, 9, 9, 8, 9, 8, 7,
          4, 3, 5, 5, 6, 5, 6, 6, 7, 7, 8, 8, 8, 7, 7, 7,
          9, 8, 9, 9,11, 9,11, 9, 8, 9, 9,11,12,11,12,12,
         13,13,12,13,14,13,14,13,14,13,13,13,12,13,13,12,
         13,13,14,14,13,13,14,14,14,14,15,18,17,18, 8,16,
         10],
        // Set 4
        [ 4, 5, 6, 6, 6, 6, 7, 7, 6, 7, 7, 9, 6, 8, 8, 7,
          7, 8, 8, 8, 6, 9, 8, 8, 7, 9, 8, 9, 8, 9, 8, 9,
          6, 9, 8, 9, 8,10, 9, 9, 8,10, 8,10, 8, 9, 8, 9,
          8, 8, 7, 9, 9, 9, 9, 9, 8,10, 9,10, 9,10, 9, 8,
          7, 8, 9, 9, 8, 9, 9, 9, 7,10, 9,10, 9, 9, 8, 9,
          8, 9, 8, 8, 8, 9, 9,10, 9, 9, 8,11, 9,11,10,10,
          8, 8,10, 8, 8, 9, 9, 9,10, 9,10,11, 9, 9, 9, 9,
          8, 9, 8, 8, 8,10,10, 9, 9, 8,10,11,10,11,11, 9,
          8, 9,10,11, 9,10,11,11, 9,12,10,10,10,12,11,11,
          9,11,11,12, 9,11, 9,10,10,10,10,12, 9,11,10,11,
          9,11,11,11,10,11,11,12, 9,10,10,12,11,11,10,11,
          9,11,10,11,10,11, 9,11,11, 9, 8,11,10,11,11,10,
          7,12,11,11,11,11,11,12,10,12,11,13,11,10,12,11,
         10,11,10,11,10,11,11,11,10,12,11,11,10,11,10,10,
         10,11,10,12,11,12,10,11, 9,11,10,11,10,11,10,12,
          9,11,11,11, 9,11,10,10, 9,11,10,10, 9,10, 9, 7,
          4, 5, 5, 5, 6, 6, 7, 6, 8, 7, 8, 9, 9, 7, 8, 8,
         10, 9,10,10,12,10,11,11,11,11,10,11,12,11,11,11,
         11,11,13,12,11,12,13,12,12,12,13,11, 9,12,13, 7,
         13,11,13,11,10,11,13,15,15,12,14,15,15,15, 6,15,
          5],
        // Set 5
        [ 8,10,11,11,11,12,11,11,12, 6,11,12,10, 5,12,12,
         12,12,12,12,12,13,13,14,13,13,12,13,12,13,12,15,
          4,10, 7, 9,11,11,10, 9, 6, 7, 8, 9, 6, 7, 6, 7,
          8, 7, 7, 8, 8, 8, 8, 8, 8, 9, 8, 7,10, 9,10,10,
         11, 7, 8, 6, 7, 8, 8, 9, 8, 7,10,10, 8, 7, 8, 8,
          7,10, 7, 6, 7, 9, 9, 8,11,11,11,10,11,11,11, 8,
         11, 6, 7, 6, 6, 6, 6, 8, 7, 6,10, 9, 6, 7, 6, 6,
          7,10, 6, 5, 6, 7, 7, 7,10, 8,11, 9,13, 7,14,16,
         12,14,14,15,15,16,16,14,15,15,15,15,15,15,15,15,
         14,15,13,14,14,16,15,17,14,17,15,17,12,14,13,16,
         12,17,13,17,14,13,13,14,14,12,13,15,15,14,15,17,
         14,17,15,14,15,16,12,16,15,14,15,16,15,16,17,17,
         15,15,17,17,13,14,15,15,13,12,16,16,17,14,15,16,
         15,15,13,13,15,13,16,17,15,17,17,17,16,17,14,17,
         14,16,15,17,15,15,14,17,15,17,15,16,15,15,16,16,
         14,17,17,15,15,16,15,17,15,14,16,16,16,16,16,12,
          4, 4, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8, 8, 9, 9,
          9, 9, 9,10,10,10,11,10,11,11,11,11,11,12,12,12,
         13,13,12,13,12,14,14,12,13,13,13,13,14,12,13,13,
         14,14,14,13,14,14,15,15,13,15,13,17,17,17, 9,17,
          7]
    ];

    const OFFSET_CODE_LENGTHS = [
        [5,6,3,3,3,3,3,3,3,4,6],           // set 1 (11)
        [5,6,4,4,3,3,3,3,3,4,4,4,6],       // set 2 (13)
        [6,7,4,4,3,3,3,3,3,4,4,4,5,7],     // set 3 (14)
        [3,6,5,4,2,3,3,3,4,4,6],           // set 4 (11)
        [6,7,7,6,4,3,2,2,3,3,6]            // set 5 (11)
    ];

    const OFFSET_CODE_SIZES = [11, 13, 14, 11, 11];

    // Meta-code for dynamic mode – already LSB-first (addValue:forCodeWithLowBitFirst:)
    const META_CODES = [
        0x5d8,0x058,0x040,0x0c0,0x000,0x078,0x02b,0x014,
        0x00c,0x01c,0x01b,0x00b,0x010,0x020,0x038,0x018,
        0x0d8,0xbd8,0x180,0x680,0x380,0xf80,0x780,0x480,
        0x080,0x280,0x3d8,0xfd8,0x7d8,0x9d8,0x1d8,0x004,
        0x001,0x002,0x007,0x003,0x008
    ];
    const META_CODE_LENGTHS = [
        11,8,8,8,8,7,6,5,5,5,5,6,5,6,7,7,9,12,10,11,11,12,
        12,11,11,11,12,12,12,12,12,5,2,2,3,4,5
    ];
    /* eslint-enable */

    // ── Helpers ───────────────────────────────────────────────────────────────

    function u16be(d, p) {
        return (d[p] << 8) | d[p + 1];
    }

    function u32be(d, p) {
        return ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
    }

    // ── LSB-first bit stream ──────────────────────────────────────────────────

    function BitStream(data, startPos, endPos) {
        this.data = data;
        this.pos  = startPos;
        this.end  = endPos;
        this.buf  = 0;
        this.bits = 0;
    }

    BitStream.prototype.peek = function (n) {
        while (this.bits < n && this.pos < this.end) {
            this.buf = (this.buf | (this.data[this.pos++] << this.bits)) >>> 0;
            this.bits += 8;
        }
        return this.buf & ((1 << n) - 1);
    };

    BitStream.prototype.skip = function (n) {
        this.buf >>>= n;
        this.bits -= n;
    };

    BitStream.prototype.readN = function (n) {
        const v = this.peek(n);
        this.skip(n);
        return v;
    };

    // ── Huffman tables ────────────────────────────────────────────────────────

    function reverseBits(v, len) {
        let r = 0;
        for (let i = 0; i < len; i++) { r = (r << 1) | (v & 1); v >>= 1; }
        return r;
    }

    // Build LSB-first lookup table from canonical code lengths.
    // shortestCodeIsZeros = YES (standard canonical assignment, code starts at 0).
    function buildCanonical(lengths, numSymbols) {
        let maxLen = 0;
        for (let i = 0; i < numSymbols; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
        if (maxLen === 0) return null;

        const tableSize = 1 << maxLen;
        const table = new Int32Array(tableSize).fill(-1);

        let code = 0;
        for (let len = 1; len <= maxLen; len++) {
            for (let sym = 0; sym < numSymbols; sym++) {
                if (lengths[sym] !== len) continue;
                const rc   = reverseBits(code, len);
                const step = 1 << len;
                for (let j = rc; j < tableSize; j += step) table[j] = (sym << 5) | len;
                code++;
            }
            code <<= 1;
        }
        return { table, maxLen };
    }

    // Build LSB-first lookup table from explicit LSB-first codes (meta-code).
    function buildFromCodes(codes, codeLengths, numSymbols) {
        let maxLen = 0;
        for (let i = 0; i < numSymbols; i++) if (codeLengths[i] > maxLen) maxLen = codeLengths[i];

        const tableSize = 1 << maxLen;
        const table = new Int32Array(tableSize).fill(-1);

        for (let sym = 0; sym < numSymbols; sym++) {
            const len  = codeLengths[sym];
            const code = codes[sym];
            const step = 1 << len;
            for (let j = code; j < tableSize; j += step) table[j] = (sym << 5) | len;
        }
        return { table, maxLen };
    }

    function readSym(bs, h) {
        const bits = bs.peek(h.maxLen);
        const e = h.table[bits];
        if (e < 0) throw new Error('Bad Huffman code at stream pos ' + bs.pos);
        bs.skip(e & 31);
        return e >> 5;
    }

    // ── Dynamic code parser (meta-code) ──────────────────────────────────────

    function parseCodeOfSize(bs, metaH, numCodes) {
        let curLen = 0;
        const lengths = new Int32Array(numCodes);

        for (let i = 0; i < numCodes; i++) {
            const val = readSym(bs, metaH);

            if (val <= 30) {
                curLen = val + 1;
            } else if (val === 31) {
                curLen = -1;
            } else if (val === 32) {
                curLen++;
            } else if (val === 33) {
                curLen--;
            } else if (val === 34) {
                if (bs.readN(1)) lengths[i++] = curLen;
            } else if (val === 35) {
                let n = bs.readN(3) + 2;
                while (n--) lengths[i++] = curLen;
            } else if (val === 36) {
                let n = bs.readN(6) + 10;
                while (n--) lengths[i++] = curLen;
            }
            lengths[i] = curLen;
        }
        return lengths;
    }

    // ── Method 15 decompressor: Arsenic (BWT + arithmetic coding) ────────────
    // Derived from XADStuffItArsenicHandle.m + BWT.c (The Unarchiver, LGPL 2.1)

    const ARSENIC_NUM_BITS = 26;
    const ARSENIC_ONE  = 1 << (ARSENIC_NUM_BITS - 1); // 2^25
    const ARSENIC_HALF = 1 << (ARSENIC_NUM_BITS - 2); // 2^24

    /* eslint-disable */
    const ARSENIC_RAND = [
        0xee, 0x56, 0xf8, 0xc3, 0x9d, 0x9f, 0xae, 0x2c,
        0xad, 0xcd, 0x24, 0x9d, 0xa6, 0x101,0x18, 0xb9,
        0xa1, 0x82, 0x75, 0xe9, 0x9f, 0x55, 0x66, 0x6a,
        0x86, 0x71, 0xdc, 0x84, 0x56, 0x96, 0x56, 0xa1,
        0x84, 0x78, 0xb7, 0x32, 0x6a, 0x03, 0xe3, 0x02,
        0x11, 0x101,0x08, 0x44, 0x83, 0x100,0x43, 0xe3,
        0x1c, 0xf0, 0x86, 0x6a, 0x6b, 0x0f, 0x03, 0x2d,
        0x86, 0x17, 0x7b, 0x10, 0xf6, 0x80, 0x78, 0x7a,
        0xa1, 0xe1, 0xef, 0x8c, 0xf6, 0x87, 0x4b, 0xa7,
        0xe2, 0x77, 0xfa, 0xb8, 0x81, 0xee, 0x77, 0xc0,
        0x9d, 0x29, 0x20, 0x27, 0x71, 0x12, 0xe0, 0x6b,
        0xd1, 0x7c, 0x0a, 0x89, 0x7d, 0x87, 0xc4, 0x101,
        0xc1, 0x31, 0xaf, 0x38, 0x03, 0x68, 0x1b, 0x76,
        0x79, 0x3f, 0xdb, 0xc7, 0x1b, 0x36, 0x7b, 0xe2,
        0x63, 0x81, 0xee, 0x0c, 0x63, 0x8b, 0x78, 0x38,
        0x97, 0x9b, 0xd7, 0x8f, 0xdd, 0xf2, 0xa3, 0x77,
        0x8c, 0xc3, 0x39, 0x20, 0xb3, 0x12, 0x11, 0x0e,
        0x17, 0x42, 0x80, 0x2c, 0xc4, 0x92, 0x59, 0xc8,
        0xdb, 0x40, 0x76, 0x64, 0xb4, 0x55, 0x1a, 0x9e,
        0xfe, 0x5f, 0x06, 0x3c, 0x41, 0xef, 0xd4, 0xaa,
        0x98, 0x29, 0xcd, 0x1f, 0x02, 0xa8, 0x87, 0xd2,
        0xa0, 0x93, 0x98, 0xef, 0x0c, 0x43, 0xed, 0x9d,
        0xc2, 0xeb, 0x81, 0xe9, 0x64, 0x23, 0x68, 0x1e,
        0x25, 0x57, 0xde, 0x9a, 0xcf, 0x7f, 0xe5, 0xba,
        0x41, 0xea, 0xea, 0x36, 0x1a, 0x28, 0x79, 0x20,
        0x5e, 0x18, 0x4e, 0x7c, 0x8e, 0x58, 0x7a, 0xef,
        0x91, 0x02, 0x93, 0xbb, 0x56, 0xa1, 0x49, 0x1b,
        0x79, 0x92, 0xf3, 0x58, 0x4f, 0x52, 0x9c, 0x02,
        0x77, 0xaf, 0x2a, 0x8f, 0x49, 0xd0, 0x99, 0x4d,
        0x98, 0x101,0x60, 0x93, 0x100,0x75, 0x31, 0xce,
        0x49, 0x20, 0x56, 0x57, 0xe2, 0xf5, 0x26, 0x2b,
        0x8a, 0xbf, 0xde, 0xd0, 0x83, 0x34, 0xf4, 0x17,
    ];
    /* eslint-enable */

    function makeArsenicModel(first, last, increment, freqLimit) {
        const n = last - first + 1;
        const syms  = new Int32Array(n);
        const freqs = new Int32Array(n);
        for (let i = 0; i < n; i++) { syms[i] = i + first; freqs[i] = increment; }
        return { syms, freqs, n, total: increment * n, increment, freqLimit };
    }

    function arsenicResetModel(m) {
        m.total = m.increment * m.n;
        m.freqs.fill(m.increment);
    }

    function arsenicNextSym(dec, m) {
        const renorm    = (dec.range / m.total) | 0;
        const frequency = (dec.code / renorm) | 0;
        let cumul = 0, ni = 0;
        for (ni = 0; ni < m.n - 1; ni++) {
            if (cumul + m.freqs[ni] > frequency) break;
            cumul += m.freqs[ni];
        }
        const lo = renorm * cumul;
        dec.code -= lo;
        dec.range = (cumul + m.freqs[ni] === m.total) ? dec.range - lo : m.freqs[ni] * renorm;
        while (dec.range <= ARSENIC_HALF) {
            dec.range <<= 1;
            dec.code = (dec.code << 1) | arsenicReadBit(dec);
        }
        // Update frequency
        m.freqs[ni] += m.increment;
        m.total     += m.increment;
        if (m.total > m.freqLimit) {
            m.total = 0;
            for (let i = 0; i < m.n; i++) {
                m.freqs[i]++;
                m.freqs[i] >>= 1;
                m.total += m.freqs[i];
            }
        }
        return m.syms[ni];
    }

    function arsenicReadBitStr(dec, m, bits) {
        let res = 0;
        for (let i = 0; i < bits; i++) if (arsenicNextSym(dec, m)) res |= (1 << i);
        return res;
    }

    function arsenicReadBit(dec) {
        const d = dec.data;
        if (dec.bitBuf === 0) { dec.bitBuf = 0x80; dec.byte = d[dec.pos++] || 0; }
        const b = (dec.byte & dec.bitBuf) ? 1 : 0;
        dec.bitBuf >>>= 1;
        return b;
    }

    function arsenicCalcInverseBWT(transform, block, len) {
        const counts = new Int32Array(256);
        for (let i = 0; i < len; i++) counts[block[i]]++;
        const cum = new Int32Array(256);
        let total = 0;
        for (let i = 0; i < 256; i++) { cum[i] = total; total += counts[i]; counts[i] = 0; }
        for (let i = 0; i < len; i++) {
            transform[cum[block[i]] + counts[block[i]]] = i;
            counts[block[i]]++;
        }
    }

    function decompressMethod15(data, offset, compLen, uncompLen) {
        const end = offset + compLen;
        const dec = {
            data, pos: offset, end,
            bitBuf: 0, byte: 0,           // MSB-first bit reader state
            range: ARSENIC_ONE,
            code:  0,
        };

        // Prime the arithmetic decoder with ARSENIC_NUM_BITS (26) bits
        for (let i = 0; i < ARSENIC_NUM_BITS; i++) {
            dec.code = (dec.code << 1) | arsenicReadBit(dec);
        }

        const initM   = makeArsenicModel(0, 1,  1,    256);
        const selM    = makeArsenicModel(0, 10, 8,   1024);
        const mtfM    = [
            makeArsenicModel(  2,   3, 8, 1024),
            makeArsenicModel(  4,   7, 4, 1024),
            makeArsenicModel(  8,  15, 4, 1024),
            makeArsenicModel( 16,  31, 4, 1024),
            makeArsenicModel( 32,  63, 2, 1024),
            makeArsenicModel( 64, 127, 2, 1024),
            makeArsenicModel(128, 255, 1, 1024),
        ];

        if (arsenicReadBitStr(dec, initM, 8) !== 0x41 /* 'A' */ ||
            arsenicReadBitStr(dec, initM, 8) !== 0x73 /* 's' */)
            throw new Error('Arsenic: bad magic');

        const blockBits = arsenicReadBitStr(dec, initM, 4) + 9;
        const blockSize = 1 << blockBits;

        let endOfBlocks = arsenicNextSym(dec, initM) !== 0;

        const output  = new Uint8Array(uncompLen);
        const block   = new Uint8Array(blockSize);
        const mtfTab  = new Uint8Array(256);

        let outPos  = 0;
        let repeat  = 0;
        let rleCnt  = 0;
        let rleLast = 0;

        while (!endOfBlocks && outPos < uncompLen) {
            // ── Reset MTF table ─────────────────────────────────────────────
            for (let i = 0; i < 256; i++) mtfTab[i] = i;

            const randomized   = arsenicNextSym(dec, initM);
            const txIdx0       = arsenicReadBitStr(dec, initM, blockBits);
            let   numbytes     = 0;

            // ── Read block data through selector / MTF models ───────────────
            outer: for (;;) {
                let sel = arsenicNextSym(dec, selM);

                // Zero-run encoding (sel 0 or 1)
                if (sel < 2) {
                    let zeroState = 1, zeroCount = 0;
                    while (sel < 2) {
                        if (sel === 0) zeroCount += zeroState;
                        else           zeroCount += 2 * zeroState;
                        zeroState *= 2;
                        sel = arsenicNextSym(dec, selM);
                    }
                    const zeroVal = mtfTab[0]; // DecodeMTF(0) = table[0] (no-op move)
                    const limit   = Math.min(zeroCount, blockSize - numbytes);
                    for (let z = 0; z < limit; z++) block[numbytes++] = zeroVal;
                    // Fall through to handle the remaining `sel`
                }

                if (sel === 10) break;

                let symbol;
                if (sel === 2) {
                    symbol = 1;
                } else {
                    symbol = arsenicNextSym(dec, mtfM[sel - 3]);
                }
                if (numbytes >= blockSize) throw new Error('Arsenic: block overflow');
                // DecodeMTF
                const v = mtfTab[symbol];
                for (let k = symbol; k > 0; k--) mtfTab[k] = mtfTab[k - 1];
                mtfTab[0] = v;
                block[numbytes++] = v;
            }

            // ── Reset adaptive models for next block ────────────────────────
            arsenicResetModel(selM);
            for (const m of mtfM) arsenicResetModel(m);

            // ── Check end-of-blocks marker ──────────────────────────────────
            if (arsenicNextSym(dec, initM)) {
                arsenicReadBitStr(dec, initM, 32); // CRC (ignore)
                endOfBlocks = true;
            }

            // ── BWT inverse transform ───────────────────────────────────────
            const transform = new Int32Array(numbytes);
            arsenicCalcInverseBWT(transform, block, numbytes);

            // ── Drain any repeat left from previous block ───────────────────
            while (repeat > 0 && outPos < uncompLen) {
                output[outPos++] = rleLast;
                repeat--;
            }

            // ── BWT traversal + inline randomization (production-order) + RLE ─
            // Matches XAD: randomization XOR applied at bytecount positions, then RLE.
            // `rleCnt` and `rleLast` reset per block (XAD resets count/last per block).
            rleCnt  = 0;
            rleLast = 0;
            let txIdx = txIdx0;
            let rIdx = 0, rCnt = ARSENIC_RAND[0]; // per-block randomization state

            for (let i = 0; i < numbytes && outPos < uncompLen; i++) {
                txIdx = transform[txIdx];
                let byte = block[txIdx];

                // Randomization: XOR at exact production-order index (bytecount = i)
                if (randomized && rCnt === i) {
                    byte ^= 1;
                    rIdx = (rIdx + 1) & 255;
                    rCnt += ARSENIC_RAND[rIdx];
                }

                if (rleCnt === 4) {
                    rleCnt = 0;
                    if (byte === 0) continue; // skip run-count=0
                    output[outPos++] = rleLast;
                    repeat = byte - 1;
                    while (repeat > 0 && outPos < uncompLen) {
                        output[outPos++] = rleLast;
                        repeat--;
                    }
                } else {
                    if (byte === rleLast) rleCnt++;
                    else { rleCnt = 1; rleLast = byte; }
                    output[outPos++] = byte;
                }
            }
        }

        return output;
    }

    // ── Method 13 decompressor (LZ+Huffman, 65536-byte window) ───────────────

    function decompressMethod13(data, offset, compLen, uncompLen) {
        const bs = new BitStream(data, offset, offset + compLen);
        const hdrByte = bs.readN(8);
        const code    = hdrByte >> 4;

        let firstH, secondH, offsetH;

        if (code === 0) {
            // Dynamic mode: build trees from meta-code
            const metaH = buildFromCodes(META_CODES, META_CODE_LENGTHS, 37);

            const firstLens = parseCodeOfSize(bs, metaH, 321);
            firstH = buildCanonical(firstLens, 321);

            if (hdrByte & 0x08) {
                secondH = firstH; // shared with firstH
            } else {
                const secondLens = parseCodeOfSize(bs, metaH, 321);
                secondH = buildCanonical(secondLens, 321);
            }

            const offsetCount = (hdrByte & 0x07) + 10;
            const offsetLens  = parseCodeOfSize(bs, metaH, offsetCount);
            offsetH = buildCanonical(offsetLens, offsetCount);

        } else if (code >= 1 && code <= 5) {
            // Preset mode
            const idx = code - 1;
            firstH  = buildCanonical(FIRST_CODE_LENGTHS[idx],  321);
            secondH = buildCanonical(SECOND_CODE_LENGTHS[idx], 321);
            offsetH = buildCanonical(OFFSET_CODE_LENGTHS[idx], OFFSET_CODE_SIZES[idx]);

        } else {
            throw new Error('Unknown Method 13 block type: ' + code);
        }

        const output = new Uint8Array(uncompLen);
        const window = new Uint8Array(65536);  // 65536-byte LZSS sliding window
        let wpos   = 0;
        let outPos = 0;
        let currH  = firstH;

        while (outPos < uncompLen) {
            const val = readSym(bs, currH);

            if (val < 256) {
                // Literal byte
                output[outPos++] = val;
                window[wpos]     = val;
                wpos  = (wpos + 1) & 0xFFFF;
                currH = firstH;

            } else {
                currH = secondH;

                let matchLen;
                if (val < 0x13e) {
                    matchLen = val - 0x100 + 3;          // 3..317
                } else if (val === 0x13e) {
                    matchLen = bs.readN(10) + 65;
                } else if (val === 0x13f) {
                    matchLen = bs.readN(15) + 65;
                } else {
                    break;  // 0x140 = END marker
                }

                const bitlen = readSym(bs, offsetH);
                let matchOff;
                if (bitlen === 0)      matchOff = 1;
                else if (bitlen === 1) matchOff = 2;
                else                   matchOff = (1 << (bitlen - 1)) + bs.readN(bitlen - 1) + 1;

                let srcPos = (wpos - matchOff + 65536) & 0xFFFF;
                for (let k = 0; k < matchLen && outPos < uncompLen; k++) {
                    const b      = window[srcPos];
                    output[outPos++] = b;
                    window[wpos]     = b;
                    wpos   = (wpos + 1) & 0xFFFF;
                    srcPos = (srcPos + 1) & 0xFFFF;
                }
            }
        }

        return output;
    }

    // ── StuffIt 5 archive parser ──────────────────────────────────────────────

    function parseSit5(data) {
        let pos = 82; // skip 82-byte ASCII header

        const version = data[pos++];
        const flags   = data[pos++];
        if (version !== 5) throw new Error('Not a StuffIt 5 archive (version ' + version + ')');

        pos += 4; // totalsize
        pos += 4; // something

        const numfiles  = u16be(data, pos); pos += 2;
        const firstoffs = u32be(data, pos); pos += 4;
        pos += 2; // crc

        if (flags & 0x10) pos += 14;         // 14-byte extension block

        let commentsize = 0, length_b = 0;
        if (flags & 0x20) {
            commentsize = u16be(data, pos); pos += 2;
            length_b    = u16be(data, pos); pos += 2;
        }

        if (flags & 0x80) {                  // encrypted archive header hash
            const hashsize = data[pos++];
            pos += hashsize;
        }

        if (flags & 0x40) {                  // extra extension block
            const length_n = u16be(data, pos); pos += 2;
            pos += length_n * 20;
        }

        if (flags & 0x20) {
            pos += commentsize;
            pos += length_b;
        }

        pos = firstoffs;                     // seek to first entry (absolute offset)

        const entries = [];
        const dirs    = {};                  // entry-offset → path string
        let numentries = numfiles;

        for (let i = 0; i < numentries; i++) {
            const offs = pos;

            const headid = u32be(data, pos); pos += 4;
            if (headid !== 0xA5A5A5A5) throw new Error('Invalid SIT5 entry at offset ' + offs);

            const entryVer   = data[pos++];
            pos++;                          // skip
            const headersize = u16be(data, pos); pos += 2;
            const headerend  = offs + headersize;
            pos++;                          // skip
            const entryFlags = data[pos++];

            pos += 4; // creation date
            pos += 4; // modification date
            pos += 4; // prevoffs
            pos += 4; // nextoffs

            const diroffs    = u32be(data, pos); pos += 4;
            const namelength = u16be(data, pos); pos += 2;
            pos += 2; // headercrc

            const datalength  = u32be(data, pos); pos += 4;
            const datacomplen = u32be(data, pos); pos += 4;
            pos += 2; // datacrc
            pos += 2; // skip

            const isDir = !!(entryFlags & 0x40);

            let datamethod = 0, entryNumFiles = 0;
            if (isDir) {
                entryNumFiles = u16be(data, pos); pos += 2;
                if (datalength === 0xFFFFFFFF) {
                    // Phantom directory — appears after real dir entries, ignore
                    numentries++;
                    continue;
                }
            } else {
                datamethod = data[pos++];
                const passlen = data[pos++];
                if (passlen > 0) pos += passlen; // skip password data (not supported)
            }

            // Name
            const nameBytes = data.subarray(pos, pos + namelength);
            pos += namelength;
            const name = Array.from(nameBytes).map(b => String.fromCharCode(b)).join('');

            // Optional comment (present when header has extra space)
            if (pos < headerend) {
                const cs = u16be(data, pos); pos += 2;
                pos += 2;   // skip
                pos += cs;  // skip comment bytes
            }

            // Second block (common to files and directories)
            const something2 = u16be(data, pos); pos += 2;
            pos += 2;  // skip
            pos += 4;  // filetype
            pos += 4;  // filecreator
            pos += 2;  // finderflags
            pos += (entryVer === 1) ? 22 : 18;

            const hasRsrc = !!(something2 & 0x01);
            let resourcecomplen = 0;
            if (hasRsrc) {
                pos += 4; // resourcelength
                resourcecomplen = u32be(data, pos); pos += 4;
                pos += 2; // resourcecrc
                pos += 2; // skip
                pos++;    // resourcemethod
                const passlen = data[pos++];
                if (passlen > 0) pos += passlen;
            }

            const datastart = pos; // resource fork data starts here (if any)

            // Build full path using parent directory lookup
            const parentPath = dirs[diroffs] || '';
            const fullPath   = parentPath ? parentPath + '/' + name : name;

            if (isDir) {
                dirs[offs] = fullPath;
                numentries += entryNumFiles;
                // pos already at datastart; children follow immediately
            } else {
                // Data fork starts after resource fork
                const dataForkOffset = datastart + resourcecomplen;
                entries.push({
                    name,
                    path: fullPath,
                    method: datamethod,
                    dataOffset: dataForkOffset,
                    compressedSize: datacomplen,
                    uncompressedSize: datalength,
                });
                pos = dataForkOffset + datacomplen;
            }
        }

        return entries;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        /** Returns true if data starts with the StuffIt 5 signature. */
        isSitFile(data) {
            const sig = 'StuffIt (c)1997-';
            if (data.length < sig.length) return false;
            for (let i = 0; i < sig.length; i++) {
                if (data[i] !== sig.charCodeAt(i)) return false;
            }
            return true;
        },

        /** Parse archive and return all file entries (not directories). */
        listFiles(data) {
            return parseSit5(data);
        },

        /** Decompress one file entry's data fork. Returns Uint8Array. */
        extractFile(data, entry) {
            if (entry.method === 0) {
                return data.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
            } else if (entry.method === 13) {
                return decompressMethod13(
                    data,
                    entry.dataOffset,
                    entry.compressedSize,
                    entry.uncompressedSize
                );
            } else if (entry.method === 15) {
                return decompressMethod15(
                    data,
                    entry.dataOffset,
                    entry.compressedSize,
                    entry.uncompressedSize
                );
            } else {
                throw new Error('Unsupported StuffIt compression method: ' + entry.method);
            }
        },
    };
})();
