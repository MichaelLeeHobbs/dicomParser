/**
 * DICOM serializer (PLAN.md item 13): datasets → Part-10 bytes.
 *
 * Two-pass, iterative (no recursion): a normalize+size pass materializes every
 * element's encoded payload and computes defined lengths bottom-up; an emit
 * pass writes headers and payloads pre-order with an explicit token stack.
 *
 * Write path is little-endian only (explicit or implicit; deflated supported);
 * explicit big endian is read-only, as retired by DICOM.
 *
 * @module writer
 */

import { DicomError } from './errors';
import { TAG_ITEM, TAG_ITEM_DELIMITATION, TAG_SEQUENCE_DELIMITATION, UNDEFINED_LENGTH, tagToString, type Tag } from './tag';
import { explicitLengthBytes } from './vr';
import {
    encodeBigintValue,
    encodeNumericValue,
    encodeStringValue,
    type WriteCharset,
    type WriteDataSet,
    type WriteElement,
    type WriteItem,
} from './writeModel';

/** Encoding options for {@link encodeDataSet}. */
export interface EncodeOptions {
    /** `true` (default) for explicit VR output. */
    readonly explicitVr?: boolean;
    /** Charset for string values: 'latin1' (default) or 'utf8' (ISO_IR 192). */
    readonly charset?: WriteCharset;
    /**
     * Emit intentionally non-conformant output for adversarial fixtures (#43).
     * Off by default; conformance checks are a feature, not an obstacle.
     *
     * When on: odd value/fragment lengths are emitted verbatim instead of
     * rejected, a value larger than its length field encodes the truncated
     * field rather than throwing, and {@link WriteElement.declaredLength} may
     * override the encoded length field. Byte accounting stays exact — only
     * the *declared* structure is corrupted, which is the point.
     */
    readonly nonConformant?: boolean;
    /**
     * Bytes buffered before each flush in the sink variants (default 64 KiB).
     * Values larger than the buffer — pixel fragments, big opaque values — are
     * passed to the sink directly and never enter it.
     */
    readonly chunkSize?: number;
}

/**
 * Resolved encoding settings shared by every element. VR mode is *not* here:
 * it varies per frame (a UN sequence's content is implicit), so it is passed
 * alongside, letting one context object serve the whole walk.
 */
interface EncodeContext {
    readonly charset: WriteCharset;
    readonly nonConformant: boolean;
}

interface SizedElement {
    readonly tag: Tag;
    readonly vr: string | undefined;
    readonly undefinedLength: boolean;
    /** Non-conformant override for the encoded length field (#43); `undefined` normally. */
    readonly declaredLength: number | undefined;
    readonly payload: SizedPayload;
    /** Value-field length (excluding header and trailing delimiter). */
    contentSize: number;
    /** Full encoded size including header and delimiters. */
    totalSize: number;
}

type SizedPayload =
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'sequence'; readonly items: readonly SizedItem[]; readonly contentExplicitVr: boolean }
    | { readonly kind: 'fragments'; readonly basicOffsetTable: readonly number[]; readonly fragments: readonly Uint8Array[] };

interface SizedItem {
    readonly elements: readonly SizedElement[];
    readonly undefinedLength: boolean;
    contentSize: number;
    totalSize: number;
}

function encodePayloadBytes(el: WriteElement, charset: WriteCharset): Uint8Array {
    const value = el.value;
    switch (value.kind) {
        case 'bytes':
            return value.bytes;
        case 'string':
            return encodeStringValue(el.vr, value.value, charset);
        case 'numbers':
            return encodeNumericValue(el.vr, value.values);
        case 'bigints':
            return encodeBigintValue(el.vr, value.values);
        default:
            throw new DicomError('invalid-argument', 'not a scalar payload');
    }
}

/** Builds the sized tree iteratively (explicit stack, no recursion). */
function normalize(elements: readonly WriteElement[], rootExplicitVr: boolean, context: EncodeContext): SizedElement[] {
    const out: SizedElement[] = [];
    const postOrder: (SizedElement | SizedItem)[] = [];
    const work: { readonly source: WriteElement; readonly target: SizedElement[]; readonly explicitVr: boolean }[] = [];
    for (let i = elements.length - 1; i >= 0; i--) {
        work.push({ source: elements[i] as WriteElement, target: out, explicitVr: rootExplicitVr });
    }
    while (work.length > 0) {
        const { source, target, explicitVr: frameExplicit } = work.pop() as (typeof work)[number];
        const sized = normalizeOne(source, frameExplicit, context);
        target.push(sized);
        postOrder.push(sized);
        const payload = sized.payload;
        if (payload.kind === 'sequence') {
            const sourceItems = (source.value as { items: readonly WriteItem[] }).items;
            payload.items.forEach((item, itemIndex) => {
                postOrder.push(item);
                const sourceElements = (sourceItems[itemIndex] as WriteItem).elements;
                for (let i = sourceElements.length - 1; i >= 0; i--) {
                    work.push({ source: sourceElements[i] as WriteElement, target: item.elements as SizedElement[], explicitVr: payload.contentExplicitVr });
                }
            });
        }
    }
    computeSizes(postOrder, rootExplicitVr, context.nonConformant);
    return out;
}

