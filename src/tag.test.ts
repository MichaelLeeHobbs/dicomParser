import { describe, expect, it } from 'vitest';
import { DicomError } from './errors';
import {
    TAG_ITEM,
    TAG_ITEM_DELIMITATION,
    TAG_PIXEL_DATA,
    TAG_SEQUENCE_DELIMITATION,
    TAG_TRANSFER_SYNTAX_UID,
    UNDEFINED_LENGTH,
    isPrivateTag,
    tag,
    tagElement,
    tagFromString,
    tagGroup,
    tagToString,
    toTag,
} from './tag';

describe('tag', () => {
    it('builds a numeric tag from group and element', () => {
        expect(tag(0x0010, 0x0010)).toBe(0x00100010);
        expect(tag(0x7fe0, 0x0010)).toBe(TAG_PIXEL_DATA);
        expect(tag(0xfffe, 0xe000)).toBe(TAG_ITEM);
    });

    it('stays unsigned for high groups', () => {
        expect(tag(0xfffe, 0xe0dd)).toBe(TAG_SEQUENCE_DELIMITATION);
        expect(tag(0xfffe, 0xe0dd)).toBeGreaterThan(0);
        expect(tag(0xffff, 0xffff)).toBe(0xffffffff);
    });

    it('rejects out-of-range parts', () => {
        expect(() => tag(-1, 0)).toThrow(DicomError);
        expect(() => tag(0, 0x10000)).toThrow(DicomError);
        expect(() => tag(0.5, 0)).toThrow(DicomError);
    });

    it('orders tags in file order with plain comparison', () => {
        expect(tag(0x0008, 0x0018)).toBeLessThan(tag(0x0010, 0x0010));
        expect(tag(0x0010, 0x0010)).toBeLessThan(TAG_PIXEL_DATA);
        expect(TAG_ITEM).toBeLessThan(TAG_ITEM_DELIMITATION);
        expect(TAG_ITEM_DELIMITATION).toBeLessThan(TAG_SEQUENCE_DELIMITATION);
    });
});

describe('tagFromString / toTag', () => {
    it('parses the legacy xggggeeee form', () => {
        expect(tagFromString('x00100010')).toBe(0x00100010);
        expect(tagFromString('x7fe00010')).toBe(TAG_PIXEL_DATA);
    });

    it('parses bare hex in either case', () => {
        expect(tagFromString('00020010')).toBe(TAG_TRANSFER_SYNTAX_UID);
        expect(tagFromString('FFFEE000')).toBe(TAG_ITEM);
    });

    it('rejects malformed strings', () => {
        expect(() => tagFromString('')).toThrow(DicomError);
        expect(() => tagFromString('x0010001')).toThrow(DicomError);
        expect(() => tagFromString('x001000100')).toThrow(DicomError);
        expect(() => tagFromString('x0010001g')).toThrow(DicomError);
        expect(() => tagFromString('(0010,0010)')).toThrow(DicomError);
    });

    it('toTag accepts numbers and strings', () => {
        expect(toTag(0x00100010)).toBe(0x00100010);
        expect(toTag('x00100010')).toBe(0x00100010);
    });

    it('toTag rejects out-of-range numbers', () => {
        expect(() => toTag(-1)).toThrow(DicomError);
        expect(() => toTag(0x100000000)).toThrow(DicomError);
        expect(() => toTag(1.5)).toThrow(DicomError);
    });
});

describe('tagToString', () => {
    it('formats in the legacy lowercase form', () => {
        expect(tagToString(0x00100010)).toBe('x00100010');
        expect(tagToString(TAG_PIXEL_DATA)).toBe('x7fe00010');
        expect(tagToString(TAG_ITEM)).toBe('xfffee000');
        expect(tagToString(0)).toBe('x00000000');
    });

    it('round-trips with tagFromString', () => {
        for (const value of [0, 0x00100010, TAG_PIXEL_DATA, 0xffffffff]) {
            expect(tagFromString(tagToString(value))).toBe(value);
        }
    });
});

describe('tagGroup / tagElement', () => {
    it('extracts group and element', () => {
        expect(tagGroup(0x00100010)).toBe(0x0010);
        expect(tagElement(0x00100010)).toBe(0x0010);
        expect(tagGroup(TAG_ITEM)).toBe(0xfffe);
        expect(tagElement(TAG_ITEM)).toBe(0xe000);
    });
});

describe('isPrivateTag', () => {
    it('identifies odd groups as private', () => {
        expect(isPrivateTag(tag(0x0009, 0x0010))).toBe(true);
        expect(isPrivateTag(tag(0x3009, 0x1201))).toBe(true);
        expect(isPrivateTag(tag(0x0010, 0x0010))).toBe(false);
        expect(isPrivateTag(TAG_PIXEL_DATA)).toBe(false);
    });
});

describe('constants', () => {
    it('match the DICOM-defined values', () => {
        expect(TAG_ITEM).toBe(0xfffee000);
        expect(TAG_ITEM_DELIMITATION).toBe(0xfffee00d);
        expect(TAG_SEQUENCE_DELIMITATION).toBe(0xfffee0dd);
        expect(TAG_PIXEL_DATA).toBe(0x7fe00010);
        expect(TAG_TRANSFER_SYNTAX_UID).toBe(0x00020010);
        expect(UNDEFINED_LENGTH).toBe(0xffffffff);
    });
});
