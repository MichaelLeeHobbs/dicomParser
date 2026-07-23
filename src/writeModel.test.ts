import { describe, expect, it } from 'vitest';
import { parse, TS_EXPLICIT_LE, TS_IMPLICIT_LE } from './parse';
import { encodeDataSet } from './writer';
import { dataSet, element } from './writeModel';

// Coverage for the per-VR DataView writer lambdas in encodeNumericValue /
// encodeBigintValue (review B4). The byte-identical round-trip test elsewhere
// copies raw bytes, so these from-model writers never execute there. Each case
// encodes from the write model, parses it back, and asserts BOTH the typed
// accessor AND the exact little-endian value bytes — the byte assertion is the
// external oracle that catches a wrong DataView method even if a symmetric
// parse-side bug would hide it from the accessor.

/** Encodes a single explicit-LE element and returns the parsed element + value bytes. */
function roundTrip(el: ReturnType<typeof element>): { valueBytes: number[]; result: ReturnType<typeof parse> } {
    const encoded = encodeDataSet(dataSet([el]));
    const result = parse(encoded, { transferSyntax: TS_EXPLICIT_LE });
    expect(result.error).toBeUndefined();
    const parsed = result.dataSet.element(el.tag);
    expect(parsed).toBeDefined();
    const p = parsed as NonNullable<typeof parsed>;
    return { valueBytes: Array.from(result.bytes.subarray(p.dataOffset, p.dataOffset + p.length)), result };
}

describe('from-model numeric round trips (review B4)', () => {
    it('SS writes signed 16-bit little-endian', () => {
        const el = element('00280106', 'SS', [-2, -32768, 32767]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.int16(el.tag, 0)).toBe(-2);
        expect(result.dataSet.int16(el.tag, 1)).toBe(-32768);
        expect(result.dataSet.int16(el.tag, 2)).toBe(32767);
        expect(result.dataSet.element(el.tag)?.length).toBe(6);
        expect(valueBytes).toEqual([0xfe, 0xff, 0x00, 0x80, 0xff, 0x7f]);
    });

    it('SL writes signed 32-bit little-endian', () => {
        const el = element('00186020', 'SL', [-2, 2147483647, -2147483648]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.int32(el.tag, 0)).toBe(-2);
        expect(result.dataSet.int32(el.tag, 1)).toBe(2147483647);
        expect(result.dataSet.int32(el.tag, 2)).toBe(-2147483648);
        expect(result.dataSet.element(el.tag)?.length).toBe(12);
        expect(valueBytes).toEqual([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x80]);
    });

    it('FL writes 32-bit floats little-endian', () => {
        const el = element('00089459', 'FL', [-5.625, 1.5]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.float32(el.tag, 0)).toBe(-5.625);
        expect(result.dataSet.float32(el.tag, 1)).toBe(1.5);
        expect(valueBytes).toEqual([0x00, 0x00, 0xb4, 0xc0, 0x00, 0x00, 0xc0, 0x3f]);
    });

    it('FD writes 64-bit floats little-endian', () => {
        const el = element('00189087', 'FD', [0.1, -2.5]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.float64(el.tag, 0)).toBe(0.1);
        expect(result.dataSet.float64(el.tag, 1)).toBe(-2.5);
        expect(result.dataSet.element(el.tag)?.length).toBe(16);
        expect(valueBytes.slice(0, 8)).toEqual([0x9a, 0x99, 0x99, 0x99, 0x99, 0x99, 0xb9, 0x3f]);
        expect(valueBytes.slice(8)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0xc0]);
    });

    it('OD writes 64-bit floats little-endian', () => {
        const el = element('7FE00009', 'OD', [1.5, 0.1]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.float64(el.tag, 0)).toBe(1.5);
        expect(result.dataSet.float64(el.tag, 1)).toBe(0.1);
        expect(result.dataSet.element(el.tag)?.length).toBe(16);
        expect(valueBytes.slice(0, 8)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f]);
    });

    it('OF writes 32-bit floats little-endian', () => {
        const el = element('7FE00008', 'OF', [1.5, -5.625]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.float32(el.tag, 0)).toBe(1.5);
        expect(result.dataSet.float32(el.tag, 1)).toBe(-5.625);
        expect(valueBytes).toEqual([0x00, 0x00, 0xc0, 0x3f, 0x00, 0x00, 0xb4, 0xc0]);
    });

    it('OW writes unsigned 16-bit little-endian', () => {
        const el = element('7FE00010', 'OW', [0x1234, 0xabcd]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.uint16(el.tag, 0)).toBe(0x1234);
        expect(result.dataSet.uint16(el.tag, 1)).toBe(0xabcd);
        expect(valueBytes).toEqual([0x34, 0x12, 0xcd, 0xab]);
    });

    it('OL writes unsigned 32-bit little-endian', () => {
        const el = element('00660129', 'OL', [0x01020304, 0xfffffffe]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.uint32(el.tag, 0)).toBe(16909060);
        expect(result.dataSet.uint32(el.tag, 1)).toBe(4294967294);
        expect(valueBytes).toEqual([0x04, 0x03, 0x02, 0x01, 0xfe, 0xff, 0xff, 0xff]);
    });

    it('OB writes raw bytes from numbers', () => {
        const el = element('7FE00010', 'OB', [0, 255, 16, 32]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.element(el.tag)?.length).toBe(4);
        expect(valueBytes).toEqual([0, 255, 16, 32]);
    });

    it('AT writes group/element uint16 pairs (VM 1-n)', () => {
        const el = element('00209165', 'AT', [0x00100010, 0x0020000d]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.attributeTag(el.tag, 0)).toBe(0x00100010);
        expect(result.dataSet.attributeTag(el.tag, 1)).toBe(0x0020000d);
        expect(result.dataSet.element(el.tag)?.length).toBe(8);
        expect(valueBytes).toEqual([0x10, 0x00, 0x10, 0x00, 0x20, 0x00, 0x0d, 0x00]);
    });

    it('US writes the unsigned 16-bit boundary values', () => {
        const el = element('00280010', 'US', [0xffff, 0]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.uint16(el.tag, 0)).toBe(65535);
        expect(result.dataSet.uint16(el.tag, 1)).toBe(0);
        expect(valueBytes).toEqual([0xff, 0xff, 0x00, 0x00]);
    });

    it('SV writes signed 64-bit little-endian', () => {
        const el = element('00720074', 'SV', [-3n, 2n]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.int64(el.tag, 0)).toBe(-3n);
        expect(result.dataSet.int64(el.tag, 1)).toBe(2n);
        expect(valueBytes.slice(0, 8)).toEqual([0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    });

    it('UV writes unsigned 64-bit little-endian', () => {
        const el = element('00720076', 'UV', [18446744073709551615n]);
        const { valueBytes, result } = roundTrip(el);
        expect(result.dataSet.uint64(el.tag, 0)).toBe(2n ** 64n - 1n);
        expect(valueBytes).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    });

    it('encodes numeric values in implicit VR too', () => {
        const encoded = encodeDataSet(dataSet([element('00186020', 'SL', [-2])]), { explicitVr: false });
        const result = parse(encoded, { transferSyntax: TS_IMPLICIT_LE });
        expect(result.error).toBeUndefined();
        expect(result.dataSet.int32('00186020')).toBe(-2);
        // 8-byte implicit header (tag + 4-byte length) + 4 value bytes
        expect(encoded.length).toBe(12);
    });
});