/** DICOM values must have even length; non-conformant fixtures may opt out (#43). */
function checkEvenFragments(fragments: readonly Uint8Array[], nonConformant: boolean): void {
    if (nonConformant) {
        return;
    }
    for (const fragment of fragments) {
        if (fragment.length % 2 !== 0) {
            throw new DicomError('invalid-argument', `fragment length ${fragment.length} is odd; DICOM values must have even length`);
        }
    }
}

/** Validates a {@link WriteElement.declaredLength} override (a caller bug even under the gate). */
function resolveDeclaredLength(source: WriteElement, nonConformant: boolean): number | undefined {
    if (source.declaredLength === undefined || !nonConformant) {
        return undefined;
    }
    if (!Number.isInteger(source.declaredLength) || source.declaredLength < 0 || source.declaredLength > 0xffffffff) {
        throw new DicomError('invalid-argument', `element ${tagToString(source.tag)} declaredLength ${source.declaredLength} is not a 32-bit unsigned integer`);
    }
    return source.declaredLength;
}

function normalizeOne(source: WriteElement, explicitVr: boolean, context: EncodeContext): SizedElement {
    const { charset, nonConformant } = context;
    const declaredLength = resolveDeclaredLength(source, nonConformant);
    let payload: SizedPayload;
    if (source.value.kind === 'sequence') {
        const contentExplicitVr = explicitVr && source.vr !== 'UN';
        payload = {
            kind: 'sequence',
            items: source.value.items.map(item => ({ elements: [], undefinedLength: item.undefinedLength ?? false, contentSize: 0, totalSize: 0 })),
            contentExplicitVr,
        };
    } else if (source.value.kind === 'fragments') {
        checkEvenFragments(source.value.fragments, nonConformant);
        payload = { kind: 'fragments', basicOffsetTable: source.value.basicOffsetTable, fragments: source.value.fragments };
    } else {
        const bytes = encodePayloadBytes(source, charset);
        if (bytes.length % 2 !== 0 && !nonConformant) {
            throw new DicomError('invalid-argument', `element ${tagToString(source.tag)} value length ${bytes.length} is odd; values must have even length`);
        }
        payload = { kind: 'bytes', bytes };
    }
    if (explicitVr) {
        checkExplicitVr(source);
    }
    return {
        tag: source.tag,
        vr: source.vr,
        undefinedLength: source.undefinedLength ?? false,
        payload,
        contentSize: 0,
        totalSize: 0,
        declaredLength,
    };
}

/** Validates that an element carries a well-formed 2-character VR for explicit output. */
function checkExplicitVr(source: WriteElement): void {
    if (source.vr === undefined) {
        throw new DicomError('invalid-argument', `element ${tagToString(source.tag)} has no VR; explicit-VR output requires one`);
    }
    if (source.vr.length !== 2) {
        throw new DicomError(
            'invalid-argument',
            `element ${tagToString(source.tag)} has VR '${source.vr}' of length ${source.vr.length}; a VR must be exactly 2 characters`
        );
    }
}

/** Largest value a 16-bit length field can hold; 0xFFFF is reserved as an odd-length flag by convention. */
const MAX_SHORT_LENGTH = 0xfffe;
/** Largest value a 32-bit length field can hold (0xFFFFFFFF is the undefined-length sentinel). */
const MAX_LONG_LENGTH = 0xfffffffe;

/**
 * Verifies a defined-length element's value fits its encoded length field.
 * Without this a value over 0xFFFF under a short-form VR silently truncates
 * (mod 65536) — the internal size accounting still balances, so the assert
 * cannot catch it.
 */
function checkLengthField(el: SizedElement, explicitVr: boolean, nonConformant: boolean): void {
    if (el.undefinedLength || nonConformant) {
        return; // non-conformant output encodes the truncated field on purpose
    }
    const isLong = !explicitVr || explicitLengthBytes(el.vr as string) === 4;
    const max = isLong ? MAX_LONG_LENGTH : MAX_SHORT_LENGTH;
    if (el.contentSize > max) {
        throw new DicomError(
            'invalid-argument',
            `element ${tagToString(el.tag)} value length ${el.contentSize} exceeds its ${isLong ? 32 : 16}-bit length field (max ${max})` +
                (isLong ? '' : ` — use a long-form VR (e.g. OB/OW/UN) for values over ${max} bytes`)
        );
    }
}

