import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dicomParser, { DataSet, isPrivateTag, parseDicom, type Element } from './compat';
import { DicomError } from './errors';
import { TS, concat, encapsulatedPixelData, explicitEl, implicitEl, latin1, p10, p10Deflated, sqExplicit } from '../tests/helpers/p10';

// Phase 4 gate: the v1 surface dcmtk.js's _p10ToJson consumes, exercised the
// way that module actually uses it (default import, parseDicom with
// vrCallback + inflater, elements record, accessors, warnings).

const IMAGES = join(__dirname, '..', 'testImages');

describe('parseDicom — v1 surface', () => {
    it('merges meta elements into the dataset and keys by xggggeeee', () => {
        const dataSet = parseDicom(p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT'))]));
        expect(dataSet.string('x00020010')).toBe(TS.explicitLE);
        expect(dataSet.string('x00080060')).toBe('CT');
        expect(dataSet.elements['x00020010']?.vr).toBe('UI');
        expect(dataSet.elements['x00080060']?.dataOffset).toBeGreaterThan(0);
        expect(Array.isArray(dataSet.warnings)).toBe(true);
    });

    it('exposes the accessor set with v1 names', () => {
        const dataSet = parseDicom(
            p10(TS.explicitLE, [
                explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02])),
                explicitEl('00281052', 'DS', latin1('-1024')),
                explicitEl('00280030', 'DS', latin1('0.5\\0.75')),
                explicitEl('0020000D', 'UI', latin1('1.2.3\0')),
                explicitEl('00189165', 'AT', Uint8Array.from([0x18, 0x00, 0x65, 0x10])),
                explicitEl('00181063', 'FD', Uint8Array.from([0, 0, 0, 0, 0, 0, 0xf8, 0x3f])),
            ])
        );
        expect(dataSet.uint16('x00280010')).toBe(512);
        expect(dataSet.int16('x00280010')).toBe(512);
        expect(dataSet.uint32('x00280010')).toBeUndefined();
        expect(dataSet.floatString('x00281052')).toBe(-1024);
        expect(dataSet.intString('x00281052')).toBe(-1024);
        expect(dataSet.numStringValues('x00280030')).toBe(2);
        expect(dataSet.string('x00280030', 1)).toBe('0.75');
        expect(dataSet.string('x0020000d')).toBe('1.2.3');
        expect(dataSet.attributeTag('x00189165')).toBe('x00181065');
        expect(dataSet.double('x00181063')).toBe(1.5);
    });

    it('supports vrCallback with xggggeeee tags for implicit datasets', () => {
        const seen: string[] = [];
        const dataSet = parseDicom(p10(TS.implicitLE, [implicitEl('00280010', Uint8Array.from([0x00, 0x02]))]), {
            vrCallback: tag => {
                seen.push(tag);
                return tag === 'x00280010' ? 'US' : undefined;
            },
        });
        expect(seen).toContain('x00280010');
        expect(dataSet.elements['x00280010']?.vr).toBe('US');
    });

    it('supports the legacy inflater contract (full bytes + position in, combined out)', () => {
        const file = p10Deflated([explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        let calledWith: number | undefined;
        const dataSet = parseDicom(file, {
            inflater: (byteArray, position) => {
                calledWith = position;
                const inflated = inflateRawSync(byteArray.subarray(position));
                const combined = new Uint8Array(position + inflated.byteLength);
                combined.set(byteArray.subarray(0, position), 0);
                combined.set(inflated, position);
                return combined;
            },
        });
        expect(calledWith).toBeGreaterThan(132);
        expect(dataSet.uint16('x00280010')).toBe(512);
    });

    it('supports TransferSyntaxUID for raw datasets and untilTag', () => {
        const raw = concat([explicitEl('00080060', 'CS', latin1('CT')), explicitEl('00280010', 'US', Uint8Array.from([0x00, 0x02]))]);
        const dataSet = parseDicom(raw, { TransferSyntaxUID: TS.explicitLE });
        expect(dataSet.string('x00080060')).toBe('CT');
        const stopped = parseDicom(raw, { TransferSyntaxUID: TS.explicitLE, untilTag: 'x00280010' });
        expect(stopped.elements['x00280010']).toBeDefined();
        expect(Object.keys(stopped.elements)).toHaveLength(2);
    });

    it('surfaces sequences as items with nested dataSets', () => {
        const file = p10(TS.explicitLE, [sqExplicit('00081140', [concat([explicitEl('00080100', 'SH', latin1('AB'))])])]);
        const dataSet = parseDicom(file);
        const sq = dataSet.elements['x00081140'] as Element;
        expect(sq.items).toHaveLength(1);
        expect(sq.items?.[0]?.tag).toBe('xfffee000');
        expect(sq.items?.[0]?.dataSet?.string('x00080100')).toBe('AB');
        // no delimiter leakage (upstream #244 fix carried into the façade)
        expect(Object.keys(dataSet.elements).some(k => k.startsWith('xfffe'))).toBe(false);
    });

    it('surfaces encapsulated pixel data with fragments and legacy-style length', () => {
        const file = p10(TS.jpegBaseline, [encapsulatedPixelData([Uint8Array.from([1, 2, 3, 4])], [0])]);
        const dataSet = parseDicom(file);
        const pixelData = dataSet.elements['x7fe00010'] as Element;
        expect(pixelData.encapsulatedPixelData).toBe(true);
        expect(pixelData.hadUndefinedLength).toBe(true);
        expect(pixelData.basicOffsetTable).toEqual([0]);
        expect(pixelData.fragments).toHaveLength(1);
        // legacy length includes the trailing sequence delimiter
        const core = pixelData.fragments?.[0] as NonNullable<NonNullable<Element['fragments']>[number]>;
        expect(dataSet.byteArray.subarray(core.position, core.position + core.length)).toEqual(Uint8Array.from([1, 2, 3, 4]));
    });

    it('throws a DicomError carrying the partial dataSet on failure', () => {
        const truncated = p10(TS.explicitLE, [explicitEl('00080060', 'CS', latin1('CT'))]).subarray(0, 150);
        try {
            parseDicom(truncated);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(DicomError);
            const withDataSet = error as DicomError & { dataSet?: DataSet };
            expect(withDataSet.dataSet).toBeInstanceOf(DataSet);
        }
    });
});

