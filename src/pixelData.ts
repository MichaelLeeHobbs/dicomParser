/**
 * Encapsulated pixel-data access helpers and typed pixel views.
 *
 * Ports legacy `readEncapsulatedPixelDataFromFragments`,
 * `readEncapsulatedImageFrame` and `createJPEGBasicOffsetTable` onto the
 * discriminated element model, plus a typed-array view helper so consumers
 * never hand-build views from `dataOffset`/`length` (the upstream #73 support
 * class). Fragments carry absolute positions, so no re-scanning is needed.
 *
 * @module pixelData
 */

import type { DicomDataSet } from './dataSet';
import type { DicomElement, EncapsulatedElement, Fragment } from './element';
import { DicomError } from './errors';
import { TAG_PIXEL_DATA, tagToString } from './tag';

function requireEncapsulated(element: DicomElement): EncapsulatedElement {
    if (element.tag !== TAG_PIXEL_DATA) {
        throw new DicomError('invalid-argument', `expected pixel data (7FE0,0010), got ${tagToString(element.tag)}`);
    }
    if (element.kind !== 'encapsulated') {
        throw new DicomError('invalid-argument', 'element does not hold encapsulated pixel data');
    }
    return element;
}

/**
 * Extracts the bytes of one or more consecutive fragments.
 *
 * @param bytes - The parsed file's bytes (`ParseResult.bytes`)
 * @param element - The encapsulated pixel-data element
 * @param startFragmentIndex - Zero-based index of the first fragment
 * @param numFragments - Number of fragments to extract (default 1)
 * @returns A zero-copy view for a single fragment, a copy for several
 * @throws DicomError `invalid-argument` on bad element or out-of-range indexes
 */
export function readEncapsulatedPixelDataFromFragments(bytes: Uint8Array, element: DicomElement, startFragmentIndex: number, numFragments = 1): Uint8Array {
    const encapsulated = requireEncapsulated(element);
    const fragments = encapsulated.fragments;
    if (startFragmentIndex < 0 || startFragmentIndex >= fragments.length) {
        throw new DicomError('invalid-argument', `startFragmentIndex ${startFragmentIndex} is out of range (${fragments.length} fragments)`);
    }
    if (numFragments < 1 || startFragmentIndex + numFragments > fragments.length) {
        throw new DicomError('invalid-argument', `numFragments ${numFragments} exceeds the available fragments`);
    }
    if (numFragments === 1) {
        const fragment = fragments[startFragmentIndex] as Fragment;
        return bytes.subarray(fragment.position, fragment.position + fragment.length);
    }
    let total = 0;
    for (let i = startFragmentIndex; i < startFragmentIndex + numFragments; i++) {
        total += (fragments[i] as Fragment).length;
    }
    const combined = new Uint8Array(total);
    let at = 0;
    for (let i = startFragmentIndex; i < startFragmentIndex + numFragments; i++) {
        const fragment = fragments[i] as Fragment;
        combined.set(bytes.subarray(fragment.position, fragment.position + fragment.length), at);
        at += fragment.length;
    }
    return combined;
}

function findFragmentIndexWithOffset(fragments: readonly Fragment[], offset: number): number {
    for (let i = 0; i < fragments.length; i++) {
        if ((fragments[i] as Fragment).offset === offset) {
            return i;
        }
    }
    return -1;
}

function fragmentCountForFrame(frameIndex: number, basicOffsetTable: readonly number[], fragments: readonly Fragment[], startFragmentIndex: number): number {
    if (frameIndex === basicOffsetTable.length - 1) {
        return fragments.length - startFragmentIndex;
    }
    const nextFrameOffset = basicOffsetTable[frameIndex + 1] as number;
    for (let i = startFragmentIndex + 1; i < fragments.length; i++) {
        if ((fragments[i] as Fragment).offset === nextFrameOffset) {
            return i - startFragmentIndex;
        }
    }
    throw new DicomError('malformed', 'could not find a fragment matching the next basic offset table entry');
}

/**
 * Extracts one frame of encapsulated pixel data using the basic offset table.
 *
 * @param bytes - The parsed file's bytes (`ParseResult.bytes`)
 * @param element - The encapsulated pixel-data element (non-empty offset table)
 * @param frameIndex - Zero-based frame index
 * @returns The frame's bytes (fragments concatenated when needed)
 * @throws DicomError `invalid-argument`/`malformed` on bad element, index or table
 */
export function readEncapsulatedImageFrame(bytes: Uint8Array, element: DicomElement, frameIndex: number): Uint8Array {
    const encapsulated = requireEncapsulated(element);
    const { basicOffsetTable, fragments } = encapsulated;
    if (basicOffsetTable.length === 0) {
        throw new DicomError('invalid-argument', 'basic offset table is empty — use readEncapsulatedPixelDataFromFragments or createJpegBasicOffsetTable');
    }
    if (frameIndex < 0 || frameIndex >= basicOffsetTable.length) {
        throw new DicomError('invalid-argument', `frameIndex ${frameIndex} is out of range (${basicOffsetTable.length} frames)`);
    }
    const startFragmentIndex = findFragmentIndexWithOffset(fragments, basicOffsetTable[frameIndex] as number);
    if (startFragmentIndex < 0) {
        throw new DicomError('malformed', 'no fragment matches the basic offset table entry for the requested frame');
    }
    const numFragments = fragmentCountForFrame(frameIndex, basicOffsetTable, fragments, startFragmentIndex);
    return readEncapsulatedPixelDataFromFragments(bytes, element, startFragmentIndex, numFragments);
}

