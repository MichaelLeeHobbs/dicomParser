/**
 * Position-tracked reader over a byte array.
 *
 * One `DataView`-based implementation replaces the legacy little/big-endian
 * parser pair; endianness is a constructor flag. Every read and seek is
 * bounds-checked and failures are typed {@link DicomError}s — this code parses
 * untrusted input.
 *
 * @module byteStream
 */

import { DicomError, type ParseWarning } from './errors';
import type { Tag } from './tag';

/** Options for {@link ByteStream}. */
export interface ByteStreamOptions {
    /** `true` (default) for little-endian, `false` for big-endian. */
    readonly littleEndian?: boolean;
    /** Starting position; defaults to 0. Must lie within `[0, bytes.length]`. */
    readonly position?: number;
    /** A shared warnings sink; a new array is created when omitted. */
    readonly warnings?: ParseWarning[];
}

/**
 * A bounds-checked, position-tracked reader over a `Uint8Array`.
 */
export class ByteStream {
    /** The underlying bytes. */
    readonly bytes: Uint8Array;
    /** `true` when multi-byte reads are little-endian. */
    readonly littleEndian: boolean;
    /** Warnings recorded while parsing (shared with the owning parse). */
    readonly warnings: ParseWarning[];
    /** Current read position. */
    position: number;

    private readonly view: DataView;

    /**
     * @param bytes - The byte array to read from
     * @param options - Endianness, starting position and warnings sink
     * @throws DicomError `invalid-argument` when `bytes` is not a Uint8Array or
     *         the position lies outside `[0, bytes.length]`
     */
    constructor(bytes: Uint8Array, options: ByteStreamOptions = {}) {
        if (!(bytes instanceof Uint8Array)) {
            throw new DicomError('invalid-argument', 'ByteStream: bytes must be a Uint8Array');
        }
        const position = options.position ?? 0;
        if (!Number.isInteger(position) || position < 0 || position > bytes.length) {
            throw new DicomError('invalid-argument', `ByteStream: position ${position} is outside [0, ${bytes.length}]`);
        }
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.littleEndian = options.littleEndian ?? true;
        this.position = position;
        this.warnings = options.warnings ?? [];
    }

    /** Total size of the underlying byte array. */
    get length(): number {
        return this.bytes.length;
    }

    /** Number of bytes between the current position and the end. */
    get remaining(): number {
        return this.bytes.length - this.position;
    }

    /**
     * Moves the position by a signed offset.
     *
     * @param offset - Bytes to add to the position (may be negative)
     * @throws DicomError `buffer-overread` when the result leaves `[0, length]`
     */
    seek(offset: number): void {
        const next = this.position + offset;
        if (next < 0 || next > this.bytes.length) {
            throw new DicomError('buffer-overread', `ByteStream.seek: position ${next} is outside [0, ${this.bytes.length}]`, { offset: this.position });
        }
        this.position = next;
    }

    private checkRead(size: number): number {
        if (this.position + size > this.bytes.length) {
            throw new DicomError('buffer-overread', `ByteStream: attempt to read ${size} bytes past end of buffer at position ${this.position}`, {
                offset: this.position,
            });
        }
        const at = this.position;
        this.position += size;
        return at;
    }

    /** Reads an unsigned 16-bit integer and advances 2 bytes. */
    readUint16(): number {
        return this.view.getUint16(this.checkRead(2), this.littleEndian);
    }

    /** Reads a signed 16-bit integer and advances 2 bytes. */
    readInt16(): number {
        return this.view.getInt16(this.checkRead(2), this.littleEndian);
    }

    /** Reads an unsigned 32-bit integer and advances 4 bytes. */
    readUint32(): number {
        return this.view.getUint32(this.checkRead(4), this.littleEndian);
    }

    /** Reads a signed 32-bit integer and advances 4 bytes. */
    readInt32(): number {
        return this.view.getInt32(this.checkRead(4), this.littleEndian);
    }

    /** Reads an unsigned 64-bit integer as a bigint and advances 8 bytes. */
    readUint64(): bigint {
        return this.view.getBigUint64(this.checkRead(8), this.littleEndian);
    }

    /** Reads a signed 64-bit integer as a bigint and advances 8 bytes. */
    readInt64(): bigint {
        return this.view.getBigInt64(this.checkRead(8), this.littleEndian);
    }

    /** Reads a 32-bit float and advances 4 bytes. */
    readFloat32(): number {
        return this.view.getFloat32(this.checkRead(4), this.littleEndian);
    }

    /** Reads a 64-bit float and advances 8 bytes. */
    readFloat64(): number {
        return this.view.getFloat64(this.checkRead(8), this.littleEndian);
    }

    /**
     * Reads a DICOM tag (group then element, each 16 bits in stream endianness)
     * and advances 4 bytes.
     */
    readTag(): Tag {
        const group = this.readUint16();
        const element = this.readUint16();
        return group * 0x10000 + element;
    }

    /**
     * Returns the tag at the current position without advancing, or `undefined`
     * when fewer than 4 bytes remain.
     */
    peekTag(): Tag | undefined {
        if (this.remaining < 4) {
            return undefined;
        }
        const group = this.view.getUint16(this.position, this.littleEndian);
        const element = this.view.getUint16(this.position + 2, this.littleEndian);
        return group * 0x10000 + element;
    }

    /**
     * Reads a fixed-length string of 8-bit characters and advances `length`
     * bytes. A NUL byte terminates the string without affecting the advance
     * (legacy `readFixedString` semantics — used for VR codes and UIDs).
     *
     * @param length - Number of bytes to consume
     * @throws DicomError `invalid-argument` on negative length,
     *         `buffer-overread` past the end of the buffer
     */
    readFixedString(length: number): string {
        if (length < 0) {
            throw new DicomError('invalid-argument', 'ByteStream.readFixedString: length cannot be less than 0');
        }
        const at = this.checkRead(length);
        let result = '';
        for (let i = 0; i < length; i++) {
            const byte = this.bytes[at + i] as number;
            if (byte === 0) {
                break;
            }
            result += String.fromCharCode(byte);
        }
        return result;
    }

    /**
     * Returns a view (no copy) of the next `length` bytes and advances.
     *
     * @param length - Number of bytes in the view
     * @throws DicomError `buffer-overread` past the end of the buffer
     */
    readBytes(length: number): Uint8Array {
        if (length < 0) {
            throw new DicomError('invalid-argument', 'ByteStream.readBytes: length cannot be less than 0');
        }
        const at = this.checkRead(length);
        return this.bytes.subarray(at, at + length);
    }
}
