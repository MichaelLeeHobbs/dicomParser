/**
 * Value Representation (VR) knowledge.
 *
 * Includes the post-2019 64-bit VRs SV, UV and OV (PS3.5 2019a §6.2) in the
 * explicit long-form set — their omission upstream mis-read the length field and
 * derailed the whole parse (upstream #280/#281).
 *
 * @module vr
 */

/** The VRs defined by PS3.5 §6.2 (2019a and later). */
export const KNOWN_VRS = [
    'AE',
    'AS',
    'AT',
    'CS',
    'DA',
    'DS',
    'DT',
    'FD',
    'FL',
    'IS',
    'LO',
    'LT',
    'OB',
    'OD',
    'OF',
    'OL',
    'OV',
    'OW',
    'PN',
    'SH',
    'SL',
    'SQ',
    'SS',
    'ST',
    'SV',
    'TM',
    'UC',
    'UI',
    'UL',
    'UN',
    'UR',
    'US',
    'UT',
    'UV',
] as const;

/** A known two-character Value Representation. */
export type Vr = (typeof KNOWN_VRS)[number];

const KNOWN_VR_SET: ReadonlySet<string> = new Set(KNOWN_VRS);

/** Tests whether a two-character code is a known VR. */
export function isKnownVr(value: string): value is Vr {
    return KNOWN_VR_SET.has(value);
}

/**
 * VRs encoded with the 12-byte explicit form (2 reserved bytes + 32-bit length).
 * All other VRs use the 8-byte form with a 16-bit length.
 */
const LONG_FORM_VRS: ReadonlySet<string> = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

/** Whether `vr` is exactly two uppercase ASCII letters (a possible future VR). */
function isTwoUpperLetters(vr: string): boolean {
    if (vr.length !== 2) {
        return false;
    }
    const c1 = vr.charCodeAt(0);
    const c2 = vr.charCodeAt(1);
    return c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90;
}

/**
 * Returns the size in bytes of the explicit-VR length field.
 *
 * An unrecognized VR that is two uppercase letters is treated as a *future* VR
 * and read with the 4-byte extended-length form: the DICOM committee reserved all
 * future VRs to that form, so reading such a code as short-form would mis-read the
 * length field and derail the rest of the stream. Other unrecognized codes keep
 * the 2-byte form. This matches DCMTK (`DcmVR::setVR` → `EVR_UNKNOWN` for
 * `[A-Z][A-Z]`, `EVR_UNKNOWN2B` otherwise).
 *
 * @param vr - The two-character VR code
 * @returns `4` for long-form VRs (12-byte header), `2` otherwise (8-byte header)
 */
export function explicitLengthBytes(vr: string): 2 | 4 {
    if (LONG_FORM_VRS.has(vr)) {
        return 4;
    }
    return !isKnownVr(vr) && isTwoUpperLetters(vr) ? 4 : 2;
}

/**
 * Whether a VR holds character data.
 *
 * `true` for string VRs, `false` for binary VRs, `undefined` for UN (unknowable).
 */
const STRING_VRS: Readonly<Record<string, boolean | undefined>> = {
    AE: true,
    AS: true,
    AT: false,
    CS: true,
    DA: true,
    DS: true,
    DT: true,
    FD: false,
    FL: false,
    IS: true,
    LO: true,
    LT: true,
    OB: false,
    OD: false,
    OF: false,
    OL: false,
    OV: false,
    OW: false,
    PN: true,
    SH: true,
    SL: false,
    SQ: false,
    SS: false,
    ST: true,
    SV: false,
    TM: true,
    UC: true,
    UI: true,
    UL: false,
    UN: undefined,
    UR: true,
    US: false,
    UT: true,
    UV: false,
};

/**
 * Tests whether a VR holds character data.
 *
 * @param vr - The two-character VR code
 * @returns `true` for string VRs, `false` for binary VRs, `undefined` for UN or
 *          unrecognized codes
 */
export function isStringVr(vr: string): boolean | undefined {
    return STRING_VRS[vr];
}

/** The text VRs that SpecificCharacterSet (0008,0005) extends (PS3.5 §6.1.2). */
const CHARSET_AFFECTED_VRS: ReadonlySet<string> = new Set(['SH', 'LO', 'ST', 'LT', 'UC', 'UT', 'PN']);

/**
 * Tests whether a VR's text is subject to SpecificCharacterSet decoding — the
 * VRs eligible for UTF-8 mislabel detection.
 *
 * @param vr - The two-character VR code (may be undefined for implicit VR)
 * @returns `true` for SH/LO/ST/LT/UC/UT/PN, `false` otherwise
 */
export function isCharsetAffectedVr(vr: string | undefined): boolean {
    return vr !== undefined && CHARSET_AFFECTED_VRS.has(vr);
}
