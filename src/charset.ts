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

/**
 * ISO 2022 escape sequences (bytes after ESC, as a string key) → decoder
 * for the following run. Per DICOM PS3.5 Table 6.3-1.
 */
const ESCAPE_DECODERS: Readonly<Record<string, SegmentDecoder>> = {
    '(B': LATIN1, // G0 = ASCII
    '(J': LATIN1, // G0 = JIS X 0201 romaji
    ')I': { kind: 'katakana' }, // G1 = JIS X 0201 katakana
    '$@': { kind: 'iso2022jp', escape: [0x1b, 0x24, 0x40] }, // G0 = JIS X 0208-1978
    $B: { kind: 'iso2022jp', escape: [0x1b, 0x24, 0x42] }, // G0 = JIS X 0208
    '$(D': { kind: 'iso2022jp', escape: [0x1b, 0x24, 0x28, 0x44] }, // G0 = JIS X 0212
    '$)C': label('euc-kr'), // G1 = KS X 1001
    '$)A': label('gbk'), // G1 = GB 2312
    '-A': LATIN1, // G1 = ISO-8859-1
    '-B': label('iso-8859-2'),
    '-C': label('iso-8859-3'),
    '-D': label('iso-8859-4'),
    '-F': label('iso-8859-7'),
    '-G': label('iso-8859-6'),
    '-H': label('iso-8859-8'),
    '-L': label('iso-8859-5'),
    '-M': label('iso-8859-9'),
    '-T': label('windows-874'),
    '-b': label('iso-8859-15'),
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

/** Decodes a single run of bytes with the given segment decoder. */
function decodeSegment(bytes: Uint8Array, decoder: SegmentDecoder): string {
    if (bytes.length === 0) {
        return '';
    }
    switch (decoder.kind) {
        case 'latin1':
            return decodeLatin1(bytes);
        case 'label': {
            const textDecoder = getTextDecoder(decoder.label);
            /* v8 ignore next -- labels in the tables are validated by resolveCharsetContext */
            return textDecoder === undefined ? decodeLatin1(bytes) : textDecoder.decode(bytes);
        }
        case 'iso2022jp': {
            const textDecoder = getTextDecoder('iso-2022-jp');
            /* v8 ignore next -- iso-2022-jp is always available with ICU */
            if (textDecoder === undefined) {
                return decodeLatin1(bytes);
            }
            const wrapped = new Uint8Array(decoder.escape.length + bytes.length);
            wrapped.set(decoder.escape, 0);
            wrapped.set(bytes, decoder.escape.length);
            return textDecoder.decode(wrapped);
        }
        case 'katakana': {
            const textDecoder = getTextDecoder('shift_jis');
            /* v8 ignore next -- shift_jis is always available with ICU */
            return textDecoder === undefined ? decodeLatin1(bytes) : textDecoder.decode(bytes);
        }
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
 * Decodes a byte run containing ISO 2022 escape sequences. Each escape
 * switches the decoder for the following segment; unrecognized escapes
 * leave the current decoder active.
 */
function decodeIso2022(bytes: Uint8Array, initial: SegmentDecoder): string {
    let out = '';
    let current = initial;
    let segStart = 0;
    let i = 0;
    while (i < bytes.length) {
        if (bytes[i] !== 0x1b) {
            i++;
            continue;
        }
        out += decodeSegment(bytes.subarray(segStart, i), current);
        const esc = readEscape(bytes, i);
        current = ESCAPE_DECODERS[esc.key] ?? current;
        i += esc.length;
        segStart = i;
    }
    out += decodeSegment(bytes.subarray(segStart), current);
    return out;
}

/** A resolved character-set configuration for one dataset. */
export interface CharsetContext {
    /** The normalized charset terms (first value of 0008,0005 first). */
    readonly terms: readonly string[];
    /** Whether ISO 2022 escape processing applies. */
    readonly iso2022: boolean;
    /** Decoder for non-2022 charsets, or the initial decoder for ISO 2022. */
    readonly initial: SegmentDecoder;
    /** Whether the context is a single-byte repertoire (UTF-8 mislabel detection applies). */
    readonly singleByte: boolean;
}

/** The default context (ISO_IR 6 / ASCII). */
export const DEFAULT_CHARSET_CONTEXT: CharsetContext = { terms: ['ISO_IR 6'], iso2022: false, initial: LATIN1, singleByte: true };

/** The Latin-1 context used as the lenient last-resort fallback. */
export const LATIN1_CHARSET_CONTEXT: CharsetContext = { terms: ['ISO_IR 100'], iso2022: false, initial: LATIN1, singleByte: true };

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

function buildContext(terms: readonly string[]): CharsetContext | undefined {
    const iso2022 = terms.length > 1 || terms.some(t => t.startsWith('ISO 2022'));
    const first = terms[0] ?? 'ISO_IR 6';
    const initial = iso2022 ? ISO2022_INITIAL[first] : CHARSET_DECODERS[first];
    if (initial === undefined) {
        return undefined;
    }
    return { terms, iso2022, initial, singleByte: !iso2022 && isSingleByteDecoder(initial) };
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
        return decodeIso2022(bytes, context.initial);
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
