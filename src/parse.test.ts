import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { EncapsulatedElement } from './element';
import { inflateRaw, inflateRawAsync } from './inflate';
import { TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_GE_PRIVATE_DLX, TS_IMPLICIT_LE, parse, parseAsync } from './parse';
import { readUiString } from './part10';
import { tagFromString } from './tag';
import { TS, concat, encapsulatedPixelData, explicitEl, implicitEl, latin1, p10, p10Deflated } from '../tests/helpers/p10';
import type { ParseResult } from './parse';

// Ported from legacy parseDicom_test.js (big endian, explicit little endian,
// implicit little endian, raw/headerless) with value assertions via direct
// byte reads — the accessor layer lands in the next PR.

function uint16At(result: ParseResult, tag: string): number {
    const element = result.dataSet.element(tag);
    expect(element).toBeDefined();
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset);
    const el = element as NonNullable<typeof element>;
    return view.getUint16(el.dataOffset, result.dataSet.littleEndian);
}

function stringAt(result: ParseResult, tag: string): string {
    // Meta (group 0002) lives in result.meta — the core keeps it separate from
    // the dataset (legacy merged them; the Phase 4 façade will re-merge).
    const element = tag.startsWith('x0002') ? result.meta.element(tag) : result.dataSet.element(tag);
    expect(element).toBeDefined();
    const el = element as NonNullable<typeof element>;
    return readUiString(result.bytes, el.dataOffset, el.length);
}

function rowsAndSliceLocation(bigEndian: boolean): Uint8Array[] {
    return [
        explicitEl('00201041', 'DS', latin1('-43 '), bigEndian),
        explicitEl('00280010', 'US', bigEndian ? Uint8Array.from([0x02, 0x00]) : Uint8Array.from([0x00, 0x02]), bigEndian),
    ];
}

describe('parse — transfer syntaxes (legacy parseDicom_test)', () => {
    it('parses explicit little endian', () => {
        const result = parse(p10(TS.explicitLE, rowsAndSliceLocation(false)));
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.transferSyntax).toBe(TS_EXPLICIT_LE);
        expect(stringAt(result, 'x00020002')).toBe('1.2.840.10008.5.1.4.1.1.7');
        expect(uint16At(result, 'x00280010')).toBe(512);
        expect(stringAt(result, 'x00201041')).toBe('-43');
    });

    it('parses explicit big endian (meta stays little endian)', () => {
        const result = parse(p10(TS.explicitBE, rowsAndSliceLocation(true)));
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_EXPLICIT_BE);
        expect(result.dataSet.littleEndian).toBe(false);
        expect(result.meta.littleEndian).toBe(true);
        expect(uint16At(result, 'x00280010')).toBe(512);
        expect(stringAt(result, 'x00201041')).toBe('-43');
    });

    it('parses implicit little endian', () => {
        const dataset = [implicitEl('00201041', latin1('-43 ')), implicitEl('00280010', Uint8Array.from([0x00, 0x02]))];
        const result = parse(p10(TS.implicitLE, dataset));
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_IMPLICIT_LE);
        expect(uint16At(result, 'x00280010')).toBe(512);
        const rows = result.dataSet.element('x00280010');
        expect(rows?.vr).toBeUndefined();
    });

    it('parses a raw headerless dataset with a transferSyntax override (#48)', () => {
        const bytes = concat(rowsAndSliceLocation(false));
        const result = parse(bytes, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.error).toBeUndefined();
        expect(result.meta.elements.size).toBe(0);
        expect(uint16At(result, 'x00280010')).toBe(512);
        expect(stringAt(result, 'x00201041')).toBe('-43');
    });

    it('reports unsupported for the GE private DLX transfer syntax (#107)', () => {
        const result = parse(p10(TS_GE_PRIVATE_DLX, rowsAndSliceLocation(false)));
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('unsupported');
        expect(result.meta.element('x00020010')).toBeDefined();
    });

    it('reports not-dicom for non-DICOM input', () => {
        const result = parse(new Uint8Array(200));
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('not-dicom');
        expect(result.dataSet.elements.size).toBe(0);
    });
});

function corruptTail(bytes: Uint8Array): Uint8Array {
    const copy = Uint8Array.from(bytes);
    copy.set([(copy[copy.length - 1] ?? 0) ^ 0xff], copy.length - 1);
    copy.set([(copy[copy.length - 5] ?? 0) ^ 0xff], copy.length - 5);
    return copy;
}

