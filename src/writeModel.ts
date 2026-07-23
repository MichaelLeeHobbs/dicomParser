/**
 * The write model: a tree of elements to serialize, and helpers to build it
 * from JS values or from a parsed dataset (round-tripping).
 *
 * VR-aware value encoding rules (PLAN.md item 13): strings pad to even length
 * (UI with NUL, text with space), numbers encode per VR, SV/UV take bigints.
 * Charset-aware string *encoding* supports the default repertoire/Latin-1 and
 * UTF-8 (ISO_IR 192) — the encodable subset of the decode side.
 *
 * @module writeModel
 */

import type { DicomDataSet } from './dataSet';
import type { DicomElement } from './element';
import { DicomError } from './errors';
import { toTag, type Tag, type TagLike } from './tag';

/** A value to encode, tagged by how it is expressed. */
export type WriteValue =
    /** Pre-encoded bytes (must already have even length). */
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    /** A string, padded per VR (UI pads with NUL, text VRs with space). */
    | { readonly kind: 'string'; readonly value: string }
    /** Numbers encoded per VR (US/SS/UL/SL/FL/FD/OB/OW/AT). */
    | { readonly kind: 'numbers'; readonly values: readonly number[] }
    /** 64-bit integers for SV/UV/OV. */
    | { readonly kind: 'bigints'; readonly values: readonly bigint[] }
    /** A sequence of items. */
    | { readonly kind: 'sequence'; readonly items: readonly WriteItem[] }
    /** Encapsulated pixel data: basic offset table + fragment pass-through. */
    | { readonly kind: 'fragments'; readonly basicOffsetTable: readonly number[]; readonly fragments: readonly Uint8Array[] };

/** One element to serialize. */
export interface WriteElement {
    readonly tag: Tag;
    /** The VR; required for explicit-VR output (except group FFFE constructs). */
    readonly vr: string | undefined;
    readonly value: WriteValue;
    /** Encode with undefined length + delimiters (sequences/fragments only). */
    readonly undefinedLength?: boolean;
}

/** One sequence item. */
export interface WriteItem {
    readonly elements: readonly WriteElement[];
    /** Encode with undefined length + item delimiter. */
    readonly undefinedLength?: boolean;
}

/** A dataset to serialize (elements must be in ascending tag order). */
export interface WriteDataSet {
    readonly elements: readonly WriteElement[];
}

/** String VRs padded with NUL instead of space. */
const NUL_PADDED_VRS = new Set(['UI']);

/** Charset for encoding string values. */
export type WriteCharset = 'latin1' | 'utf8';

/** Encodes a string VR value with even-length padding. */
export function encodeStringValue(vr: string | undefined, value: string, charset: WriteCharset = 'latin1'): Uint8Array {
    let raw: Uint8Array;
    if (charset === 'utf8') {
        raw = new TextEncoder().encode(value);
    } else {
        raw = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code > 0xff) {
                throw new DicomError('invalid-argument', `encodeStringValue: '${value[i]}' is not encodable as Latin-1; use UTF-8 (ISO_IR 192)`);
            }
            raw[i] = code;
        }
    }
    if (raw.length % 2 === 0) {
        return raw;
    }
    const padded = new Uint8Array(raw.length + 1);
    padded.set(raw, 0);
    padded[raw.length] = vr !== undefined && NUL_PADDED_VRS.has(vr) ? 0x00 : 0x20;
    return padded;
}

type NumberWriter = (view: DataView, offset: number, value: number) => void;

const NUMBER_WRITERS: Readonly<Record<string, { readonly size: number; readonly write: NumberWriter }>> = {
    US: { size: 2, write: (v, o, x) => v.setUint16(o, x, true) },
    SS: { size: 2, write: (v, o, x) => v.setInt16(o, x, true) },
    OW: { size: 2, write: (v, o, x) => v.setUint16(o, x, true) },
    UL: { size: 4, write: (v, o, x) => v.setUint32(o, x, true) },
    SL: { size: 4, write: (v, o, x) => v.setInt32(o, x, true) },
    OL: { size: 4, write: (v, o, x) => v.setUint32(o, x, true) },
    FL: { size: 4, write: (v, o, x) => v.setFloat32(o, x, true) },
    OF: { size: 4, write: (v, o, x) => v.setFloat32(o, x, true) },
    FD: { size: 8, write: (v, o, x) => v.setFloat64(o, x, true) },
    OD: { size: 8, write: (v, o, x) => v.setFloat64(o, x, true) },
    OB: { size: 1, write: (v, o, x) => v.setUint8(o, x) },
};

/** Encodes a numeric VR value (little endian, the write path's only endianness). */
export function encodeNumericValue(vr: string | undefined, values: readonly number[]): Uint8Array {
    if (vr === 'AT') {
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, i) => {
            const tag = toTag(value);
            view.setUint16(i * 4, Math.floor(tag / 0x10000), true);
            view.setUint16(i * 4 + 2, tag % 0x10000, true);
        });
        return bytes;
    }
    const writer = vr === undefined ? undefined : NUMBER_WRITERS[vr];
    if (writer === undefined) {
        throw new DicomError('invalid-argument', `encodeNumericValue: VR '${String(vr)}' does not take numeric values`);
    }
    const bytes = new Uint8Array(values.length * writer.size);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => writer.write(view, i * writer.size, value));
    return bytes;
}

