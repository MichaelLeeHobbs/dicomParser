import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, TS_IMPLICIT_LE } from '../src/parse';
import type { DicomDataSet } from '../src/dataSet';
import { collectTestImages, TEST_IMAGES } from './helpers/corpus';

// Independent read oracle: the fork vs DCMTK `dcm2xml` (DCMTK-native XML).
// dcm2json is deliberately NOT used — it transcodes character sets and hangs on
// compressed pixel data (documented DCMTK bugs); dcm2xml is reliable on both.
//
// The strongest signal here is VR-independent: `len` (byte length) and the tag
// set must match DCMTK element-for-element at the dataset root. VR / value are
// additionally checked on explicit-VR files (the dictionary-free fork infers VR
// on implicit files, so only its byte accounting is comparable there).

const CHOCO_DCM2XML = 'C:\\ProgramData\\chocolatey\\bin\\dcm2xml.exe';

function resolveDcm2xml(): string | undefined {
    const override = process.env.DCM2XML;
    if (override !== undefined && override !== '' && existsSync(override)) {
        return override;
    }
    try {
        execFileSync('dcm2xml', ['--version'], { stdio: 'ignore' });
        return 'dcm2xml';
    } catch {
        // not on PATH — fall through to the local Windows install
    }
    return existsSync(CHOCO_DCM2XML) ? CHOCO_DCM2XML : undefined;
}

const dcm2xml = resolveDcm2xml();

// Anti-silent-skip guard: when REQUIRE_DCMTK=1 (the CI acceptance job) a missing
// dcm2xml must fail red, never skip green.
it.runIf(process.env.REQUIRE_DCMTK === '1')('dcm2xml is available', () => {
    expect(dcm2xml).toBeDefined();
});

interface XmlEl {
    readonly tag: number;
    readonly vr: string;
    readonly len: number;
    readonly value: string;
    readonly binary: boolean;
    readonly items?: number;
}

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DT', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UT', 'UI', 'UR', 'DS', 'IS']);
const INT_VRS = new Set(['US', 'SS', 'UL', 'SL']);

