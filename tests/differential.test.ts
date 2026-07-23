import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import legacyParser from 'dicom-parser';
import { parseDicom, type DataSet as CompatDataSet, type Element as CompatElement } from '../src/compat';
import { collectTestImages } from './helpers/corpus';

// Verification oracle #2 (PLAN.md §6): the fork's compat façade compared
// tag-for-tag against dicom-parser@1.8.21, except where the fork deliberately
// fixes upstream (documented divergences A1–A6). Two corpora feed the SAME
// comparator:
//   1. the in-repo `testImages/` fixtures — always on, so BE/implicit/deflated/
//      encapsulated differential coverage runs in CI (the devDep is present and
//      the fixtures ship in-repo);
//   2. the external dcmtk.js JPEG2000 sample corpus — a deep local gate that is
//      never vendored (size/PHI hygiene), skipped where the sibling tree is
//      absent.

// External corpus: overridable for other checkouts; defaults to the sibling
// dcmtk.js working copy. Never copied into this repo.
const CORPUS = process.env.DICOM_DIFF_CORPUS ?? join(__dirname, '..', '..', 'dcmtk.js', 'dicomSamples');
const hasCorpus = existsSync(CORPUS);

function collectFiles(): string[] {
    const files: string[] = [];
    const queue = [CORPUS];
    while (queue.length > 0) {
        const dir = queue.pop() as string;
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                if (entry !== 'bad') {
                    queue.push(path);
                }
            } else {
                files.push(path);
            }
        }
    }
    return files;
}

interface LegacyFragment {
    offset: number;
    position: number;
    length: number;
}

interface LegacyItem {
    tag: string;
    length: number;
    dataOffset: number;
    hadUndefinedLength?: boolean;
    dataSet: LegacyDataSet;
}

interface LegacyElement {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    hadUndefinedLength?: boolean;
    items?: LegacyItem[];
    fragments?: LegacyFragment[];
    basicOffsetTable?: number[];
}

interface LegacyDataSet {
    elements: Record<string, LegacyElement>;
    byteArray: Uint8Array;
    string(tag: string, index?: number): string | undefined;
    uint16(tag: string, index?: number): number | undefined;
}

/** Tags whose value the fork must reproduce identically (common metadata). */
const VALUE_TAGS = ['x00080016', 'x00080018', 'x00080060', 'x0020000d', 'x0020000e', 'x00080050'];

/** Numeric metadata read back through the uint16 accessor when present. */
const UINT16_TAGS = ['x00280010', 'x00280011', 'x00280100', 'x00280002'];

/**
 * Narrow, per-file/per-tag exemptions for documented divergences (A1–A6) that
 * the deepened comparator would otherwise flag. Keyed by fixture basename →
 * set of `'xggggeeee'` tags whose element comparison is skipped. Rules are
 * NEVER weakened globally; each entry cites the divergence it covers. Empty
 * today — the in-repo corpus compares clean.
 */
const KNOWN_DIVERGENCES = new Map<string, ReadonlySet<string>>();

function isExempt(fileName: string, key: string): boolean {
    const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
    return KNOWN_DIVERGENCES.get(base)?.has(key) === true;
}

/** True for an odd-group (private) tag key `'xggggeeee'`. */
function isPrivateKey(key: string): boolean {
    return (Number.parseInt(key.slice(1, 5), 16) & 1) === 1;
}

interface Pair {
    legacy: LegacyDataSet;
    fork: CompatDataSet;
    isRoot: boolean;
}

function sortedKeys(ds: { elements: Record<string, unknown> }): string[] {
    return Object.keys(ds.elements)
        .filter(k => !k.startsWith('xfffe'))
        .sort();
}

/** Per-pair comparison context, threaded to keep function arity low. */
interface Ctx {
    legacy: LegacyDataSet;
    fork: CompatDataSet;
    fileName: string;
    worklist: Pair[];
}

