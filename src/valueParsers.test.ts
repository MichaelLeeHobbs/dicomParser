import { describe, expect, it } from 'vitest';
import { DicomError } from './errors';
import { isValidUid, parseDA, parsePN, parseTM } from './valueParsers';

// Ported from legacy util_test.js (parseDA, parseTM, parsePN sections).

describe('parseDA', () => {
    it('parses a valid DA', () => {
        expect(parseDA('20140329')).toEqual({ year: 2014, month: 3, day: 29 });
    });

    it('returns undefined for the wrong length or missing input', () => {
        expect(parseDA('2014032')).toBeUndefined();
        expect(parseDA('201403299')).toBeUndefined();
        expect(parseDA(undefined)).toBeUndefined();
    });

    it('throws a typed error for invalid dates when validating', () => {
        expect(() => parseDA('20149999', true)).toThrow(DicomError);
        expect(() => parseDA('20140230', true)).toThrow(DicomError);
        expect(() => parseDA('abcd0101', true)).toThrow(DicomError);
        expect(() => parseDA('2014032', true)).toThrow(DicomError);
        expect(() => parseDA(undefined, true)).toThrow(DicomError);
    });

    it('accepts leap-day dates', () => {
        expect(parseDA('20160229', true)).toEqual({ year: 2016, month: 2, day: 29 });
        expect(parseDA('20000229', true)).toEqual({ year: 2000, month: 2, day: 29 });
        expect(() => parseDA('21000229', true)).toThrow(DicomError);
        expect(() => parseDA('20150229', true)).toThrow(DicomError);
    });

    it('validates month lengths', () => {
        expect(parseDA('20140430', true)).toEqual({ year: 2014, month: 4, day: 30 });
        expect(() => parseDA('20140431', true)).toThrow(DicomError);
        expect(parseDA('20140131', true)).toEqual({ year: 2014, month: 1, day: 31 });
    });
});

describe('parseTM', () => {
    it('parses a full TM', () => {
        expect(parseTM('081236.531000')).toEqual({ hours: 8, minutes: 12, seconds: 36, fractionalSeconds: 531000 });
    });

    it('parses a partial TM', () => {
        expect(parseTM('08')).toEqual({ hours: 8, minutes: undefined, seconds: undefined, fractionalSeconds: undefined });
        expect(parseTM('0812')?.minutes).toBe(12);
    });

    it('normalizes short fractional parts to microseconds', () => {
        expect(parseTM('081236.5')?.fractionalSeconds).toBe(500000);
        expect(parseTM('081236.00500')?.fractionalSeconds).toBe(5000);
    });

    it('returns undefined for too-short or missing input', () => {
        expect(parseTM('0')).toBeUndefined();
        expect(parseTM(undefined)).toBeUndefined();
    });

    it('throws a typed error for invalid times when validating', () => {
        expect(() => parseTM('241236.531000', true)).toThrow(DicomError);
        expect(() => parseTM('236036.531000', true)).toThrow(DicomError);
        expect(() => parseTM('232260.531000', true)).toThrow(DicomError);
        expect(() => parseTM('232259.AA', true)).toThrow(DicomError);
        expect(() => parseTM('0', true)).toThrow(DicomError);
        expect(() => parseTM('xx', true)).toThrow(DicomError);
    });

    it('rejects digit-prefixed garbage when validating (review C3)', () => {
        expect(() => parseDA('2023011!', true)).toThrow(DicomError);
        expect(() => parseDA('2023 101', true)).toThrow(DicomError);
        expect(() => parseTM('1x', true)).toThrow(DicomError);
        expect(() => parseTM('120000.5x', true)).toThrow(DicomError);
        expect(() => parseTM('12345678', true)).toThrow(DicomError);
    });

    it('accepts valid times when validating', () => {
        expect(parseTM('235959.999999', true)).toEqual({ hours: 23, minutes: 59, seconds: 59, fractionalSeconds: 999999 });
    });
});

describe('parsePN', () => {
    it('parses a full PN', () => {
        expect(parsePN('F^G^M^P^S')).toEqual({
            familyName: 'F',
            givenName: 'G',
            middleName: 'M',
            prefix: 'P',
            suffix: 'S',
        });
    });

    it('parses a partial PN with undefined components', () => {
        const parsed = parsePN('F');
        expect(parsed?.familyName).toBe('F');
        expect(parsed?.givenName).toBeUndefined();
        expect(parsed?.middleName).toBeUndefined();
        expect(parsed?.prefix).toBeUndefined();
        expect(parsed?.suffix).toBeUndefined();
    });

    it('returns undefined for missing input', () => {
        expect(parsePN(undefined)).toBeUndefined();
    });
});

describe('isValidUid (W7)', () => {
    it('accepts well-formed UIDs', () => {
        expect(isValidUid('1.2.840.10008.1.2.1')).toBe(true);
        expect(isValidUid('0')).toBe(true);
        expect(isValidUid('1.0.2')).toBe(true);
        expect(isValidUid('2.25.331717632425659486778196813677143528292')).toBe(true);
        expect(isValidUid('1'.repeat(64))).toBe(true); // exactly 64 chars
    });

    it('rejects malformed UIDs, path-traversal and over-length values', () => {
        expect(isValidUid('')).toBe(false);
        expect(isValidUid('1'.repeat(65))).toBe(false); // over 64
        expect(isValidUid('1..2')).toBe(false); // empty component
        expect(isValidUid('.1.2')).toBe(false); // leading dot
        expect(isValidUid('1.2.')).toBe(false); // trailing dot
        expect(isValidUid('01.2')).toBe(false); // leading zero
        expect(isValidUid('1.2.a')).toBe(false); // non-digit
        expect(isValidUid('../etc/passwd')).toBe(false); // path traversal
        expect(isValidUid('1.2 ')).toBe(false); // unstripped padding
    });
});
