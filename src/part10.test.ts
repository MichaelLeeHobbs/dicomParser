import { describe, expect, it } from 'vitest';
import { DicomError } from './errors';
import { readPart10Header, readUiString } from './part10';
import { TAG_TRANSFER_SYNTAX_UID, tagFromString } from './tag';
import { TS, concat, explicitEl, evenPad, latin1, metaGroup, p10 } from '../tests/helpers/p10';

describe('readPart10Header', () => {
    it('reads the meta group of a standard Part-10 file', () => {
        const bytes = p10(TS.explicitLE, []);
        const header = readPart10Header(bytes);
        expect(header.error).toBeUndefined();
        expect(header.isPart10).toBe(true);
        expect(header.transferSyntax).toBe(TS.explicitLE);
        expect(header.dataSetPosition).toBe(bytes.length);
        expect(header.meta.element('x00020002')).toBeDefined();
        expect(header.meta.element(TAG_TRANSFER_SYNTAX_UID)).toBeDefined();
        expect(header.warnings).toHaveLength(0);
    });

    it('stops the meta parse at the first non-group-0002 tag', () => {
        const dataset = explicitEl('00080060', 'CS', latin1('CT'));
        const bytes = p10(TS.explicitLE, [dataset]);
        const header = readPart10Header(bytes);
        expect(header.dataSetPosition).toBe(bytes.length - dataset.length);
        expect(header.meta.element('x00080060')).toBeUndefined();
    });

    it('tolerates a missing preamble with DICM at offset 0 (divergence: legacy rejected it)', () => {
        const withPreamble = p10(TS.explicitLE, []);
        const bytes = withPreamble.subarray(128);
        const header = readPart10Header(bytes);
        expect(header.error).toBeUndefined();
        expect(header.transferSyntax).toBe(TS.explicitLE);
        expect(header.warnings.some(w => w.code === 'missing-preamble')).toBe(true);
    });

    it('supports headerless input via the transferSyntax option (#48)', () => {
        const bytes = explicitEl('00080060', 'CS', latin1('CT'));
        const header = readPart10Header(bytes, { transferSyntax: TS.explicitLE });
        expect(header.error).toBeUndefined();
        expect(header.isPart10).toBe(false);
        expect(header.transferSyntax).toBe(TS.explicitLE);
        expect(header.dataSetPosition).toBe(0);
        expect(header.meta.elements.size).toBe(0);
    });

    it('reports not-dicom without a DICM prefix or override', () => {
        const header = readPart10Header(new Uint8Array(200));
        expect(header.error?.code).toBe('not-dicom');
        expect(header.isPart10).toBe(false);
    });

    it('reports a malformed meta group missing (0002,0010)', () => {
        const meta = explicitEl('00020002', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7', '\0'));
        const bytes = concat([new Uint8Array(128), latin1('DICM'), meta]);
        const header = readPart10Header(bytes);
        expect(header.error?.code).toBe('malformed');
        expect(header.meta.element('x00020002')).toBeDefined();
    });

    it('salvages meta elements when the meta group is truncated', () => {
        const full = concat([new Uint8Array(128), latin1('DICM'), metaGroup(TS.explicitLE)]);
        const truncated = full.subarray(0, full.length - 3);
        const header = readPart10Header(truncated);
        expect(header.error).toBeInstanceOf(DicomError);
        expect(header.meta.element('x00020002')).toBeDefined();
    });

    it('rejects non-Uint8Array input', () => {
        expect(() => readPart10Header(undefined as unknown as Uint8Array)).toThrow(DicomError);
    });
});

describe('readUiString', () => {
    it('strips trailing NUL and space padding', () => {
        const bytes = latin1('1.2.840.10008.1.2.1\0');
        expect(readUiString(bytes, 0, bytes.length)).toBe('1.2.840.10008.1.2.1');
        const spaced = latin1('CT ');
        expect(readUiString(spaced, 0, spaced.length)).toBe('CT');
    });

    it('reads a slice at an offset', () => {
        const bytes = latin1('xxABy');
        expect(readUiString(bytes, 2, 2)).toBe('AB');
    });

    it('returns empty for all-padding values', () => {
        const bytes = latin1('\0\0');
        expect(readUiString(bytes, 0, 2)).toBe('');
    });
});

describe('meta group element identity', () => {
    it('keeps meta elements addressable by legacy tag strings', () => {
        const header = readPart10Header(p10(TS.implicitLE, []));
        const ts = header.meta.element('x00020010');
        expect(ts?.kind).toBe('value');
        expect(ts?.vr).toBe('UI');
        expect(ts?.tag).toBe(tagFromString('x00020010'));
    });
});
