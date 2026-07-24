/**
 * DICOM character set decoding (upstream #146).
 *
 * Maps SpecificCharacterSet (0008,0005) defined terms to decoders and decodes
 * raw element bytes into JS strings, including ISO 2022 code extensions
 * (escape-sequence switching) for the common CJK cases: Japanese
 * (ISO 2022 IR 13/87), Korean (ISO 2022 IR 149) and Chinese (ISO 2022 IR 58).
 *
 * Values are decoded to full strings first; multi-value and person-name
 * splitting happens on the decoded string, which avoids delimiter-byte
 * collisions inside multi-byte encodings (e.g. 0x5C as a trailing byte in
 * GBK/Shift_JIS/JIS X 0208 sequences).
 *
 * Ported from `@ubercode/dcmtk` `_charset.ts` (the proven implementation named
 * in docs/porting-notes.md), adapted to this repo's typed-error model and
 * platform-neutral build (no `Buffer`).
 *
 * @module charset
 */

import { DicomError } from './errors';

/** How to decode a run of bytes. */
type SegmentDecoder =
    /** ISO-8859-1: every byte maps to U+00xx. Also used for ASCII. */
    | { readonly kind: 'latin1' }
    /** A WHATWG TextDecoder label (e.g. 'iso-8859-5', 'utf-8', 'euc-kr'). */
    | { readonly kind: 'label'; readonly label: string }
    /** JIS X 0208 two-byte GL codes: re-wrapped with its ISO 2022 escape and decoded as iso-2022-jp. */
    | { readonly kind: 'iso2022jp'; readonly escape: readonly number[] }
    /** JIS X 0212 two-byte GL codes: framed as euc-jp SS3 (0x8F + GR pair) — WHATWG iso-2022-jp does not support it. */
    | { readonly kind: 'jis0212' }
    /** JIS X 0201 katakana (GR single-byte, 0xA1-0xDF): decoded as shift_jis. */
    | { readonly kind: 'katakana' };

const LATIN1: SegmentDecoder = { kind: 'latin1' };

function label(name: string): SegmentDecoder {
    return { kind: 'label', label: name };
}

/**
 * Single-byte and non-extension charsets: DICOM defined term → decoder.
 * WHATWG maps some ISO labels to their Windows supersets (e.g. iso-8859-9 →
 * windows-1254); the differences are confined to the C1 control range
 * 0x80-0x9F, which DICOM text does not use.
 */
const CHARSET_DECODERS: Readonly<Record<string, SegmentDecoder>> = {
    'ISO_IR 6': LATIN1,
    'ISO_IR 100': LATIN1,
    'ISO_IR 101': label('iso-8859-2'),
    'ISO_IR 109': label('iso-8859-3'),
    'ISO_IR 110': label('iso-8859-4'),
    'ISO_IR 144': label('iso-8859-5'),
    'ISO_IR 127': label('iso-8859-6'),
    'ISO_IR 126': label('iso-8859-7'),
    'ISO_IR 138': label('iso-8859-8'),
    'ISO_IR 148': label('iso-8859-9'),
    'ISO_IR 203': label('iso-8859-15'),
    'ISO_IR 13': label('shift_jis'),
    'ISO_IR 166': label('windows-874'),
    'ISO_IR 192': label('utf-8'),
    GB18030: label('gb18030'),
    GBK: label('gbk'),
};

/**
 * Initial decoder for ISO 2022 charsets (before any escape sequence).
 * Terms designating multi-byte G0 sets (IR 87/159) start in ASCII — the
 * multi-byte set is only active after its escape sequence.
 */
const ISO2022_INITIAL: Readonly<Record<string, SegmentDecoder>> = {
    'ISO 2022 IR 6': LATIN1,
    'ISO 2022 IR 13': label('shift_jis'),
    'ISO 2022 IR 87': LATIN1,
    'ISO 2022 IR 159': LATIN1,
    'ISO 2022 IR 149': label('euc-kr'),
    'ISO 2022 IR 58': label('gbk'),
    'ISO 2022 IR 100': LATIN1,
    'ISO 2022 IR 101': label('iso-8859-2'),
    'ISO 2022 IR 109': label('iso-8859-3'),
    'ISO 2022 IR 110': label('iso-8859-4'),
    'ISO 2022 IR 144': label('iso-8859-5'),
    'ISO 2022 IR 127': label('iso-8859-6'),
    'ISO 2022 IR 126': label('iso-8859-7'),
    'ISO 2022 IR 138': label('iso-8859-8'),
    'ISO 2022 IR 148': label('iso-8859-9'),
    'ISO 2022 IR 166': label('windows-874'),
    'ISO 2022 IR 203': label('iso-8859-15'),
};