function compareFragments(legacyEl: LegacyElement, forkEl: CompatElement, key: string, fileName: string): void {
    if (legacyEl.fragments === undefined) {
        return;
    }
    const legacyFragments = legacyEl.fragments;
    const forkFragments = forkEl.fragments ?? [];
    expect(forkEl.fragments, `fragments present ${key} (${fileName})`).toBeDefined();
    expect(forkFragments.length, `fragment count ${key} (${fileName})`).toBe(legacyFragments.length);
    legacyFragments.forEach((lf, i) => {
        const ff = forkFragments[i];
        expect(ff, `fragment[${i}] present ${key} (${fileName})`).toBeDefined();
        if (ff === undefined) {
            return;
        }
        expect(ff.offset, `fragment[${i}].offset ${key} (${fileName})`).toBe(lf.offset);
        expect(ff.position, `fragment[${i}].position ${key} (${fileName})`).toBe(lf.position);
        expect(ff.length, `fragment[${i}].length ${key} (${fileName})`).toBe(lf.length);
    });
    expect(forkEl.basicOffsetTable ?? [], `basicOffsetTable ${key} (${fileName})`).toEqual(legacyEl.basicOffsetTable ?? []);
}

function compareItems(ctx: Ctx, legacyEl: LegacyElement, forkEl: CompatElement, key: string): void {
    const { fileName, worklist } = ctx;
    const legacyItems = legacyEl.items;
    const forkItems = forkEl.items;
    if (legacyItems !== undefined && forkItems === undefined) {
        expect(forkEl.items, `fork must keep items for ${key} (${fileName})`).toBeDefined();
        return;
    }
    if (legacyItems === undefined && forkItems !== undefined) {
        // Documented divergence: implicit private undefined-length SQ — legacy
        // discarded the items, the fork keeps them (compat.ts, review). Any
        // other legacy-lacks/fork-has case is a real failure.
        const documented = legacyEl.hadUndefinedLength === true && legacyEl.vr === undefined && isPrivateKey(key);
        expect(documented, `unexpected fork-only items for ${key} (${fileName})`).toBe(true);
        return;
    }
    if (legacyItems === undefined || forkItems === undefined) {
        return;
    }
    expect(forkItems.length, `item count ${key} (${fileName})`).toBe(legacyItems.length);
    legacyItems.forEach((li, i) => {
        const fi = forkItems[i];
        expect(fi, `item[${i}] present ${key} (${fileName})`).toBeDefined();
        if (fi === undefined) {
            return;
        }
        expect(fi.dataOffset, `item[${i}].dataOffset ${key} (${fileName})`).toBe(li.dataOffset);
        if (li.hadUndefinedLength !== true) {
            expect(fi.length, `item[${i}].length ${key} (${fileName})`).toBe(li.length);
        }
        expect(fi.dataSet, `item[${i}].dataSet ${key} (${fileName})`).toBeDefined();
        if (fi.dataSet !== undefined) {
            worklist.push({ legacy: li.dataSet, fork: fi.dataSet, isRoot: false });
        }
    });
}

function compareLeafBytes(ctx: Ctx, legacyEl: LegacyElement, forkEl: CompatElement, key: string): void {
    // Leaf: neither items nor fragments. Compare the raw value bytes — distinct
    // buffers for deflated files, so this is not redundant with offset/length.
    if (legacyEl.items !== undefined || legacyEl.fragments !== undefined) {
        return;
    }
    const legacyBytes = Buffer.from(ctx.legacy.byteArray.subarray(legacyEl.dataOffset, legacyEl.dataOffset + legacyEl.length));
    const forkBytes = ctx.fork.byteArray.subarray(forkEl.dataOffset, forkEl.dataOffset + forkEl.length);
    expect(legacyBytes.equals(forkBytes), `value bytes ${key} (${ctx.fileName})`).toBe(true);
}

function compareElement(ctx: Ctx, key: string): void {
    const { fileName } = ctx;
    if (isExempt(fileName, key)) {
        return;
    }
    const legacyEl = ctx.legacy.elements[key] as LegacyElement;
    const forkEl = ctx.fork.elements[key] as CompatElement;
    if (legacyEl.vr !== undefined) {
        expect(forkEl.vr, `vr of ${key} (${fileName})`).toBe(legacyEl.vr);
    }
    expect(forkEl.hadUndefinedLength === true, `hadUndefinedLength of ${key} (${fileName})`).toBe(legacyEl.hadUndefinedLength === true);
    expect(forkEl.dataOffset, `dataOffset of ${key} (${fileName})`).toBe(legacyEl.dataOffset);
    if (legacyEl.hadUndefinedLength !== true) {
        expect(forkEl.length, `length of ${key} (${fileName})`).toBe(legacyEl.length);
    }
    compareLeafBytes(ctx, legacyEl, forkEl, key);
    compareFragments(legacyEl, forkEl, key, fileName);
    compareItems(ctx, legacyEl, forkEl, key);
}