function isEndOfImageMarker(bytes: Uint8Array, position: number): boolean {
    return bytes[position] === 0xff && bytes[position + 1] === 0xd9;
}

function isFragmentEndOfImage(bytes: Uint8Array, fragment: Fragment): boolean {
    // check the last two and last three bytes — odd-length fragments are padded
    return isEndOfImageMarker(bytes, fragment.position + fragment.length - 2) || isEndOfImageMarker(bytes, fragment.position + fragment.length - 3);
}

/**
 * Builds a basic offset table for JPEG-family encapsulated pixel data by
 * scanning fragments for end-of-image markers (legacy
 * `createJPEGBasicOffsetTable` port).
 *
 * @param bytes - The parsed file's bytes (`ParseResult.bytes`)
 * @param element - The encapsulated pixel-data element
 * @returns Frame start offsets (relative to the first byte after the BOT item)
 * @throws DicomError `invalid-argument` when the element has no fragments
 */
export function createJpegBasicOffsetTable(bytes: Uint8Array, element: DicomElement): number[] {
    const encapsulated = requireEncapsulated(element);
    const fragments = encapsulated.fragments;
    if (fragments.length === 0) {
        throw new DicomError('invalid-argument', 'element has no fragments');
    }
    const basicOffsetTable: number[] = [];
    let startFragmentIndex = 0;
    while (startFragmentIndex < fragments.length) {
        basicOffsetTable.push((fragments[startFragmentIndex] as Fragment).offset);
        let endFragmentIndex = -1;
        for (let i = startFragmentIndex; i < fragments.length; i++) {
            if (isFragmentEndOfImage(bytes, fragments[i] as Fragment)) {
                endFragmentIndex = i;
                break;
            }
        }
        if (endFragmentIndex < 0 || endFragmentIndex === fragments.length - 1) {
            return basicOffsetTable;
        }
        startFragmentIndex = endFragmentIndex + 1;
    }
    return basicOffsetTable;
}

/** A typed view over native (uncompressed) pixel data. */
export type PixelDataView = Uint8Array | Int8Array | Uint16Array | Int16Array | Float32Array | Float64Array;

interface ViewSpec {
    readonly offset: number;
    readonly length: number;
    readonly bitsAllocated: number;
    readonly signed: boolean;
}

function viewFor(bytes: Uint8Array, spec: ViewSpec): PixelDataView {
    const { offset, length, bitsAllocated, signed } = spec;
    const bytesPer = bitsAllocated / 8;
    const count = Math.floor(length / bytesPer);
    const absolute = bytes.byteOffset + offset;
    if (bitsAllocated === 8) {
        return signed ? new Int8Array(bytes.buffer, absolute, count) : new Uint8Array(bytes.buffer, absolute, count);
    }
    if (absolute % bytesPer !== 0) {
        // typed arrays require aligned offsets; copy to a fresh buffer
        const copy = bytes.slice(offset, offset + count * bytesPer);
        return signed ? new Int16Array(copy.buffer, 0, count) : new Uint16Array(copy.buffer, 0, count);
    }
    return signed ? new Int16Array(bytes.buffer, absolute, count) : new Uint16Array(bytes.buffer, absolute, count);
}

/**
 * Returns a correctly-constructed typed-array view over native pixel data,
 * using BitsAllocated (0028,0100) and PixelRepresentation (0028,0103) — the
 * helper upstream users kept hand-building incorrectly (#73).
 *
 * Only native (kind `'value'`) pixel data is viewable; encapsulated pixel data
 * must be decoded by a codec first (fragment access above).
 *
 * @param dataSet - The parsed dataset (supplies BitsAllocated/PixelRepresentation)
 * @returns The typed view, or `undefined` when pixel data is absent or encapsulated
 * @throws DicomError `unsupported` for BitsAllocated other than 8/16
 */
export function nativePixelDataView(dataSet: DicomDataSet): PixelDataView | undefined {
    const element = dataSet.element(TAG_PIXEL_DATA);
    if (element === undefined || element.kind !== 'value') {
        return undefined;
    }
    const bitsAllocated = dataSet.uint16(0x00280100) ?? 16;
    const signed = (dataSet.uint16(0x00280103) ?? 0) === 1;
    if (bitsAllocated !== 8 && bitsAllocated !== 16) {
        throw new DicomError('unsupported', `nativePixelDataView: BitsAllocated ${bitsAllocated} is not supported (8 and 16 are)`);
    }
    return viewFor(dataSet.bytes, { offset: element.dataOffset, length: element.length, bitsAllocated, signed });
}
