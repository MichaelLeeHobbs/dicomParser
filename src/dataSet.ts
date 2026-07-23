/**
 * The parsed dataset container and typed value accessors.
 *
 * Accessor semantics follow the legacy `DataSet` (trailing-space handling,
 * `undefined` for absent/empty elements) with two deliberate fixes:
 *
 * - Strings are **not truncated at the first NUL byte** (upstream #146):
 *   values decode fully, then trailing NUL padding is stripped.
 * - Reads are **bounds-checked against the element's value length**: an
 *   out-of-range index returns `undefined` instead of reading the neighbor
 *   element's bytes.
 *
 * New over legacy: `uint64`/`int64` BigInt accessors (SV/UV, upstream #280) and
 * an indexed `attributeTag` (AT VM 1-n, upstream #253).
 *
 * @module dataSet
 */

import { decodeDicomText, type CharsetContext } from './charset';
import type { DicomElement } from './element';
import { toTag, type Tag, type TagLike } from './tag';

/** Element kinds whose value bytes are directly readable. */
function isReadable(element: DicomElement): boolean {
    return element.kind === 'value' || element.kind === 'unknown';
}

/**
 * A parsed DICOM dataset: elements keyed by numeric tag over the source bytes,
 * with typed accessors for element values.
 */
export class DicomDataSet {
    /** The bytes the element offsets refer to. */
    readonly bytes: Uint8Array;
    /** `true` when multi-byte values are little-endian. */
    readonly littleEndian: boolean;
    /** The parsed elements, keyed by numeric {@link Tag}, in insertion order. */
    readonly elements: ReadonlyMap<Tag, DicomElement>;

    private lazyView: DataView | undefined;
    private charsetContext: CharsetContext | undefined;

    constructor(bytes: Uint8Array, littleEndian: boolean, elements: ReadonlyMap<Tag, DicomElement>) {
        this.bytes = bytes;
        this.littleEndian = littleEndian;
        this.elements = elements;
    }

    /** The charset context used by string accessors, when assigned by the parser (#146). */
    get charset(): CharsetContext | undefined {
        return this.charsetContext;
    }

    /**
     * Assigns the charset context used by {@link string}/{@link text}.
     * Called by the parser after resolving (0008,0005); item datasets inherit
     * their parent's context unless they carry their own.
     */
    applyCharset(context: CharsetContext): void {
        this.charsetContext = context;
    }

    /**
     * Looks up an element by tag.
     *
     * @param tag - Numeric tag or `'xggggeeee'`/`'GGGGEEEE'` string
     * @returns The element, or `undefined` when absent
     */
    element(tag: TagLike): DicomElement | undefined {
        return this.elements.get(toTag(tag));
    }

    /**
     * Returns a zero-copy view of an element's value bytes (upstream #146:
     * raw bytes are always reachable alongside decoded values).
     *
     * @param tag - The element's tag
     * @returns The value bytes, or `undefined` when the element is absent or
     *          not a readable kind (sequences, encapsulated pixel data)
     */
    rawBytes(tag: TagLike): Uint8Array | undefined {
        const element = this.element(tag);
        if (element === undefined || !isReadable(element)) {
            return undefined;
        }
        return this.bytes.subarray(element.dataOffset, element.dataOffset + element.length);
    }

    private view(): DataView {
        this.lazyView ??= new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        return this.lazyView;
    }

    /** Resolves the read offset for a fixed-size value at an index, bounds-checked. */
    private offsetOf(tag: TagLike, size: number, index: number): number | undefined {
        const element = this.element(tag);
        if (element === undefined || !isReadable(element) || index < 0 || (index + 1) * size > element.length) {
            return undefined;
        }
        return element.dataOffset + index * size;
    }