/** Which code element (invoked by GL or GR bytes) an escape designates. */
type Register = 'g0' | 'g1';

/** An ISO 2022 designation: the target register and the decoder for it. */
interface Designation {
    readonly register: Register;
    readonly decoder: SegmentDecoder;
}

/**
 * ISO 2022 escape sequences (bytes after ESC, as a string key) → the register
 * they designate and its decoder. Per DICOM PS3.5 Table 6.3-1. G0 is invoked
 * by GL bytes (0x21-0x7E), G1 by GR bytes (0xA0-0xFF).
 */
const ESCAPE_DECODERS: Readonly<Record<string, Designation>> = {
    '(B': { register: 'g0', decoder: LATIN1 }, // G0 = ASCII
    '(J': { register: 'g0', decoder: LATIN1 }, // G0 = JIS X 0201 romaji
    ')I': { register: 'g1', decoder: { kind: 'katakana' } }, // G1 = JIS X 0201 katakana
    '$@': { register: 'g0', decoder: { kind: 'iso2022jp', escape: [0x1b, 0x24, 0x40] } }, // G0 = JIS X 0208-1978
    $B: { register: 'g0', decoder: { kind: 'iso2022jp', escape: [0x1b, 0x24, 0x42] } }, // G0 = JIS X 0208
    '$(D': { register: 'g0', decoder: { kind: 'jis0212' } }, // G0 = JIS X 0212
    '$)C': { register: 'g1', decoder: label('euc-kr') }, // G1 = KS X 1001
    '$)A': { register: 'g1', decoder: label('gbk') }, // G1 = GB 2312
    '-A': { register: 'g1', decoder: LATIN1 }, // G1 = ISO-8859-1
    '-B': { register: 'g1', decoder: label('iso-8859-2') },
    '-C': { register: 'g1', decoder: label('iso-8859-3') },
    '-D': { register: 'g1', decoder: label('iso-8859-4') },
    '-F': { register: 'g1', decoder: label('iso-8859-7') },
    '-G': { register: 'g1', decoder: label('iso-8859-6') },
    '-H': { register: 'g1', decoder: label('iso-8859-8') },
    '-L': { register: 'g1', decoder: label('iso-8859-5') },
    '-M': { register: 'g1', decoder: label('iso-8859-9') },
    '-T': { register: 'g1', decoder: label('windows-874') },
    '-b': { register: 'g1', decoder: label('iso-8859-15') },
};

/**
 * Initial G0/G1 decoders for an ISO 2022 term (before any escape). Most terms
 * start with G0 = ASCII and designate G1 via an escape in the data; the
 * exceptions carry an active G1 (or a non-ASCII G0) from the start.
 */
const ISO2022_REGISTERS: Readonly<Record<string, { readonly g0: SegmentDecoder; readonly g1: SegmentDecoder | undefined }>> = {
    'ISO 2022 IR 13': { g0: LATIN1, g1: { kind: 'katakana' } }, // JIS X 0201: G0 romaji, G1 katakana (active from the start)
    'ISO 2022 IR 149': { g0: LATIN1, g1: label('euc-kr') },
    'ISO 2022 IR 58': { g0: LATIN1, g1: label('gbk') },
};

