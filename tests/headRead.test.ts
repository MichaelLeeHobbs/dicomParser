import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHeadAsync, type BulkRange, type RangeReader } from '../src/headRead';
import { parse } from '../src/parse';
import type { DicomElement } from '../src/element';
import type { DicomDataSet } from '../src/dataSet';
import { DicomError, type ParseWarning } from '../src/errors';
import type { Tag } from '../src/tag';
import type { HeadResult } from '../src/headRead';
import { collectTestImages, TEST_IMAGES } from './helpers/corpus';
import {
    concat,
    explicitEl,
    encapsulatedPixelData,
    implicitEl,
    item,
    latin1,
    p10,
    p10Deflated,
    sqExplicit,
    sqExplicitUndefined,
    tagBytes,
    TS,
} from './helpers/p10';

// Bounded head-read differential (fork #59): for every fixture and synthetic
// case, parseHeadAsync must produce metadata + warnings + transfer syntax
// identical to a whole-file parse with the bulk values elided, report the
// skipped bulk ranges accurately, and read materially fewer bytes.

/** A read-counting RangeReader over an in-memory buffer (sync reads). */
function memReader(bytes: Uint8Array): RangeReader & { totalRead: number } {
    const r = {
        size: bytes.length,
        totalRead: 0,
        read(offset: number, length: number): Uint8Array {
            const end = Math.min(bytes.length, offset + length);
            r.totalRead += Math.max(0, end - offset); // never negative for a read at/after EOF
            return bytes.slice(offset, end);
        },
    };
    return r;
}

/** Wraps a reader so every read resolves through a Promise (async path). */
function asyncReader(bytes: Uint8Array): RangeReader {
    return { size: bytes.length, read: (o, l) => Promise.resolve(bytes.slice(o, Math.min(bytes.length, o + l))) };
}

const codes = (warnings: readonly ParseWarning[]): string[] => [...new Set(warnings.map(w => w.code))].sort();
const tagsOf = (ds: DicomDataSet): Tag[] => [...ds.elements.keys()].sort((a, b) => a - b);
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/** Asserts a head-read result matches a whole-file parse with bulk elided. */
function assertMatchesFull(head: HeadResult, fileBytes: Uint8Array, label: string): void {
    const full = parse(fileBytes, {});
    expect(head.transferSyntax, `${label}: transferSyntax`).toBe(full.transferSyntax);

    // Every skipped bulk tag must exist in the full parse with a matching range.
    for (const [tag, range] of head.bulk) {
        const el = full.dataSet.element(tag);
        expect(el, `${label}: bulk tag ${tag} present in full parse`).toBeDefined();
        const full_ = el as DicomElement;
        expect(range.offset, `${label}: bulk ${tag} offset`).toBe(full_.dataOffset);
        expect(range.length, `${label}: bulk ${tag} length`).toBe(full_.endOffset - full_.dataOffset);
    }

    // The dataset must equal the full dataset minus the elided bulk tags.
    const expectedTags = tagsOf(full.dataSet).filter(t => !head.bulk.has(t));
    expect(tagsOf(head.dataSet), `${label}: metadata tag set`).toEqual(expectedTags);
    for (const tag of expectedTags) {
        const h = head.dataSet.element(tag) as DicomElement;
        const f = full.dataSet.element(tag) as DicomElement;
        expect(h.kind, `${label}: ${tag} kind`).toBe(f.kind);
        expect(h.vr, `${label}: ${tag} vr`).toBe(f.vr);
        expect(h.length, `${label}: ${tag} length`).toBe(f.length);
        if (h.kind === 'value' || h.kind === 'unknown') {
            expect(bytesEqual(head.dataSet.rawBytes(tag), full.dataSet.rawBytes(tag)), `${label}: ${tag} value bytes`).toBe(true);
        }
        if (h.kind === 'sequence' && f.kind === 'sequence') {
            expect(h.items.length, `${label}: ${tag} item count`).toBe(f.items.length);
        }
    }

    // Head warnings are a subset of the full parse's (bulk elements may add codes
    // only the full parse sees; the head never invents a code the full lacks).
    const fullCodes = new Set(codes(full.warnings));
    for (const code of codes(head.warnings)) {
        expect(fullCodes.has(code), `${label}: warning code ${code} also in full parse`).toBe(true);
    }
    expect(head.ok, `${label}: ok`).toBe(full.ok);
}