describe('compat namespace object', () => {
    it('exposes the v1 helpers', () => {
        expect(dicomParser.parseDicom).toBe(parseDicom);
        expect(dicomParser.isPrivateTag('x00090010')).toBe(true);
        expect(isPrivateTag('x00100010')).toBe(false);
        expect(dicomParser.isStringVr('CS')).toBe(true);
        expect(dicomParser.parseDA('20140329')?.year).toBe(2014);
        expect(dicomParser.parseTM('081236')?.minutes).toBe(12);
        expect(dicomParser.parsePN('F^G')?.givenName).toBe('G');
        expect(dicomParser.version).toBe('2.0.0');
    });
});

describe('compat against real files (the _p10ToJson usage pattern)', () => {
    it('parses CT1_UNC and walks elements the way dcmtk.js does', () => {
        const bytes = new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.explicit_little_endian.dcm')));
        const dataSet = parseDicom(bytes);
        const littleEndian = dataSet.string('x00020010') !== '1.2.840.10008.1.2.2';
        expect(littleEndian).toBe(true);
        const keys = Object.keys(dataSet.elements).sort();
        expect(keys.length).toBeGreaterThan(20);
        for (const key of keys) {
            const element = dataSet.elements[key] as Element;
            expect(element.tag).toBe(key);
            expect(element.dataOffset + element.length).toBeLessThanOrEqual(dataSet.byteArray.length);
        }
        expect(dataSet.uint16('x00280010')).toBe(512);
    });

    it('parses the fragmented encapsulated fixture through the façade', () => {
        const bytes = new Uint8Array(readFileSync(join(IMAGES, 'encapsulated', 'single-frame', 'CT1_UNC.fragmented_bot_jpeg_ls.80.dcm')));
        const dataSet = parseDicom(bytes);
        const pixelData = dataSet.elements['x7fe00010'] as Element;
        expect(pixelData.fragments?.length).toBeGreaterThan(1);
        expect(pixelData.basicOffsetTable?.length).toBeGreaterThan(0);
    });

    it('parses deflated files without an inflater (core zlib path)', () => {
        const bytes = new Uint8Array(readFileSync(join(IMAGES, 'deflate', 'image_dfl')));
        const dataSet = parseDicom(bytes);
        expect(dataSet.string('x00020010')).toBe('1.2.840.10008.1.2.1.99');
        expect(dataSet.uint16('x00280010')).toBeGreaterThan(0);
    });

    it('parses big-endian files (BE stays readable through the façade)', () => {
        const bytes = new Uint8Array(readFileSync(join(IMAGES, 'CT1_UNC.explicit_big_endian.dcm')));
        const dataSet = parseDicom(bytes);
        expect(dataSet.uint16('x00280010')).toBe(512);
        expect(dataSet.uint16('x00280011')).toBe(512);
    });
});