function headerSize(el: SizedElement, explicitVr: boolean): number {
    if (!explicitVr) {
        return 8;
    }
    return explicitLengthBytes(el.vr as string) === 4 ? 12 : 8;
}

/** Fills contentSize/totalSize bottom-up (postOrder holds parents before children). */
function computeSizes(postOrder: readonly (SizedElement | SizedItem)[], rootExplicitVr: boolean, nonConformant: boolean): void {
    const explicitOf = new Map<SizedElement, boolean>();
    for (const node of postOrder) {
        if ('payload' in node && node.payload.kind === 'sequence') {
            for (const item of node.payload.items) {
                for (const child of item.elements) {
                    explicitOf.set(child, node.payload.contentExplicitVr);
                }
            }
        }
    }
    for (let i = postOrder.length - 1; i >= 0; i--) {
        const node = postOrder[i] as SizedElement | SizedItem;
        if ('payload' in node) {
            sizeElement(node, explicitOf.get(node) ?? rootExplicitVr, nonConformant);
        } else {
            node.contentSize = node.elements.reduce((sum, el) => sum + el.totalSize, 0);
            node.totalSize = 8 + node.contentSize + (node.undefinedLength ? 8 : 0);
        }
    }
}

function sizeElement(el: SizedElement, explicitVr: boolean, nonConformant: boolean): void {
    if (el.payload.kind === 'bytes') {
        el.contentSize = el.payload.bytes.length;
    } else if (el.payload.kind === 'sequence') {
        el.contentSize = el.payload.items.reduce((sum, item) => sum + item.totalSize, 0);
    } else {
        const fragmentsSize = el.payload.fragments.reduce((sum, f) => sum + 8 + f.length, 0);
        el.contentSize = 8 + el.payload.basicOffsetTable.length * 4 + fragmentsSize;
    }
    checkLengthField(el, explicitVr, nonConformant);
    el.totalSize = headerSize(el, explicitVr) + el.contentSize + (el.undefinedLength ? 8 : 0);
}

/**
 * Where encoded bytes go. Two implementations share the one token loop: a
 * buffer target (write into a caller's array at an offset) and a sink target
 * (flush fixed-size chunks as they fill, for streaming writes) — #41.
 */
interface Emitter {
    /** Bytes emitted so far, used by the exact-size assertion. */
    readonly position: number;
    uint16(value: number): void;
    uint32(value: number): void;
    tag(value: Tag): void;
    raw(bytes: Uint8Array): void;
    ascii(value: string): void;
}

/** Emits into a caller-supplied buffer at an offset — no assembly copy. */
class BufferEmitter implements Emitter {
    position = 0;
    private readonly bytes: Uint8Array;
    private readonly view: DataView;
    private readonly start: number;

    constructor(bytes: Uint8Array, offset: number) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.start = offset;
    }

    uint16(value: number): void {
        this.view.setUint16(this.start + this.position, value, true);
        this.position += 2;
    }

    uint32(value: number): void {
        this.view.setUint32(this.start + this.position, value, true);
        this.position += 4;
    }

    tag(value: Tag): void {
        this.uint16(Math.floor(value / 0x10000));
        this.uint16(value % 0x10000);
    }

    raw(bytes: Uint8Array): void {
        this.bytes.set(bytes, this.start + this.position);
        this.position += bytes.length;
    }

    ascii(value: string): void {
        for (let i = 0; i < value.length; i++) {
            this.bytes[this.start + this.position + i] = value.charCodeAt(i);
        }
        this.position += value.length;
    }
}

/** Default bytes buffered before a sink flush. */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * Emits to a sink in chunks, so peak memory is the chunk size rather than the
 * whole file. Each flushed chunk is a fresh copy (safe to queue on a Node
 * stream, which does not copy what it is handed); values larger than the
 * chunk buffer bypass it entirely and reach the sink as a **view over the
 * caller's own data** — zero-copy for pixel fragments, but only valid while
 * that source is unmodified.
 */
class SinkEmitter implements Emitter {
    position = 0;
    private readonly sink: WriteSink;
    private readonly buffer: Uint8Array;
    private readonly view: DataView;
    private filled = 0;

