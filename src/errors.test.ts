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
    });

    it('recognizes a cross-realm DicomError via the shared Symbol.for brand', () => {
        // A DicomError constructed in the other (ESM/CJS) build would fail
        // `instanceof`, but carries the same registry-shared brand symbol.
        const fromOtherBuild = { [Symbol.for('@ubercode/dicom-parser/DicomError')]: true };
        expect(isDicomError(fromOtherBuild)).toBe(true);
    });
});