describe('parseHeadAsync — synthetic cases', () => {
    const bigBlob = latin1('X'.repeat(200_000));

    const cases: ReadonlyArray<{ name: string; bytes: Uint8Array; expectBulk: Tag[] }> = [
        {
            name: 'native LE explicit with OB blob + trailing element',
            bytes: p10(TS.explicitLE, [
                explicitEl('00080060', 'CS', latin1('CT')),
                explicitEl('7FE00010', 'OB', bigBlob),
                explicitEl('00080070', 'LO', latin1('ACME')),
            ]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'native LE explicit with non-pixel OB bulk (icon-style)',
            bytes: p10(TS.explicitLE, [explicitEl('00880200', 'OB', bigBlob), explicitEl('00080060', 'CS', latin1('CT'))]),
            expectBulk: [0x00880200],
        },
        {
            name: 'implicit LE (no vrLookup: nothing provably bulk except pixel data)',
            bytes: p10(TS.implicitLE, [implicitEl('00080060', latin1('CT')), implicitEl('7FE00010', bigBlob)]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'defined-length sequence copied verbatim, pixel data skipped',
            bytes: p10(TS.explicitLE, [sqExplicit('00081140', [concat([explicitEl('00080100', 'SH', latin1('AB'))])]), explicitEl('7FE00010', 'OW', bigBlob)]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'undefined-length sequence copied verbatim, pixel data skipped',
            bytes: p10(TS.explicitLE, [
                sqExplicitUndefined('00081140', [item(explicitEl('00080100', 'SH', latin1('CD')))]),
                explicitEl('7FE00010', 'OW', bigBlob),
            ]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'encapsulated pixel data hopped via fragments',
            bytes: p10(TS.jpegBaseline, [explicitEl('00080060', 'CS', latin1('CT')), encapsulatedPixelData([bigBlob, latin1('YZ')], [0])]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'big-endian explicit with OW pixel data',
            bytes: p10(TS.explicitBE, [explicitEl('00080060', 'CS', latin1('CT'), true), explicitEl('7FE00010', 'OW', bigBlob, true)]),
            expectBulk: [0x7fe00010],
        },
        {
            name: 'no bulk at all (all metadata)',
            bytes: p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('00080070', 'LO', latin1('ACME'))]),
            expectBulk: [],
        },
    ];

    for (const c of cases) {
        it(c.name, async () => {
            const head = await parseHeadAsync(memReader(c.bytes));
            assertMatchesFull(head, c.bytes, c.name);
            expect([...head.bulk.keys()].sort((a, b) => a - b)).toEqual(c.expectBulk);
        });
    }

    it('deflated files are read whole and parsed normally', async () => {
        const bytes = p10Deflated([explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        const head = await parseHeadAsync(memReader(bytes));
        expect(head.transferSyntax).toBe(TS.deflatedLE);
        expect(head.dataSet.uint16('x00280010')).toBe(512);
        expect(head.bulk.size).toBe(0);
    });

    it('truncated bulk value: same warning codes and clamped bulk range', async () => {
        const full = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', latin1('X'.repeat(4096)))]);
        const truncated = full.subarray(0, full.length - 2000); // cut into the pixel data
        const head = await parseHeadAsync(memReader(truncated));
        assertMatchesFull(head, truncated, 'truncated');
        const range = head.bulk.get(0x7fe00010) as BulkRange;
        expect(range).toBeDefined();
        expect(range.offset + range.length).toBe(truncated.length); // clamped to EOF
    });

    it('honors stopAt to end the walk early (metadata fast path)', async () => {
        const bytes = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', latin1('X'.repeat(50_000)))]);
        const head = await parseHeadAsync(memReader(bytes), { stopAt: { tag: 0x7fe00010 } });
        expect(head.dataSet.element(0x7fe00010)).toBeUndefined();
        expect(head.bulk.has(0x7fe00010)).toBe(false); // stopped before reaching pixel data
        expect(head.dataSet.string('x00080060')).toBe('CT');
    });

    it('works through an async reader', async () => {
        const bytes = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', latin1('X'.repeat(80_000)))]);
        const head = await parseHeadAsync(asyncReader(bytes));
        assertMatchesFull(head, bytes, 'async');
        expect(head.bytesRead).toBeLessThan(bytes.length / 2);
    });

    it('reads far fewer bytes than the file size when pixel data dominates', async () => {
        const bytes = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', latin1('X'.repeat(500_000)))]);
        const reader = memReader(bytes);
        const head = await parseHeadAsync(reader);
        const reduction = 1 - head.bytesRead / bytes.length;
        expect(reduction).toBeGreaterThan(0.9);
    });
});

describe('parseHeadAsync — corpus differential', () => {
    const files = collectTestImages();
    let totalFile = 0;
    let totalRead = 0;

    for (const path of files) {
        const rel = relative(TEST_IMAGES, path);
        it(`matches whole-file parse: ${rel}`, async () => {
            const bytes = new Uint8Array(readFileSync(path));
            const head = await parseHeadAsync(memReader(bytes));
            // A file the full parser rejects outright (bad header) is out of scope
            // for the differential's element comparison; skip only those.
            const full = parse(bytes, {});
            if (!full.ok && full.dataSet.elements.size === 0) {
                return;
            }
            assertMatchesFull(head, bytes, rel);
            totalFile += bytes.length;
            totalRead += head.bytesRead;
        });
    }

    it('reports the aggregate bytes-read reduction', () => {
        if (totalFile === 0) return;
        const reduction = 1 - totalRead / totalFile;
        // Informational: the memory/IO win across the corpus.
        console.warn(`head-read corpus: read ${totalRead} of ${totalFile} bytes (${(reduction * 100).toFixed(1)}% fewer)`);
        expect(reduction).toBeGreaterThan(0);
    });
});

describe('parseHeadAsync — edge cases, options, and fallbacks', () => {
    const blob = latin1('X'.repeat(4096));

    it('rejects a negative reader size', async () => {
        await expect(parseHeadAsync({ size: -1, read: () => new Uint8Array(0) })).rejects.toBeInstanceOf(DicomError);
    });

    it('falls back to a whole-file parse for a non-DICOM buffer', async () => {
        const bytes = latin1('this is not a DICOM file, no DICM prefix here at all');
        const head = await parseHeadAsync(memReader(bytes));
        expect(head.ok).toBe(false);
        expect(head.error).toBeInstanceOf(DicomError);
        expect(head.bulk.size).toBe(0);
    });

    it('parses a headerless (raw) dataset with an explicit transfer syntax', async () => {
        const raw = concat([explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', blob)]);
        const head = await parseHeadAsync(memReader(raw), { transferSyntax: TS.explicitLE });
        expect(head.transferSyntax).toBe(TS.explicitLE);
        expect(head.dataSet.string('x00080060')).toBe('CT');
        expect(head.bulk.get(0x7fe00010)).toBeDefined();
    });

    it('threads vrLookup / charset / maxDepth / maxElements through to the parse', async () => {
        const bytes = p10(TS.implicitLE, [implicitEl('00080060', latin1('CT')), sqExplicitUndefinedImplicit(), implicitEl('7FE00010', blob)]);
        const vrLookup = (t: Tag): string | undefined => (t === 0x00080060 ? 'CS' : t === 0x00081140 ? 'SQ' : undefined);
        const head = await parseHeadAsync(memReader(bytes), { vrLookup, charset: {}, maxDepth: 64, maxElements: 5000 });
        expect(head.dataSet.string('x00080060')).toBe('CT');
        expect(head.bulk.has(0x7fe00010)).toBe(true);
    });

    it('skips an implicit element the vrLookup identifies as a bulk VR', async () => {
        const bytes = p10(TS.implicitLE, [implicitEl('00080060', latin1('CT')), implicitEl('00880200', blob)]);
        const vrLookup = (t: Tag): string | undefined => (t === 0x00880200 ? 'OB' : t === 0x00080060 ? 'CS' : undefined);
        const head = await parseHeadAsync(memReader(bytes), { vrLookup });
        expect(head.bulk.has(0x00880200)).toBe(true);
        expect(head.dataSet.element(0x00880200)).toBeUndefined();
    });

    it('skips an explicit UN value that is not an implicit sequence', async () => {
        const bytes = p10(TS.explicitLE, [explicitEl('00410010', 'UN', blob), explicitEl('00080060', 'CS', latin1('CT'))]);
        const head = await parseHeadAsync(memReader(bytes));
        expect(head.bulk.has(0x00410010)).toBe(true);
        expect(head.dataSet.string('x00080060')).toBe('CT');
    });

    it('stopAt inclusive includes (and skips) the triggering pixel data', async () => {
        const bytes = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT')), explicitEl('7FE00010', 'OB', blob)]);
        const head = await parseHeadAsync(memReader(bytes), { stopAt: { tag: 0x7fe00010, inclusive: true } });
        expect(head.bulk.has(0x7fe00010)).toBe(true);
        expect(head.dataSet.string('x00080060')).toBe('CT');
    });

    it('handles a truncated undefined-length sequence (delimiter cut off)', async () => {
        const file = p10(TS.explicitLE, [sqExplicitUndefined('00081140', [item(explicitEl('00080100', 'SH', latin1('CD')))])]);
        const truncated = file.subarray(0, file.length - 6); // cut into the FFFE,E0DD delimiter
        const head = await parseHeadAsync(memReader(truncated));
        assertMatchesFull(head, truncated, 'truncated-sq');
    });

    it('handles a malformed undefined-length sequence (item overruns EOF)', async () => {
        const badItem = concat([tagBytes('FFFEE000'), Uint8Array.from([0x00, 0x10, 0x00, 0x00])]); // item claims 0x1000 bytes, none follow
        const badSq = concat([tagBytes('00081140'), latin1('SQ'), new Uint8Array(2), Uint8Array.from([0xff, 0xff, 0xff, 0xff]), badItem]);
        const file = p10(TS.explicitLE, [badSq]);
        const head = await parseHeadAsync(memReader(file));
        assertMatchesFull(head, file, 'malformed-sq');
    });

    it('copies a trailing partial element header verbatim (parity with full parse)', async () => {
        // A complete element followed by a long-form header missing its length bytes.
        const partial = concat([tagBytes('7FE00010'), latin1('OB'), new Uint8Array(2), Uint8Array.from([0x00, 0x00])]);
        const file = concat([p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT'))]), partial]);
        const head = await parseHeadAsync(memReader(file));
        assertMatchesFull(head, file, 'partial-header');
    });

    it('copies fewer-than-8 trailing bytes verbatim (parity with full parse)', async () => {
        const file = concat([p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT'))]), Uint8Array.from([0x08, 0x00, 0x60, 0x00])]);
        const head = await parseHeadAsync(memReader(file));
        assertMatchesFull(head, file, 'short-tail');
    });

    it('measures an undefined-length sequence larger than the read window (grows it)', async () => {
        // A ~9 KiB sequence exceeds the 8 KiB measure window, forcing a grow.
        const bigText = explicitEl('00080100', 'UT', latin1('Z'.repeat(9000)));
        const file = p10(TS.explicitLE, [sqExplicitUndefined('00081140', [item(bigText)]), explicitEl('7FE00010', 'OB', blob)]);
        const head = await parseHeadAsync(memReader(file));
        assertMatchesFull(head, file, 'big-sq');
        expect(head.bulk.has(0x7fe00010)).toBe(true);
    });

    it('measures a construct whose root tag is later duplicated (map overwrite)', async () => {
        // Two root-level undefined-length sequences share tag (0008,1140) — a
        // malformed duplicate. The tag-keyed measurement map keeps only the last,
        // so extent must be pinned by the following element's start, not by
        // finding the offset-0 element. Otherwise the first SQ's window grows to
        // EOF and the trailing pixel data is never skipped.
        const dup = '00081140';
        const file = p10(TS.explicitLE, [
            sqExplicitUndefined(dup, [item(explicitEl('00080100', 'SH', latin1('AB')))]),
            sqExplicitUndefined(dup, [item(explicitEl('00080100', 'SH', latin1('CD')))]),
            explicitEl('7FE00010', 'OW', blob),
        ]);
        const head = await parseHeadAsync(memReader(file));
        assertMatchesFull(head, file, 'dup-root-tag');
        expect(head.bulk.has(0x7fe00010), 'pixel data skipped despite duplicate root tag').toBe(true);
    });
});

/** An undefined-length implicit-VR sequence element (tag 00081140) with one item. */
function sqExplicitUndefinedImplicit(): Uint8Array {
    const content = item(implicitEl('00080100', latin1('CD')));
    return concat([tagBytes('00081140'), Uint8Array.from([0xff, 0xff, 0xff, 0xff]), content, tagBytes('FFFEE0DD'), new Uint8Array(4)]);
}
