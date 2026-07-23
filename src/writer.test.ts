import { describe, expect, it } from 'vitest';
import { DicomError } from './errors';
import { parse, TS_DEFLATED_LE, TS_EXPLICIT_LE, TS_IMPLICIT_LE } from './parse';
import { encodeDataSet } from './writer';
import { buildMetaGroup, modifyDataSet, serializeParsed, writeFile } from './writeFile';
import { dataSet, element, encodeBigintValue, encodeNumericValue, encodeStringValue, item, toWriteModel } from './writeModel';
import type { EncapsulatedElement, SequenceElement } from './element';

describe('encodeStringValue', () => {
    it('pads to even length: space for text, NUL for UI', () => {
        expect(Array.from(encodeStringValue('SH', 'ABC'))).toEqual([0x41, 0x42, 0x43, 0x20]);
        expect(Array.from(encodeStringValue('UI', '1.2'))).toEqual([0x31, 0x2e, 0x32, 0x00]);
        expect(Array.from(encodeStringValue('SH', 'AB'))).toEqual([0x41, 0x42]);
    });

    it('encodes UTF-8 when asked', () => {
        const bytes = encodeStringValue('PN', 'Müller', 'utf8');
        expect(bytes.length % 2).toBe(0);
        expect(new TextDecoder().decode(bytes).trimEnd()).toBe('Müller');
    });

    it('rejects non-Latin-1 characters in latin1 mode', () => {
        expect(() => encodeStringValue('PN', '王')).toThrow(DicomError);
    });
});