/** Aliases accepted for assume/fallback options (lowercased) → DICOM defined term. */
const CHARSET_ALIASES: Readonly<Record<string, string>> = {
    ascii: 'ISO_IR 6',
    'latin-1': 'ISO_IR 100',
    latin1: 'ISO_IR 100',
    'iso-8859-1': 'ISO_IR 100',
    'latin-2': 'ISO_IR 101',
    'latin-3': 'ISO_IR 109',
    'latin-4': 'ISO_IR 110',
    'latin-5': 'ISO_IR 148',
    'latin-9': 'ISO_IR 203',
    cyrillic: 'ISO_IR 144',
    arabic: 'ISO_IR 127',
    greek: 'ISO_IR 126',
    hebrew: 'ISO_IR 138',
    thai: 'ISO_IR 166',
    'shift-jis': 'ISO_IR 13',
    shift_jis: 'ISO_IR 13',
    'utf-8': 'ISO_IR 192',
    utf8: 'ISO_IR 192',
    gb18030: 'GB18030',
    gbk: 'GBK',
};

/**
 * WHATWG labels that decode one byte per character. UTF-8 mislabel detection
 * only applies under these (plus latin1/ASCII): a multi-byte charset can
 * legitimately contain byte runs that also form valid UTF-8.
 */
const SINGLE_BYTE_LABELS: ReadonlySet<string> = new Set([
    'iso-8859-2',
    'iso-8859-3',
    'iso-8859-4',
    'iso-8859-5',
    'iso-8859-6',
    'iso-8859-7',
    'iso-8859-8',
    'iso-8859-9',
    'iso-8859-15',
    'windows-874',
]);

function isSingleByteDecoder(decoder: SegmentDecoder): boolean {
    return decoder.kind === 'latin1' || (decoder.kind === 'label' && SINGLE_BYTE_LABELS.has(decoder.label));
}

/** Cache of TextDecoder instances by label (undefined = construction failed). */
const decoderCache = new Map<string, TextDecoder | undefined>();

function getTextDecoder(labelName: string): TextDecoder | undefined {
    if (decoderCache.has(labelName)) {
        return decoderCache.get(labelName);
    }
    let decoder: TextDecoder | undefined;
    try {
        decoder = new TextDecoder(labelName);
    } catch {
        decoder = undefined;
    }
    decoderCache.set(labelName, decoder);
    return decoder;
}

/** Decodes bytes as ISO-8859-1 (every byte → U+00xx). */
export function decodeLatin1(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        result += String.fromCharCode(bytes[i] as number);
    }
    return result;
}

/** Decodes via a cached TextDecoder for `label`, falling back to Latin-1. */
function decodeVia(label: string, bytes: Uint8Array): string {
    const textDecoder = getTextDecoder(label);
    /* v8 ignore next -- charset labels are validated by resolveCharsetContext / always available with ICU */
    return textDecoder === undefined ? decodeLatin1(bytes) : textDecoder.decode(bytes);
}

/** Decodes a JIS X 0208 GL run by re-wrapping it in its ISO 2022 escape and decoding as iso-2022-jp. */
function decodeIso2022Jp(escape: readonly number[], bytes: Uint8Array): string {
    const wrapped = new Uint8Array(escape.length + bytes.length);
    wrapped.set(escape, 0);
    wrapped.set(bytes, escape.length);
    return decodeVia('iso-2022-jp', wrapped);
}

/** Decodes a JIS X 0212 GL run by framing each GL pair as euc-jp SS3 (WHATWG iso-2022-jp lacks 0212). */
function decodeJisX0212(bytes: Uint8Array): string {
    const framed: number[] = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        framed.push(0x8f, (bytes[i] as number) | 0x80, (bytes[i + 1] as number) | 0x80);
    }
    return decodeVia('euc-jp', Uint8Array.from(framed));
}

/** Decodes a single run of bytes with the given segment decoder. */
function decodeSegment(bytes: Uint8Array, decoder: SegmentDecoder): string {
    if (bytes.length === 0) {
        return '';
    }
    switch (decoder.kind) {
        case 'latin1':
            return decodeLatin1(bytes);
        case 'label':
            return decodeVia(decoder.label, bytes);
        case 'iso2022jp':
            return decodeIso2022Jp(decoder.escape, bytes);
        case 'jis0212':
            return decodeJisX0212(bytes);
        case 'katakana':
            return decodeVia('shift_jis', bytes);
    }
}

interface EscapeMatch {
    readonly key: string;
    readonly length: number;
}

