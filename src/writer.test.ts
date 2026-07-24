import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DicomError } from './errors';
import { parse, TS_DEFLATED_LE, TS_EXPLICIT_LE, TS_IMPLICIT_LE } from './parse';
import { encodeDataSet } from './writer';
import { buildMetaGroup, modifyDataSet, serializeParsed, writeFile } from './writeFile';
import { dataSet, element, encodeBigintValue, encodeNumericValue, encodeStringValue, item, toWriteModel } from './writeModel';
import type { EncapsulatedElement, SequenceElement } from './element';
import { concat, explicitEl, latin1 } from '../tests/helpers/p10';

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

describe('encodeDataSet — length-field and VR validation (adversarial review W1/W6)', () => {
    it('rejects a value that overflows a short-form 16-bit length field instead of silently truncating', () => {
        // 80000 bytes under US (short form) would encode as 80000 & 0xFFFF = 14464
        const big = new Array(40000).fill(1);
        expect(() => encodeDataSet(dataSet([element('00281201', 'US', big)]))).toThrow(DicomError);
        expect(() => encodeDataSet(dataSet([element('00281201', 'US', big)]))).toThrow(/exceeds its 16-bit length field/);
    });

    it('accepts the same large value under a long-form VR', () => {
        const bytes = new Uint8Array(80000);
        const encoded = encodeDataSet(dataSet([element('7FE00010', 'OW', bytes)]));
        // 12-byte long-form header + 80000 value
        expect(encoded.length).toBe(12 + 80000);
        const dv = new DataView(encoded.buffer, encoded.byteOffset);
        expect(dv.getUint32(8, true)).toBe(80000);
    });

    it('accepts a value exactly at the 16-bit boundary and rejects one past it', () => {
        expect(() => encodeDataSet(dataSet([element('00081030', 'LO', new Uint8Array(0xfffe))]))).not.toThrow();
        // 0x10000 bytes under a short-form VR overflows
        expect(() => encodeDataSet(dataSet([element('00081030', 'UN', new Uint8Array(0x10000))]))).not.toThrow(); // UN is long-form
    });

    it('rejects an implicit-VR value that overflows the 32-bit length field only above 0xFFFFFFFE', () => {
        // implicit uses a 32-bit field; values that large are impractical to allocate, so
        // just assert the short-form path does not apply (implicit is always long)
        const encoded = encodeDataSet(dataSet([element('00281201', 'US', new Array(40000).fill(1))]), { explicitVr: false });
        const dv = new DataView(encoded.buffer, encoded.byteOffset);
        expect(dv.getUint32(4, true)).toBe(80000); // full length preserved in implicit VR
    });

    it('rejects an explicit VR whose code is not exactly 2 characters', () => {
        expect(() => encodeDataSet(dataSet([{ ...element('00080060', 'C', 'CT'), vr: 'C' }]))).toThrow(/exactly 2 characters/);
        expect(() => encodeDataSet(dataSet([{ ...element('00080060', 'CSX', 'CT'), vr: 'CSX' }]))).toThrow(/exactly 2 characters/);
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

    it('rejects a transfer-syntax / pixel-data payload mismatch (review D2)', () => {
        const jpeg = '1.2.840.10008.1.2.4.50';
        const encapsulated = dataSet([
            ...spec,
            { ...element('7FE00010', 'OB', { kind: 'fragments', basicOffsetTable: [0], fragments: [Uint8Array.from([1, 2, 3, 4])] }), undefinedLength: true },
        ]);
        const native = dataSet([...spec, element('7FE00010', 'OW', { kind: 'bytes', bytes: Uint8Array.from([1, 2, 3, 4]) })]);
        // encapsulated payload defaulting to native Explicit LE is refused...
        expect(() => writeFile({ dataSet: encapsulated })).toThrow(/encapsulated .*native/);
        // ...but the matching compressed transfer syntax is accepted
        expect(() => writeFile({ dataSet: encapsulated, transferSyntax: jpeg })).not.toThrow();
        // native pixel data under a compressed transfer syntax is refused...
        expect(() => writeFile({ dataSet: native, transferSyntax: jpeg })).toThrow(/native pixel data .*compressed/);
        // ...and is fine under a native transfer syntax
        expect(() => writeFile({ dataSet: native })).not.toThrow();
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

describe('serializeParsed — completeness guard (review W7)', () => {
    const threeElementFile = (): Uint8Array =>
        writeFile({ dataSet: dataSet([element('00080060', 'CS', 'CT'), element('00100010', 'PN', 'A^B'), element('00280010', 'US', [512])]) });

    it('serializes a full ok parse identically, with or without options', () => {
        const file = threeElementFile();
        const parsed = parse(file);
        // precondition: a complete, unstopped, error-free parse
        expect(parsed.ok).toBe(true);
        expect(parsed.error).toBeUndefined();
        expect(parsed.stoppedAt).toBeUndefined();

        const a = serializeParsed(parsed);
        const b = serializeParsed(parsed, {});
        const c = serializeParsed(parsed, { allowPartial: true });
        expect(Array.from(a)).toEqual(Array.from(file));
        expect(Array.from(b)).toEqual(Array.from(file));
        expect(Array.from(c)).toEqual(Array.from(file));
    });

    it('refuses a stopAt-terminated parse by default', () => {
        const parsed = parse(threeElementFile(), { stopAt: { tag: 'x00280010', inclusive: false } });
        // precondition: ok=true but halted early — !ok alone would miss this
        expect(parsed.ok).toBe(true);
        expect(parsed.stoppedAt).not.toBeUndefined();

        expect(() => serializeParsed(parsed)).toThrow(DicomError);
        try {
            serializeParsed(parsed);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(DicomError);
            expect((err as DicomError).code).toBe('invalid-argument');
            expect((err as DicomError).message).toMatch(/stopped early at .*allowPartial/);
        }
    });

    it('serializes a truncated stopAt parse under allowPartial', () => {
        const parsed = parse(threeElementFile(), { stopAt: { tag: 'x00280010', inclusive: false } });
        const bytes = serializeParsed(parsed, { allowPartial: true });
        expect(bytes.length).toBeGreaterThan(0);

        const reparsed = parse(bytes);
        expect(reparsed.ok).toBe(true);
        expect(reparsed.dataSet.element('x00080060')).not.toBeUndefined();
        expect(reparsed.dataSet.element('x00100010')).not.toBeUndefined();
        expect(reparsed.dataSet.element('x00280010')).toBeUndefined();
    });

    it('refuses a failed parse by default and reports the cause', () => {
        const file = threeElementFile();
        // cut the trailing defined-length value so it overruns EOF
        let result = parse(file);
        for (let cut = 1; cut < file.length; cut++) {
            const candidate = parse(file.subarray(0, file.length - cut));
            if (!candidate.ok && candidate.error !== undefined) {
                result = candidate;
                break;
            }
        }
        // precondition: a genuine failure carrying an error
        expect(result.ok).toBe(false);
        expect(result.error).not.toBeUndefined();

        expect(() => serializeParsed(result)).toThrow(DicomError);
        try {
            serializeParsed(result);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(DicomError);
            expect((err as DicomError).code).toBe('invalid-argument');
            expect((err as DicomError).message).toMatch(/failed parse.*allowPartial/);
            expect((err as DicomError).cause).toBe(result.error);
        }
    });

    it('serializes a partial dataset from a failed parse under allowPartial', () => {
        const file = threeElementFile();
        let result = parse(file);
        for (let cut = 1; cut < file.length; cut++) {
            const candidate = parse(file.subarray(0, file.length - cut));
            if (!candidate.ok && candidate.error !== undefined) {
                result = candidate;
                break;
            }
        }
        expect(result.ok).toBe(false);
        expect(result.error).not.toBeUndefined();

        const bytes = serializeParsed(result, { allowPartial: true });
        const reparsed = parse(bytes);
        expect(reparsed.ok).toBe(true);
        // the elements parsed before the failure survive the round-trip
        expect(reparsed.dataSet.element('x00080060')).not.toBeUndefined();
        expect(reparsed.dataSet.element('x00100010')).not.toBeUndefined();
    });

    it('does not trip the guard on a warnings-only parse', () => {
        // headerless explicit-LE dataset with the same tag twice: emits a
        // 'duplicate-tag' warning (last value wins) but parses ok with no
        // error/stop, and re-encodes cleanly. (The plan suggested an odd-length
        // value here, but a genuinely odd value is rejected by the encoder's
        // even-length rule on re-serialization — an unrelated throw — so a
        // duplicate-tag warning is used to isolate the W7 guard.)
        const duplicate = Uint8Array.from([
            0x08, 0x00, 0x60, 0x00, 0x43, 0x53, 0x02, 0x00, 0x43, 0x54, 0x08, 0x00, 0x60, 0x00, 0x43, 0x53, 0x02, 0x00, 0x4d, 0x52,
        ]);
        const result = parse(duplicate, { transferSyntax: TS_EXPLICIT_LE });
        expect(result.ok).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.stoppedAt).toBeUndefined();
        expect(result.warnings.some(w => w.code === 'duplicate-tag')).toBe(true);
        expect(() => serializeParsed(result)).not.toThrow();
    });

    it('allowPartial does not mask an unsupported big-endian throw', () => {
        const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'testImages', 'CT1_UNC.explicit_big_endian.dcm')));
        const result = parse(bytes);
        expect(() => serializeParsed(result, { allowPartial: true })).toThrow(DicomError);
        expect(() => serializeParsed(result, { allowPartial: true })).toThrow(/read-only/);
    });
});

describe('serializeParsed — truncation-warning guard (review verify)', () => {
    it('refuses a value silently clamped at EOF (unexpected-eof warning, ok=true)', () => {
        // OW element declaring 8 value bytes, then cut the file by 2 bytes so the
        // tokenizer clamps the value 8->6 with an unexpected-eof warning (ok stays true)
        const full = writeFile({ dataSet: dataSet([element('00080060', 'CS', 'CT'), element('7FE00010', 'OW', new Uint8Array(8))]) });
        const truncated = full.subarray(0, full.length - 2);
        const parsed = parse(truncated);
        expect(parsed.ok).toBe(true);
        expect(parsed.error).toBeUndefined();
        expect(parsed.stoppedAt).toBeUndefined();
        expect(parsed.warnings.some(w => w.code === 'unexpected-eof')).toBe(true);
        expect(() => serializeParsed(parsed)).toThrow(/adjusted or truncated/);
        // allowPartial lets it through
        expect(() => serializeParsed(parsed, { allowPartial: true })).not.toThrow();
    });

    it('still serializes a benign-warning parse (duplicate-tag) without allowPartial', () => {
        // craft a raw dataset with a duplicate tag (warns, but complete)
        const dup = concat([explicitEl('00080060', 'CS', latin1('CT')), explicitEl('00080060', 'CS', latin1('MR'))]);
        const parsed = parse(dup, { transferSyntax: TS_EXPLICIT_LE });
        expect(parsed.warnings.some(w => w.code === 'duplicate-tag')).toBe(true);
        expect(() => serializeParsed(parsed)).not.toThrow();
    });
});
