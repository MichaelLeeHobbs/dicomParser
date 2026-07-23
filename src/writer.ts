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
}

interface SizedElement {
    readonly tag: Tag;
    readonly vr: string | undefined;
    readonly undefinedLength: boolean;
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
function normalize(elements: readonly WriteElement[], explicitVr: boolean, charset: WriteCharset): SizedElement[] {
    const out: SizedElement[] = [];
    const postOrder: (SizedElement | SizedItem)[] = [];
    const work: { readonly source: WriteElement; readonly target: SizedElement[]; readonly explicitVr: boolean }[] = [];
    for (let i = elements.length - 1; i >= 0; i--) {
        work.push({ source: elements[i] as WriteElement, target: out, explicitVr });
    }
    while (work.length > 0) {
        const { source, target, explicitVr: frameExplicit } = work.pop() as (typeof work)[number];
        const sized = normalizeOne(source, frameExplicit, charset);
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
    computeSizes(postOrder, explicitVr);
    return out;
}

function normalizeOne(source: WriteElement, explicitVr: boolean, charset: WriteCharset): SizedElement {
    let payload: SizedPayload;
    if (source.value.kind === 'sequence') {
        const contentExplicitVr = explicitVr && source.vr !== 'UN';
        payload = {
            kind: 'sequence',
            items: source.value.items.map(item => ({ elements: [], undefinedLength: item.undefinedLength ?? false, contentSize: 0, totalSize: 0 })),
            contentExplicitVr,
        };
    } else if (source.value.kind === 'fragments') {
        for (const fragment of source.value.fragments) {
            if (fragment.length % 2 !== 0) {
                throw new DicomError('invalid-argument', `fragment length ${fragment.length} is odd; DICOM values must have even length`);
            }
        }
        payload = { kind: 'fragments', basicOffsetTable: source.value.basicOffsetTable, fragments: source.value.fragments };
    } else {
        const bytes = encodePayloadBytes(source, charset);
        if (bytes.length % 2 !== 0) {
            throw new DicomError('invalid-argument', `element ${tagToString(source.tag)} value length ${bytes.length} is odd; values must have even length`);
        }
        payload = { kind: 'bytes', bytes };
    }
    if (explicitVr) {
        checkExplicitVr(source);
    }
    return { tag: source.tag, vr: source.vr, undefinedLength: source.undefinedLength ?? false, payload, contentSize: 0, totalSize: 0 };
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
function checkLengthField(el: SizedElement, explicitVr: boolean): void {
    if (el.undefinedLength) {
        return;
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
function computeSizes(postOrder: readonly (SizedElement | SizedItem)[], rootExplicitVr: boolean): void {
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
            sizeElement(node, explicitOf.get(node) ?? rootExplicitVr);
        } else {
            node.contentSize = node.elements.reduce((sum, el) => sum + el.totalSize, 0);
            node.totalSize = 8 + node.contentSize + (node.undefinedLength ? 8 : 0);
        }
    }
}

function sizeElement(el: SizedElement, explicitVr: boolean): void {
    if (el.payload.kind === 'bytes') {
        el.contentSize = el.payload.bytes.length;
    } else if (el.payload.kind === 'sequence') {
        el.contentSize = el.payload.items.reduce((sum, item) => sum + item.totalSize, 0);
    } else {
        const fragmentsSize = el.payload.fragments.reduce((sum, f) => sum + 8 + f.length, 0);
        el.contentSize = 8 + el.payload.basicOffsetTable.length * 4 + fragmentsSize;
    }
    checkLengthField(el, explicitVr);
    el.totalSize = headerSize(el, explicitVr) + el.contentSize + (el.undefinedLength ? 8 : 0);
}

class Emitter {
    readonly bytes: Uint8Array;
    private readonly view: DataView;
    position = 0;

    constructor(size: number) {
        this.bytes = new Uint8Array(size);
        this.view = new DataView(this.bytes.buffer);
    }

    uint16(value: number): void {
        this.view.setUint16(this.position, value, true);
        this.position += 2;
    }

    uint32(value: number): void {
        this.view.setUint32(this.position, value, true);
        this.position += 4;
    }

    tag(value: Tag): void {
        this.uint16(Math.floor(value / 0x10000));
        this.uint16(value % 0x10000);
    }

    raw(bytes: Uint8Array): void {
        this.bytes.set(bytes, this.position);
        this.position += bytes.length;
    }

    ascii(value: string): void {
        for (let i = 0; i < value.length; i++) {
            this.bytes[this.position++] = value.charCodeAt(i);
        }
    }
}

type EmitToken =
    | { readonly kind: 'element'; readonly el: SizedElement; readonly explicitVr: boolean }
    | { readonly kind: 'item'; readonly item: SizedItem; readonly explicitVr: boolean }
    | { readonly kind: 'delimiter'; readonly tag: Tag };

function emitHeader(emitter: Emitter, el: SizedElement, explicitVr: boolean): void {
    emitter.tag(el.tag);
    const length = el.undefinedLength ? UNDEFINED_LENGTH : el.contentSize;
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
    // fragments were emitted inline; drop the delimiter token order fix below
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
    const explicitVr = options.explicitVr ?? true;
    const sized = normalize(dataSet.elements, explicitVr, options.charset ?? 'latin1');
    const total = sized.reduce((sum, el) => sum + el.totalSize, 0);
    const emitter = new Emitter(total);
    const tokens: EmitToken[] = [];
    for (let i = sized.length - 1; i >= 0; i--) {
        tokens.push({ kind: 'element', el: sized[i] as SizedElement, explicitVr });
    }
    emitTokens(emitter, tokens);
    if (emitter.position !== total) {
        throw new DicomError('invalid-argument', `internal: encoded ${emitter.position} bytes, expected ${total}`);
    }
    return emitter.bytes;
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