/** Encodes an SV/UV/OV value. */
export function encodeBigintValue(vr: string | undefined, values: readonly bigint[]): Uint8Array {
    if (vr !== 'SV' && vr !== 'UV' && vr !== 'OV') {
        throw new DicomError('invalid-argument', `encodeBigintValue: VR '${String(vr)}' does not take bigint values`);
    }
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => {
        if (vr === 'SV') {
            view.setBigInt64(i * 8, value, true);
        } else {
            view.setBigUint64(i * 8, value, true);
        }
    });
    return bytes;
}

/** Convenience spec for {@link element}. */
export type ValueSpec = WriteValue | Uint8Array | string | readonly number[] | readonly bigint[] | readonly WriteItem[];

function toWriteValue(vr: string | undefined, spec: ValueSpec): WriteValue {
    if (spec instanceof Uint8Array) {
        return { kind: 'bytes', bytes: spec };
    }
    if (typeof spec === 'string') {
        return { kind: 'string', value: spec };
    }
    if (Array.isArray(spec)) {
        const first: unknown = spec[0];
        if (spec.length === 0) {
            return vr === 'SQ' ? { kind: 'sequence', items: [] } : { kind: 'bytes', bytes: new Uint8Array(0) };
        }
        if (typeof first === 'number') {
            return { kind: 'numbers', values: spec as readonly number[] };
        }
        if (typeof first === 'bigint') {
            return { kind: 'bigints', values: spec as readonly bigint[] };
        }
        return { kind: 'sequence', items: spec as readonly WriteItem[] };
    }
    return spec as WriteValue;
}

/**
 * Builds a {@link WriteElement} from a convenient value spec.
 *
 * @param tag - The element tag (numeric or `'xggggeeee'`/`'GGGGEEEE'`)
 * @param vr - The VR (used for encoding and explicit-VR output)
 * @param spec - Bytes, string, number[]/bigint[], items, or a tagged WriteValue
 * @returns The write element
 */
export function element(tag: TagLike, vr: string | undefined, spec: ValueSpec): WriteElement {
    return { tag: toTag(tag), vr, value: toWriteValue(vr, spec) };
}

/**
 * Builds a {@link WriteDataSet}, sorting elements into ascending tag order as
 * DICOM requires.
 */
export function dataSet(elements: readonly WriteElement[]): WriteDataSet {
    return { elements: [...elements].sort((a, b) => a.tag - b.tag) };
}

/** An item from element specs. */
export function item(elements: readonly WriteElement[], undefinedLength = false): WriteItem {
    return { elements: [...elements].sort((a, b) => a.tag - b.tag), undefinedLength };
}

interface ModelFrame {
    readonly source: readonly DicomElement[];
    readonly out: WriteElement[];
    readonly parentItems: WriteItem[] | undefined;
    readonly itemFlagsQueue: { readonly undefinedLength: boolean; readonly elements: DicomElement[] }[];
}

/**
 * Converts a parsed dataset into a write model (round-trip source). Value
 * bytes are copied by reference from the parsed buffer; structure flags
 * (undefined lengths on sequences, items, encapsulation) are preserved so an
 * unmodified re-encode is byte-identical for conformant files.
 *
 * Elements of kind `'unknown'` (undefined-length non-sequences) are not
 * re-encodable and raise `invalid-argument`.
 *
 * @param parsed - The parsed dataset
 * @returns The equivalent write model
 */
export function toWriteModel(parsed: DicomDataSet): WriteDataSet {
    const root: WriteElement[] = [];
    const stack: ModelFrame[] = [{ source: [...parsed.elements.values()], out: root, parentItems: undefined, itemFlagsQueue: [] }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1] as ModelFrame;
        const next = frame.itemFlagsQueue.shift();
        if (next !== undefined) {
            const itemOut: WriteElement[] = [];
            (frame.parentItems as WriteItem[]).push({ elements: itemOut, undefinedLength: next.undefinedLength });
            stack.push({ source: next.elements, out: itemOut, parentItems: undefined, itemFlagsQueue: [] });
            continue;
        }
        stack.pop();
        convertElements(parsed, frame, stack);
    }
    return { elements: root };
}

/** Converts one frame's elements, queueing sequence items for the stack. */
function convertElements(parsed: DicomDataSet, frame: ModelFrame, stack: ModelFrame[]): void {
    for (const source of frame.source) {
        if (source.kind === 'sequence') {
            const items: WriteItem[] = [];
            frame.out.push({ tag: source.tag, vr: source.vr ?? 'SQ', value: { kind: 'sequence', items }, undefinedLength: source.hadUndefinedLength });
            const queue = source.items.map(item => ({ undefinedLength: item.hadUndefinedLength, elements: [...item.dataSet.elements.values()] }));
            stack.push({ source: [], out: [], parentItems: items, itemFlagsQueue: queue });
            continue;
        }
        if (source.kind === 'encapsulated') {
            frame.out.push({
                tag: source.tag,
                vr: source.vr,
                value: {
                    kind: 'fragments',
                    basicOffsetTable: source.basicOffsetTable,
                    fragments: source.fragments.map(f => parsed.bytes.subarray(f.position, f.position + f.length)),
                },
                undefinedLength: source.hadUndefinedLength,
            });
            continue;
        }
        if (source.kind === 'unknown') {
            throw new DicomError('invalid-argument', 'toWriteModel: undefined-length non-sequence elements cannot be re-encoded');
        }
        frame.out.push({
            tag: source.tag,
            vr: source.vr,
            value: { kind: 'bytes', bytes: parsed.bytes.subarray(source.dataOffset, source.dataOffset + source.length) },
        });
    }
}
