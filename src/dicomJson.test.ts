import { describe, expect, it } from 'vitest';
import { toDicomJson } from './dicomJson';
import { parse } from './parse';
import { TS, concat, encapsulatedPixelData, evenPad, explicitEl, implicitEl, latin1, p10, sqExplicit, tagBytes } from '../tests/helpers/p10';

function uint16le(...values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((v, i) => view.setUint16(i * 2, v, true));
    return bytes;
}

describe('toDicomJson — per-VR value semantics (PS3.18 Annex F)', () => {
    const file = p10(TS.explicitLE, [
        explicitEl('00080018', 'UI', evenPad('1.2.3.4', '\0')),
        explicitEl('00080060', 'CS', evenPad('MR')),
        explicitEl('00081090', 'LO', evenPad('A\\\\B')), // empty middle value → null
        explicitEl('00100010', 'PN', evenPad('Yamada^Tarou=Ideo^Graphic=Pho^Netic')),
        explicitEl('00101020', 'DS', evenPad('1.75')),
        explicitEl('00101021', 'DS', evenPad('1.5\\abc')), // unparsable stays a string
        explicitEl('00200011', 'IS', evenPad('7')),
        explicitEl('00280010', 'US', uint16le(512, 513)),
        explicitEl('00081160', 'IS', evenPad('')), // present but empty
        explicitEl('00209056', 'SH', evenPad(' padded ')),
        explicitEl('00270010', 'AT', concat([tagBytes('00100010'), tagBytes('7FE00010')])),
        explicitEl('00420011', 'OB', latin1('binary01')),
        explicitEl('7FE00010', 'OW', latin1('pixels!!')),
    ]);
    const model = toDicomJson(parse(file).dataSet);

    it('keys attributes by 8-hex uppercase tag in ascending order', () => {
        const keys = Object.keys(model);
        expect(keys[0]).toBe('00080018');
        expect([...keys].sort()).toEqual(keys);
        expect(keys).toContain('7FE00010');
    });

    it('splits multi-valued strings and nullifies empty components', () => {
        expect(model['00081090']).toEqual({ vr: 'LO', Value: ['A', null, 'B'] });
        expect(model['00080060']).toEqual({ vr: 'CS', Value: ['MR'] });
        expect(model['00209056']).toEqual({ vr: 'SH', Value: ['padded'] });
    });

    it('groups PN into Alphabetic/Ideographic/Phonetic', () => {
        const value = model['00100010']?.Value?.[0] as Record<string, string>;
        expect(value.Alphabetic).toBe('Yamada^Tarou');
        expect(value.Ideographic).toBeDefined();
        expect(value.Phonetic).toBeDefined();
    });

    it('coerces IS/DS to numbers, keeping unparsable components as strings', () => {
        expect(model['00200011']).toEqual({ vr: 'IS', Value: [7] });
        expect(model['00101020']).toEqual({ vr: 'DS', Value: [1.75] });
        expect(model['00101021']).toEqual({ vr: 'DS', Value: [1.5, 'abc'] });
    });

    it('omits Value for empty attributes', () => {
        expect(model['00081160']).toEqual({ vr: 'IS' });
    });

    it('reads binary numeric VRs with multiplicity', () => {
        expect(model['00280010']).toEqual({ vr: 'US', Value: [512, 513] });
    });

    it('renders AT values as 8-hex strings', () => {
        expect(model['00270010']).toEqual({ vr: 'AT', Value: ['00100010', '7FE00010'] });
    });

    it('inlines binary VRs as base64 by default', () => {
        expect(model['00420011']).toEqual({ vr: 'OB', InlineBinary: Buffer.from('binary01').toString('base64') });
        expect(model['7FE00010']?.InlineBinary).toBe(Buffer.from('pixels!!').toString('base64'));
    });
});

