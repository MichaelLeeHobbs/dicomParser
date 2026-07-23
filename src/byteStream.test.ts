import { describe, expect, it } from 'vitest';
import { ByteStream } from './byteStream';
import { DicomError } from './errors';

// Ported from legacy byteStream_test.js, littleEndianByteArrayParser_test.js and
// bigEndianByteArrayParser_test.js. The two endian parser objects collapsed into
// one DataView-based ByteStream with a littleEndian flag, so the parser-level
// vectors are exercised through streams at a starting position.

function bytesOf(values: readonly number[]): Uint8Array {
    return Uint8Array.from(values);
}

describe('ByteStream constructor', () => {
    it('defaults to position 0, little endian', () => {
        const stream = new ByteStream(new Uint8Array(32));
        expect(stream.position).toBe(0);
        expect(stream.littleEndian).toBe(true);
        expect(stream.length).toBe(32);
    });

    it('honors a starting position', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 10 });
        expect(stream.position).toBe(10);
        expect(stream.remaining).toBe(22);
    });

    it('accepts Buffer (a Uint8Array subclass)', () => {
        const stream = new ByteStream(Buffer.alloc(4));
        expect(stream.length).toBe(4);
    });

    it('rejects non-Uint8Array input', () => {
        expect(() => new ByteStream(new Uint16Array(32) as unknown as Uint8Array)).toThrow(DicomError);
        expect(() => new ByteStream(undefined as unknown as Uint8Array)).toThrow(DicomError);
    });

    it('rejects a position outside [0, length]', () => {
        expect(() => new ByteStream(new Uint8Array(32), { position: -1 })).toThrow(DicomError);
        expect(() => new ByteStream(new Uint8Array(32), { position: 33 })).toThrow(DicomError);
    });

    it('allows a position at end-of-stream (divergence: legacy rejected position === length)', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 32 });
        expect(stream.remaining).toBe(0);
    });
});

describe('ByteStream.seek', () => {
    it('moves the position', () => {
        const stream = new ByteStream(new Uint8Array(32));
        stream.seek(10);
        expect(stream.position).toBe(10);
        stream.seek(-5);
        expect(stream.position).toBe(5);
    });

    it('rejects seeking below 0', () => {
        const stream = new ByteStream(new Uint8Array(32));
        expect(() => stream.seek(-1)).toThrow(DicomError);
    });

    it('rejects seeking past the end (divergence: legacy allowed it)', () => {
        const stream = new ByteStream(new Uint8Array(32));
        stream.seek(32);
        expect(stream.position).toBe(32);
        expect(() => stream.seek(1)).toThrow(DicomError);
    });
});

describe('ByteStream.readUint16 / readInt16', () => {
    it('reads little-endian uint16', () => {
        const stream = new ByteStream(bytesOf([0xff, 0x80]));
        expect(stream.readUint16()).toBe(0x80ff);
        expect(stream.position).toBe(2);
    });

    it('reads big-endian uint16', () => {
        const stream = new ByteStream(bytesOf([0x80, 0xff]), { littleEndian: false });
        expect(stream.readUint16()).toBe(0x80ff);
    });

    it('reads negative little-endian int16', () => {
        expect(new ByteStream(bytesOf([0x3a, 0xc9])).readInt16()).toBe(-14022);
        expect(new ByteStream(bytesOf([0xff, 0xff])).readInt16()).toBe(-1);
    });

    it('reads negative big-endian int16', () => {
        const stream = new ByteStream(bytesOf([0xc9, 0x3a]), { littleEndian: false });
        expect(stream.readInt16()).toBe(-14022);
    });

    it('reads at the exact end of the buffer', () => {
        expect(new ByteStream(bytesOf([0xff, 0x80])).readUint16()).toBe(0x80ff);
    });

    it('throws on overread', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 31 });
        expect(() => stream.readUint16()).toThrow(DicomError);
        expect(() => stream.readInt16()).toThrow(DicomError);
    });
});

describe('ByteStream.readUint32 / readInt32', () => {
    it('reads little-endian uint32', () => {
        expect(new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44])).readUint32()).toBe(0x44332211);
        expect(new ByteStream(bytesOf([0xff, 0xff, 0xff, 0xff])).readUint32()).toBe(4294967295);
    });

    it('reads big-endian uint32', () => {
        const stream = new ByteStream(bytesOf([0x44, 0x33, 0x22, 0x11]), { littleEndian: false });
        expect(stream.readUint32()).toBe(0x44332211);
    });

    it('reads little-endian int32', () => {
        expect(new ByteStream(bytesOf([0xff, 0xff, 0xff, 0xff])).readInt32()).toBe(-1);
    });

    it('reads big-endian int32', () => {
        const stream = new ByteStream(bytesOf([0xfe, 0xdc, 0xba, 0x98]), { littleEndian: false });
        expect(stream.readInt32()).toBe(-19088744);
    });

    it('throws on overread', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 30 });
        expect(() => stream.readUint32()).toThrow(DicomError);
    });
});

