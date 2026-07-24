import { describe, expect, it } from 'vitest';
import { DicomError, isDicomError } from './errors';

describe('isDicomError', () => {
    it('recognizes DicomError instances and rejects everything else', () => {
        expect(isDicomError(new DicomError('malformed', 'boom'))).toBe(true);
        expect(isDicomError(new Error('boom'))).toBe(false);
        expect(isDicomError(null)).toBe(false);
        expect(isDicomError(undefined)).toBe(false);
        expect(isDicomError('malformed')).toBe(false);
        expect(isDicomError({ code: 'malformed', name: 'DicomError' })).toBe(false);
        // a bare branded plain object is not Error-like, so it is rejected
        expect(isDicomError({ [Symbol.for('@ubercode/dicom-parser/DicomError')]: true })).toBe(false);
    });

    it('recognizes a cross-build DicomError (Error-like + shared brand)', () => {
        // A DicomError from the other (ESM/CJS) build fails `instanceof DicomError`
        // but is a real Error carrying the registry-shared brand symbol.
        const brand = Symbol.for('@ubercode/dicom-parser/DicomError');
        const fromOtherBuild = new Error('boom');
        (fromOtherBuild as unknown as Record<symbol, unknown>)[brand] = true;
        expect(isDicomError(fromOtherBuild)).toBe(true);
    });
});