describe('parse — deflated transfer syntax (#270/#125)', () => {
    const deflatedFile = p10Deflated(rowsAndSliceLocation(false));

    it('inflates via node:zlib', () => {
        const result = parse(deflatedFile);
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_DEFLATED_LE);
        expect(uint16At(result, 'x00280010')).toBe(512);
        // offsets refer to the spliced (header + inflated) byte array
        expect(result.bytes).not.toBe(deflatedFile);
    });

    it('inflates via an injected inflater (upstream inflater option)', () => {
        const inflate = vi.fn((deflated: Uint8Array) => new Uint8Array(inflateRawSync(deflated)));
        const result = parse(deflatedFile, { inflate });
        expect(result.error).toBeUndefined();
        expect(inflate).toHaveBeenCalledOnce();
        expect(uint16At(result, 'x00280010')).toBe(512);
    });

    it('reports malformed for a corrupt deflate stream, keeping the meta group', () => {
        const result = parse(corruptTail(deflatedFile));
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('malformed');
        expect(result.meta.element('x00020010')).toBeDefined();
    });

    it('parseAsync inflates via DecompressionStream when node:zlib is unavailable', async () => {
        const spy = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);
        try {
            expect(parse(deflatedFile).error?.code).toBe('no-inflater');
            const result = await parseAsync(deflatedFile);
            expect(result.error).toBeUndefined();
            expect(uint16At(result, 'x00280010')).toBe(512);
        } finally {
            spy.mockRestore();
        }
    });

    it('parseAsync uses the sync path when available', async () => {
        const result = await parseAsync(deflatedFile);
        expect(result.error).toBeUndefined();
        expect(uint16At(result, 'x00280010')).toBe(512);
    });

    it('parseAsync reports malformed for a corrupt deflate stream, keeping the meta group', async () => {
        const result = await parseAsync(corruptTail(deflatedFile));
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('malformed');
        expect(result.meta.element('x00020010')).toBeDefined();
    });
});

describe('inflateRaw / inflateRawAsync', () => {
    const payload = latin1('hello dicom');
    const deflated = new Uint8Array(deflateRawSync(payload));

    it('round-trips via node:zlib', () => {
        expect(Array.from(inflateRaw(deflated))).toEqual(Array.from(payload));
    });

    it('prefers an injected inflater', () => {
        const inflate = vi.fn(() => payload);
        expect(inflateRaw(deflated, inflate)).toBe(payload);
        expect(inflate).toHaveBeenCalledOnce();
    });

    it('round-trips via DecompressionStream when zlib is stubbed away', async () => {
        const spy = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);
        try {
            expect(await inflateRawAsync(deflated)).toEqual(payload);
        } finally {
            spy.mockRestore();
        }
    });

    it('reports malformed on corrupt input in both paths', async () => {
        const corrupt = Uint8Array.from([1, 2, 3]);
        expect(() => inflateRaw(corrupt)).toThrow(/inflate failed/);
        const spy = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);
        try {
            await expect(inflateRawAsync(corrupt)).rejects.toThrow(/inflate failed/);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('parse — structure and options', () => {
    it('parses encapsulated pixel data end to end', () => {
        const fragment = Uint8Array.from([1, 2, 3, 4]);
        const result = parse(p10(TS.jpegBaseline, [encapsulatedPixelData([fragment], [0])]));
        expect(result.error).toBeUndefined();
        const element = result.dataSet.element('x7fe00010') as EncapsulatedElement;
        expect(element.kind).toBe('encapsulated');
        expect(element.basicOffsetTable).toEqual([0]);
        expect(element.fragments).toHaveLength(1);
        expect(Array.from(result.bytes.subarray(element.fragments[0]?.position, (element.fragments[0]?.position ?? 0) + 4))).toEqual([1, 2, 3, 4]);
    });

    it('honors stopAt through the parse entry (metadata-only fast path)', () => {
        const dataset = [...rowsAndSliceLocation(false), explicitEl('7FE00010', 'OB', new Uint8Array(64))];
        const result = parse(p10(TS.explicitLE, dataset), { stopAt: { tag: 'x7fe00010', inclusive: false } });
        expect(result.error).toBeUndefined();
        expect(result.stoppedAt).toBe(tagFromString('x7fe00010'));
        expect(result.dataSet.element('x7fe00010')).toBeUndefined();
        expect(uint16At(result, 'x00280010')).toBe(512);
    });

    it('passes vrLookup to implicit datasets', () => {
        const dataset = [implicitEl('00280010', Uint8Array.from([0x00, 0x02]))];
        const result = parse(p10(TS.implicitLE, dataset), { vrLookup: tag => (tag === 0x00280010 ? 'US' : undefined) });
        expect(result.dataSet.element('x00280010')?.vr).toBe('US');
    });

    it('returns partial datasets for truncated files (#203)', () => {
        const full = p10(TS.explicitLE, [...rowsAndSliceLocation(false), explicitEl('7FE00010', 'OB', new Uint8Array(64))]);
        // cut inside the pixel-data element *header* — an unrecoverable truncation
        const truncated = full.subarray(0, full.length - 68);
        const result = parse(truncated);
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('buffer-overread');
        expect(result.meta.element('x00020010')).toBeDefined();
        expect(result.dataSet.element('x00280010')).toBeDefined();
    });

    it('tolerates value-level truncation with a warning and a clamped element', () => {
        const full = p10(TS.explicitLE, [...rowsAndSliceLocation(false), explicitEl('7FE00010', 'OB', new Uint8Array(64))]);
        const truncated = full.subarray(0, full.length - 60);
        const result = parse(truncated);
        expect(result.ok).toBe(true);
        expect(result.warnings.some(w => w.code === 'unexpected-eof')).toBe(true);
        expect(result.dataSet.element('x7fe00010')?.length).toBe(4);
    });

    it('rejects non-Uint8Array input', () => {
        expect(() => parse(undefined as unknown as Uint8Array)).toThrow(/Uint8Array/);
    });
});