    constructor(sink: WriteSink, chunkSize: number) {
        this.sink = sink;
        this.buffer = new Uint8Array(Math.max(16, chunkSize));
        this.view = new DataView(this.buffer.buffer);
    }

    private reserve(size: number): number {
        if (this.filled + size > this.buffer.length) {
            this.flush();
        }
        const at = this.filled;
        this.filled += size;
        this.position += size;
        return at;
    }

    uint16(value: number): void {
        this.view.setUint16(this.reserve(2), value, true);
    }

    uint32(value: number): void {
        this.view.setUint32(this.reserve(4), value, true);
    }

    tag(value: Tag): void {
        this.uint16(Math.floor(value / 0x10000));
        this.uint16(value % 0x10000);
    }

    raw(bytes: Uint8Array): void {
        if (bytes.length > this.buffer.length) {
            this.flush(); // keep ordering, then hand the payload over uncopied
            this.position += bytes.length;
            this.sink(bytes);
            return;
        }
        this.buffer.set(bytes, this.reserve(bytes.length));
    }

    ascii(value: string): void {
        const at = this.reserve(value.length);
        for (let i = 0; i < value.length; i++) {
            this.buffer[at + i] = value.charCodeAt(i);
        }
    }

    /** Flushes whatever is buffered; call once after the last write. */
    flush(): void {
        if (this.filled > 0) {
            this.sink(this.buffer.slice(0, this.filled));
            this.filled = 0;
        }
    }
}

type EmitToken =
    | { readonly kind: 'element'; readonly el: SizedElement; readonly explicitVr: boolean }
    | { readonly kind: 'item'; readonly item: SizedItem; readonly explicitVr: boolean }
    | { readonly kind: 'delimiter'; readonly tag: Tag };

function emitHeader(emitter: Emitter, el: SizedElement, explicitVr: boolean): void {
    emitter.tag(el.tag);
    // declaredLength (non-conformant only) corrupts the declared structure while
    // the real bytes are still emitted — the whole point of the escape hatch
    const length = el.undefinedLength ? UNDEFINED_LENGTH : (el.declaredLength ?? el.contentSize);
    if (!explicitVr) {
        emitter.uint32(length);
        return;
    }
    emitter.ascii(el.vr as string);
    if (explicitLengthBytes(el.vr as string) === 4) {
        emitter.uint16(0);
        emitter.uint32(length);
    } else {
        emitter.uint16(length);
    }
}

function pushElementContent(tokens: EmitToken[], el: SizedElement, emitter: Emitter): void {
    if (el.payload.kind === 'bytes') {
        emitter.raw(el.payload.bytes);
        return;
    }
    if (el.undefinedLength) {
        tokens.push({ kind: 'delimiter', tag: TAG_SEQUENCE_DELIMITATION });
    }
    if (el.payload.kind === 'sequence') {
        for (let i = el.payload.items.length - 1; i >= 0; i--) {
            tokens.push({ kind: 'item', item: el.payload.items[i] as SizedItem, explicitVr: el.payload.contentExplicitVr });
        }
        return;
    }
    emitter.tag(TAG_ITEM);
    emitter.uint32(el.payload.basicOffsetTable.length * 4);
    for (const offset of el.payload.basicOffsetTable) {
        emitter.uint32(offset);
    }
    for (const fragment of el.payload.fragments) {
        emitter.tag(TAG_ITEM);
        emitter.uint32(fragment.length);
        emitter.raw(fragment);
    }
}

/** Receives encoded chunks in order; see {@link encodeDataSetTo}. */
export type WriteSink = (chunk: Uint8Array) => void;

/** A sized encoding plan: the two-pass design's first pass, reusable. */
interface EncodePlan {
    readonly sized: readonly SizedElement[];
    readonly explicitVr: boolean;
    /** Exact encoded size in bytes. */
    readonly total: number;
}

/** Runs the sizing pass (validating as it goes) without emitting anything. */
function planEncode(dataSet: WriteDataSet, options: EncodeOptions): EncodePlan {
    const explicitVr = options.explicitVr ?? true;
    const sized = normalize(dataSet.elements, explicitVr, { charset: options.charset ?? 'latin1', nonConformant: options.nonConformant === true });
    return { sized, explicitVr, total: sized.reduce((sum, el) => sum + el.totalSize, 0) };
}

/** Emits a plan through any {@link Emitter}, asserting exact byte accounting. */
function emitPlan(plan: EncodePlan, emitter: Emitter): void {
    const tokens: EmitToken[] = [];
    for (let i = plan.sized.length - 1; i >= 0; i--) {
        tokens.push({ kind: 'element', el: plan.sized[i] as SizedElement, explicitVr: plan.explicitVr });
    }
    emitTokens(emitter, tokens);
    if (emitter.position !== plan.total) {
        throw new DicomError('invalid-argument', `internal: encoded ${emitter.position} bytes, expected ${plan.total}`);
    }
}

