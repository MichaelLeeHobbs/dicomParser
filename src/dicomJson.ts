/**
 * DICOM-JSON (PS3.18 Annex F) serializer — issue #37.
 *
 * Converts a parsed {@link DicomDataSet} into the DICOM JSON Model: attributes
 * keyed by 8-hex uppercase tag in ascending order, each `{ vr, Value }` with
 * per-VR value semantics — PN Alphabetic/Ideographic/Phonetic grouping, IS/DS
 * numeric coercion, `null` for empty values inside multi-valued attributes,
 * `Value` omitted entirely for empty attributes, nested `SQ` items, `AT` as
 * hex strings, 64-bit SV/UV as numbers when exactly representable (decimal
 * strings otherwise, per F.2.3), and binary VRs as `BulkDataURI` (via the
 * caller's substitution callback) or base64 `InlineBinary`.
 *
 * String values decode through the dataset's assigned charset contexts, so a
 * parse-produced dataset serializes with correct specific-character-set
 * handling. Sequence nesting is built iteratively (no recursion — this
 * serializes datasets parsed from untrusted input).
 *
 * The reverse direction (DICOM-JSON → write model) is deliberately out of
 * scope here; the writer's build model covers construction.
 *
 * @module dicomJson
 */

import type { DicomDataSet } from './dataSet';
import type { DicomElement, SequenceElement } from './element';
import type { VrLookup } from './elementHeader';
import type { Tag } from './tag';

/** One attribute of the DICOM JSON Model (PS3.18 Annex F). */
export interface DicomJsonAttribute {
    /** The Value Representation code (`UN` when unresolvable). */
    readonly vr: string;
    /** The attribute values; omitted for empty attributes. */
    Value?: unknown[];
    /** Bulk-data reference substituted by the caller's callback. */
    BulkDataURI?: string;
    /** Base64 of the value bytes (binary VRs without a bulk-data URI). */
    InlineBinary?: string;
}

/** A DICOM JSON Model dataset: 8-hex uppercase tag → attribute. */
export type DicomJsonModel = Record<string, DicomJsonAttribute>;

/** PN value object per PS3.18 F.2.2 (empty component groups omitted). */
export interface DicomJsonPersonName {
    Alphabetic?: string;
    Ideographic?: string;
    Phonetic?: string;
}

/** Options for {@link toDicomJson}. */
export interface DicomJsonOptions {
    /** VR source for implicit-VR elements without a stream VR (else `UN`). */
    readonly vrLookup?: VrLookup;
    /**
     * Substitutes a `BulkDataURI` for a binary value (OB/OW/OD/OF/OL/OV/UN and
     * encapsulated pixel data). Returning `undefined` inlines the bytes as
     * base64 `InlineBinary` instead. For encapsulated pixel data the inlined
     * bytes are the raw value region as stored (basic offset table and
     * fragment item headers included, closing delimiter excluded).
     */
    readonly bulkDataUri?: (element: DicomElement) => string | undefined;
}

const SINGLE_TEXT = new Set(['LT', 'ST', 'UT', 'UR']);
const BINARY = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN']);

interface NumericReader {
    readonly size: number;
    readonly read: (dataSet: DicomDataSet, tag: Tag, index: number) => number | undefined;
}

const NUMERIC: Readonly<Record<string, NumericReader>> = {
    US: { size: 2, read: (d, t, i) => d.uint16(t, i) },
    SS: { size: 2, read: (d, t, i) => d.int16(t, i) },
    UL: { size: 4, read: (d, t, i) => d.uint32(t, i) },
    SL: { size: 4, read: (d, t, i) => d.int32(t, i) },
    FL: { size: 4, read: (d, t, i) => d.float32(t, i) },
    FD: { size: 8, read: (d, t, i) => d.float64(t, i) },
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Dependency-free base64 (Buffer/btoa are not available on every target),
 * built in chunks and joined once — repeated string concatenation is
 * quadratic-prone on large values such as inlined Pixel Data.
 */
function toBase64(bytes: Uint8Array): string {
    const parts = new Array<string>(Math.ceil(bytes.length / 3));
    for (let i = 0, o = 0; i < bytes.length; i += 3, o++) {
        const b0 = bytes[i] as number;
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        parts[o] =
            (BASE64_ALPHABET[b0 >> 2] as string) +
            (BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] as string) +
            (b1 === undefined ? '=' : (BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] as string)) +
            (b2 === undefined ? '=' : (BASE64_ALPHABET[b2 & 0x3f] as string));
    }
    return parts.join('');
}

function hex8(tag: Tag): string {
    return tag.toString(16).padStart(8, '0').toUpperCase();
}

/** Empty string values inside a multi-valued attribute become JSON null (F.2.5). */
function nullifyEmpty(values: readonly string[]): unknown[] {
    return values.map(value => (value === '' ? null : value));
}

/** Splits one PN value into its Alphabetic/Ideographic/Phonetic groups (F.2.2). */
function personNameValue(value: string): DicomJsonPersonName | null {
    if (value === '') {
        return null;
    }
    const groups = value.split('=');
    const result: DicomJsonPersonName = {};
    if (groups[0] !== undefined && groups[0] !== '') {
        result.Alphabetic = groups[0];
    }
    if (groups[1] !== undefined && groups[1] !== '') {
        result.Ideographic = groups[1];
    }
    if (groups[2] !== undefined && groups[2] !== '') {
        result.Phonetic = groups[2];
    }
    return result;
}

