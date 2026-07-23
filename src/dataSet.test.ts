import { describe, expect, it } from 'vitest';
import { ByteStream } from './byteStream';
import { DicomDataSet } from './dataSet';
import { readElements } from './tokenizer';

// Ported from legacy dataSet_test.js. The little/big-endian element vectors are
// the legacy ones verbatim. Divergences under test: no NUL truncation in
// string() (#146), bounds-checked indexed reads, numeric attributeTag, and the
// new uint64/int64 accessors (#280).

const LE_ELEMENTS = [
    // x22114433             US          4           0xadde 0x1234
    [0x11, 0x22, 0x33, 0x44, 0x55, 0x53, 0x04, 0x00, 0xde, 0xad, 0x34, 0x12],
    // x22114434             OB          4           'O\B\0'
    [0x11, 0x22, 0x34, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x4f, 0x5c, 0x42, 0x00],
    // x22114435             OB          10          ' 1.2\2.3  '
    [0x11, 0x22, 0x35, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x20, 0x31, 0x2e, 0x32, 0x5c, 0x32, 0x2e, 0x33, 0x20, 0x20],
    // x22114436             IS          4           '1234'
    [0x11, 0x22, 0x36, 0x44, 0x49, 0x53, 0x04, 0x00, 0x31, 0x32, 0x33, 0x34],
    // x2211443a             PN          4           ' S  '
    [0x11, 0x22, 0x3a, 0x44, 0x50, 0x4e, 0x04, 0x00, 0x20, 0x53, 0x20, 0x20],
    // x2211443b             (SL data)   8           -90745933, 28035055
    [0x11, 0x22, 0x3b, 0x44, 0x50, 0x4e, 0x08, 0x00, 0xb3, 0x53, 0x97, 0xfa, 0xef, 0xc7, 0xab, 0x01],
    // x2211443c             (FL data)   8           -73.00198, 194.53615
    [0x11, 0x22, 0x3c, 0x44, 0x50, 0x4e, 0x08, 0x00, 0x04, 0x01, 0x92, 0xc2, 0x41, 0x89, 0x42, 0x43],
    // x2211443d             (FD data)   16
    [0x11, 0x22, 0x3d, 0x44, 0x50, 0x4e, 0x10, 0x00, 0xed, 0x91, 0xfb, 0x20, 0x57, 0x63, 0xa4, 0xc8, 0x3d, 0xac, 0x78, 0x6b, 0x92, 0xf4, 0xe1, 0x50],
    // x2211443e             AT          4           (0018,1065)
    [0x11, 0x22, 0x3e, 0x44, 0x41, 0x54, 0x04, 0x00, 0x18, 0x00, 0x65, 0x10],
    // x2211443f             UV          8           18446744073709551615
    [0x11, 0x22, 0x3f, 0x44, 0x55, 0x56, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    // x22114440             SV          8           -2
    [0x11, 0x22, 0x40, 0x44, 0x53, 0x56, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    // x22114441             OB          0           (empty)
    [0x11, 0x22, 0x41, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
];

const BE_ELEMENTS = [
    [0x22, 0x11, 0x44, 0x33, 0x55, 0x53, 0x00, 0x04, 0xad, 0xde, 0x12, 0x34],
    [0x22, 0x11, 0x44, 0x3b, 0x50, 0x4e, 0x00, 0x08, 0xfa, 0x97, 0x53, 0xb3, 0x01, 0xab, 0xc7, 0xef],
    [0x22, 0x11, 0x44, 0x3c, 0x50, 0x4e, 0x00, 0x08, 0xc2, 0x92, 0x01, 0x04, 0x43, 0x42, 0x89, 0x41],
    [0x22, 0x11, 0x44, 0x3d, 0x50, 0x4e, 0x00, 0x10, 0xc8, 0xa4, 0x63, 0x57, 0x20, 0xfb, 0x91, 0xed, 0x50, 0xe1, 0xf4, 0x92, 0x6b, 0x78, 0xac, 0x3d],
    [0x22, 0x11, 0x44, 0x3e, 0x41, 0x54, 0x00, 0x04, 0x00, 0x18, 0x10, 0x63],
];

function makeDataSet(vectors: readonly (readonly number[])[], littleEndian: boolean): DicomDataSet {
    const bytes = Uint8Array.from(vectors.flat());
    const stream = new ByteStream(bytes, { littleEndian });
    const result = readElements(stream, { explicitVr: true });
    expect(result.error).toBeUndefined();
    return new DicomDataSet(bytes, littleEndian, result.elements);
}

const le = (): DicomDataSet => makeDataSet(LE_ELEMENTS, true);
const be = (): DicomDataSet => makeDataSet(BE_ELEMENTS, false);

describe('DicomDataSet numeric accessors', () => {
    it('uint16 reads values by index in both endiannesses', () => {
        expect(le().uint16('x22114433')).toBe(0xadde);
        expect(le().uint16('x22114433', 1)).toBe(0x1234);
        expect(be().uint16('x22114433', 1)).toBe(0x1234);
    });

    it('int16 reads values by index', () => {
        expect(le().int16('x22114433')).toBe(-21026);
        expect(le().int16('x22114433', 1)).toBe(4660);
        expect(be().int16('x22114433', 1)).toBe(4660);
    });

    it('uint32 reads values by index', () => {
        expect(le().uint32('x2211443b')).toBe(4204221363);
        expect(le().uint32('x2211443b', 1)).toBe(28035055);
        expect(be().uint32('x2211443b', 1)).toBe(28035055);
    });

    it('int32 reads values by index', () => {
        expect(le().int32('x2211443b')).toBe(-90745933);
        expect(le().int32('x2211443b', 1)).toBe(28035055);
        expect(be().int32('x2211443b', 1)).toBe(28035055);
    });

    it('float32 reads values by index', () => {
        expect(le().float32('x2211443c')).toBe(-73.001983642578125);
        expect(le().float32('x2211443c', 1)).toBe(194.5361480712890625);
        expect(be().float32('x2211443c', 1)).toBe(194.5361480712890625);
    });

    it('float64 reads values by index', () => {
        expect(le().float64('x2211443d')).toBe(-8.880247435259784e41);
        expect(le().float64('x2211443d', 1)).toBe(4.257973357568699e81);
        expect(be().float64('x2211443d', 1)).toBe(4.257973357568699e81);
    });

    it('uint64/int64 read SV/UV values as bigint (#280)', () => {
        expect(le().uint64('x2211443f')).toBe(18446744073709551615n);
        expect(le().int64('x22114440')).toBe(-2n);
        expect(le().int64('x2211443f')).toBe(-1n);
    });

    it('returns undefined for nonexistent tags', () => {
        const dataSet = le();
        expect(dataSet.uint16('x12345678')).toBeUndefined();
        expect(dataSet.int32('x12345678')).toBeUndefined();
        expect(dataSet.float64('x12345678')).toBeUndefined();
        expect(dataSet.uint64('x12345678')).toBeUndefined();
    });

    it('returns undefined for zero-length elements', () => {
        expect(le().uint16('x22114441')).toBeUndefined();
    });

    it('bounds-checks indexed reads (divergence: legacy read past the element)', () => {
        const dataSet = le();
        expect(dataSet.uint16('x22114433', 2)).toBeUndefined();
        expect(dataSet.uint16('x22114433', -1)).toBeUndefined();
        expect(dataSet.uint32('x22114433', 1)).toBeUndefined();
        expect(dataSet.uint64('x22114433')).toBeUndefined();
    });
});

describe('DicomDataSet attributeTag', () => {
    it('reads an AT value as a numeric tag', () => {
        expect(le().attributeTag('x2211443e')).toBe(0x00181065);
        expect(be().attributeTag('x2211443e')).toBe(0x00181063);
    });

    it('supports an index for multi-valued AT (#253)', () => {
        expect(le().attributeTag('x2211443e', 0)).toBe(0x00181065);
        expect(le().attributeTag('x2211443e', 1)).toBeUndefined();
    });

    it('returns undefined when absent', () => {
        expect(le().attributeTag('x12345678')).toBeUndefined();
    });
});

describe('DicomDataSet string accessors', () => {
    it('string trims leading and trailing whitespace', () => {
        expect(le().string('x2211443a')).toBe('S');
    });

    it('string splits on backslash for an index, ignoring NUL padding (#146)', () => {
        expect(le().string('x22114434', 1)).toBe('B');
        expect(le().string('x22114434', 0)).toBe('O');
        expect(le().string('x22114434', 2)).toBeUndefined();
    });

    it('string does not truncate at an embedded NUL (#146 fix)', () => {
        // 'A\0B' with even length — legacy would have returned 'A'
        const bytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x53, 0x48, 0x04, 0x00, 0x41, 0x00, 0x42, 0x00]);
        const stream = new ByteStream(bytes);
        const result = readElements(stream, { explicitVr: true });
        const dataSet = new DicomDataSet(bytes, true, result.elements);
        expect(dataSet.string('x22114433')).toBe('A\0B');
    });

    it('text preserves leading spaces and strips trailing spaces', () => {
        expect(le().text('x2211443a')).toBe(' S');
        expect(le().text('x22114435', 1)).toBe('2.3');
    });

    it('numStringValues counts backslash-separated values', () => {
        expect(le().numStringValues('x22114435')).toBe(2);
        expect(le().numStringValues('x22114436')).toBe(1);
        expect(le().numStringValues('x22114441')).toBeUndefined();
    });

    it('floatString parses by index', () => {
        expect(le().floatString('x22114435')).toBe(1.2);
        expect(le().floatString('x22114435', 0)).toBe(1.2);
        expect(le().floatString('x22114435', 1)).toBe(2.3);
        expect(le().floatString('x12345678')).toBeUndefined();
    });

    it('intString parses integers', () => {
        expect(le().intString('x22114436')).toBe(1234);
        expect(le().intString('x12345678')).toBeUndefined();
    });

    it('string accessors return undefined for empty and absent elements', () => {
        const dataSet = le();
        expect(dataSet.string('x22114441')).toBeUndefined();
        expect(dataSet.string('x12345678')).toBeUndefined();
        expect(dataSet.text('x12345678')).toBeUndefined();
    });
});

describe('DicomDataSet rawBytes', () => {
    it('returns a zero-copy view of the value bytes', () => {
        const dataSet = le();
        const raw = dataSet.rawBytes('x22114436');
        expect(raw).toBeDefined();
        expect(Array.from(raw as Uint8Array)).toEqual([0x31, 0x32, 0x33, 0x34]);
    });

    it('returns undefined for absent elements and sequences', () => {
        expect(le().rawBytes('x12345678')).toBeUndefined();
        // sequence element
        const bytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(new ByteStream(bytes), { explicitVr: true });
        const dataSet = new DicomDataSet(bytes, true, result.elements);
        expect(dataSet.rawBytes('x22114433')).toBeUndefined();
        expect(dataSet.uint16('x22114433')).toBeUndefined();
    });
});
