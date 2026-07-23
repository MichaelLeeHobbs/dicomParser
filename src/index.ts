/**
 * @ubercode/dicom-parser — TypeScript remake of dicomParser.
 *
 * Parse and write DICOM Part-10 with zero runtime dependencies.
 *
 * Phase 0 scaffold: the public API lands in Phase 1 (core tokenizer) through
 * Phase 4 (v1 compat façade). See PLAN.md for the roadmap.
 *
 * @packageDocumentation
 */

export { VERSION } from './version';
export { DicomError, type DicomErrorCode, type ParseWarning, type ParseWarningCode } from './errors';
export {
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
    type Tag,
    type TagLike,
} from './tag';
export { KNOWN_VRS, explicitLengthBytes, isCharsetAffectedVr, isKnownVr, isStringVr, type Vr } from './vr';
export { ByteStream, type ByteStreamOptions } from './byteStream';
export { readExplicitElementHeader, readImplicitElementHeader, type ElementHeader, type VrLookup, type VrSource } from './elementHeader';
export type { DicomElement, ElementBase, EncapsulatedElement, Fragment, SequenceElement, SequenceItem, UnknownElement, ValueElement } from './element';
export { DicomDataSet } from './dataSet';
export { scanEncapsulatedPixelData } from './encapsulated';
export { readElements, type ReadElementsOptions, type ReadElementsResult, type StopAtOption } from './tokenizer';
export { readPart10Header, readUiString, type Part10Header, type Part10Options } from './part10';
export { inflateRaw, inflateRawAsync, hasSyncInflate, type InflateFn } from './inflate';
export {
    parse,
    parseAsync,
    TS_DEFLATED_LE,
    TS_EXPLICIT_BE,
    TS_EXPLICIT_LE,
    TS_GE_PRIVATE_DLX,
    TS_IMPLICIT_LE,
    type ParseOptions,
    type ParseResult,
} from './parse';
export { parseDA, parsePN, parseTM, type DicomDate, type DicomTime, type PersonName } from './valueParsers';
export {
    DEFAULT_CHARSET_CONTEXT,
    LATIN1_CHARSET_CONTEXT,
    decodeDicomText,
    decodeLatin1,
    decodeUtf8,
    isProbableUtf8Mislabel,
    normalizeCharsetName,
    resolveCharsetContext,
    type CharsetContext,
    type CharsetOptions,
} from './charset';
export {
    createJpegBasicOffsetTable,
    nativePixelDataView,
    readEncapsulatedImageFrame,
    readEncapsulatedPixelDataFromFragments,
    type PixelDataView,
} from './pixelData';
export { DEFAULT_MAX_INFLATED_BYTES, type InflateOptions } from './inflate';
export { encodeDataSet, type EncodeOptions } from './writer';
export {
    IMPLEMENTATION_CLASS_UID,
    IMPLEMENTATION_VERSION_NAME,
    buildMetaGroup,
    modifyDataSet,
    serializeParsed,
    writeFile,
    type DataSetEdits,
    type DeflateFn,
    type SerializeParsedOptions,
    type WriteFileOptions,
} from './writeFile';
export {
    dataSet,
    element,
    encodeBigintValue,
    encodeNumericValue,
    encodeStringValue,
    item,
    toWriteModel,
    type ValueSpec,
    type WriteCharset,
    type WriteDataSet,
    type WriteElement,
    type WriteItem,
    type WriteValue,
} from './writeModel';
