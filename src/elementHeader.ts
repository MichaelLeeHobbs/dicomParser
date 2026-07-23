/**
 * Element header readers for explicit and implicit VR encodings.
 *
 * A header is the tag/VR/length prefix of a data element — everything before
 * the value field. Deciding what the value *is* (plain value, sequence,
 * encapsulated pixel data) is the tokenizer's job; these readers only tokenize
 * the header and report exact byte offsets.
 *
 * The explicit reader consults {@link explicitLengthBytes}, which includes the
 * post-2019 long-form VRs SV/UV/OV — upstream mis-read those as short-form,
 * derailing every element after the first one (upstream #280/#281).
 *
 * @module elementHeader
 */

import type { ByteStream } from './byteStream';
import { UNDEFINED_LENGTH, type Tag } from './tag';
import { explicitLengthBytes } from './vr';

/** How an element header's VR was determined. */
export type VrSource =
    /** Encoded in the stream (explicit VR transfer syntax). */
    | 'explicit'
    /** Supplied by the caller's VR lookup (implicit VR transfer syntax). */
    | 'lookup'
    /** Not available (implicit VR without a lookup match). */
    | 'none';

/** The decoded tag/VR/length prefix of a data element. */
export interface ElementHeader {
    /** The element's tag. */
    readonly tag: Tag;
    /** The two-character VR code, when known. */
    readonly vr: string | undefined;
    /** How {@link vr} was determined. */
    readonly vrSource: VrSource;
    /** Offset of the first header byte (the tag). */
    readonly startOffset: number;
    /** Offset of the first value byte (one past the header). */
    readonly dataOffset: number;
    /** Raw encoded length field ({@link UNDEFINED_LENGTH} when undefined). */
    readonly lengthField: number;
    /** `true` when the length field is the undefined-length sentinel. */
    readonly hadUndefinedLength: boolean;
}

/**
 * Looks up a VR for a tag in an implicit-VR stream.
 *
 * The core is dictionary-free (as upstream): consumers supply VR knowledge.
 */
export type VrLookup = (tag: Tag) => string | undefined;

/**
 * Reads an explicit-VR element header (8-byte short form or 12-byte long form)
 * and leaves the stream positioned at the first value byte.
 *
 * @param stream - Stream positioned at the element's tag
 * @returns The decoded header
 * @throws DicomError `buffer-overread` when the header is truncated
 */
export function readExplicitElementHeader(stream: ByteStream): ElementHeader {
    const startOffset = stream.position;
    const tag = stream.readTag();
    const vr = stream.readFixedString(2);
    let lengthField: number;
    if (explicitLengthBytes(vr) === 2) {
        lengthField = stream.readUint16();
    } else {
        stream.seek(2);
        lengthField = stream.readUint32();
    }
    return {
        tag,
        vr,
        vrSource: 'explicit',
        startOffset,
        dataOffset: stream.position,
        lengthField,
        hadUndefinedLength: lengthField === UNDEFINED_LENGTH,
    };
}

/**
 * Reads an implicit-VR element header (always 8 bytes) and leaves the stream
 * positioned at the first value byte.
 *
 * @param stream - Stream positioned at the element's tag
 * @param vrLookup - Optional VR source for implicit elements
 * @returns The decoded header
 * @throws DicomError `buffer-overread` when the header is truncated
 */
export function readImplicitElementHeader(stream: ByteStream, vrLookup?: VrLookup): ElementHeader {
    const startOffset = stream.position;
    const tag = stream.readTag();
    const lengthField = stream.readUint32();
    const vr = vrLookup?.(tag);
    return {
        tag,
        vr,
        vrSource: vr === undefined ? 'none' : 'lookup',
        startOffset,
        dataOffset: stream.position,
        lengthField,
        hadUndefinedLength: lengthField === UNDEFINED_LENGTH,
    };
}