/**
 * Reads an ISO 2022 escape sequence starting at `start` (which must point at
 * an ESC byte). Intermediate bytes are 0x20-0x2F, the final byte 0x30-0x7E.
 */
function readEscape(bytes: Uint8Array, start: number): EscapeMatch {
    let i = start + 1;
    while (i < bytes.length && (bytes[i] as number) >= 0x20 && (bytes[i] as number) <= 0x2f) {
        i++;
    }
    if (i < bytes.length && (bytes[i] as number) >= 0x30 && (bytes[i] as number) <= 0x7e) {
        i++;
    }
    return { key: decodeLatin1(bytes.subarray(start + 1, i)), length: i - start };
}

/**
 * Decodes an inter-escape run, routing GL bytes (0x00-0x7F) through the G0
 * decoder and GR bytes (0x80-0xFF) through G1. This separation is what lets a
 * G0 escape (e.g. ESC ( J) leave an active G1 designation (e.g. katakana)
 * intact for the GR bytes in the same run.
 */
function decodeMixed(bytes: Uint8Array, g0: SegmentDecoder, g1: SegmentDecoder | undefined): string {
    let out = '';
    let runStart = 0;
    let runIsGr = bytes.length > 0 && (bytes[0] as number) >= 0x80;
    for (let i = 0; i <= bytes.length; i++) {
        const isGr = i < bytes.length && (bytes[i] as number) >= 0x80;
        if (i === bytes.length || isGr !== runIsGr) {
            out += decodeSegment(bytes.subarray(runStart, i), runIsGr ? (g1 ?? LATIN1) : g0);
            runStart = i;
            runIsGr = isGr;
        }
    }
    return out;
}

/**
 * Value/line delimiters at which the ISO 2022 designations reset to the initial
 * state: HT, LF, FF, CR, and the multi-value backslash. (`^`/`=` are PN-specific
 * and need the VR, so they are not reset here.)
 */
const RESET_DELIMITERS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x5c]);

/**
 * Whether a decoder replaces the G0/ASCII code area with a multi-byte set (JIS X
 * 0208/0212). While one is active, a GL byte such as 0x5C is a character byte, not
 * a delimiter — so delimiter reset is suppressed (DCMTK: `checkDelimiters` is
 * false for ISO 2022 IR 87/159).
 */
function isMultiByteG0(decoder: SegmentDecoder): boolean {
    return decoder.kind === 'iso2022jp' || decoder.kind === 'jis0212';
}

/**
 * Decodes a byte run containing ISO 2022 escape sequences. Escapes designate a
 * decoder into the G0 or G1 register; data bytes are then routed by their range
 * (GL→G0, GR→G1). Unrecognized escapes leave both registers unchanged.
 *
 * At a value/line delimiter the designations reset to the initial state — unless
 * a multi-byte G0 set is active, where GL bytes are character bytes (PS3.5
 * C.12.1.1.2; matches DCMTK's `checkDelimiters`). This resets a leaked single-byte
 * G1 designation across a non-conformant delimiter that omitted the reset escape.
 */
function decodeIso2022(bytes: Uint8Array, initialG0: SegmentDecoder, initialG1: SegmentDecoder | undefined): string {
    let out = '';
    let g0 = initialG0;
    let g1 = initialG1;
    let segStart = 0;
    let i = 0;
    while (i < bytes.length) {
        const byte = bytes[i] as number;
        if (byte === 0x1b) {
            out += decodeMixed(bytes.subarray(segStart, i), g0, g1);
            const esc = readEscape(bytes, i);
            const designation = ESCAPE_DECODERS[esc.key];
            if (designation !== undefined) {
                if (designation.register === 'g0') {
                    g0 = designation.decoder;
                } else {
                    g1 = designation.decoder;
                }
            }
            i += esc.length;
            segStart = i;
        } else if (RESET_DELIMITERS.has(byte) && !isMultiByteG0(g0)) {
            out += decodeMixed(bytes.subarray(segStart, i), g0, g1);
            out += String.fromCharCode(byte);
            g0 = initialG0;
            g1 = initialG1;
            i += 1;
            segStart = i;
        } else {
            i++;
        }
    }
    out += decodeMixed(bytes.subarray(segStart), g0, g1);
    return out;
}