/** IS/DS coercion: numbers when finite, the original string otherwise (F.2.3.1). */
function numberStringValue(value: string): unknown {
    if (value === '') {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
}

/** SV/UV: a number when exactly representable, a decimal string otherwise (F.2.3). */
function big64Value(value: bigint): unknown {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function binaryAttribute(vr: string, element: DicomElement, source: DicomDataSet, options: DicomJsonOptions): DicomJsonAttribute {
    const uri = options.bulkDataUri?.(element);
    if (uri !== undefined) {
        return { vr, BulkDataURI: uri };
    }
    return { vr, InlineBinary: toBase64(source.bytes.subarray(element.dataOffset, element.dataOffset + element.length)) };
}

function numericValues(reader: NumericReader, source: DicomDataSet, element: DicomElement): unknown[] {
    // ceil + null: a malformed length that is not a multiple of the value size
    // surfaces its partial trailing value as null instead of silently dropping
    const count = Math.ceil(element.length / reader.size);
    const values: unknown[] = [];
    for (let i = 0; i < count; i++) {
        values.push(reader.read(source, element.tag, i) ?? null);
    }
    return values;
}

function big64Values(vr: string, source: DicomDataSet, element: DicomElement): unknown[] {
    const count = Math.ceil(element.length / 8);
    const values: unknown[] = [];
    for (let i = 0; i < count; i++) {
        const value = vr === 'SV' ? source.int64(element.tag, i) : source.uint64(element.tag, i);
        values.push(value === undefined ? null : big64Value(value));
    }
    return values;
}

function attributeTagValues(source: DicomDataSet, element: DicomElement): unknown[] {
    const count = Math.ceil(element.length / 4);
    const values: unknown[] = [];
    for (let i = 0; i < count; i++) {
        const value = source.attributeTag(element.tag, i);
        values.push(value === undefined ? null : hex8(value));
    }
    return values;
}

/** Per-VR value list for a non-empty, non-sequence, non-binary element. */
function elementValues(vr: string, source: DicomDataSet, element: DicomElement): unknown[] {
    if (vr === 'AT') {
        return attributeTagValues(source, element);
    }
    if (vr === 'SV' || vr === 'UV') {
        return big64Values(vr, source, element);
    }
    const numeric = NUMERIC[vr];
    if (numeric !== undefined) {
        return numericValues(numeric, source, element);
    }
    return stringValues(vr, source, element.tag);
}

/** Value list for the string-encoded VRs (PN/IS/DS/text/multi-valued). */
function stringValues(vr: string, source: DicomDataSet, tag: Tag): unknown[] {
    if (vr === 'PN') {
        return (source.strings(tag) ?? []).map(personNameValue);
    }
    if (vr === 'IS' || vr === 'DS') {
        return (source.strings(tag) ?? []).map(numberStringValue);
    }
    if (SINGLE_TEXT.has(vr)) {
        const text = source.text(tag);
        return text === undefined || text === '' ? [] : [text];
    }
    // AE/AS/CS/DA/DT/LO/SH/TM/UC/UI and any remaining string-like VR: split
    return nullifyEmpty(source.strings(tag) ?? []);
}

interface BuildJob {
    readonly source: DicomDataSet;
    readonly target: DicomJsonModel;
}

function sequenceAttribute(element: SequenceElement, stack: BuildJob[]): DicomJsonAttribute {
    const attribute: DicomJsonAttribute = { vr: 'SQ' };
    if (element.items.length > 0) {
        attribute.Value = element.items.map(item => {
            const target: DicomJsonModel = {};
            stack.push({ source: item.dataSet, target });
            return target;
        });
    }
    return attribute;
}

function buildAttribute(source: DicomDataSet, element: DicomElement, options: DicomJsonOptions, stack: BuildJob[]): DicomJsonAttribute {
    if (element.kind === 'sequence') {
        return sequenceAttribute(element, stack);
    }
    const vr = element.vr ?? options.vrLookup?.(element.tag) ?? 'UN';
    if (element.length === 0) {
        return { vr };
    }
    if (element.kind === 'encapsulated' || element.kind === 'unknown' || BINARY.has(vr)) {
        return binaryAttribute(vr, element, source, options);
    }
    const values = elementValues(vr, source, element);
    return values.length === 0 ? { vr } : { vr, Value: values };
}

/**
 * Serializes a dataset to the DICOM JSON Model (PS3.18 Annex F).
 *
 * Attributes are emitted in ascending tag order with per-VR value semantics
 * (see the module docs). Pass `parse(...).dataSet` for the main dataset, or
 * `parse(...).meta` for the file meta group. Group-length elements present in
 * the dataset are emitted as-is.
 *
 * @param dataSet - The dataset to serialize (charset contexts already applied by `parse`)
 * @param options - VR lookup for implicit elements and bulk-data substitution
 * @returns The JSON model object (serialize with `JSON.stringify`)
 */
export function toDicomJson(dataSet: DicomDataSet, options: DicomJsonOptions = {}): DicomJsonModel {
    const root: DicomJsonModel = {};
    const stack: BuildJob[] = [{ source: dataSet, target: root }];
    while (stack.length > 0) {
        const job = stack.pop() as BuildJob;
        const tags = [...job.source.elements.keys()].sort((a, b) => a - b);
        for (const tag of tags) {
            const element = job.source.elements.get(tag) as DicomElement;
            job.target[hex8(tag)] = buildAttribute(job.source, element, options, stack);
        }
    }
    return root;
}
