import { describe, expect, it } from 'vitest';
import { ByteStream } from './byteStream';
import type { EncapsulatedElement, SequenceElement, UnknownElement, ValueElement } from './element';
import { readElements } from './tokenizer';
import { tagFromString } from './tag';
import { concat, evenPad, explicitEl, item, sqExplicit, sqExplicitUndefined, undefinedLengthItem } from '../tests/helpers/p10';

// Ported from legacy readSequenceItemsExplicit_test.js,
// readSequenceItemsImplicit_test.js and the sequence/UN halves of
// readDicomElementExplicit_test.js / readDicomElementImplicit_test.js, plus new
// coverage for the corrected delimiter model (#244/#143/#266), stopAt ≥
// semantics (#104/#268/#52), typed errors with partial results (#46/#203/#277)
// and the depth bound.
//
// Byte-accounting divergence from legacy: `length` always excludes delimiters;
// `endOffset` includes them. Legacy folded delimiters into some lengths.

function streamOf(bytes: readonly number[], littleEndian = true): ByteStream {
    return new ByteStream(Uint8Array.from(bytes), { littleEndian });
}

function sq(element: unknown): SequenceElement {
    expect((element as SequenceElement).kind).toBe('sequence');
    return element as SequenceElement;
}

describe('readElements — explicit values', () => {
    it('reads consecutive value elements with exact offsets', () => {
        // (2210,4433) OB len 0 · (2211,4433) OB len 2
        const stream = streamOf([
            0x10, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
            0xaa, 0xbb,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(2);
        const second = result.elements.get(tagFromString('x22114433')) as ValueElement;
        expect(second.kind).toBe('value');
        expect(second.startOffset).toBe(12);
        expect(second.dataOffset).toBe(24);
        expect(second.length).toBe(2);
        expect(second.endOffset).toBe(26);
    });

    it('salvages parsed elements when a header is truncated (partial results, #203)', () => {
        const stream = streamOf([
            0x10, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            // 5 bytes of trailing garbage — not enough for a header
            0x11, 0x22, 0x33, 0x44, 0x4f,
        ]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('buffer-overread');
        expect(result.elements.size).toBe(1);
        expect(result.elements.has(tagFromString('x22104433'))).toBe(true);
    });

    it('truncates a value overrunning end of data with a warning (legacy: silent seek past end)', () => {
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x54, 0xff, 0x00, 0x41, 0x42]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x22114433')) as ValueElement;
        expect(element.length).toBe(2);
        expect(stream.warnings.some(w => w.code === 'unexpected-eof')).toBe(true);
    });
});

describe('readElements — explicit sequences', () => {
    it('parses a defined-length SQ with an empty item', () => {
        // (2211,4433) SQ len 8 · item len 0
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x22114433')));
        expect(element.length).toBe(8);
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.length).toBe(0);
        expect(element.items[0]?.dataSet.elements.size).toBe(0);
    });

    it('parses an undefined-length SQ with undefined-length items; delimiters never surface as elements (#244)', () => {
        // (0008,1140) SQ undefined · item undefined · (0008,0100) SH len 2 'A ' ·
        // item delimiter · sequence delimiter
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.hadUndefinedLength).toBe(true);
        // content ends where the sequence delimiter starts; endOffset includes it
        expect(element.length).toBe(38 - 12);
        expect(element.endOffset).toBe(46);
        const item = element.items[0];
        expect(item?.hadUndefinedLength).toBe(true);
        expect(item?.length).toBe(10);
        expect(item?.endOffset).toBe(38);
        // the item's dataset holds only the real element — no xfffee00d leakage
        expect(item?.dataSet.elements.size).toBe(1);
        expect(item?.dataSet.element('x00080100')).toBeDefined();
        expect(item?.dataSet.element('xfffee00d')).toBeUndefined();
    });

    it('parses an undefined-length SQ containing a defined-length item (#181)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.hadUndefinedLength).toBe(false);
        expect(element.items[0]?.length).toBe(10);
    });

    it('treats a non-zero sequence delimiter length as zero with a warning (#266)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0xff, 0xff, 0xff, 0xff,
            // a following element that a length-honoring seek would have skipped
            0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'nonzero-delimiter-length')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x00081140'))).items).toHaveLength(0);
        expect(result.elements.get(tagFromString('x00080100'))).toBeDefined();
    });

    it('warns on eof before a sequence delimiter (legacy readSequenceItemsExplicit test)', () => {
        // SQ header with undefined length, then nothing
        const stream = streamOf([0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x00081140'))).items).toHaveLength(0);
    });

    it('parses a UN element of undefined length as an implicit sequence (CP-246, legacy behavior)', () => {
        // (1001,2000) UN undefined · item undefined · nested empty explicit-style
        // SQ bytes read as implicit content · delimiters
        const stream = streamOf([
            0x01, 0x10, 0x00, 0x20, 0x55, 0x4e, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x01, 0x10, 0x02, 0x20,
            0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x10012000')));
        expect(element.vr).toBe('UN');
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.dataSet.elements.size).toBe(1);
        expect(element.items[0]?.dataSet.element('x10012002')).toBeDefined();
    });

    it('scans an undefined-length non-UN element to its delimiter as an unknown element', () => {
        // (2211,4433) OB undefined length (not pixel data) · garbage · item delimiter
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00,
            0x00, 0x00,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x22114433')) as UnknownElement;
        expect(element.kind).toBe('unknown');
        expect(element.length).toBe(6);
        expect(element.endOffset).toBe(26);
        expect(element.hadUndefinedLength).toBe(true);
    });
});

describe('readElements — implicit', () => {
    const OW_LOOKUP = (tag: number): string | undefined => (tag === 0x7fe00010 ? 'OW' : undefined);

    it('detects an implicit SQ by peeking at an item tag (public tag, no lookup)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00,
            0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00080006')));
        expect(element.items).toHaveLength(1);
        const codeValue = element.items[0]?.dataSet.element('x00080100');
        expect(codeValue?.length).toBe(2);
        expect(codeValue?.dataOffset).toBe(24);
    });

    it('parses an implicit undefined-length empty sequence via peeking at the sequence delimiter', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00,
            0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(sq(result.elements.get(tagFromString('x00080006'))).items).toHaveLength(0);
        expect(result.elements.get(tagFromString('x00080100'))).toBeDefined();
    });

    it('recovers peek-misdetected pixel data to an opaque value (speculative fallback; legacy threw and lost the file)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(8);
        expect(stream.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
    });

    it('the VR lookup overrides peeking (item-tag-like pixel data)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.vr).toBe('OW');
        expect(element.length).toBe(8);
    });

    it('the VR lookup overrides peeking (delimiter-tag-like pixel data)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x0b, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x12, 0x43, 0x98]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.vr).toBe('OW');
        expect(element.length).toBe(11);
    });

    it('recovers delimiter-tag-like pixel data to an opaque value without a lookup (legacy threw and lost the file)', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x0b, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x12, 0x43, 0x98]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(11);
        expect(stream.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
    });

    it('keeps a private defined-length element opaque even when it looks like a sequence (#114)', () => {
        const stream = streamOf([
            0x09, 0x00, 0x06, 0x00, 0x1a, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x18, 0x00, 0x02, 0x00, 0x00, 0x00,
            0x42, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x00090006')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(26);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });

    it('parses a private undefined-length element structurally, keeping items (divergence: legacy discarded them)', () => {
        const stream = streamOf([
            0x09, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x08, 0x00, 0x18, 0x00, 0x04, 0x00, 0x00, 0x00,
            0x41, 0x42, 0x43, 0x20, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00090006')));
        // content excludes the sequence delimiter: items + item delimiter = 28 bytes
        expect(element.length).toBe(28);
        expect(element.items).toHaveLength(1);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });

    it('warns once for a truncated defined-length element (legacy parity)', () => {
        const stream = streamOf([0x06, 0x30, 0xa6, 0x00, 0x00, 0xff, 0xff, 0xff]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(1);
        expect(stream.warnings).toHaveLength(1);
    });

    it('warns once for a truncated undefined-length element (legacy parity)', () => {
        const stream = streamOf([0x06, 0x30, 0xa6, 0x00, 0xff, 0xff, 0xff, 0xff]);
        const result = readElements(stream, { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(1);
        expect(stream.warnings).toHaveLength(1);
    });

    it('reads an element that looks like SQ inside an undefined-length item with a lookup (legacy sequence test)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xe0, 0x7f, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = sq(result.elements.get(tagFromString('x00080006')));
        const item = element.items[0];
        expect(item?.length).toBe(16);
        expect(item?.endOffset).toBe(40);
        const pixelData = item?.dataSet.element('x7fe00010');
        expect(pixelData?.length).toBe(8);
        expect(pixelData?.vr).toBe('OW');
    });

    it('warns for missing item and sequence delimiters at eof (legacy sequence test)', () => {
        const stream = streamOf([
            0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xe0, 0x7f, 0x10, 0x00, 0x04, 0x00, 0x00, 0x00,
            0x01, 0x23, 0x45, 0x67,
        ]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OW_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00080006')));
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.dataSet.element('x7fe00010')?.length).toBe(4);
        expect(stream.warnings.some(w => w.code === 'missing-item-delimiter')).toBe(true);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });
});

describe('readElements — encapsulated pixel data', () => {
    // (7FE0,0010) OB undefined · empty BOT · one 4-byte fragment · delimiter
    const ENCAPSULATED = [
        0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x04,
        0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
    ];

    it('parses the basic offset table and fragments', () => {
        const stream = streamOf(ENCAPSULATED);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.kind).toBe('encapsulated');
        expect(element.basicOffsetTable).toEqual([]);
        expect(element.fragments).toHaveLength(1);
        expect(element.fragments[0]).toEqual({ offset: 0, position: 28, length: 4 });
        expect(element.length).toBe(32 - 12);
        expect(element.endOffset).toBe(40);
    });

    it('DCMTK-parity: a pixel sequence closed by an item delimiter (FFFE,E00D) ends cleanly, no phantom fragment', () => {
        // BOT (empty) + one 4-byte fragment, then FFFE,E00D (wrong) instead of E0DD,
        // then a root sibling. The stray item delimiter must terminate the pixel
        // sequence — not surface as a bogus zero-length fragment — and the tail must
        // survive (parity with the sequence path and DCMTK's EC_ItemEnd).
        // (7FE0,0010) OB undefined · empty BOT · 4-byte fragment · FFFE,E00D (wrong terminator)
        const enc = [
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ];
        const sib = [0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 0x04, 0x00, 0x44, 0x4f, 0x45, 0x20];
        const stream = streamOf([...enc, ...sib]);
        const result = readElements(stream, { explicitVr: true, compressedTransferSyntax: true });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments.map(f => f.length)).toEqual([4]); // no phantom zero-length fragment
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true); // the tail survives
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('parses a populated basic offset table', () => {
        const bytes = [
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xfe, 0xff, 0x00, 0xe0, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ];
        const result = readElements(streamOf(bytes));
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.basicOffsetTable).toEqual([0]);
        expect(element.fragments[0]).toEqual({ offset: 0, position: 32, length: 2 });
    });

    it('treats a non-zero delimiter length as zero instead of seeking (#266)', () => {
        const bytes = [...ENCAPSULATED];
        // corrupt the closing delimiter's length to 0xFFFFFFFF
        bytes[36] = 0xff;
        bytes[37] = 0xff;
        bytes[38] = 0xff;
        bytes[39] = 0xff;
        const stream = streamOf(bytes);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'nonzero-delimiter-length')).toBe(true);
    });

    it('warns when the sequence delimiter is missing', () => {
        const stream = streamOf(ENCAPSULATED.slice(0, 32));
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('reports a typed error for a basic offset table with undefined length', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('reports a typed error for a basic offset table longer than the data', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xf0, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('buffer-overread');
    });

    it('reports a typed error for a fragment with undefined length', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0xff, 0xff, 0xff, 0xff,
        ]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('clamps a fragment length overrunning the data with a warning', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0xf0, 0x00, 0x00, 0x00, 0x01, 0x02,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments[0]?.length).toBe(2);
        expect(stream.warnings.some(w => w.code === 'length-adjusted')).toBe(true);
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('reports a typed error when the basic offset table is missing', () => {
        const stream = streamOf([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('tolerates an unexpected tag as a final fragment with a warning (legacy behavior)', () => {
        const stream = streamOf([
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x02, 0x00, 0x00, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.fragments).toHaveLength(1);
        expect(stream.warnings.some(w => w.code === 'unexpected-tag')).toBe(true);
    });
});

describe('readElements — length pathologies', () => {
    it('reports a typed error when a defined-length SQ overruns its enclosing bound', () => {
        // SQ claims 0xF0 bytes but only 8 remain
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
    });

    it('warns when defined-length SQ content overruns the declared length', () => {
        // SQ len 8, but its single item declares 10 content bytes
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
            0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.code === 'length-adjusted')).toBe(true);
        expect(sq(result.elements.get(tagFromString('x22114433'))).items).toHaveLength(1);
    });

    it('reports a typed error when a sequence item overruns end of data', () => {
        const stream = streamOf([0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0xf0, 0x00, 0x00, 0x00]);
        const result = readElements(stream);
        expect(result.error?.code).toBe('malformed');
        // the sequence itself is salvaged
        expect(result.elements.size).toBe(1);
    });

    it('rolls a defined-length SQ back to an opaque value when an inner value overruns the item bound', () => {
        // item declares 10 bytes; the element inside claims 0x20 — the
        // speculative frame falls back and the following element still parses
        const stream = streamOf([
            0x11, 0x22, 0x33, 0x44, 0x53, 0x51, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01,
            0x53, 0x48, 0x20, 0x00, 0x41, 0x20, 0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20,
        ]);
        const result = readElements(stream);
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x22114433')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(0x12);
        expect(stream.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });
});

describe('readElements — stopAt (≥ semantics, #104/#268/#52)', () => {
    // (0008,0100) SH 'A ' · (0010,0010) PN 'X ' · (7FE0,0010) OB len 2
    const THREE_ELEMENTS = [
        0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20, 0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 0x02, 0x00, 0x58, 0x20, 0xe0, 0x7f, 0x10, 0x00, 0x4f,
        0x42, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02,
    ];

    it('defaults to exclusive at an exact match (core default flipped; compat pins inclusive)', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100010' } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(1);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(false);
    });

    it('includes the triggering element when inclusive is true', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100010', inclusive: true } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(2);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
        expect(result.elements.has(tagFromString('x7fe00010'))).toBe(false);
    });

    it('stops at the first tag greater than a missing tag (the #104 fix)', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100005', inclusive: true } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(2);
    });

    it('excludes the triggering element when inclusive is false (#52; now the default)', () => {
        const result = readElements(streamOf(THREE_ELEMENTS), { stopAt: { tag: 'x00100010', inclusive: false } });
        expect(result.stoppedAt).toBe(tagFromString('x00100010'));
        expect(result.elements.size).toBe(1);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(false);
    });

    it('does not stop inside sequence items', () => {
        const stream = streamOf([
            0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x10, 0x00, 0x10, 0x00,
            0x50, 0x4e, 0x02, 0x00, 0x58, 0x20,
        ]);
        const result = readElements(stream, { stopAt: { tag: 'x00100010' } });
        expect(result.stoppedAt).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.items[0]?.dataSet.element('x00100010')).toBeDefined();
    });
});

describe('readElements — depth bound', () => {
    it('reports a typed error when nesting exceeds maxDepth', () => {
        // Implicit SQ nesting: each level is an undefined-length element whose
        // content starts with an item that again starts a sequence-looking tag.
        const bytes: number[] = [];
        for (let i = 0; i < 8; i++) {
            bytes.push(0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff);
            bytes.push(0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff);
        }
        const result = readElements(streamOf(bytes), { explicitVr: false, maxDepth: 6 });
        expect(result.error?.code).toBe('depth-exceeded');
        // partial results survive: the outermost sequence is present
        expect(result.elements.size).toBe(1);
    });
});

describe('readElements — CP-246 defined-length UN sequences (#141)', () => {
    const SQ_LOOKUP = (tag: number): string | undefined => (tag === 0x00081140 ? 'SQ' : undefined);

    // (0008,1140) UN, defined length 18, containing one defined-length item
    // with one implicit element (0008,0100) 'A '
    const UN_SQ = [
        0x08, 0x00, 0x40, 0x11, 0x55, 0x4e, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x01, 0x02,
        0x00, 0x00, 0x00, 0x41, 0x20,
    ];

    it('parses UN + defined length as an implicit sequence when the lookup says SQ', () => {
        const stream = streamOf(UN_SQ);
        const result = readElements(stream, { explicitVr: true, vrLookup: SQ_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = sq(result.elements.get(tagFromString('x00081140')));
        expect(element.vr).toBe('UN');
        expect(element.items).toHaveLength(1);
        expect(element.items[0]?.dataSet.element('x00080100')?.length).toBe(2);
    });

    it('keeps UN + defined length opaque without a lookup match (legacy behavior)', () => {
        const stream = streamOf(UN_SQ);
        const result = readElements(stream, { explicitVr: true });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x00081140')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(0x12);
    });

    it('falls back to an opaque value when the UN content is not a sequence', () => {
        // lookup says SQ but the value bytes are garbage
        const bytes = [
            0x08, 0x00, 0x40, 0x11, 0x55, 0x4e, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
            // following element still parses
            0x08, 0x00, 0x00, 0x01, 0x53, 0x48, 0x02, 0x00, 0x41, 0x20,
        ];
        const stream = streamOf(bytes);
        const result = readElements(stream, { explicitVr: true, vrLookup: SQ_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x00081140')) as ValueElement;
        expect(element.kind).toBe('value');
        expect(element.length).toBe(10);
        expect(stream.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
        expect(result.elements.get(tagFromString('x00080100'))?.length).toBe(2);
    });
});

describe('readElements — defined-length encapsulated pixel data (#59/#60)', () => {
    // (7FE0,0010) OB defined length 20: empty BOT item + one 4-byte fragment
    const DEFINED_ENCAPSULATED = [
        0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x04,
        0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    ];

    it('scans defined-length pixel data as encapsulated in a compressed transfer syntax', () => {
        const stream = streamOf(DEFINED_ENCAPSULATED);
        const result = readElements(stream, { explicitVr: true, compressedTransferSyntax: true });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x7fe00010')) as EncapsulatedElement;
        expect(element.kind).toBe('encapsulated');
        expect(element.hadUndefinedLength).toBe(false);
        expect(element.fragments).toHaveLength(1);
        expect(element.fragments[0]).toEqual({ offset: 0, position: 28, length: 4 });
        expect(element.endOffset).toBe(32);
    });

    it('keeps defined-length pixel data opaque in an uncompressed transfer syntax', () => {
        const stream = streamOf(DEFINED_ENCAPSULATED);
        const result = readElements(stream, { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(result.elements.get(tagFromString('x7fe00010'))?.kind).toBe('value');
    });

    it('keeps native-looking pixel data opaque even in a compressed transfer syntax', () => {
        // value does not start with an item tag
        const bytes = [0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04];
        const result = readElements(streamOf(bytes), { explicitVr: true, compressedTransferSyntax: true });
        expect(result.elements.get(tagFromString('x7fe00010'))?.kind).toBe('value');
    });

    it('falls back to an opaque value when the bounded scan fails', () => {
        // starts with an item tag whose fragment has undefined length
        const bytes = [
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0xfe, 0xff, 0x00, 0xe0,
            0xff, 0xff, 0xff, 0xff,
        ];
        const stream = streamOf(bytes);
        const result = readElements(stream, { explicitVr: true, compressedTransferSyntax: true });
        expect(result.error).toBeUndefined();
        expect(result.elements.get(tagFromString('x7fe00010'))?.kind).toBe('value');
        expect(stream.warnings.some(w => w.code === 'sequence-fallback')).toBe(true);
    });
});

describe('readElements — malformed-input containment (adversarial review #1-#7)', () => {
    const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const bytesOf = (arr: readonly number[]): number[] => [...arr];

    it('#1: a stray sequence delimiter inside an undefined-length item ends the item; siblings survive', () => {
        const el = bytesOf([0x08, 0x00, 0x18, 0x00, ...u32(2), 0x41, 0x20]); // (0008,0018) len 2
        const item = [0xfe, 0xff, 0x00, 0xe0, ...u32(0xffffffff), ...el]; // undefined item, no E00D
        const sq = [0x08, 0x00, 0x40, 0x11, ...u32(0xffffffff), ...item, 0xfe, 0xff, 0xdd, 0xe0, ...u32(0)];
        const sib = [0x10, 0x00, 0x10, 0x00, ...u32(4), 0x44, 0x4f, 0x45, 0x20];
        const result = readElements(streamOf([...sq, ...sib]), { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
        expect(result.elements.has(0xfffee0dd)).toBe(false);
        expect(result.elements.has(0xfffee00d)).toBe(false);
    });

    it('#4: an undefined-length non-sequence element is bounded by its item; it does not eat siblings', () => {
        const inner = [0x09, 0x00, 0x01, 0x00, ...u32(0xffffffff)]; // (0009,0001) undefined, no delimiter
        const item = [0xfe, 0xff, 0x00, 0xe0, ...u32(inner.length), ...inner];
        const sq = [0x08, 0x00, 0x40, 0x11, ...u32(item.length), ...item];
        const sib = [0x10, 0x00, 0x10, 0x00, ...u32(4), 0x44, 0x4f, 0x45, 0x20];
        const result = readElements(streamOf([...sq, ...sib]), { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
    });

    it('#5: an item length overrunning its sequence is clamped, not allowed to swallow siblings', () => {
        const el = bytesOf([0x08, 0x00, 0x18, 0x00, ...u32(2), 0x41, 0x20]);
        // item declares 24 but the SQ is only 16 long
        const item = [0xfe, 0xff, 0x00, 0xe0, ...u32(24), ...el];
        const sq = [0x08, 0x00, 0x40, 0x11, ...u32(16), ...item.slice(0, 16)];
        const sib = [0x10, 0x00, 0x10, 0x00, ...u32(4), 0x44, 0x4f, 0x45, 0x20];
        const result = readElements(streamOf([...sq, ...sib]), { explicitVr: false });
        expect(result.error).toBeUndefined();
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
    });

    it('#7: an item delimiter inside a defined-length item is consumed structurally, not surfaced as an element', () => {
        // defined-length item (16 bytes) containing an element then a stray E00D
        const el = bytesOf([0x08, 0x00, 0x18, 0x00, ...u32(2), 0x41, 0x20]);
        const item = [...el, 0xfe, 0xff, 0x0d, 0xe0, ...u32(0)]; // 10 + 8 = 18 -> declare 18
        const sq = [0x08, 0x00, 0x40, 0x11, ...u32(4 + 18), 0xfe, 0xff, 0x00, 0xe0, ...u32(18), ...item];
        const result = readElements(streamOf(sq), { explicitVr: false });
        const element = sq_(result.elements.get(tagFromString('x00081140')));
        expect(element.items[0]?.dataSet.element('x00080018')).toBeDefined();
        expect(element.items[0]?.dataSet.element('xfffee00d')).toBeUndefined();
    });

    it('D1: a defined-length item ending at its exact bound does not consume an ancestor item delimiter (conformant input)', () => {
        // NB: unlike its siblings in this block, this input is fully conformant —
        // it is the containment of a mis-termination, not of malformed bytes.
        // Conformant, mixed length encodings (explicit LE, so SQ is self-describing).
        // Nesting: outer SQ (undefined) → item A (undefined) whose last element is
        // a defined-length SQ B → defined-length item C ending exactly at B's bound
        // → A's FFFE,E00D → item D. The bytes right after C are A's item delimiter;
        // a defined-length item at its bound must NOT eat them (review D1).
        const cEl = explicitEl('00090010', 'SH', evenPad('C'));
        const sqB = sqExplicit('00110011', [cEl]); // defined SQ; item C fills it exactly
        const aEl = explicitEl('00080018', 'UI', evenPad('1.2', '\0'));
        const itemA = undefinedLengthItem(concat([aEl, sqB])); // SQ B is A's last element
        const dEl = explicitEl('00100010', 'PN', evenPad('DOE'));
        const itemD = item(concat([dEl]));
        const outer = sqExplicitUndefined('00081115', [itemA, itemD]);
        const result = readElements(new ByteStream(outer, { littleEndian: true }), { explicitVr: true });
        expect(result.error).toBeUndefined();
        const seq = sq_(result.elements.get(tagFromString('x00081115')));
        expect(seq.items).toHaveLength(2); // not 1 — item D is its own item, not swallowed into A
        const a = seq.items[0]?.dataSet;
        expect(a?.element('x00080018')).toBeDefined();
        expect(a?.element('x00110011')).toBeDefined();
        expect(a?.element('xfffee000')).toBeUndefined(); // item D's header not misattributed into A
        expect(seq.items[1]?.dataSet.element('x00100010')).toBeDefined(); // D's contents attributed to D
    });

    it('DCMTK-parity: an undefined-length sequence closed by an item delimiter (FFFE,E00D) recovers, not derails', () => {
        // A known scanner quirk: the sequence is closed with FFFE,E00D instead of
        // FFFE,E0DD. Rather than deriving into a malformed error and losing the rest
        // of the stream, the fork treats the stray item delimiter as the sequence
        // terminator (matches DCMTK's dcmReplaceWrongDelimitationItem) and reads on.
        const el = [0x08, 0x00, 0x18, 0x00, 0x55, 0x49, 2, 0, 0x31, 0x20]; // (0008,0018) UI len 2
        const item = [0xfe, 0xff, 0x00, 0xe0, ...u32(0xffffffff), ...el, 0xfe, 0xff, 0x0d, 0xe0, ...u32(0)]; // undef item + its E00D
        const sq = [0x08, 0x00, 0x40, 0x11, 0x53, 0x51, 0, 0, ...u32(0xffffffff), ...item, 0xfe, 0xff, 0x0d, 0xe0, ...u32(0)]; // SQ closed by E00D (wrong)
        const sib = [0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 4, 0, 0x44, 0x4f, 0x45, 0x20]; // (0010,0010) PN
        const stream = streamOf([...sq, ...sib]);
        const result = readElements(stream, { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(sq_(result.elements.get(tagFromString('x00081140'))).items).toHaveLength(1);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true); // the tail after the sequence survives
        expect(stream.warnings.some(w => w.code === 'missing-sequence-delimiter')).toBe(true);
    });

    it('DCMTK-parity: an unknown two-uppercase-letter VR is read with a 4-byte length; the tail survives', () => {
        // (0009,0010) VR "ZZ" (unknown, uppercase) in the 12-byte long form. Read as
        // short form, its length would come from the reserved bytes and derail the
        // rest of the stream. As a future VR (4-byte length), the value and the
        // following (0010,0010) are read correctly.
        const el = [0x09, 0x00, 0x10, 0x00, 0x5a, 0x5a, 0, 0, ...u32(4), 0xaa, 0xbb, 0xcc, 0xdd];
        const sib = [0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 4, 0, 0x44, 0x4f, 0x45, 0x20];
        const result = readElements(streamOf([...el, ...sib]), { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(result.elements.get(tagFromString('x00090010'))?.length).toBe(4);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
    });

    it('#2: a defined-length encapsulated basic offset table overrunning the value falls back to opaque', () => {
        const enc = [0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, ...u32(12), 0xfe, 0xff, 0x00, 0xe0, ...u32(40)];
        const result = readElements(streamOf(enc), { explicitVr: true, compressedTransferSyntax: true });
        const element = result.elements.get(tagFromString('x7fe00010'));
        expect(element?.kind).toBe('value');
        expect(result.error).toBeUndefined();
    });

    it('#6: defined-length encapsulated resumes exactly at the value end, with no phantom trailing element', () => {
        // value = empty BOT + E0DD + 8 padding bytes, declared length 24 (dataOffset 12 -> end 36)
        const enc = [
            0xe0,
            0x7f,
            0x10,
            0x00,
            0x4f,
            0x42,
            0x00,
            0x00,
            ...u32(24),
            0xfe,
            0xff,
            0x00,
            0xe0,
            ...u32(0),
            0xfe,
            0xff,
            0xdd,
            0xe0,
            ...u32(0),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        const sib = [0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 0x08, 0x00, 0x44, 0x4f, 0x45, 0x5e, 0x4a, 0x4f, 0x48, 0x4e];
        const result = readElements(streamOf([...enc, ...sib]), { explicitVr: true, compressedTransferSyntax: true });
        const element = result.elements.get(tagFromString('x7fe00010'));
        expect(element?.endOffset).toBe(36);
        expect(result.elements.has(0)).toBe(false);
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
    });

    it('§3: a fallback opaque value that trips maxElements surfaces limit-exceeded with partial results, not a throw', () => {
        // Element A is a normal value; element B is (0009,0010) implicit vrLookup→SQ,
        // defined length 8, content not an item tag → pushItem throws malformed →
        // recoverToFallback adds the opaque value, which crosses maxElements. That
        // add must not throw out of run()'s catch, and — even though it is the last
        // element read — the cap must still surface as a limit-exceeded error.
        const a = [0x08, 0x00, 0x18, 0x00, ...u32(2), 0x31, 0x20];
        const b = [0x09, 0x00, 0x10, 0x00, ...u32(8), 0x08, 0x00, 0x18, 0x00, ...u32(2)];
        const bytes = [...a, ...b];
        const vrLookup = (t: number): string | undefined => (t === 0x00090010 ? 'SQ' : undefined);
        expect(() => readElements(streamOf(bytes), { explicitVr: false, vrLookup, maxElements: 2 })).not.toThrow();
        const result = readElements(streamOf(bytes), { explicitVr: false, vrLookup, maxElements: 2 });
        expect(result.error?.code).toBe('limit-exceeded');
        expect(result.elements.has(tagFromString('x00080018'))).toBe(true); // partial result kept
        expect(result.elements.has(tagFromString('x00090010'))).toBe(false); // the element that tripped the cap is dropped
    });

    it('§3: undefined-length encapsulated pixel data nested in an item does not swallow a following root sibling', () => {
        // PixelData (7FE0,0010) OB undefined length, missing its FFFE,E0DD, inside a
        // defined-length item/SQ. Bounded by stream length it would read the root
        // sibling's bytes as fragments; bounded by the item it stops cleanly.
        const bot = [0xfe, 0xff, 0x00, 0xe0, ...u32(0)];
        const frag = [0xfe, 0xff, 0x00, 0xe0, ...u32(4), 0xaa, 0xbb, 0xcc, 0xdd];
        const pd = [0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, ...bot, ...frag]; // no E0DD
        const itemC = [0xfe, 0xff, 0x00, 0xe0, ...u32(pd.length), ...pd];
        const sqB = [0x09, 0x00, 0x10, 0x00, 0x53, 0x51, 0x00, 0x00, ...u32(itemC.length), ...itemC];
        const sib = [0x10, 0x00, 0x10, 0x00, 0x50, 0x4e, 0x04, 0x00, 0x44, 0x4f, 0x45, 0x20]; // (0010,0010) PN
        const result = readElements(streamOf([...sqB, ...sib]), { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(result.elements.has(tagFromString('x00100010'))).toBe(true);
    });
});

function sq_(element: unknown): SequenceElement {
    expect((element as SequenceElement).kind).toBe('sequence');
    return element as SequenceElement;
}

describe('readElements — implicit undefined-length with a VR lookup (review B4)', () => {
    // dispatchImplicit's `header.vr !== undefined && header.hadUndefinedLength`
    // branch: the lookup resolves a non-sequence VR, so peeking is skipped and
    // scanUnknown runs. Existing vrLookup tests all use defined lengths and
    // never reach it.
    const OB_LOOKUP = (tag: number): string | undefined => (tag === 0x00080006 ? 'OB' : undefined);

    it('scans an undefined-length OB (via lookup) to its item delimiter as an unknown element', () => {
        // (0008,0006) undefined length · 4 content bytes · item delimiter (FFFE,E00D)
        const stream = streamOf([0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0x41, 0x42, 0x43, 0x44, 0xfe, 0xff, 0x0d, 0xe0, 0x00, 0x00, 0x00, 0x00]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OB_LOOKUP });
        expect(result.error).toBeUndefined();
        expect(stream.warnings).toHaveLength(0);
        const element = result.elements.get(tagFromString('x00080006')) as UnknownElement;
        expect(element.kind).toBe('unknown');
        expect(element.vr).toBe('OB');
        expect(element.length).toBe(4);
        expect(element.hadUndefinedLength).toBe(true);
    });

    it('bounds the scan at end of data and warns when the delimiter is missing', () => {
        // same header + 4 content bytes and NO delimiter
        const stream = streamOf([0x08, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff, 0x41, 0x42, 0x43, 0x44]);
        const result = readElements(stream, { explicitVr: false, vrLookup: OB_LOOKUP });
        expect(result.error).toBeUndefined();
        const element = result.elements.get(tagFromString('x00080006')) as UnknownElement;
        expect(element.kind).toBe('unknown');
        expect(element.vr).toBe('OB');
        expect(element.length).toBe(4);
        expect(stream.warnings.some(w => w.code === 'missing-item-delimiter')).toBe(true);
    });
});

describe('readElements — diagnostic warnings (adversarial review W2/W3/W5)', () => {
    it('warns on a duplicate tag at the same level (keeping the last value)', () => {
        // (0008,0018) UI 'A ', then (0008,0018) again 'B '
        const bytes = [0x08, 0x00, 0x18, 0x00, 0x55, 0x49, 0x02, 0x00, 0x41, 0x20, 0x08, 0x00, 0x18, 0x00, 0x55, 0x49, 0x02, 0x00, 0x42, 0x20];
        const stream = streamOf(bytes);
        const result = readElements(stream, { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(result.elements.size).toBe(1);
        expect(stream.warnings.some(w => w.code === 'duplicate-tag')).toBe(true);
    });

    it('warns on an odd defined-length value', () => {
        // (0008,0018) SH length 3 'ABC'
        const bytes = [0x08, 0x00, 0x18, 0x00, 0x53, 0x48, 0x03, 0x00, 0x41, 0x42, 0x43];
        const stream = streamOf(bytes);
        readElements(stream, { explicitVr: true });
        expect(stream.warnings.some(w => w.code === 'odd-length')).toBe(true);
    });

    it('warns when a basic offset table length is not a multiple of 4', () => {
        // encapsulated OB, BOT item length 6 (not a multiple of 4)
        const enc = [
            0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0x00, 0xe0, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0xfe, 0xff, 0xdd, 0xe0, 0x00, 0x00, 0x00, 0x00,
        ];
        const stream = streamOf(enc);
        const result = readElements(stream, { explicitVr: true });
        expect(result.error).toBeUndefined();
        expect(stream.warnings.some(w => w.message.includes('not a multiple of 4'))).toBe(true);
    });
});