    /** Reads an unsigned 16-bit value at `index` (default 0). */
    uint16(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 2, index);
        return offset === undefined ? undefined : this.view().getUint16(offset, this.littleEndian);
    }

    /** Reads a signed 16-bit value at `index` (default 0). */
    int16(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 2, index);
        return offset === undefined ? undefined : this.view().getInt16(offset, this.littleEndian);
    }

    /** Reads an unsigned 32-bit value at `index` (default 0). */
    uint32(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 4, index);
        return offset === undefined ? undefined : this.view().getUint32(offset, this.littleEndian);
    }

    /** Reads a signed 32-bit value at `index` (default 0). */
    int32(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 4, index);
        return offset === undefined ? undefined : this.view().getInt32(offset, this.littleEndian);
    }

    /** Reads an unsigned 64-bit (UV) value at `index` as a bigint (upstream #280). */
    uint64(tag: TagLike, index = 0): bigint | undefined {
        const offset = this.offsetOf(tag, 8, index);
        return offset === undefined ? undefined : this.view().getBigUint64(offset, this.littleEndian);
    }

    /** Reads a signed 64-bit (SV) value at `index` as a bigint (upstream #280). */
    int64(tag: TagLike, index = 0): bigint | undefined {
        const offset = this.offsetOf(tag, 8, index);
        return offset === undefined ? undefined : this.view().getBigInt64(offset, this.littleEndian);
    }

    /** Reads a 32-bit float (FL) at `index` (default 0). */
    float32(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 4, index);
        return offset === undefined ? undefined : this.view().getFloat32(offset, this.littleEndian);
    }

    /** Reads a 64-bit float (FD) at `index` (default 0). */
    float64(tag: TagLike, index = 0): number | undefined {
        const offset = this.offsetOf(tag, 8, index);
        return offset === undefined ? undefined : this.view().getFloat64(offset, this.littleEndian);
    }

    /**
     * Reads an AT (attribute tag) value at `index` (default 0) — indexed per
     * upstream #253 (AT elements can be multi-valued).
     *
     * @returns The numeric tag, or `undefined` when absent/out of range
     */
    attributeTag(tag: TagLike, index = 0): Tag | undefined {
        const offset = this.offsetOf(tag, 4, index);
        if (offset === undefined) {
            return undefined;
        }
        return this.view().getUint16(offset, this.littleEndian) * 0x10000 + this.view().getUint16(offset + 2, this.littleEndian);
    }

    /** Decodes the full value as latin-1 with trailing NUL padding stripped. */
    private decodeString(tag: TagLike): string | undefined {
        const element = this.element(tag);
        if (element === undefined || !isReadable(element) || element.length === 0) {
            return undefined;
        }
        let end = element.dataOffset + element.length;
        while (end > element.dataOffset && this.bytes[end - 1] === 0x00) {
            end--;
        }
        const value = this.bytes.subarray(element.dataOffset, end);
        if (this.charsetContext !== undefined) {
            return decodeDicomText(value, this.charsetContext);
        }
        let result = '';
        for (let i = 0; i < value.length; i++) {
            result += String.fromCharCode(value[i] as number);
        }
        return result;
    }

    /**
     * Returns the number of backslash-separated values, or `undefined` when
     * the element is absent or empty.
     */
    numStringValues(tag: TagLike): number | undefined {
        const decoded = this.decodeString(tag);
        return decoded === undefined ? undefined : decoded.split('\\').length;
    }

    /**
     * Returns the element's string value with leading/trailing whitespace
     * trimmed (legacy semantics for AE/CS/SH/LO/UI/DS/IS…). With `index`, the
     * value is split on backslash first.
     *
     * Unlike legacy, the value is not truncated at the first NUL byte (#146).
     */
    string(tag: TagLike, index?: number): string | undefined {
        const decoded = this.decodeString(tag);
        if (decoded === undefined) {
            return undefined;
        }
        if (index !== undefined && index >= 0) {
            return decoded.split('\\')[index]?.trim();
        }
        return decoded.trim();
    }

    /**
     * Returns the element's string value with only trailing spaces removed
     * (legacy semantics for ST/LT/UT). With `index`, splits on backslash.
     */
    text(tag: TagLike, index?: number): string | undefined {
        const decoded = this.decodeString(tag);
        if (decoded === undefined) {
            return undefined;
        }
        if (index !== undefined && index >= 0) {
            return decoded.split('\\')[index]?.replace(/ +$/, '');
        }
        return decoded.replace(/ +$/, '');
    }

    /** Parses the string value at `index` (default 0) as a float (DS). */
    floatString(tag: TagLike, index = 0): number | undefined {
        const value = this.string(tag, index);
        return value === undefined || value === '' ? undefined : Number.parseFloat(value);
    }

    /** Parses the string value at `index` (default 0) as an integer (IS). */
    intString(tag: TagLike, index = 0): number | undefined {
        const value = this.string(tag, index);
        return value === undefined || value === '' ? undefined : Number.parseInt(value, 10);
    }
}
