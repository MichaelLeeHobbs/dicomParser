/**
 * Numeric DICOM tag representation and helpers.
 *
 * The core represents tags as unsigned 32-bit numbers (`group * 0x10000 + element`)
 * for fast ordered comparison (required by the `stopAt` ≥ semantics). Formatted
 * strings appear only at API boundaries; the legacy `'xggggeeee'` form is accepted
 * on input for compatibility.
 *
 * @module tag
 */

import { DicomError } from './errors';

/**
 * An unsigned 32-bit DICOM tag: `group * 0x10000 + element`.
 *
 * Tags compare in DICOM file order with plain `<`/`>` operators.
 */
export type Tag = number;

/** A tag accepted at API boundaries: numeric, `'xggggeeee'`, or `'GGGGEEEE'`. */
export type TagLike = Tag | string;

/**
 * Builds a {@link Tag} from group and element numbers.
 *
 * @param group - Group number in `[0, 0xffff]`
 * @param element - Element number in `[0, 0xffff]`
 * @returns The numeric tag
 * @throws DicomError `invalid-argument` when either part is out of range
 */
export function tag(group: number, element: number): Tag {
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) {
        throw new DicomError('invalid-argument', `tag: group ${group} is not an integer in [0, 0xffff]`);
    }
    if (!Number.isInteger(element) || element < 0 || element > 0xffff) {
        throw new DicomError('invalid-argument', `tag: element ${element} is not an integer in [0, 0xffff]`);
    }
    return group * 0x10000 + element;
}

const TAG_STRING_PATTERN = /^x?([0-9a-fA-F]{8})$/;

/**
 * Parses a tag string in `'xggggeeee'` (legacy) or `'ggggeeee'`/`'GGGGEEEE'` form.
 *
 * @param value - The tag string
 * @returns The numeric tag
 * @throws DicomError `invalid-argument` when the string is not a valid tag
 */
export function tagFromString(value: string): Tag {
    const match = TAG_STRING_PATTERN.exec(value);
    if (match === null || match[1] === undefined) {
        throw new DicomError('invalid-argument', `tagFromString: '${value}' is not a tag in 'xggggeeee' or 'ggggeeee' form`);
    }
    return Number.parseInt(match[1], 16);
}

/**
 * Normalizes a {@link TagLike} to a numeric {@link Tag}.
 *
 * @param value - Numeric tag or tag string
 * @returns The numeric tag
 * @throws DicomError `invalid-argument` when the value is not a valid tag
 */
export function toTag(value: TagLike): Tag {
    if (typeof value === 'string') {
        return tagFromString(value);
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new DicomError('invalid-argument', `toTag: ${value} is not an unsigned 32-bit tag`);
    }
    return value;
}

/**
 * Formats a tag in the legacy `'xggggeeee'` form (lowercase hex).
 *
 * @param value - The numeric tag
 * @returns The formatted tag string
 */
export function tagToString(value: Tag): string {
    return `x${value.toString(16).padStart(8, '0')}`;
}

/** Extracts the group number of a tag. */
export function tagGroup(value: Tag): number {
    return Math.floor(value / 0x10000);
}

/** Extracts the element number of a tag. */
export function tagElement(value: Tag): number {
    return value % 0x10000;
}

/**
 * Tests whether a tag is private (odd group number).
 *
 * @param value - The numeric tag
 * @returns `true` when the group number is odd
 */
export function isPrivateTag(value: Tag): boolean {
    return tagGroup(value) % 2 === 1;
}

/** Item tag (FFFE,E000). */
export const TAG_ITEM: Tag = 0xfffee000;
/** Item Delimitation Item tag (FFFE,E00D). */
export const TAG_ITEM_DELIMITATION: Tag = 0xfffee00d;
/** Sequence Delimitation Item tag (FFFE,E0DD). */
export const TAG_SEQUENCE_DELIMITATION: Tag = 0xfffee0dd;
/** Pixel Data tag (7FE0,0010). */
export const TAG_PIXEL_DATA: Tag = 0x7fe00010;
/** Transfer Syntax UID tag (0002,0010). */
export const TAG_TRANSFER_SYNTAX_UID: Tag = 0x00020010;
/** Undefined-length sentinel (0xFFFFFFFF). */
export const UNDEFINED_LENGTH = 0xffffffff;
