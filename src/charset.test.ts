import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CHARSET_CONTEXT,
    decodeDicomText,
    decodeLatin1,
    decodeUtf8,
    isProbableUtf8Mislabel,
    normalizeCharsetName,
    resolveCharsetContext,
    type CharsetContext,
} from './charset';
import { DicomError } from './errors';

// Ported from @ubercode/dcmtk _charset.test.ts (PS3.5 Annex H/I/J vectors),
// adapted to this repo's typed-error model (throws DicomError instead of
// returning a Result) and Buffer-free helpers.

function ctx(specific: string | undefined, assume?: string, fallback?: string): CharsetContext {
    return resolveCharsetContext(specific, { ...(assume === undefined ? {} : { assume }), ...(fallback === undefined ? {} : { fallback }) });
}

function latin1Bytes(byteString: string): Uint8Array {
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) {
        bytes[i] = byteString.charCodeAt(i) & 0xff;
    }
    return bytes;
}

function decode(specific: string | undefined, byteString: string): string {
    return decodeDicomText(latin1Bytes(byteString), ctx(specific));
}

describe('resolveCharsetContext', () => {
    it('returns the default (ASCII) context when 0008,0005 is absent', () => {
        expect(resolveCharsetContext(undefined)).toBe(DEFAULT_CHARSET_CONTEXT);
    });

    it('treats an empty/blank 0008,0005 as the default repertoire', () => {
        expect(ctx('').iso2022).toBe(false);
        expect(ctx('  ').terms).toEqual(['ISO_IR 6']);
    });

    it('resolves single-byte charsets', () => {
        expect(ctx('ISO_IR 100').iso2022).toBe(false);
        expect(ctx('ISO_IR 192').terms).toEqual(['ISO_IR 192']);
    });

    it('marks multi-valued and ISO 2022 charsets as iso2022', () => {
        expect(ctx('ISO 2022 IR 6\\ISO 2022 IR 87').iso2022).toBe(true);
        expect(ctx('ISO 2022 IR 149').iso2022).toBe(true);
    });

    it('maps an empty first value to the default repertoire term', () => {
        expect(ctx('\\ISO 2022 IR 149').terms[0]).toBe('ISO 2022 IR 6');
    });

    it('applies assume only when 0008,0005 is absent', () => {
        expect(ctx(undefined, 'latin-1').terms).toEqual(['ISO_IR 100']);
        expect(ctx('ISO_IR 144', 'latin-1').terms).toEqual(['ISO_IR 144']);
    });

    it('accepts DICOM defined terms and aliases for assume', () => {
        expect(ctx(undefined, 'ISO_IR 144').terms).toEqual(['ISO_IR 144']);
        expect(ctx(undefined, 'utf-8').terms).toEqual(['ISO_IR 192']);
    });

    it('throws a typed error on an unsupported charset without a fallback', () => {
        expect(() => resolveCharsetContext('ISO_IR 999')).toThrow(DicomError);
        expect(() => resolveCharsetContext('ISO_IR 999')).toThrow(/ISO_IR 999/);
    });

    it('uses the fallback for an unsupported charset', () => {
        expect(ctx('ISO_IR 999', undefined, 'latin-1').terms).toEqual(['ISO_IR 100']);
    });

    it('throws on an unsupported assume without a fallback', () => {
        expect(() => resolveCharsetContext(undefined, { assume: 'klingon' })).toThrow(DicomError);
    });

    it('falls back when assume is unsupported', () => {
        expect(ctx(undefined, 'klingon', 'latin-1').terms).toEqual(['ISO_IR 100']);
    });

    it('throws when the fallback itself is unsupported', () => {
        expect(() => resolveCharsetContext('ISO_IR 999', { fallback: 'also-bad' })).toThrow(/also-bad/);
    });
});

describe('CharsetContext.singleByte', () => {
    it('is true for the ASCII default and Latin charsets', () => {
        expect(DEFAULT_CHARSET_CONTEXT.singleByte).toBe(true);
        expect(ctx(undefined).singleByte).toBe(true);
        expect(ctx('ISO_IR 100').singleByte).toBe(true);
        expect(ctx('ISO_IR 144').singleByte).toBe(true);
        expect(ctx('ISO_IR 166').singleByte).toBe(true);
    });

    it('is false for multi-byte and ISO 2022 charsets', () => {
        expect(ctx('ISO_IR 192').singleByte).toBe(false);
        expect(ctx('GB18030').singleByte).toBe(false);
        expect(ctx('ISO_IR 13').singleByte).toBe(false);
        expect(ctx('ISO 2022 IR 6\\ISO 2022 IR 87').singleByte).toBe(false);
        expect(ctx('ISO 2022 IR 149').singleByte).toBe(false);
    });
});

