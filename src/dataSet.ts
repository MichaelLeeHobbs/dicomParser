/**
 * The parsed dataset container.
 *
 * Phase 1 scope: element storage and lookup with exact byte accounting. Typed
 * value accessors (`uint16`, `string`, …) land with the accessor layer; the
 * legacy `DataSet` accessor surface returns as the v1 compat façade in Phase 4.
 *
 * @module dataSet
 */

import type { DicomElement } from './element';
import { toTag, type Tag, type TagLike } from './tag';

/**
 * A parsed DICOM dataset: elements keyed by numeric tag over the source bytes.
 */
export class DicomDataSet {
    /** The bytes the element offsets refer to. */
    readonly bytes: Uint8Array;
    /** `true` when multi-byte values are little-endian. */
    readonly littleEndian: boolean;
    /** The parsed elements, keyed by numeric {@link Tag}, in insertion order. */
    readonly elements: ReadonlyMap<Tag, DicomElement>;

    constructor(bytes: Uint8Array, littleEndian: boolean, elements: ReadonlyMap<Tag, DicomElement>) {
        this.bytes = bytes;
        this.littleEndian = littleEndian;
        this.elements = elements;
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
}
