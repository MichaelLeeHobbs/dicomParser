/**
 * Encapsulated pixel-data scanner: basic offset table + fragments.
 *
 * Rewrites legacy `findEndOfEncapsulatedPixelData` with the corrected delimiter
 * model: the closing Sequence Delimitation Item is consumed structurally and
 * treated as zero-length regardless of its encoded length — a non-compliant
 * `0xFFFFFFFF` delimiter length made upstream seek past the buffer and throw
 * (upstream #266).
 *
 * @module encapsulated
 */

import type { ByteStream } from './byteStream';
import type { EncapsulatedElement, Fragment } from './element';
import { DicomError } from './errors';
import type { ElementHeader } from './elementHeader';
import { TAG_ITEM, TAG_SEQUENCE_DELIMITATION, UNDEFINED_LENGTH, tagToString } from './tag';

function readBasicOffsetTable(stream: ByteStream, end: number): number[] {
    const itemTag = stream.readTag();
    if (itemTag !== TAG_ITEM) {
        throw new DicomError('malformed', `encapsulated pixel data: basic offset table item (FFFE,E000) not found at offset ${stream.position - 4}`, {
            offset: stream.position - 4,
        });
    }
    const itemLength = stream.readUint32();
    if (itemLength === UNDEFINED_LENGTH) {
        throw new DicomError('malformed', 'encapsulated pixel data: basic offset table item has undefined length', { offset: stream.position - 4 });
    }
    // Bound the table against the value end, not just the stream — for
    // defined-length encapsulation an overlong table would otherwise read the
    // following element's bytes as offset entries (review #2).
    if (itemLength > end - stream.position) {
        throw new DicomError('buffer-overread', `encapsulated pixel data: basic offset table length ${itemLength} exceeds the value bound`, {
            offset: stream.position - 4,
        });
    }
    const entryCount = Math.floor(itemLength / 4);
    const basicOffsetTable: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        basicOffsetTable.push(stream.readUint32());
    }
    const remainder = itemLength - entryCount * 4;
    if (remainder !== 0) {
        stream.warnings.push({
            code: 'length-adjusted',
            message: `basic offset table length ${itemLength} is not a multiple of 4; ${remainder} trailing byte(s) skipped`,
            offset: stream.position,
        });
    }
    stream.seek(remainder);
    return basicOffsetTable;
}

function readFragmentLength(stream: ByteStream, header: ElementHeader, end: number): number {
    const length = stream.readUint32();
    if (length === UNDEFINED_LENGTH) {
        throw new DicomError('malformed', `encapsulated pixel data ${tagToString(header.tag)}: fragment with undefined length`, {
            offset: stream.position - 4,
        });
    }
    const available = end - stream.position;
    if (length > available) {
        stream.warnings.push({
            code: 'length-adjusted',
            message: `fragment length ${length} exceeds remaining bytes; clamped to ${available}`,
            offset: stream.position - 4,
        });
        return available;
    }
    return length;
}

/**
 * Scans an undefined-length pixel-data value: basic offset table item, fragment
 * items, closing sequence delimiter. Leaves the stream one past the delimiter
 * (or at end-of-stream with a warning when the delimiter is missing).
 *
 * Legacy quirk preserved: a non-item tag inside the value is tolerated as a
 * final fragment with a warning (upstream shipped files that do this).
 *
 * @param stream - Stream positioned at the first value byte
 * @param header - The pixel-data element's header
 * @param end - Optional exclusive value bound for defined-length encapsulated
 *              pixel data (upstream #59): the scan stops cleanly there instead
 *              of requiring a sequence delimiter
 * @param frameBound - Optional exclusive bound of the enclosing item/dataset. An
 *              undefined-length pixel-data element nested in a sequence item must
 *              not scan past its item into a following sibling when its sequence
 *              delimiter is missing (review §3); defaults to the whole stream.
 * @returns The encapsulated element with exact byte accounting
 * @throws DicomError `malformed`/`buffer-overread` when the structure is unreadable
 */
export function scanEncapsulatedPixelData(stream: ByteStream, header: ElementHeader, end?: number, frameBound?: number): EncapsulatedElement {
    const bound = end ?? frameBound ?? stream.length;
    const basicOffsetTable = readBasicOffsetTable(stream, bound);
    const fragments: Fragment[] = [];
    const scan = scanFragments(stream, header, fragments, bound);
    let { contentEnd, endOffset } = scan;
    // Undefined-length pixel data that reached its bound without a delimiter is
    // genuinely missing FFFE,E0DD (defined-length has an exact extent instead).
    if (end === undefined && scan.missingDelimiter) {
        stream.warnings.push({
            code: 'missing-sequence-delimiter',
            message: `pixel data element ${tagToString(header.tag)} missing sequence delimiter (FFFE,E0DD)`,
            offset: contentEnd,
        });
    }
    // Defined-length encapsulation has an exact value extent: always resume at
    // it, so an early scan return (delimiter/short data) can't leave the
    // tokenizer reading padding bytes as phantom elements (review #6).
    if (end !== undefined && stream.position !== end) {
        stream.seek(end - stream.position);
        contentEnd = end;
        endOffset = end;
    }
    return {
        kind: 'encapsulated',
        tag: header.tag,
        vr: header.vr,
        vrSource: header.vrSource,
        startOffset: header.startOffset,
        dataOffset: header.dataOffset,
        length: contentEnd - header.dataOffset,
        endOffset,
        hadUndefinedLength: header.hadUndefinedLength,
        basicOffsetTable,
        fragments,
    };
}

/** Scans fragment items up to `bound`. `missingDelimiter` marks that it ran out
 * to the bound without a closing FFFE,E0DD (or a terminal fragment). */
function scanFragments(
    stream: ByteStream,
    header: ElementHeader,
    fragments: Fragment[],
    bound: number
): { contentEnd: number; endOffset: number; missingDelimiter: boolean } {
    const baseOffset = stream.position;
    while (bound - stream.position >= 8) {
        const itemStart = stream.position;
        const itemTag = stream.readTag();
        if (itemTag === TAG_SEQUENCE_DELIMITATION) {
            const delimiterLength = stream.readUint32();
            if (delimiterLength !== 0) {
                stream.warnings.push({
                    code: 'nonzero-delimiter-length',
                    message: `sequence delimiter of ${tagToString(header.tag)} has non-zero length ${delimiterLength}; treated as zero`,
                    offset: itemStart + 4,
                });
            }
            return { contentEnd: itemStart, endOffset: stream.position, missingDelimiter: false };
        }
        const length = readFragmentLength(stream, header, bound);
        fragments.push({ offset: itemStart - baseOffset, position: stream.position, length });
        stream.seek(length);
        if (itemTag !== TAG_ITEM) {
            stream.warnings.push({
                code: 'unexpected-tag',
                message: `unexpected tag ${tagToString(itemTag)} while reading encapsulated pixel data; treated as final fragment`,
                offset: itemStart,
            });
            return { contentEnd: stream.position, endOffset: stream.position, missingDelimiter: false };
        }
    }
    stream.seek(bound - stream.position);
    return { contentEnd: stream.position, endOffset: stream.position, missingDelimiter: true };
}