describe('isProbableUtf8Mislabel', () => {
    it('returns false for pure ASCII and empty input', () => {
        expect(isProbableUtf8Mislabel(latin1Bytes('Smith^John'))).toBe(false);
        expect(isProbableUtf8Mislabel(new Uint8Array(0))).toBe(false);
    });

    it('returns false for Latin-1 high bytes that are not valid UTF-8', () => {
        expect(isProbableUtf8Mislabel(latin1Bytes('M\xfcller^J\xf6rg'))).toBe(false);
        expect(isProbableUtf8Mislabel(Uint8Array.from([0x80]))).toBe(false);
        expect(isProbableUtf8Mislabel(Uint8Array.from([0xc3]))).toBe(false);
    });

    it('returns true for UTF-8 bytes with multi-byte sequences', () => {
        expect(isProbableUtf8Mislabel(new TextEncoder().encode('Müller^José'))).toBe(true);
        expect(isProbableUtf8Mislabel(new TextEncoder().encode('王^小东'))).toBe(true);
    });
});

describe('decodeUtf8 / decodeLatin1', () => {
    it('decodes UTF-8 bytes', () => {
        expect(decodeUtf8(new TextEncoder().encode('Müller^José'))).toBe('Müller^José');
    });

    it('decodes latin-1 bytes byte-for-byte', () => {
        expect(decodeLatin1(latin1Bytes('M\xfcller'))).toBe('Müller');
    });
});

describe('normalizeCharsetName', () => {
    it('passes through defined terms', () => {
        expect(normalizeCharsetName('ISO_IR 100')).toBe('ISO_IR 100');
        expect(normalizeCharsetName('ISO 2022 IR 87')).toBe('ISO 2022 IR 87');
        expect(normalizeCharsetName('GB18030')).toBe('GB18030');
    });

    it('maps DCMTK-style aliases case-insensitively', () => {
        expect(normalizeCharsetName('Latin-1')).toBe('ISO_IR 100');
        expect(normalizeCharsetName('UTF-8')).toBe('ISO_IR 192');
        expect(normalizeCharsetName('cyrillic')).toBe('ISO_IR 144');
        expect(normalizeCharsetName('shift_jis')).toBe('ISO_IR 13');
    });

    it('returns undefined for unknown names', () => {
        expect(normalizeCharsetName('klingon')).toBeUndefined();
    });
});

describe('decodeDicomText — single-byte charsets', () => {
    it('decodes ASCII / default repertoire', () => {
        expect(decode(undefined, 'Smith^John')).toBe('Smith^John');
    });

    it('decodes ISO_IR 100 (Latin-1)', () => {
        expect(decode('ISO_IR 100', 'M\xfcller^J\xf6rg')).toBe('Müller^Jörg');
    });

    it('decodes ISO_IR 144 (Cyrillic)', () => {
        expect(decode('ISO_IR 144', '\xbb\xee\xda\xe1\xd5\xdc\xd1\xe3\xe0\xd3')).toBe('Люксембург');
    });

    it('decodes ISO_IR 126 (Greek)', () => {
        expect(decode('ISO_IR 126', '\xc4\xe9\xef\xed\xf5\xf3\xe9\xef\xf2')).toBe('Διονυσιος');
    });

    it('decodes ISO_IR 127 (Arabic)', () => {
        expect(decode('ISO_IR 127', '\xe2\xc8\xc7\xe6\xea')).toBe('قباني');
    });

    it('decodes ISO_IR 138 (Hebrew)', () => {
        expect(decode('ISO_IR 138', '\xf9\xf8\xe5\xef^\xe3\xe1\xe5\xf8\xe4')).toBe('שרון^דבורה');
    });

    it('decodes ISO_IR 166 (Thai)', () => {
        expect(decode('ISO_IR 166', '\xb9\xc7\xd1\xb2\xb9\xec')).toBe('นวัฒน์');
    });

    it('decodes ISO_IR 192 (UTF-8)', () => {
        const bytes = new TextEncoder().encode('Wang^XiaoDong=王^小东');
        expect(decodeDicomText(bytes, ctx('ISO_IR 192'))).toBe('Wang^XiaoDong=王^小东');
    });

    it('decodes GB18030', () => {
        expect(decode('GB18030', 'Wang^XiaoDong=\xcd\xf5^\xd0\xa1\xb6\xab=')).toBe('Wang^XiaoDong=王^小东=');
    });

    it('decodes ISO_IR 13 (Shift_JIS katakana — halfwidth forms are correct)', () => {
        expect(decode('ISO_IR 13', '\xd4\xcf\xc0\xde^\xc0\xdb\xb3')).toBe('ﾔﾏﾀﾞ^ﾀﾛｳ');
    });

    it('returns empty string for empty input', () => {
        expect(decode('ISO_IR 100', '')).toBe('');
    });
});

