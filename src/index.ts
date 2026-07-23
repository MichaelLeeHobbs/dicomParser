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
export { KNOWN_VRS, explicitLengthBytes, isKnownVr, isStringVr, type Vr } from './vr';
export { ByteStream, type ByteStreamOptions } from './byteStream';