describe('toDicomJson — sequences, bulk data, implicit VR', () => {
    it('nests SQ items iteratively', () => {
        const inner = concat([explicitEl('00081150', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7', '\0'))]);
        const file = p10(TS.explicitLE, [sqExplicit('00081110', [inner]), explicitEl('00081115', 'SQ', new Uint8Array(0))]);
        const model = toDicomJson(parse(file).dataSet);
        expect(model['00081110']?.vr).toBe('SQ');
        const item = model['00081110']?.Value?.[0] as Record<string, unknown>;
        expect(item['00081150']).toEqual({ vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.7'] });
        expect(model['00081115']).toEqual({ vr: 'SQ' }); // empty sequence: no Value
    });

    it('substitutes BulkDataURI via the callback (encapsulated pixel data)', () => {
        const file = p10(TS.jpegBaseline, [explicitEl('00080018', 'UI', evenPad('1.2', '\0')), encapsulatedPixelData([latin1('frag')], [0])]);
        const model = toDicomJson(parse(file).dataSet, {
            bulkDataUri: element => (element.tag === 0x7fe00010 ? 'https://pacs/bulk/pixeldata' : undefined),
        });
        expect(model['7FE00010']).toEqual({ vr: 'OB', BulkDataURI: 'https://pacs/bulk/pixeldata' });
    });

    it('uses the vrLookup for implicit elements and falls back to UN binary', () => {
        const file = p10(TS.implicitLE, [implicitEl('00080060', evenPad('CT')), implicitEl('00090011', latin1('private!'))]);
        const model = toDicomJson(parse(file).dataSet, { vrLookup: tag => (tag === 0x00080060 ? 'CS' : undefined) });
        expect(model['00080060']).toEqual({ vr: 'CS', Value: ['CT'] });
        expect(model['00090011']).toEqual({ vr: 'UN', InlineBinary: Buffer.from('private!').toString('base64') });
    });

    it('serializes with charset-decoded strings (ISO_IR 100)', () => {
        const file = p10(TS.explicitLE, [
            explicitEl('00080005', 'CS', evenPad('ISO_IR 100')),
            explicitEl('00100010', 'PN', concat([latin1('M'), Uint8Array.from([0xfc]), latin1('ller^Erik ')])),
        ]);
        const model = toDicomJson(parse(file).dataSet);
        expect((model['00100010']?.Value?.[0] as Record<string, string>).Alphabetic).toBe('Müller^Erik');
    });

    it('round-trips through JSON.stringify without loss of structure', () => {
        const file = p10(TS.explicitLE, [explicitEl('00080018', 'UI', evenPad('1.2.3', '\0')), explicitEl('00280010', 'US', uint16le(64))]);
        const model = toDicomJson(parse(file).dataSet);
        expect(JSON.parse(JSON.stringify(model))).toEqual(model);
    });
});

describe('toDicomJson — 64-bit and base64 edges', () => {
    it('emits SV/UV as numbers when safe and decimal strings beyond 2^53', () => {
        const sv = new Uint8Array(8);
        new DataView(sv.buffer).setBigInt64(0, -42n, true);
        const uv = new Uint8Array(8);
        new DataView(uv.buffer).setBigUint64(0, 0xffffffffffffffffn, true);
        const file = p10(TS.explicitLE, [explicitEl('00720082', 'SV', sv), explicitEl('00720083', 'UV', uv)]);
        const model = toDicomJson(parse(file).dataSet);
        expect(model['00720082']).toEqual({ vr: 'SV', Value: [-42] });
        expect(model['00720083']).toEqual({ vr: 'UV', Value: ['18446744073709551615'] });
    });

    it('base64 matches Buffer for all padding remainders', () => {
        const file = p10(TS.explicitLE, [explicitEl('00420011', 'OB', latin1('abcdef'))]);
        for (const content of ['ab', 'abcd', 'abcdef']) {
            const f = p10(TS.explicitLE, [explicitEl('00420011', 'OB', latin1(content))]);
            const model = toDicomJson(parse(f).dataSet);
            expect(model['00420011']?.InlineBinary).toBe(Buffer.from(content).toString('base64'));
        }
        expect(toDicomJson(parse(file).dataSet)['00420011']?.InlineBinary).toBe(Buffer.from('abcdef').toString('base64'));
    });
});