describe('decodeDicomText — ISO 2022 code extensions', () => {
    it('decodes the PS3.5 H.3 Japanese example (ISO 2022 IR 87)', () => {
        const bytes = 'Yamada^Tarou=\x1b$B;3ED\x1b(B^\x1b$BB@O:\x1b(B=\x1b$B$d$^$@\x1b(B^\x1b$B$?$m$&\x1b(B';
        expect(decode('ISO 2022 IR 6\\ISO 2022 IR 87', bytes)).toBe('Yamada^Tarou=山田^太郎=やまだ^たろう');
    });

    it('decodes the PS3.5 H.2 Japanese example (ISO 2022 IR 13 + 87)', () => {
        const bytes = '\xd4\xcf\xc0\xde^\xc0\xdb\xb3=\x1b$B;3ED\x1b(J^\x1b$BB@O:\x1b(J=\x1b$B$d$^$@\x1b(J^\x1b$B$?$m$&\x1b(J';
        expect(decode('ISO 2022 IR 13\\ISO 2022 IR 87', bytes)).toBe('ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎=やまだ^たろう');
    });

    it('decodes the PS3.5 I.2 Korean example (ISO 2022 IR 149)', () => {
        const bytes = 'Hong^Gildong=\x1b$)C\xfb\xf3^\x1b$)C\xd1\xce\xd4\xd7=\x1b$)C\xc8\xab^\x1b$)C\xb1\xe6\xb5\xbf';
        expect(decode('\\ISO 2022 IR 149', bytes)).toBe('Hong^Gildong=洪^吉洞=홍^길동');
    });

    it('decodes the Chinese ISO 2022 IR 58 example', () => {
        const bytes = 'Zhang^XiaoDong=\x1b$)A\xd5\xc5^\x1b$)A\xd0\xa1\xb6\xab=';
        expect(decode('\\ISO 2022 IR 58', bytes)).toBe('Zhang^XiaoDong=张^小东=');
    });

    it('decodes G1 single-byte designations (ESC - L → ISO-8859-5)', () => {
        expect(decode('ISO 2022 IR 6\\ISO 2022 IR 144', 'abc\x1b-L\xbb\xee\xda')).toBe('abcЛюк');
    });

    it('keeps the current decoder on unrecognized escape sequences', () => {
        expect(decode('ISO 2022 IR 6\\ISO 2022 IR 87', 'abc\x1b%Gdef')).toBe('abcdef');
    });

    it('handles a truncated escape sequence at end of input', () => {
        expect(decode('ISO 2022 IR 6\\ISO 2022 IR 87', 'abc\x1b')).toBe('abc');
        expect(decode('ISO 2022 IR 6\\ISO 2022 IR 87', 'abc\x1b$')).toBe('abc');
    });

    it('decodes an ISO 2022 IR 100 initial designation without escapes', () => {
        expect(decode('ISO 2022 IR 100', 'M\xfcller')).toBe('Müller');
    });
});

describe('resolveCharsetContext — bare ISO_IR in code extension (review C5)', () => {
    const BS = String.fromCharCode(92);

    it('aliases a bare ISO_IR term to its ISO 2022 IR form in a multi-valued context', () => {
        const context = ctx('ISO_IR 100' + BS + 'ISO 2022 IR 87');
        expect(context.terms).toEqual(['ISO 2022 IR 100', 'ISO 2022 IR 87']);
        expect(context.aliased).toBe(true);
    });

    it('decodes the aliased first value and the escaped segment correctly', () => {
        // 'Müller=' latin-1 then ESC$B 山田 ESC(B under ISO_IR 100\ISO 2022 IR 87
        expect(decode('ISO_IR 100' + BS + 'ISO 2022 IR 87', 'M\xfcller=\x1b$B;3ED\x1b(B')).toBe('Müller=山田');
    });

    it('leaves a single-valued ISO_IR term non-2022 and unaliased', () => {
        expect(ctx('ISO_IR 100').iso2022).toBe(false);
        expect(ctx('ISO_IR 100').aliased).toBe(false);
        expect(ctx('ISO_IR 144').iso2022).toBe(false);
    });

    it('keeps an initial G1 register when a bare term aliases to a register-carrying form', () => {
        // 'ISO_IR 13' -> 'ISO 2022 IR 13' gives katakana G1 from the start
        const context = ctx('ISO_IR 13' + BS + 'ISO 2022 IR 87');
        expect(context.terms[0]).toBe('ISO 2022 IR 13');
        expect(context.aliased).toBe(true);
    });

    it('does not alias terms with no ISO 2022 equivalent (multi-valued UTF-8 stays unsupported)', () => {
        // ISO_IR 192 has no ISO 2022 form; a multi-valued lead keeps the fallback path
        expect(() => resolveCharsetContext('ISO_IR 999' + BS + 'ISO 2022 IR 87')).toThrow();
    });
});
