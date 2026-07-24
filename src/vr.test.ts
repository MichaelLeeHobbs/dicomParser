import { describe, expect, it } from 'vitest';
import { KNOWN_VRS, explicitLengthBytes, isKnownVr, isStringVr } from './vr';

describe('explicitLengthBytes', () => {
    // Ported from legacy readDicomElementExplicit_test long-form coverage,
    // extended with the post-2019 VRs (SV/UV/OV) whose omission caused
    // upstream #281's parse derailment.
    const longForm = ['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'] as const;

    it.each(longForm)('uses the 12-byte header form for %s', vr => {
        expect(explicitLengthBytes(vr)).toBe(4);
    });

    const shortForm = ['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FD', 'FL', 'IS', 'LO', 'LT', 'PN', 'SH', 'SL', 'SS', 'ST', 'TM', 'UI', 'UL', 'US'] as const;

    it.each(shortForm)('uses the 8-byte header form for %s', vr => {
        expect(explicitLengthBytes(vr)).toBe(2);
    });

    it('treats an unknown two-uppercase-letter VR as a future long-form VR (DCMTK parity)', () => {
        // The DICOM committee reserved all future VRs to the extended-length form,
        // so an unknown [A-Z][A-Z] code reads a 4-byte length (matches DCMTK).
        expect(explicitLengthBytes('ZZ')).toBe(4);
        expect(explicitLengthBytes('QQ')).toBe(4);
    });

    it('treats other unrecognized VR codes as short form', () => {
        expect(explicitLengthBytes('??')).toBe(2); // DCMTK EVR_UNKNOWN2B workaround
        expect(explicitLengthBytes('zz')).toBe(2); // lowercase
        expect(explicitLengthBytes('A1')).toBe(2); // mixed
        expect(explicitLengthBytes('')).toBe(2);
    });
});

describe('isKnownVr', () => {
    it('accepts every known VR', () => {
        for (const vr of KNOWN_VRS) {
            expect(isKnownVr(vr)).toBe(true);
        }
    });

    it('rejects unknown codes', () => {
        expect(isKnownVr('ZZ')).toBe(false);
        expect(isKnownVr('')).toBe(false);
        expect(isKnownVr('ob')).toBe(false);
    });
});

describe('isStringVr', () => {
    it('classifies string VRs', () => {
        for (const vr of ['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']) {
            expect(isStringVr(vr)).toBe(true);
        }
    });

    it('classifies binary VRs', () => {
        for (const vr of ['AT', 'FD', 'FL', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SL', 'SQ', 'SS', 'SV', 'UL', 'US', 'UV']) {
            expect(isStringVr(vr)).toBe(false);
        }
    });

    it('returns undefined for UN and unrecognized codes', () => {
        expect(isStringVr('UN')).toBeUndefined();
        expect(isStringVr('ZZ')).toBeUndefined();
    });
});
