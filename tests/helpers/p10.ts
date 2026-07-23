/**
 * Test helper: builds synthetic DICOM Part-10 buffers.
 *
 * Ported from `@ubercode/dcmtk` `test/helpers/p10.ts` (an asset-to-port listed
 * in docs/porting-notes.md), adapted to Uint8Array and extended with
 * undefined-length sequence and deflated-file builders.
 */

import { deflateRawSync } from 'node:zlib';

/** Standard transfer syntax UIDs used by the builders. */
export const TS = {
    implicitLE: '1.2.840.10008.1.2',
    explicitLE: '1.2.840.10008.1.2.1',
    explicitBE: '1.2.840.10008.1.2.2',
    deflatedLE: '1.2.840.10008.1.2.1.99',
    jpegBaseline: '1.2.840.10008.1.2.4.50',
} as const;

/** VRs encoded with the 12-byte (long) explicit form. */
const LONG_FORM_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

export function concat(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        result.set(part, at);
        at += part.length;
    }
    return result;
}

function uint16Bytes(value: number, bigEndian: boolean): Uint8Array {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, !bigEndian);
    return bytes;
}

function uint32Bytes(value: number, bigEndian: boolean): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, !bigEndian);
    return bytes;
}

export function latin1(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        bytes[i] = value.charCodeAt(i) & 0xff;
    }
    return bytes;
}

/** Encodes a 'GGGGEEEE' tag. */
export function tagBytes(tag: string, bigEndian = false): Uint8Array {
    const group = Number.parseInt(tag.slice(0, 4), 16);
    const element = Number.parseInt(tag.slice(4, 8), 16);
    return concat([uint16Bytes(group, bigEndian), uint16Bytes(element, bigEndian)]);
}

/** Pads a string value to even length. UI pads with NUL, text VRs with space. */
export function evenPad(value: string, padChar = ' '): Uint8Array {
    const raw = latin1(value);
    return raw.length % 2 === 0 ? raw : concat([raw, latin1(padChar)]);
}

/** Encodes one explicit-VR element. */
export function explicitEl(tag: string, vr: string, value: Uint8Array, bigEndian = false): Uint8Array {
    const head = tagBytes(tag, bigEndian);
    const vrBytes = latin1(vr);
    if (LONG_FORM_VRS.has(vr)) {
        return concat([head, vrBytes, new Uint8Array(2), uint32Bytes(value.length, bigEndian), value]);
    }
    return concat([head, vrBytes, uint16Bytes(value.length, bigEndian), value]);
}

/** Encodes one implicit-VR element (always little endian). */
export function implicitEl(tag: string, value: Uint8Array): Uint8Array {
    return concat([tagBytes(tag), uint32Bytes(value.length, false), value]);
}

/** Wraps item content in a defined-length item (FFFE,E000). */
export function item(content: Uint8Array, bigEndian = false): Uint8Array {
    return concat([tagBytes('FFFEE000', bigEndian), uint32Bytes(content.length, bigEndian), content]);
}

/** Wraps item content in an undefined-length item terminated by FFFE,E00D. */
export function undefinedLengthItem(content: Uint8Array, bigEndian = false): Uint8Array {
    return concat([tagBytes('FFFEE000', bigEndian), Uint8Array.from([0xff, 0xff, 0xff, 0xff]), content, tagBytes('FFFEE00D', bigEndian), new Uint8Array(4)]);
}

/** Encodes a defined-length explicit-VR SQ element from item contents. */
export function sqExplicit(tag: string, itemContents: readonly Uint8Array[], bigEndian = false): Uint8Array {
    return explicitEl(tag, 'SQ', concat(itemContents.map(c => item(c, bigEndian))), bigEndian);
}

/** Encodes an undefined-length explicit-VR SQ element terminated by FFFE,E0DD. */
export function sqExplicitUndefined(tag: string, encodedItems: readonly Uint8Array[], bigEndian = false): Uint8Array {
    return concat([
        tagBytes(tag, bigEndian),
        latin1('SQ'),
        new Uint8Array(2),
        Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
        ...encodedItems,
        tagBytes('FFFEE0DD', bigEndian),
        new Uint8Array(4),
    ]);
}

/** Encodes a defined-length implicit-VR SQ element. */
export function sqImplicit(tag: string, itemContents: readonly Uint8Array[]): Uint8Array {
    return implicitEl(tag, concat(itemContents.map(c => item(c))));
}

/** Encodes an encapsulated pixel-data element (undefined length, offset table + fragments). */
export function encapsulatedPixelData(fragments: readonly Uint8Array[], offsetTableEntries: readonly number[] = []): Uint8Array {
    const head = concat([tagBytes('7FE00010'), latin1('OB'), new Uint8Array(2), Uint8Array.from([0xff, 0xff, 0xff, 0xff])]);
    const offsetTable = item(concat(offsetTableEntries.map(entry => uint32Bytes(entry, false))));
    const frags = concat(fragments.map(fragment => item(fragment)));
    const delimiter = concat([tagBytes('FFFEE0DD'), new Uint8Array(4)]);
    return concat([head, offsetTable, frags, delimiter]);
}

/** Builds the file meta group (always explicit little endian). */
export function metaGroup(transferSyntaxUid: string): Uint8Array {
    const tsEl = explicitEl('00020010', 'UI', evenPad(transferSyntaxUid, '\0'));
    const sopClassEl = explicitEl('00020002', 'UI', evenPad('1.2.840.10008.5.1.4.1.1.7', '\0'));
    const groupLenEl = explicitEl('00020000', 'UL', uint32Bytes(sopClassEl.length + tsEl.length, false));
    return concat([groupLenEl, sopClassEl, tsEl]);
}

/** Builds a complete Part-10 file: preamble + DICM + meta + dataset elements. */
export function p10(transferSyntaxUid: string, datasetElements: readonly Uint8Array[]): Uint8Array {
    return concat([new Uint8Array(128), latin1('DICM'), metaGroup(transferSyntaxUid), ...datasetElements]);
}

/** Builds a deflated Part-10 file: preamble + DICM + meta + deflated dataset. */
export function p10Deflated(datasetElements: readonly Uint8Array[]): Uint8Array {
    const dataset = concat([...datasetElements]);
    const deflated = new Uint8Array(deflateRawSync(dataset));
    return concat([new Uint8Array(128), latin1('DICM'), metaGroup(TS.deflatedLE), deflated]);
}