const attr = (line: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(line)?.[1];
const tagNum = (t: string): number => parseInt(t.replace(',', ''), 16);
const hex8 = (tag: number): string => tag.toString(16).padStart(8, '0');
const unescape = (s: string): string =>
    s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');

interface RootSq {
    tag: number;
    vr: string;
    len: number;
    items: number;
}
interface State {
    section: Map<number, XmlEl> | undefined;
    depth: number;
    rootSq: RootSq | undefined;
}

function parseElementLine(line: string): XmlEl | undefined {
    const tag = attr(line, 'tag');
    if (tag === undefined) {
        return undefined;
    }
    const inner = /<element[^>]*>(.*)<\/element>$/.exec(line)?.[1] ?? '';
    return { tag: tagNum(tag), vr: attr(line, 'vr') ?? '', len: Number(attr(line, 'len') ?? -1), value: unescape(inner), binary: /binary="[^"]+"/.test(line) };
}

function handleSection(line: string, st: State, meta: Map<number, XmlEl>, data: Map<number, XmlEl>): boolean {
    if (line.startsWith('<meta-header')) {
        st.section = meta;
        st.depth = 0;
    } else if (line.startsWith('<data-set')) {
        st.section = data;
        st.depth = 0;
    } else if (line.startsWith('</meta-header>') || line.startsWith('</data-set>')) {
        st.section = undefined;
    } else {
        return false;
    }
    return true;
}

function closeSequence(st: State): void {
    st.depth--;
    if (st.depth === 0 && st.rootSq !== undefined && st.section !== undefined) {
        const s = st.rootSq;
        st.section.set(s.tag, { tag: s.tag, vr: s.vr, len: s.len, value: '', binary: false, items: s.items });
        st.rootSq = undefined;
    }
}

function handleItem(line: string, st: State): boolean {
    if (line.startsWith('<item')) {
        if (st.depth === 1 && st.rootSq !== undefined) st.rootSq.items++;
        st.depth++;
        return true;
    }
    if (line.startsWith('</item>')) {
        st.depth--;
        return true;
    }
    return line.startsWith('<pixel-item') || line.startsWith('</pixel');
}

/** Handles sequence/item/pixel nesting; records a depth-0 SQ when it closes. */
function handleStructure(line: string, st: State): boolean {
    if (line.startsWith('<sequence')) {
        if (st.depth === 0) st.rootSq = { tag: tagNum(attr(line, 'tag') ?? '0'), vr: attr(line, 'vr') ?? 'SQ', len: Number(attr(line, 'len') ?? -1), items: 0 };
        st.depth++;
        return true;
    }
    if (line.startsWith('</sequence>')) {
        closeSequence(st);
        return true;
    }
    return handleItem(line, st);
}

/** Parses dcm2xml output into the depth-0 (root) elements of meta and data set. */
function parseDcm2xml(xml: string): { meta: Map<number, XmlEl>; data: Map<number, XmlEl> } {
    const meta = new Map<number, XmlEl>();
    const data = new Map<number, XmlEl>();
    const st: State = { section: undefined, depth: 0, rootSq: undefined };
    for (const raw of xml.split('\n')) {
        const line = raw.trim();
        if (handleSection(line, st, meta, data) || st.section === undefined || handleStructure(line, st)) {
            continue;
        }
        if (st.depth === 0 && line.startsWith('<element')) {
            const el = parseElementLine(line);
            if (el !== undefined) st.section.set(el.tag, el);
        }
    }
    return { meta, data };
}

type ForkEl = NonNullable<ReturnType<DicomDataSet['element']>>;
interface Ctx {
    ds: DicomDataSet;
    explicit: boolean;
    fails: string[];
}

function compareValue(tag: number, x: XmlEl, ctx: Ctx): void {
    const id = hex8(tag);
    if (STRING_VRS.has(x.vr)) {
        const fork = (ctx.ds.strings(tag) ?? []).join('\\').replace(/[ \0]+$/, '');
        const dcmtk = x.value.replace(/[ \0]+$/, '');
        if (fork !== dcmtk) ctx.fails.push(`${id} (${x.vr}): value fork=${JSON.stringify(fork).slice(0, 60)} dcmtk=${JSON.stringify(dcmtk).slice(0, 60)}`);
    } else if (INT_VRS.has(x.vr)) {
        const dcmtk = x.value.split('\\').map(Number);
        const fork = dcmtk.map((_, i) =>
            x.vr === 'US' ? ctx.ds.uint16(tag, i) : x.vr === 'SS' ? ctx.ds.int16(tag, i) : x.vr === 'UL' ? ctx.ds.uint32(tag, i) : ctx.ds.int32(tag, i)
        );
        if (JSON.stringify(fork) !== JSON.stringify(dcmtk))
            ctx.fails.push(`${id} (${x.vr}): value fork=${JSON.stringify(fork)} dcmtk=${JSON.stringify(dcmtk)}`);
    }
}

function compareSq(x: XmlEl, el: ForkEl, ctx: Ctx, id: string): void {
    // dcm2xml renders encapsulated pixel data as a <sequence> too; the fork models
    // it as `encapsulated`. Agreement that it is a pixel sequence is enough here
    // (fragment bytes are covered by the round-trip gate).
    if (el.kind === 'encapsulated') return;
    if (el.kind !== 'sequence') ctx.fails.push(`${id}: fork kind ${el.kind}, dcmtk SQ`);
    else if (x.items !== undefined && el.items.length !== x.items) ctx.fails.push(`${id}: item count fork=${el.items.length} dcmtk=${x.items}`);
}

function compareScalar(tag: number, x: XmlEl, el: ForkEl, ctx: Ctx): void {
    if (el.kind !== 'value') return;
    const id = hex8(tag);
    // len: VR-independent byte-length agreement (undefined length is 0xFFFFFFFF)
    if (x.len !== 0xffffffff && el.length !== x.len) ctx.fails.push(`${id}: len fork=${el.length} dcmtk=${x.len}`);
    if (!ctx.explicit) return;
    if (el.vr !== undefined && el.vr !== 'UN' && el.vr !== x.vr) ctx.fails.push(`${id}: vr fork=${el.vr} dcmtk=${x.vr}`);
    if (!x.binary && x.value !== '') compareValue(tag, x, ctx);
}

function compareElement(tag: number, x: XmlEl, el: ForkEl, ctx: Ctx): void {
    if (x.items !== undefined) compareSq(x, el, ctx, hex8(tag));
    else compareScalar(tag, x, el, ctx);
}

function compareSection(xml: Map<number, XmlEl>, ds: DicomDataSet, explicit: boolean, fails: string[]): void {
    for (const tag of xml.keys()) if (!ds.elements.has(tag)) fails.push(`missing in fork: ${hex8(tag)} (dcmtk ${xml.get(tag)!.vr})`);
    for (const tag of ds.elements.keys()) if (!xml.has(tag)) fails.push(`extra in fork: ${hex8(tag)}`);
    const ctx: Ctx = { ds, explicit, fails };
    for (const [tag, x] of xml) {
        const el = ds.elements.get(tag);
        if (el !== undefined) compareElement(tag, x, el, ctx);
    }
}

describe.skipIf(dcm2xml === undefined)('DCMTK dcm2xml read differential', () => {
    const files = collectTestImages();
    it.each(files.map(f => [f.slice(TEST_IMAGES.length + 1)]))('%s', relative => {
        const path = join(TEST_IMAGES, relative);
        const xml = execFileSync(dcm2xml as string, [path], { maxBuffer: 1 << 30 }).toString();
        const { meta, data } = parseDcm2xml(xml);
        const result = parse(new Uint8Array(readFileSync(path)));
        expect(result.error, `${relative}: fork parse error`).toBeUndefined();
        const explicit = result.transferSyntax !== TS_IMPLICIT_LE;
        const fails: string[] = [];
        compareSection(meta, result.meta, true, fails); // meta group is always explicit LE
        compareSection(data, result.dataSet, explicit, fails);
        expect(fails, `${relative}\n  ${fails.join('\n  ')}`).toHaveLength(0);
    });
});
