import { describe, expect, it } from 'vitest';
import { ByteStream } from './byteStream';
import { DicomError } from './errors';
import { readExplicitElementHeader, readImplicitElementHeader } from './elementHeader';
import { UNDEFINED_LENGTH, tagFromString } from './tag';

// Ported from the header-parsing halves of legacy readDicomElementExplicit_test.js
// and readDicomElementImplicit_test.js. Sequence/value handling moved to the
// tokenizer and is tested there. Unlike legacy, the header readers do not need
// the value bytes present, so the long-form cases no longer allocate 16 MB
// arrays.

function bytesOf(values: readonly number[]): Uint8Array {
    return Uint8Array.from(values);
}

describe('readExplicitElementHeader', () => {
    it('parses the tag', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x54, 0x00, 0x00]));
        const header = readExplicitElementHeader(stream);
        expect(header.tag).toBe(tagFromString('x22114433'));
    });

    it('parses the VR', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x54, 0x00, 0x00]));
        const header = readExplicitElementHeader(stream);
        expect(header.vr).toBe('ST');
        expect(header.vrSource).toBe('explicit');
    });

    it('parses a short-form (16-bit) length', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x54, 0x01, 0x02]));
        const header = readExplicitElementHeader(stream);
        expect(header.lengthField).toBe(513);
        expect(header.dataOffset).toBe(8);
        expect(header.hadUndefinedLength).toBe(false);
    });

    // overall length = 16909060 = 16777216 + 131072 + 768 + 4
    const longFormVrs = ['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'] as const;

    it.each(longFormVrs)('parses a long-form (32-bit) length for %s', vr => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, vr.charCodeAt(0), vr.charCodeAt(1), 0x00, 0x00, 0x04, 0x03, 0x02, 0x01]));
        const header = readExplicitElementHeader(stream);
        expect(header.lengthField).toBe(16909060);
        expect(header.dataOffset).toBe(12);
    });

    it('reports the data offset after a long-form header', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x04, 0x03, 0x02, 0x01]));
        const header = readExplicitElementHeader(stream);
        expect(header.vr).toBe('OB');
        expect(header.startOffset).toBe(0);
        expect(header.dataOffset).toBe(12);
    });

    it('flags the undefined-length sentinel', () => {
        const stream = new ByteStream(bytesOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]));
        const header = readExplicitElementHeader(stream);
        expect(header.lengthField).toBe(UNDEFINED_LENGTH);
        expect(header.hadUndefinedLength).toBe(true);
    });

    it('reads big-endian lengths in a big-endian stream', () => {
        const stream = new ByteStream(bytesOf([0x22, 0x11, 0x44, 0x33, 0x4f, 0x42, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]), { littleEndian: false });
        const header = readExplicitElementHeader(stream);
        expect(header.tag).toBe(tagFromString('x22114433'));
        expect(header.vr).toBe('OB');
        expect(header.lengthField).toBe(16909060);
    });

    it('treats an unknown two-uppercase-letter VR as a future long-form VR (DCMTK parity)', () => {
        // ZZ → 12-byte long form: tag(4) + "ZZ" + reserved(2) + u32 length (4)
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x5a, 0x5a, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]));
        const header = readExplicitElementHeader(stream);
        expect(header.vr).toBe('ZZ');
        expect(header.lengthField).toBe(4);
        expect(header.dataOffset).toBe(12);
    });

    it('treats a non-uppercase unknown VR as short form', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x3f, 0x3f, 0x02, 0x00])); // "??"
        const header = readExplicitElementHeader(stream);
        expect(header.vr).toBe('??');
        expect(header.lengthField).toBe(2);
        expect(header.dataOffset).toBe(8);
    });

    it('throws a typed error on a truncated header', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x04]));
        expect(() => readExplicitElementHeader(stream)).toThrow(DicomError);
    });
});

describe('readImplicitElementHeader', () => {
    it('parses tag, length and data offset', () => {
        const stream = new ByteStream(bytesOf([0x06, 0x30, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00]));
        const header = readImplicitElementHeader(stream);
        expect(header.tag).toBe(tagFromString('x300600a6'));
        expect(header.lengthField).toBe(0);
        expect(header.dataOffset).toBe(8);
        expect(header.vr).toBeUndefined();
        expect(header.vrSource).toBe('none');
    });

    it('flags the undefined-length sentinel', () => {
        const stream = new ByteStream(bytesOf([0x06, 0x30, 0xa6, 0x00, 0xff, 0xff, 0xff, 0xff]));
        const header = readImplicitElementHeader(stream);
        expect(header.lengthField).toBe(UNDEFINED_LENGTH);
        expect(header.hadUndefinedLength).toBe(true);
    });

    it('uses the VR lookup when it matches', () => {
        const stream = new ByteStream(bytesOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00]));
        const header = readImplicitElementHeader(stream, tag => (tag === 0x7fe00010 ? 'OW' : undefined));
        expect(header.vr).toBe('OW');
        expect(header.vrSource).toBe('lookup');
    });

    it('reports no VR when the lookup misses', () => {
        const stream = new ByteStream(bytesOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00]));
        const header = readImplicitElementHeader(stream, () => undefined);
        expect(header.vr).toBeUndefined();
        expect(header.vrSource).toBe('none');
    });

    it('throws a typed error on a truncated header', () => {
        const stream = new ByteStream(bytesOf([0x06, 0x30, 0xa6, 0x00, 0x00, 0x00]));
        expect(() => readImplicitElementHeader(stream)).toThrow(DicomError);
    });
});