/** A resolved character-set configuration for one dataset. */
export interface CharsetContext {
    /** The normalized charset terms (first value of 0008,0005 first). */
    readonly terms: readonly string[];
    /** Whether ISO 2022 escape processing applies. */
    readonly iso2022: boolean;
    /** Decoder for non-2022 charsets, or the initial G0 decoder for ISO 2022. */
    readonly initial: SegmentDecoder;
    /** Initial G1 (GR) decoder for ISO 2022, when the term carries one from the start. */
    readonly initialG1: SegmentDecoder | undefined;
    /** Whether the context is a single-byte repertoire (UTF-8 mislabel detection applies). */
    readonly singleByte: boolean;
    /** `true` when a bare `ISO_IR n` term was normalized to its `ISO 2022 IR n` form in a code-extension context (#C5). */
    readonly aliased: boolean;
}

/** The default context (ISO_IR 6 / ASCII). */
export const DEFAULT_CHARSET_CONTEXT: CharsetContext = {
    terms: ['ISO_IR 6'],
    iso2022: false,
    initial: LATIN1,
    initialG1: undefined,
    singleByte: true,
    aliased: false,
};

/** The Latin-1 context used as the lenient last-resort fallback. */
export const LATIN1_CHARSET_CONTEXT: CharsetContext = {
    terms: ['ISO_IR 100'],
    iso2022: false,
    initial: LATIN1,
    initialG1: undefined,
    singleByte: true,
    aliased: false,
};

/**
 * Normalizes a user-supplied charset name (alias or defined term) to a DICOM
 * defined term, or `undefined` when unrecognized.
 */
export function normalizeCharsetName(input: string): string | undefined {
    const trimmed = input.trim();
    if (CHARSET_DECODERS[trimmed] !== undefined || ISO2022_INITIAL[trimmed] !== undefined) {
        return trimmed;
    }
    return CHARSET_ALIASES[trimmed.toLowerCase()];
}

/**
 * Maps a bare `ISO_IR n` term to its `ISO 2022 IR n` equivalent, or `undefined`
 * when there is none. Membership-gated on {@link ISO2022_INITIAL}, so no term is
 * invented (`ISO_IR 999` still fails). DCMTK accepts this non-standard spelling
 * in a code-extension context; PS3.5 C.12.1.1.2 mandates the `ISO 2022` terms
 * whenever the value is multi-valued.
 */
function toIso2022Term(term: string): string | undefined {
    if (!term.startsWith('ISO_IR ')) {
        return undefined;
    }
    const candidate = `ISO 2022 IR ${term.slice(7)}`;
    return ISO2022_INITIAL[candidate] === undefined ? undefined : candidate;
}

function buildContext(terms: readonly string[]): CharsetContext | undefined {
    // `iso2022` is computed from the RAW terms so a single-valued 'ISO_IR 100'
    // can never be promoted into code-extension mode by the aliasing below.
    const iso2022 = terms.length > 1 || terms.some(t => t.startsWith('ISO 2022'));
    if (!iso2022) {
        const initial = CHARSET_DECODERS[terms[0] ?? 'ISO_IR 6'];
        if (initial === undefined) {
            return undefined;
        }
        return { terms, iso2022, initial, initialG1: undefined, singleByte: isSingleByteDecoder(initial), aliased: false };
    }
    const resolved = terms.map(t => toIso2022Term(t) ?? t);
    const aliased = resolved.some((t, i) => t !== terms[i]);
    const first = resolved[0] ?? 'ISO 2022 IR 6';
    const registers = ISO2022_REGISTERS[first];
    if (registers !== undefined) {
        return { terms: resolved, iso2022, initial: registers.g0, initialG1: registers.g1, singleByte: false, aliased };
    }
    // default: a single decoder that covers both GL (ASCII) and GR (its set),
    // used as both G0 and G1 — the split is a no-op unless an escape changes one
    const initial = ISO2022_INITIAL[first];
    if (initial === undefined) {
        return undefined;
    }
    return { terms: resolved, iso2022, initial, initialG1: initial, singleByte: false, aliased };
}