/**
 * Exact encoded size of a dataset, without emitting it — so a caller can
 * allocate once and encode straight into that buffer (#41).
 *
 * @param dataSet - The elements to size, in ascending tag order
 * @param options - VR mode and string charset (must match the later encode)
 * @returns The byte length {@link encodeDataSet} would produce
 * @throws DicomError `invalid-argument` on unencodable input
 */
export function encodedLength(dataSet: WriteDataSet, options: EncodeOptions = {}): number {
    return planEncode(dataSet, options).total;
}

/**
 * Encodes a dataset (no preamble/meta) to little-endian bytes.
 *
 * @param dataSet - The elements to encode, in ascending tag order
 * @param options - VR mode and string charset
 * @returns The encoded bytes
 * @throws DicomError `invalid-argument` on unencodable input (odd lengths,
 *         missing VRs in explicit mode, bad value/VR combinations)
 */
export function encodeDataSet(dataSet: WriteDataSet, options: EncodeOptions = {}): Uint8Array {
    const plan = planEncode(dataSet, options);
    const bytes = new Uint8Array(plan.total);
    emitPlan(plan, new BufferEmitter(bytes, 0));
    return bytes;
}

/**
 * Encodes a dataset into a caller-supplied buffer at `offset`, avoiding the
 * intermediate allocation an assemble-then-copy flow needs (#41). Size the
 * buffer with {@link encodedLength} using the same options.
 *
 * @param dataSet - The elements to encode, in ascending tag order
 * @param target - Destination buffer, with room for the encoding at `offset`
 * @param offset - Where to start writing (default 0)
 * @param options - VR mode and string charset
 * @returns The number of bytes written
 * @throws DicomError `invalid-argument` when the target is too small, or on
 *         unencodable input
 */
export function encodeDataSetInto(dataSet: WriteDataSet, target: Uint8Array, offset = 0, options: EncodeOptions = {}): number {
    const plan = planEncode(dataSet, options);
    if (!Number.isInteger(offset) || offset < 0 || offset + plan.total > target.length) {
        throw new DicomError('invalid-argument', `encodeDataSetInto: ${plan.total} bytes at offset ${offset} do not fit a ${target.length}-byte target`);
    }
    emitPlan(plan, new BufferEmitter(target, offset));
    return plan.total;
}

/**
 * Encodes a dataset to a sink in chunks, so peak memory tracks the chunk size
 * rather than the file (#41) — the streaming write path.
 *
 * The sink is synchronous and is called in stream order; chunks it receives
 * are either fresh copies or zero-copy views over the caller's own value bytes
 * (see {@link SinkEmitter}), never a reused internal buffer, so they are safe
 * to queue. Backpressure is the caller's: a Node `Writable` will buffer
 * whatever it is given past its high-water mark, so throttle there if the
 * destination is slower than the encoder.
 *
 * @param sink - Receives each chunk in order
 * @param dataSet - The elements to encode, in ascending tag order
 * @param options - VR mode, string charset and `chunkSize`
 * @returns The total number of bytes written
 * @throws DicomError `invalid-argument` on unencodable input
 */
export function encodeDataSetTo(sink: WriteSink, dataSet: WriteDataSet, options: EncodeOptions = {}): number {
    const plan = planEncode(dataSet, options);
    const emitter = new SinkEmitter(sink, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    emitPlan(plan, emitter);
    emitter.flush();
    return plan.total;
}

function emitTokens(emitter: Emitter, tokens: EmitToken[]): void {
    while (tokens.length > 0) {
        const token = tokens.pop() as EmitToken;
        if (token.kind === 'element') {
            emitHeader(emitter, token.el, token.explicitVr);
            pushElementContent(tokens, token.el, emitter);
        } else if (token.kind === 'item') {
            emitter.tag(TAG_ITEM);
            emitter.uint32(token.item.undefinedLength ? UNDEFINED_LENGTH : token.item.contentSize);
            if (token.item.undefinedLength) {
                tokens.push({ kind: 'delimiter', tag: TAG_ITEM_DELIMITATION });
            }
            for (let i = token.item.elements.length - 1; i >= 0; i--) {
                tokens.push({ kind: 'element', el: token.item.elements[i] as SizedElement, explicitVr: token.explicitVr });
            }
        } else {
            emitter.tag(token.tag);
            emitter.uint32(0);
        }
    }
}
