/**
 * Typed error and warning model.
 *
 * The parser never throws strings (upstream #46/#277): every failure is a
 * {@link DicomError} carrying a machine-readable code and, where known, the byte
 * offset. Recoverable anomalies are recorded as structured {@link ParseWarning}s
 * instead of failing the parse.
 *
 * @module errors
 */

/** Machine-readable failure categories. */
export type DicomErrorCode =
    /** A caller-supplied argument is invalid. */
    | 'invalid-argument'
    /** A read or seek would leave the bounds of the byte array. */
    | 'buffer-overread'
    /** The input is not recognizable as DICOM (no DICM prefix, no override). */
    | 'not-dicom'
    /** A structural rule of the encoding was violated (e.g. missing item tag). */
    | 'malformed'
    /** The file requires a capability the parser does not provide. */
    | 'unsupported'
    /** A deflated transfer syntax was found but no inflate strategy is available. */
    | 'no-inflater'
    /** Sequence nesting exceeded the configured depth bound. */
    | 'depth-exceeded'
    /** The parse exceeded a configured resource bound (e.g. total element count). */
    | 'limit-exceeded';

/**
 * The error type thrown by all parser internals.
 *
 * `parse()` catches these and returns them in the failed {@link ParseResult}
 * alongside the partially-parsed dataset (upstream #203).
 */
export class DicomError extends Error {
    /** Machine-readable failure category. */
    readonly code: DicomErrorCode;
    /** Byte offset where the failure was detected, when known. */
    readonly offset: number | undefined;

    constructor(code: DicomErrorCode, message: string, options?: { readonly offset?: number; readonly cause?: unknown }) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'DicomError';
        this.code = code;
        this.offset = options?.offset;
    }
}

/** Machine-readable warning categories. */
export type ParseWarningCode =
    /** A delimitation item carried a non-zero length (treated as zero, #266). */
    | 'nonzero-delimiter-length'
    /** End of input reached before an expected item delimiter. */
    | 'missing-item-delimiter'
    /** End of input reached before an expected sequence delimiter. */
    | 'missing-sequence-delimiter'
    /** An unexpected tag was encountered and tolerated. */
    | 'unexpected-tag'
    /** End of input reached in the middle of a structure. */
    | 'unexpected-eof'
    /** A declared length was inconsistent and was adjusted. */
    | 'length-adjusted'
    /** The `DICM` prefix was found at offset 0 (no 128-byte preamble). */
    | 'missing-preamble'
    /** A speculative sequence/encapsulation parse failed; the element was kept as an opaque value. */
    | 'sequence-fallback'
    /** An unsupported SpecificCharacterSet; strings decode as Latin-1 best-effort. */
    | 'unsupported-charset'
    /** A tag appeared more than once at the same level; the last value wins (non-conformant). */
    | 'duplicate-tag'
    /** A defined-length element carried an odd value length (non-conformant; values must be even). */
    | 'odd-length';

/** A recoverable anomaly recorded during parsing. */
export interface ParseWarning {
    /** Machine-readable warning category. */
    readonly code: ParseWarningCode;
    /** Human-readable description. */
    readonly message: string;
    /** Byte offset where the anomaly was detected. */
    readonly offset: number;
}