/** Parses raw SpecificCharacterSet values into normalized terms. An empty first value means the default repertoire. */
function parseSpecificCharacterSet(raw: string): string[] {
    const values = raw.split('\\').map(v => v.trim());
    return values.map((v, idx) => (v === '' && idx === 0 ? 'ISO 2022 IR 6' : v)).filter(v => v !== '');
}

function contextFromTerms(terms: readonly string[], fallback: string | undefined, source: string): CharsetContext {
    const context = buildContext(terms);
    if (context !== undefined) {
        return context;
    }
    if (fallback !== undefined) {
        const fallbackTerm = normalizeCharsetName(fallback);
        const fallbackContext = fallbackTerm !== undefined ? buildContext([fallbackTerm]) : undefined;
        if (fallbackContext !== undefined) {
            return fallbackContext;
        }
        throw new DicomError('unsupported', `unsupported charset fallback '${fallback}' (while handling unsupported ${source})`);
    }
    throw new DicomError('unsupported', `unsupported character set: ${source} — provide a charset fallback (e.g. 'latin-1') to decode best-effort`);
}

/** Options for {@link resolveCharsetContext}. */
export interface CharsetOptions {
    /** Charset to assume when (0008,0005) is absent (alias or defined term). */
    readonly assume?: string;
    /** Charset to use when the specified charset is unsupported. */
    readonly fallback?: string;
}

/**
 * Resolves the character-set context for a dataset.
 *
 * @param specificCharacterSet - Raw (0008,0005) value, or `undefined` if absent
 * @param options - Assume/fallback configuration
 * @returns The resolved context
 * @throws DicomError `unsupported` when the charset (or fallback) is unsupported
 */
export function resolveCharsetContext(specificCharacterSet: string | undefined, options: CharsetOptions = {}): CharsetContext {
    if (specificCharacterSet === undefined || specificCharacterSet.trim() === '') {
        if (options.assume === undefined) {
            return DEFAULT_CHARSET_CONTEXT;
        }
        const term = normalizeCharsetName(options.assume);
        return contextFromTerms([term ?? options.assume], options.fallback, `charset assume '${options.assume}'`);
    }
    const terms = parseSpecificCharacterSet(specificCharacterSet);
    return contextFromTerms(terms, options.fallback, `'${specificCharacterSet}' (0008,0005)`);
}

/**
 * Decodes raw DICOM text bytes using the resolved character-set context.
 * Multi-value / person-name splitting must be done on the returned string.
 *
 * @param bytes - The raw value bytes
 * @param context - The context from {@link resolveCharsetContext}
 * @returns The decoded string
 */
export function decodeDicomText(bytes: Uint8Array, context: CharsetContext): string {
    if (context.iso2022) {
        return decodeIso2022(bytes, context.initial, context.initialG1);
    }
    return decodeSegment(bytes, context.initial);
}

/** Strict UTF-8 decoder used only for mislabel detection. */
let strictUtf8: TextDecoder | undefined;

/**
 * Detects a near-certain UTF-8 mislabel: the bytes contain at least one byte
 * ≥ 0x80 and the whole run is valid UTF-8. In valid UTF-8 every byte ≥ 0x80
 * belongs to a multi-byte sequence, so both conditions together imply at least
 * one multi-byte character — under a single-byte charset context that text is
 * almost certainly UTF-8 with a wrong or absent SpecificCharacterSet.
 *
 * @param bytes - The raw value bytes
 * @returns `true` when the bytes look like mislabeled UTF-8
 */
export function isProbableUtf8Mislabel(bytes: Uint8Array): boolean {
    let hasHighByte = false;
    for (const byte of bytes) {
        if (byte >= 0x80) {
            hasHighByte = true;
            break;
        }
    }
    if (!hasHighByte) {
        return false;
    }
    strictUtf8 ??= new TextDecoder('utf-8', { fatal: true });
    try {
        strictUtf8.decode(bytes);
        return true;
    } catch {
        return false;
    }
}

/**
 * Decodes bytes as UTF-8 (used when promoting a detected mislabel).
 *
 * @param bytes - The raw value bytes
 * @returns The decoded string
 */
export function decodeUtf8(bytes: Uint8Array): string {
    return decodeSegment(bytes, label('utf-8'));
}