function compareAccessors(legacy: LegacyDataSet, fork: CompatDataSet, fileName: string): void {
    const charsetValue = legacy.elements['x00080005'] === undefined ? undefined : legacy.string('x00080005');
    const charsetNonDefault = charsetValue !== undefined && charsetValue !== '' && charsetValue !== 'ISO_IR 6';
    for (const tag of VALUE_TAGS) {
        const el = legacy.elements[tag];
        if (el === undefined || el.hadUndefinedLength === true) {
            continue;
        }
        // A5: fork string() is charset-aware; under a non-default charset it
        // decodes real text instead of mojibake. Raw bytes already compared.
        if (charsetNonDefault) {
            continue;
        }
        expect(fork.string(tag), `string(${tag}) (${fileName})`).toBe(legacy.string(tag));
    }
    for (const tag of UINT16_TAGS) {
        if (legacy.elements[tag] !== undefined) {
            expect(fork.uint16(tag), `uint16(${tag}) (${fileName})`).toBe(legacy.uint16(tag));
        }
    }
}

function compareDataSets(rootLegacy: LegacyDataSet, rootFork: CompatDataSet, fileName: string): void {
    const worklist: Pair[] = [{ legacy: rootLegacy, fork: rootFork, isRoot: true }];
    while (worklist.length > 0) {
        const { legacy, fork, isRoot } = worklist.pop() as Pair;
        const legacyKeys = sortedKeys(legacy);
        const forkKeys = sortedKeys(fork);
        expect(forkKeys, `element keys (${fileName})`).toEqual(legacyKeys);
        const ctx: Ctx = { legacy, fork, fileName, worklist };
        for (const key of legacyKeys) {
            compareElement(ctx, key);
        }
        if (isRoot) {
            compareAccessors(legacy, fork, fileName);
        }
    }
}

function compareFile(bytes: Uint8Array, fileName: string): void {
    let legacy: LegacyDataSet;
    try {
        // Hand legacy a Buffer, not a bare Uint8Array: 1.8.21's deflate path uses
        // `byteArray.copy`, which only exists on Buffer — so a Uint8Array makes it
        // throw on every `_dfl` file and fall through to the smoke branch, hiding
        // deflated regressions. With a Buffer, legacy inflates and the full
        // tag-for-tag comparison runs (verified: image_dfl=40 elements, etc.).
        legacy = (legacyParser as unknown as { parseDicom(b: Uint8Array): LegacyDataSet }).parseDicom(Buffer.from(bytes));
    } catch {
        // Legacy genuinely could not parse (e.g. UV derailment #281). Degrade to a
        // fork-only smoke check: the fork must still parse something.
        const fork = parseDicom(bytes);
        expect(Object.keys(fork.elements).length, `fork parsed ${fileName}`).toBeGreaterThan(0);
        return;
    }
    const fork: CompatDataSet = parseDicom(bytes);
    // On a deflated file, 1.8.21 restarts the inflated ByteStream at position 0
    // and re-parses the preamble/DICM/meta as junk dataset elements (its DICM
    // misread `x49444d43` is the tell) — divergence A3, fork-is-right. That
    // pollutes legacy's keyset and offsets, so a tag-for-tag deep compare would
    // fight legacy's own bug; hold the fork to legacy at the VALUE-accessor level
    // instead (still real differential coverage of the inflated dataset).
    if (legacy.elements['x49444d43'] !== undefined) {
        compareAccessors(legacy, fork, fileName);
        return;
    }
    // Deep-comparison branch: legacy parsed cleanly, so the fork is held tag-for-tag.
    compareDataSets(legacy, fork, fileName);
}

describe('differential: fork compat vs dicom-parser@1.8.21 (in-repo testImages)', () => {
    const files = collectTestImages();

    it('found the in-repo corpus', () => {
        expect(collectTestImages().length).toBeGreaterThanOrEqual(23);
    });

    it.each(files.map(f => [f]))('%s', file => {
        compareFile(new Uint8Array(readFileSync(file)), file);
    });
});

describe.skipIf(!hasCorpus)('differential: fork compat vs dicom-parser@1.8.21 (dcmtk.js corpus)', () => {
    const files = hasCorpus ? collectFiles() : [];

    it('found the full corpus', () => {
        expect(files.length).toBeGreaterThanOrEqual(198);
    });

    it.each(files.map(f => [f.slice(CORPUS.length + 1)]))('%s', relative => {
        compareFile(new Uint8Array(readFileSync(join(CORPUS, relative))), relative);
    });
});
