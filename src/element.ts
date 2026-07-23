/**
 * The discriminated-union element model (upstream #257/#278/#279).
 *
 * One `kind` tag replaces the legacy single `Element` interface whose 8 optional
 * fields merged four mutually exclusive runtime shapes. Byte accounting is
 * exact and uniform (upstream #143/#244):
 *
 * - `length` is the number of value bytes, always excluding delimiters. For
 *   undefined-length constructs it is computed from the delimiter position.
 * - `endOffset` is one past the element's last byte *including* any trailing
 *   delimiter, so `startOffset..endOffset` always reconstructs the exact byte
 *   range and consecutive elements tile the stream.
 *
 * @module element
 */

import type { VrSource } from './elementHeader';
import type { DicomDataSet } from './dataSet';
import type { Tag } from './tag';

/** Byte accounting and identity shared by every element kind. */
export interface ElementBase {
    /** The element's tag. */
    readonly tag: Tag;
    /** The two-character VR code, when known. */
    readonly vr: string | undefined;
    /** How {@link vr} was determined. */
    readonly vrSource: VrSource;
    /** Offset of the first header byte (the tag). */
    readonly startOffset: number;
    /** Offset of the first value byte. */
    readonly dataOffset: number;
    /** Value length in bytes, excluding delimiters (computed when undefined). */
    readonly length: number;
    /** One past the element's last byte, including any trailing delimiter. */
    readonly endOffset: number;
    /** `true` when the encoded length was the undefined-length sentinel. */
    readonly hadUndefinedLength: boolean;
}

/** A defined-length element whose value is plain bytes. */
export interface ValueElement extends ElementBase {
    readonly kind: 'value';
}

/**
 * An undefined-length element that is not a sequence: its extent was found by
 * scanning for a delimitation item, and its value bytes are opaque.
 */
export interface UnknownElement extends ElementBase {
    readonly kind: 'unknown';
}

/** A sequence of items (SQ, or UN/peeked implicit parsed as a sequence). */
export interface SequenceElement extends ElementBase {
    readonly kind: 'sequence';
    /** The parsed sequence items, in stream order. */
    readonly items: readonly SequenceItem[];
}

/** One fragment of encapsulated pixel data. */
export interface Fragment {
    /** Offset of the fragment's item tag relative to the first byte after the basic offset table. */
    readonly offset: number;
    /** Absolute offset of the fragment's first data byte. */
    readonly position: number;
    /** Fragment data length in bytes. */
    readonly length: number;
}

/** Undefined-length pixel data holding a basic offset table and fragments. */
export interface EncapsulatedElement extends ElementBase {
    readonly kind: 'encapsulated';
    /** Frame offsets from the basic offset table item (may be empty). */
    readonly basicOffsetTable: readonly number[];
    /** The pixel-data fragments, in stream order. */
    readonly fragments: readonly Fragment[];
}

/** Any parsed data element. */
export type DicomElement = ValueElement | UnknownElement | SequenceElement | EncapsulatedElement;

/** One item of a sequence element. */
export interface SequenceItem {
    /** Offset of the item tag (FFFE,E000). */
    readonly startOffset: number;
    /** Offset of the item's first content byte. */
    readonly dataOffset: number;
    /** Content length in bytes, excluding the item delimiter (computed when undefined). */
    readonly length: number;
    /** One past the item's last byte, including any item delimiter. */
    readonly endOffset: number;
    /** `true` when the encoded item length was the undefined-length sentinel. */
    readonly hadUndefinedLength: boolean;
    /** The item's parsed content. */
    readonly dataSet: DicomDataSet;
}