describe('encodeNumericValue / encodeBigintValue', () => {
    it('encodes US/UL/SS/SL/FL/FD little-endian', () => {
        expect(Array.from(encodeNumericValue('US', [0x1234]))).toEqual([0x34, 0x12]);
        expect(Array.from(encodeNumericValue('UL', [0x01020304]))).toEqual([0x04, 0x03, 0x02, 0x01]);
        expect(Array.from(encodeNumericValue('SS', [-1]))).toEqual([0xff, 0xff]);
        expect(Array.from(encodeNumericValue('SL', [-2]))).toEqual([0xfe, 0xff, 0xff, 0xff]);
        expect(encodeNumericValue('FL', [-5.625])[3]).toBe(0xc0);
        expect(encodeNumericValue('FD', [1.5])).toHaveLength(8);
    });

    it('encodes AT as group/element pairs', () => {
        expect(Array.from(encodeNumericValue('AT', [0x00181065]))).toEqual([0x18, 0x00, 0x65, 0x10]);
    });

    it('encodes SV/UV as 64-bit', () => {
        expect(Array.from(encodeBigintValue('SV', [-1n]))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        expect(Array.from(encodeBigintValue('UV', [1n]))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('rejects bad VR/value combinations', () => {
        expect(() => encodeNumericValue('SH', [1])).toThrow(DicomError);
        expect(() => encodeBigintValue('US', [1n])).toThrow(DicomError);
    });
});

describe('encodeDataSet ↔ parse round trips', () => {
    it('round-trips scalar elements (explicit)', () => {
        const encoded = encodeDataSet(
            dataSet([
                element('00080060', 'CS', 'CT'),
                element('00280010', 'US', [512]),
                element('00281052', 'DS', '-1024'),
                element('7FE00010', 'OW', Uint8Array.from([1, 2, 3, 4])),
            ])
        );
        const result = parse(encoded, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.error).toBeUndefined();
        expect(result.dataSet.string('x00080060')).toBe('CT');
        expect(result.dataSet.uint16('x00280010')).toBe(512);
        expect(result.dataSet.floatString('x00281052')).toBe(-1024);
        expect(result.dataSet.element('x7fe00010')?.length).toBe(4);
    });

    it('round-trips implicit output', () => {
        const encoded = encodeDataSet(dataSet([element('00280010', 'US', [512])]), { explicitVr: false });
        const result = parse(encoded, { transferSyntax: TS_IMPLICIT_LE });
        expect(result.dataSet.uint16('x00280010')).toBe(512);
        // implicit header: tag + 4-byte length
        expect(encoded.length).toBe(8 + 2);
    });

    it('round-trips defined-length sequences', () => {
        const encoded = encodeDataSet(dataSet([element('00081140', 'SQ', [item([element('00080100', 'SH', 'AB')])])]));
        const result = parse(encoded, { transferSyntax: TS_EXPLICIT_LE });
        const sq = result.dataSet.element('x00081140') as SequenceElement;
        expect(sq.kind).toBe('sequence');
        expect(sq.hadUndefinedLength).toBe(false);
        expect(sq.items[0]?.dataSet.string('x00080100')).toBe('AB');
    });

    it('round-trips undefined-length sequences and items', () => {
        const encoded = encodeDataSet(dataSet([{ ...element('00081140', 'SQ', [item([element('00080100', 'SH', 'AB')], true)]), undefinedLength: true }]));
        const result = parse(encoded, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.error).toBeUndefined();
        const sq = result.dataSet.element('x00081140') as SequenceElement;
        expect(sq.hadUndefinedLength).toBe(true);
        expect(sq.items[0]?.hadUndefinedLength).toBe(true);
        expect(sq.items[0]?.dataSet.string('x00080100')).toBe('AB');
    });

    it('round-trips encapsulated pixel data', () => {
        const encoded = encodeDataSet(
            dataSet([
                {
                    ...element('7FE00010', 'OB', { kind: 'fragments', basicOffsetTable: [0], fragments: [Uint8Array.from([1, 2, 3, 4])] }),
                    undefinedLength: true,
                },
            ])
        );
        const result = parse(encoded, { transferSyntax: '1.2.840.10008.1.2.4.50' });
        const pixelData = result.dataSet.element('x7fe00010') as EncapsulatedElement;
        expect(pixelData.kind).toBe('encapsulated');
        expect(pixelData.basicOffsetTable).toEqual([0]);
        expect(pixelData.fragments).toHaveLength(1);
    });

    it('rejects odd-length values and missing explicit VRs', () => {
        expect(() => encodeDataSet(dataSet([element('00080060', 'CS', Uint8Array.from([1, 2, 3]))]))).toThrow(/even length/);
        expect(() => encodeDataSet(dataSet([element('00080060', undefined, 'AB')]))).toThrow(/requires one/);
        expect(() => encodeDataSet(dataSet([element('00080060', undefined, 'AB')]), { explicitVr: false })).not.toThrow();
    });
});

describe('writeFile', () => {
    const spec = [
        element('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.7'),
        element('00080018', 'UI', '1.2.3.4.5'),
        element('00080060', 'CS', 'OT'),
        element('00280010', 'US', [2]),
    ];

    it('produces a parseable Part-10 file with a correct meta group', () => {
        const file = writeFile({ dataSet: dataSet(spec) });
        const result = parse(file);
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_EXPLICIT_LE);
        expect(result.meta.string('x00020002')).toBe('1.2.840.10008.5.1.4.1.1.7');
        expect(result.meta.string('x00020003')).toBe('1.2.3.4.5');
        expect(result.dataSet.string('x00080060')).toBe('OT');
        // group length correctness: (0002,0000) equals bytes after it to end of meta
        const groupLength = result.meta.uint32('x00020000') as number;
        const metaEnd = Math.max(...[...result.meta.elements.values()].map(el => el.endOffset));
        const lengthElement = result.meta.element('x00020000') as NonNullable<ReturnType<typeof result.meta.element>>;
        expect(groupLength).toBe(metaEnd - lengthElement.endOffset);
    });

    it('writes implicit little endian', () => {
        const file = writeFile({ dataSet: dataSet(spec), transferSyntax: TS_IMPLICIT_LE });
        const result = parse(file);
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_IMPLICIT_LE);
        expect(result.dataSet.uint16('x00280010')).toBe(2);
    });

    it('writes deflated files', () => {
        const file = writeFile({ dataSet: dataSet(spec), transferSyntax: TS_DEFLATED_LE });
        const result = parse(file);
        expect(result.error).toBeUndefined();
        expect(result.transferSyntax).toBe(TS_DEFLATED_LE);
        expect(result.dataSet.string('x00080060')).toBe('OT');
    });

    it('rejects big-endian output and bad preambles', () => {
        expect(() => writeFile({ dataSet: dataSet(spec), transferSyntax: '1.2.840.10008.1.2.2' })).toThrow(/read-only/);
        expect(() => writeFile({ dataSet: dataSet(spec), preamble: new Uint8Array(4) })).toThrow(/128 bytes/);
    });

    it('buildMetaGroup produces the documented identifiers', () => {
        const meta = buildMetaGroup(TS_EXPLICIT_LE, '1.2', '3.4');
        const result = parse(meta, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.dataSet.string('x00020012')).toMatch(/^2\.25\./);
        expect(result.dataSet.string('x00020013')).toBe('UBERCODE_DP2');
    });
});

describe('modifyDataSet (parse → modify → serialize)', () => {
    it('replaces, adds and removes elements', () => {
        const original = writeFile({
            dataSet: dataSet([element('00080060', 'CS', 'CT'), element('00100010', 'PN', 'Old^Name'), element('00280010', 'US', [512])]),
        });
        const parsed = parse(original);
        const edited = modifyDataSet(parsed.dataSet, {
            set: [element('00100010', 'PN', 'New^Name'), element('00100020', 'LO', 'ID42')],
            remove: ['x00280010'],
        });
        const rewritten = writeFile({ dataSet: edited });
        const result = parse(rewritten);
        expect(result.error).toBeUndefined();
        expect(result.dataSet.string('x00100010')).toBe('New^Name');
        expect(result.dataSet.string('x00100020')).toBe('ID42');
        expect(result.dataSet.string('x00080060')).toBe('CT');
        expect(result.dataSet.element('x00280010')).toBeUndefined();
    });
});

describe('toWriteModel + serializeParsed idempotence', () => {
    it('write → parse → write is byte-identical', () => {
        const file = writeFile({
            dataSet: dataSet([
                element('00080060', 'CS', 'CT'),
                element('00081140', 'SQ', [item([element('00080100', 'SH', 'AB')])]),
                {
                    ...element('00082218', 'SQ', [item([element('00080100', 'SH', 'CD')], true)]),
                    undefinedLength: true,
                },
                element('00280010', 'US', [512]),
            ]),
        });
        const parsed = parse(file);
        expect(parsed.error).toBeUndefined();
        const rewritten = serializeParsed(parsed);
        expect(Array.from(rewritten)).toEqual(Array.from(file));
    });

    it('toWriteModel rejects unknown-kind elements', () => {
        // undefined-length OB (non-pixel-data) scanned as unknown
        const bytes = Uint8Array.from([
            0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = parse(bytes, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.error).toBeUndefined();
        expect(() => toWriteModel(result.dataSet)).toThrow(/cannot be re-encoded/);
    });
});