describe('ByteStream.readUint64 / readInt64', () => {
    // New coverage: 64-bit reads back the SV/UV/OV VRs (upstream #280/#281).
    it('reads little-endian uint64 as bigint', () => {
        const stream = new ByteStream(bytesOf([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
        expect(stream.readUint64()).toBe(18446744073709551615n);
        expect(stream.position).toBe(8);
    });

    it('reads little-endian int64 as bigint', () => {
        expect(new ByteStream(bytesOf([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).readInt64()).toBe(-1n);
    });

    it('reads big-endian uint64', () => {
        const stream = new ByteStream(bytesOf([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]), { littleEndian: false });
        expect(stream.readUint64()).toBe(0x0102030405060708n);
    });

    it('throws on overread', () => {
        const stream = new ByteStream(new Uint8Array(8), { position: 1 });
        expect(() => stream.readUint64()).toThrow(DicomError);
        expect(() => stream.readInt64()).toThrow(DicomError);
    });
});

describe('ByteStream.readFloat32', () => {
    it('reads little-endian float32', () => {
        expect(new ByteStream(bytesOf([0x00, 0x00, 0xb4, 0xc0])).readFloat32()).toBe(-5.625);
    });

    it('reads a second value at an offset', () => {
        const stream = new ByteStream(bytesOf([0x00, 0x00, 0xb4, 0xc0, 0x00, 0x00, 0xb4, 0xc1]), { position: 4 });
        expect(stream.readFloat32()).toBe(-22.5);
    });

    it('reads big-endian float32', () => {
        const stream = new ByteStream(bytesOf([0xc7, 0x80, 0x01, 0x04]), { littleEndian: false });
        expect(stream.readFloat32()).toBe(-65538.03125);
    });

    it('throws on overread', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 29 });
        expect(() => stream.readFloat32()).toThrow(DicomError);
    });
});

describe('ByteStream.readFloat64', () => {
    it('reads little-endian float64', () => {
        const stream = new ByteStream(bytesOf([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xef, 0x7f]));
        expect(stream.readFloat64()).toBe(1.7976931348623157e308);
    });

    it('reads a second value at an offset', () => {
        const first = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xef, 0x7f];
        const second = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xef];
        const stream = new ByteStream(bytesOf([...first, ...second]), { position: 8 });
        expect(stream.readFloat64()).toBe(-1.2129047596099287e229);
    });

    it('reads big-endian float64', () => {
        const stream = new ByteStream(bytesOf([0xce, 0x98, 0xab, 0x12, 0x04, 0x87, 0x56, 0xfa]), { littleEndian: false });
        expect(stream.readFloat64()).toBe(-4.256349017182337e70);
    });

    it('throws on overread', () => {
        const stream = new ByteStream(new Uint8Array(32), { position: 25 });
        expect(() => stream.readFloat64()).toThrow(DicomError);
    });
});

describe('ByteStream.readTag / peekTag', () => {
    it('reads a little-endian tag', () => {
        const stream = new ByteStream(bytesOf([0x11, 0x22, 0x33, 0x44]));
        expect(stream.readTag()).toBe(0x22114433);
        expect(stream.position).toBe(4);
    });

    it('reads a big-endian tag', () => {
        const stream = new ByteStream(bytesOf([0x22, 0x11, 0x44, 0x33]), { littleEndian: false });
        expect(stream.readTag()).toBe(0x22114433);
    });

    it('peeks without advancing', () => {
        const stream = new ByteStream(bytesOf([0xfe, 0xff, 0x00, 0xe0]));
        expect(stream.peekTag()).toBe(0xfffee000);
        expect(stream.position).toBe(0);
    });

    it('peek returns undefined near the end', () => {
        const stream = new ByteStream(bytesOf([0x01, 0x02, 0x03]));
        expect(stream.peekTag()).toBeUndefined();
    });
});

describe('ByteStream.readFixedString', () => {
    function streamOfString(value: string, size: number): ByteStream {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < value.length; i++) {
            bytes[i] = value.charCodeAt(i);
        }
        return new ByteStream(bytes);
    }

    it('reads the expected value', () => {
        expect(streamOfString('Hello', 32).readFixedString(5)).toBe('Hello');
    });

    it('reads at the exact end of the buffer', () => {
        expect(streamOfString('Hello', 5).readFixedString(5)).toBe('Hello');
    });

    it('stops at a NUL terminator but advances the full length', () => {
        const stream = streamOfString('Hello', 6);
        expect(stream.readFixedString(6)).toBe('Hello');
        expect(stream.position).toBe(6);
    });

    it('throws on overread', () => {
        expect(() => streamOfString('Hello', 32).readFixedString(33)).toThrow(DicomError);
    });

    it('throws on negative length', () => {
        expect(() => streamOfString('Hello', 32).readFixedString(-1)).toThrow(DicomError);
    });
});

describe('ByteStream.readBytes', () => {
    it('returns a zero-copy view and advances', () => {
        const bytes = bytesOf([1, 2, 3, 4, 5]);
        const stream = new ByteStream(bytes);
        const view = stream.readBytes(3);
        expect(Array.from(view)).toEqual([1, 2, 3]);
        expect(stream.position).toBe(3);
        bytes[0] = 9;
        expect(view[0]).toBe(9);
    });

    it('reads all remaining bytes', () => {
        const stream = new ByteStream(new Uint8Array(32));
        expect(stream.readBytes(32).length).toBe(32);
    });

    it('throws on overread and negative length', () => {
        const stream = new ByteStream(new Uint8Array(32));
        expect(() => stream.readBytes(40)).toThrow(DicomError);
        expect(() => stream.readBytes(-1)).toThrow(DicomError);
    });
});

describe('DicomError shape', () => {
    it('carries an optional cause', () => {
        const cause = new Error('root');
        const error = new DicomError('unsupported', 'wrapped', { cause });
        expect(error.cause).toBe(cause);
        expect(error.offset).toBeUndefined();
    });

    it('carries code and offset', () => {
        const stream = new ByteStream(new Uint8Array(4), { position: 3 });
        try {
            stream.readUint32();
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(DicomError);
            const dicomError = error as DicomError;
            expect(dicomError.code).toBe('buffer-overread');
            expect(dicomError.offset).toBe(3);
            expect(dicomError.name).toBe('DicomError');
        }
    });
});
