/**
 * Part-10 file writing: meta-group generation, whole-file assembly, and
 * round-trip serialization of parsed datasets.
 *
 * @module writeFile
 */

import { DicomDataSet } from './dataSet';
import { DicomError } from './errors';
import type { ParseResult } from './parse';
import { NATIVE_TRANSFER_SYNTAXES, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_GE_PRIVATE_DLX, TS_IMPLICIT_LE } from './parse';
import { TAG_PIXEL_DATA, tagToString, toTag, type Tag, type TagLike } from './tag';
import { encodeDataSet, encodeDataSetTo, encodePlanInto, planEncode, type EncodeOptions, type WriteSink } from './writer';
import { dataSet as buildDataSet, element, item, toWriteModel, type WriteDataSet, type WriteElement, type WriteItem } from './writeModel';

/** Implementation Class UID for generated file meta groups (UUID-derived, 2.25 root). */
export const IMPLEMENTATION_CLASS_UID = '2.25.331717632425659486778196813677143528292';
/** Implementation Version Name for generated file meta groups. */
export const IMPLEMENTATION_VERSION_NAME = 'UBERCODE_DP2';

/** A raw-deflate compressor (mirror of {@link InflateFn}). */
export type DeflateFn = (bytes: Uint8Array) => Uint8Array;

interface ZlibLike {
    deflateRawSync(data: Uint8Array): Uint8Array;
}

function nodeDeflate(): DeflateFn | undefined {
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
        return undefined;
    }
    const zlib = process.getBuiltinModule('node:zlib') as unknown as ZlibLike;
    return (bytes: Uint8Array): Uint8Array => zlib.deflateRawSync(bytes);
}

/** Options for {@link writeFile}. */
export interface WriteFileOptions {
    /** The main dataset (ascending tag order; see `dataSet()`/`toWriteModel()`). */
    readonly dataSet: WriteDataSet;
    /** Output transfer syntax (default Explicit VR Little Endian). */
    readonly transferSyntax?: string;
    /** 128-byte preamble (default zeros). */
    readonly preamble?: Uint8Array;
    /** Media Storage SOP Class UID; default: the dataset's (0008,0016). */
    readonly sopClassUid?: string;
    /** Media Storage SOP Instance UID; default: the dataset's (0008,0018). */
    readonly sopInstanceUid?: string;
    /** Injected deflater for the deflated transfer syntax. */
    readonly deflate?: DeflateFn;
    /** Charset for string values ('latin1' default, 'utf8' for ISO_IR 192). */
    readonly charset?: EncodeOptions['charset'];
    /** Meta-group knobs: implementation identity, (0002,0016), extra group-2 elements (#39). */
    readonly meta?: MetaGroupOptions;
    /** Bytes buffered before each flush in {@link writeFileTo} (default 64 KiB). */
    readonly chunkSize?: number;
    /**
     * Emit intentionally non-conformant output for adversarial fixtures (#43):
     * relaxes the odd-length and length-field checks (see
     * {@link EncodeOptions.nonConformant}) and the transfer-syntax/payload
     * agreement check, so a fixture can pair encapsulated pixel data with a
     * native syntax on purpose. Off by default.
     */
    readonly nonConformant?: boolean;
}

function findStringValue(dataSet: WriteDataSet, tag: TagLike): string | undefined {
    const wanted = toTag(tag);
    const found = dataSet.elements.find(el => el.tag === wanted);
    if (found === undefined || found.value.kind !== 'bytes') {
        return found !== undefined && found.value.kind === 'string' ? found.value.value : undefined;
    }
    let end = found.value.bytes.length;
    while (end > 0 && ((found.value.bytes[end - 1] as number) === 0 || (found.value.bytes[end - 1] as number) === 0x20)) {
        end--;
    }
    let out = '';
    for (let i = 0; i < end; i++) {
        out += String.fromCharCode(found.value.bytes[i] as number);
    }
    return out;
}

/** Options for {@link buildMetaGroup} — issue #39 (W8). */
export interface MetaGroupOptions {
    /** Overrides (0002,0012) ImplementationClassUID (default {@link IMPLEMENTATION_CLASS_UID}). */
    readonly implementationClassUid?: string;
    /** Overrides (0002,0013) ImplementationVersionName (default {@link IMPLEMENTATION_VERSION_NAME}). */
    readonly implementationVersionName?: string;
    /** Adds (0002,0016) SourceApplicationEntityTitle. */
    readonly sourceApplicationEntityTitle?: string;
    /**
     * Additional group-2 elements (e.g. (0002,0017)/(0002,0018) or private
     * meta elements), encoded in ascending tag order with the generated ones.
     * Must be group 0002 and must not collide with a generated tag —
     * violations are `invalid-argument` errors.
     */
    readonly extraElements?: readonly WriteElement[];
}

/** The group-2 tags {@link buildMetaGroup} generates itself. */
const GENERATED_META_TAGS: ReadonlySet<number> = new Set([0x00020000, 0x00020001, 0x00020002, 0x00020003, 0x00020010, 0x00020012, 0x00020013]);

/** Validates and merges caller meta elements with the generated set (#39). */
function metaElements(identifiers: readonly [string, string, string], options: MetaGroupOptions): WriteElement[] {
    const [transferSyntax, sopClassUid, sopInstanceUid] = identifiers;
    const elements = [
        element(0x00020001, 'OB', Uint8Array.from([0x00, 0x01])),
        element(0x00020002, 'UI', sopClassUid),
        element(0x00020003, 'UI', sopInstanceUid),
        element(0x00020010, 'UI', transferSyntax),
        element(0x00020012, 'UI', options.implementationClassUid ?? IMPLEMENTATION_CLASS_UID),
        element(0x00020013, 'SH', options.implementationVersionName ?? IMPLEMENTATION_VERSION_NAME),
    ];
    if (options.sourceApplicationEntityTitle !== undefined) {
        elements.push(element(0x00020016, 'AE', options.sourceApplicationEntityTitle));
    }
    const seen = new Set<number>(elements.map(el => el.tag));
    for (const extra of options.extraElements ?? []) {
        if (extra.tag >>> 16 !== 0x0002) {
            throw new DicomError('invalid-argument', `meta extraElements must be group 0002; got ${tagToString(extra.tag)}`);
        }
        if (GENERATED_META_TAGS.has(extra.tag) || seen.has(extra.tag)) {
            throw new DicomError('invalid-argument', `meta extraElements may not duplicate ${tagToString(extra.tag)}`);
        }
        seen.add(extra.tag);
        elements.push(extra);
    }
    // ascending order comes from buildDataSet(), which sorts every write model
    return elements;
}

/**
 * Builds the file meta group (group 0002) with a correct group length.
 *
 * @param transferSyntax - The dataset transfer syntax UID
 * @param sopClassUid - Media Storage SOP Class UID
 * @param sopInstanceUid - Media Storage SOP Instance UID
 * @param options - Implementation-identity overrides and extra group-2 elements (#39)
 * @returns The encoded meta group bytes (always explicit little endian)
 * @throws DicomError `invalid-argument` for non-group-2 or colliding extras
 */
export function buildMetaGroup(transferSyntax: string, sopClassUid: string, sopInstanceUid: string, options: MetaGroupOptions = {}): Uint8Array {
    const afterLength = encodeDataSet(buildDataSet(metaElements([transferSyntax, sopClassUid, sopInstanceUid], options)), { explicitVr: true });
    const lengthElement = encodeDataSet(buildDataSet([element(0x00020000, 'UL', [afterLength.length])]), { explicitVr: true });
    const out = new Uint8Array(lengthElement.length + afterLength.length);
    out.set(lengthElement, 0);
    out.set(afterLength, lengthElement.length);
    return out;
}

/**
 * Rejects a transfer syntax that disagrees with the pixel-data payload: a
 * compressed syntax must carry encapsulated (fragmented) pixel data, and a native
 * syntax must carry native pixel bytes. Without this a tag-morph flow (parse a
 * JPEG, modify, writeFile defaulting to Explicit LE) silently emits fragments
 * under a native syntax — a non-conformant file that still reparses (review D2).
 */
function checkTransferSyntaxPayload(dataSet: WriteDataSet, transferSyntax: string): void {
    const pixelData = dataSet.elements.find(el => el.tag === TAG_PIXEL_DATA);
    if (pixelData === undefined) {
        return;
    }
    const encapsulated = pixelData.value.kind === 'fragments';
    const nativeSyntax = NATIVE_TRANSFER_SYNTAXES.has(transferSyntax);
    if (encapsulated && nativeSyntax) {
        throw new DicomError(
            'invalid-argument',
            `dataset has encapsulated (fragmented) pixel data but transfer syntax ${transferSyntax} is native; pass the source compressed transfer syntax (e.g. options.transferSyntax = parsed.transferSyntax)`
        );
    }
    if (!encapsulated && !nativeSyntax) {
        throw new DicomError(
            'invalid-argument',
            `dataset has native pixel data but transfer syntax ${transferSyntax} is compressed/encapsulated; native pixel data requires a native transfer syntax`
        );
    }
}

/** Validates the syntax and derives the dataset encode options for a write. */
function encodeOptionsFor(options: WriteFileOptions, transferSyntax: string): EncodeOptions {
    if (transferSyntax === TS_EXPLICIT_BE || transferSyntax === TS_GE_PRIVATE_DLX) {
        throw new DicomError('unsupported', `transfer syntax ${transferSyntax} is read-only; the write path is little-endian`);
    }
    if (options.nonConformant !== true) {
        checkTransferSyntaxPayload(options.dataSet, transferSyntax);
    }
    return {
        explicitVr: transferSyntax !== TS_IMPLICIT_LE,
        ...(options.charset === undefined ? {} : { charset: options.charset }),
        ...(options.nonConformant === undefined ? {} : { nonConformant: options.nonConformant }),
    };
}

/** Deflates an encoded dataset for the deflated transfer syntax. */
function deflateDataSet(options: WriteFileOptions, encoded: Uint8Array): Uint8Array {
    const deflate = options.deflate ?? nodeDeflate();
    if (deflate === undefined) {
        throw new DicomError('no-inflater', 'deflated transfer syntax: no deflater available — supply options.deflate');
    }
    return deflate(encoded);
}

function encodedDataSetFor(options: WriteFileOptions, transferSyntax: string): Uint8Array {
    const encodeOptions = encodeOptionsFor(options, transferSyntax);
    const encoded = encodeDataSet(options.dataSet, encodeOptions);
    return transferSyntax === TS_DEFLATED_LE ? deflateDataSet(options, encoded) : encoded;
}

/**
 * Writes a complete Part-10 file: preamble + `DICM` + generated meta group +
 * encoded dataset.
 *
 * @param options - Dataset, transfer syntax, meta identifiers
 * @returns The file bytes
 * @throws DicomError `invalid-argument`/`unsupported` on unencodable input
 */
/** The fixed header a Part-10 file starts with: preamble, `DICM`, meta group. */
interface FileHeader {
    readonly preamble: Uint8Array;
    readonly meta: Uint8Array;
    readonly transferSyntax: string;
    /** Offset of the first dataset byte. */
    readonly dataSetPosition: number;
}

function fileHeaderFor(options: WriteFileOptions): FileHeader {
    const transferSyntax = options.transferSyntax ?? TS_EXPLICIT_LE;
    const preamble = options.preamble ?? new Uint8Array(128);
    if (preamble.length !== 128) {
        throw new DicomError('invalid-argument', `preamble must be 128 bytes, got ${preamble.length}`);
    }
    const sopClassUid = options.sopClassUid ?? findStringValue(options.dataSet, 0x00080016) ?? '';
    const sopInstanceUid = options.sopInstanceUid ?? findStringValue(options.dataSet, 0x00080018) ?? '';
    const meta = buildMetaGroup(transferSyntax, sopClassUid, sopInstanceUid, options.meta ?? {});
    return { preamble, meta, transferSyntax, dataSetPosition: 132 + meta.length };
}

/** Writes preamble + `DICM` + meta into `out`, returning the dataset offset. */
function writeFileHeader(out: Uint8Array, header: FileHeader): number {
    out.set(header.preamble, 0);
    out.set([0x44, 0x49, 0x43, 0x4d], 128);
    out.set(header.meta, 132);
    return header.dataSetPosition;
}

/**
 * Writes a complete Part-10 file: preamble + `DICM` + generated meta group +
 * encoded dataset.
 *
 * @param options - Dataset, transfer syntax, meta identifiers
 * @returns The file bytes
 * @throws DicomError `invalid-argument`/`unsupported` on unencodable input
 */
export function writeFile(options: WriteFileOptions): Uint8Array {
    const header = fileHeaderFor(options);
    if (header.transferSyntax === TS_DEFLATED_LE) {
        // the deflater needs the whole encoded dataset, so this path keeps the copy
        const deflated = encodedDataSetFor(options, header.transferSyntax);
        const out = new Uint8Array(header.dataSetPosition + deflated.length);
        out.set(deflated, writeFileHeader(out, header));
        return out;
    }
    // one allocation for the whole file: the dataset encodes straight into it,
    // so the modify path no longer holds the dataset and the file at once (#41).
    // The plan is reused, so the sizing pass runs once rather than per call.
    const plan = planEncode(options.dataSet, encodeOptionsFor(options, header.transferSyntax));
    const out = new Uint8Array(header.dataSetPosition + plan.total);
    encodePlanInto(plan, out, writeFileHeader(out, header));
    return out;
}

/**
 * Streams a complete Part-10 file to a sink, so peak memory tracks the chunk
 * size rather than the file (#41).
 *
 * Chunks arrive in order: preamble, `DICM`, meta group, then the dataset in
 * `chunkSize` pieces — with values larger than a chunk passed through
 * uncopied (see {@link encodeDataSetTo} for the chunk-lifetime and
 * backpressure contract). The deflated transfer syntax cannot be streamed —
 * the deflater needs the whole dataset — so its payload arrives as a single
 * chunk; everything else streams.
 *
 * @param sink - Receives each chunk in order
 * @param options - Dataset, transfer syntax, meta identifiers, `chunkSize`
 * @returns The total number of bytes written
 * @throws DicomError `invalid-argument`/`unsupported` on unencodable input
 */
export function writeFileTo(sink: WriteSink, options: WriteFileOptions): number {
    const header = fileHeaderFor(options);
    sink(header.preamble);
    sink(Uint8Array.from([0x44, 0x49, 0x43, 0x4d]));
    sink(header.meta);
    if (header.transferSyntax === TS_DEFLATED_LE) {
        const deflated = encodedDataSetFor(options, header.transferSyntax);
        sink(deflated);
        return header.dataSetPosition + deflated.length;
    }
    const encodeOptions = encodeOptionsFor(options, header.transferSyntax);
    const streamOptions: EncodeOptions = { ...encodeOptions, ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }) };
    return header.dataSetPosition + encodeDataSetTo(sink, options.dataSet, streamOptions);
}

/** Options for {@link serializeParsed}. */
export interface SerializeParsedOptions {
    /**
     * Serialize even a partial (`error`) or `stopAt`-terminated parse. Off by
     * default so an incomplete parse cannot silently produce a truncated file.
     */
    readonly allowPartial?: boolean;
}

/**
 * Builds the completeness-guard error for {@link serializeParsed}: a failed
 * parse reports its underlying error (as `cause`), a `stopAt`-terminated parse
 * reports the stop tag. A concrete error takes precedence over a stop tag.
 *
 * @param result - The offending parse result
 * @returns The `invalid-argument` {@link DicomError} to throw
 */
/**
 * Warning codes that mean the parsed model does not faithfully represent
 * complete input — a value was clamped at EOF, a delimiter was missing, or a
 * length was adjusted. Re-serializing such a parse silently emits a file that
 * differs from the source, so the guard refuses it too (not just hard failures
 * and `stopAt`). Benign non-conformance (duplicate-tag, odd-length) is excluded.
 */
const INCOMPLETE_WARNING_CODES: ReadonlySet<string> = new Set(['unexpected-eof', 'missing-item-delimiter', 'missing-sequence-delimiter', 'length-adjusted']);

/** The first truncation/incompleteness warning on a result, if any. */
function incompleteWarning(result: ParseResult): string | undefined {
    return result.warnings.find(w => INCOMPLETE_WARNING_CODES.has(w.code))?.code;
}

/** Whether a parse fully and faithfully represents its input (safe to re-serialize). */
function isComplete(result: ParseResult): boolean {
    return result.ok && result.error === undefined && result.stoppedAt === undefined && incompleteWarning(result) === undefined;
}

function guardError(result: ParseResult): DicomError {
    if (result.error !== undefined) {
        return new DicomError(
            'invalid-argument',
            `refusing to serialize a failed parse (${result.error.code}): ${result.error.message}; pass { allowPartial: true } to serialize the partial dataset`,
            { cause: result.error, ...(result.error.offset === undefined ? {} : { offset: result.error.offset }) }
        );
    }
    if (result.stoppedAt !== undefined) {
        return new DicomError(
            'invalid-argument',
            `refusing to serialize a parse stopped early at ${tagToString(result.stoppedAt)} (stopAt); pass { allowPartial: true } to serialize the truncated dataset`
        );
    }
    return new DicomError(
        'invalid-argument',
        `refusing to serialize a parse that adjusted or truncated its input ('${String(incompleteWarning(result))}'); pass { allowPartial: true } to serialize it anyway`
    );
}

/**
 * Re-serializes a parsed file: the original preamble/DICM/meta bytes are kept
 * verbatim and the dataset is re-encoded from the parsed model.
 *
 * For conformant little-endian files this is **byte-identical** to the input
 * (the round-trip gate); deflated files re-compress (parse-equal, not
 * byte-equal). Explicit big endian is read-only and raises `unsupported`.
 *
 * By default an incomplete parse is refused: one that failed (`error`), was
 * halted by `stopAt` (`stoppedAt`), or carries a truncation/adjustment warning
 * (`unexpected-eof`, `missing-item-delimiter`, `missing-sequence-delimiter`,
 * `length-adjusted`) — because the re-serialized file would silently differ
 * from the source yet still read as valid DICOM. Pass `{ allowPartial: true }`
 * to serialize anyway. Benign warnings (`duplicate-tag`, `odd-length`, …) do
 * not block serialization.
 *
 * @param result - A successful parse result (or partial, with `allowPartial`)
 * @param options - Serialization options; see {@link SerializeParsedOptions}
 * @returns The re-serialized file bytes
 * @throws DicomError `invalid-argument` when `result` is a failed or
 *         `stopAt`-terminated parse and `allowPartial` is not set, or for
 *         datasets containing non-re-encodable (unknown-kind) elements;
 *         `unsupported` for big-endian input (never suppressed by
 *         `allowPartial`)
 */
export function serializeParsed(result: ParseResult, options: SerializeParsedOptions = {}): Uint8Array {
    if (options.allowPartial !== true && !isComplete(result)) {
        throw guardError(result);
    }
    if (result.transferSyntax === TS_EXPLICIT_BE) {
        throw new DicomError('unsupported', 'explicit big endian is read-only; re-encode via a little-endian write model instead');
    }
    const model = toWriteModel(result.dataSet);
    const explicitVr = result.transferSyntax !== TS_IMPLICIT_LE;
    let encoded = encodeDataSet(model, { explicitVr });
    if (result.transferSyntax === TS_DEFLATED_LE) {
        const deflate = nodeDeflate();
        if (deflate === undefined) {
            throw new DicomError('no-inflater', 'deflated transfer syntax: no deflater available');
        }
        encoded = deflate(encoded);
    }
    const headerEnd = headerLength(result);
    const out = new Uint8Array(headerEnd + encoded.length);
    out.set(result.bytes.subarray(0, headerEnd), 0);
    out.set(encoded, headerEnd);
    return out;
}

/** Length of the original preamble+DICM+meta section in `result.bytes`. */
function headerLength(result: ParseResult): number {
    let last = 0;
    for (const element of result.meta.elements.values()) {
        last = Math.max(last, element.endOffset);
    }
    return last;
}

/** Edits for {@link modifyDataSet}. */
export interface DataSetEdits {
    /** Elements to add or replace at the **root**, matched by exact tag. */
    readonly set?: readonly WriteElement[];
    /** **Root** tags to remove, matched exactly. */
    readonly remove?: readonly TagLike[];
    /**
     * Removes every element — at any depth — whose tag satisfies the predicate
     * (#42). This is how range and class removal is expressed: the caller owns
     * the rule, so no range type is needed, e.g. `isPrivateTag`, or
     * `tag => (tagGroup(tag) & 0xff00) === 0x6000` for the overlay groups.
     *
     * @param tag - The element's tag
     * @param path - Enclosing sequence tags, outermost first (empty at the root)
     */
    readonly removeWhere?: (tag: Tag, path: readonly Tag[]) => boolean;
    /**
     * Transforms every element at any depth (#42): return a replacement, the
     * element unchanged, or `undefined` to remove it. Runs after
     * {@link removeWhere}; a returned sequence is then walked, so a transform
     * applies to the replacement's items rather than the original's.
     *
     * Elements are visited depth-first in tag order: a sequence's items are
     * transformed before the elements that follow it.
     *
     * @param element - The element as it stands after the earlier edits
     * @param path - Enclosing sequence tags, outermost first (empty at the root)
     */
    readonly mapElements?: (element: WriteElement, path: readonly Tag[]) => WriteElement | undefined;
}

/** Mutable state for one {@link modifyDataSet} walk. */
interface EditState {
    readonly removed: ReadonlySet<Tag>;
    /** Root replacements, consumed as they match; the rest are appended. */
    readonly replaced: Map<Tag, WriteElement>;
    readonly edits: DataSetEdits;
}

/** A rebuilt sequence item, filled by the child tasks before the sequence closes. */
interface EditItem {
    readonly elements: WriteElement[];
    readonly undefinedLength: boolean;
}

type EditTask =
    | { readonly kind: 'element'; readonly el: WriteElement; readonly out: WriteElement[]; readonly path: readonly Tag[]; readonly root: boolean }
    | { readonly kind: 'sequence'; readonly source: WriteElement; readonly items: readonly EditItem[]; readonly out: WriteElement[] };

/** Where a run of elements is being rebuilt, and at what depth. */
interface EditTarget {
    readonly out: WriteElement[];
    readonly path: readonly Tag[];
    readonly root: boolean;
}

/**
 * Pushes elements so the first one is processed first (the stack is LIFO),
 * in ascending tag order. The source order is the *stream* order the parse
 * saw — identical to tag order for a conformant file, but not for one whose
 * elements are out of order — so it is sorted here to make the documented
 * visit order hold for every input, not just well-formed ones.
 */
function pushElements(tasks: EditTask[], elements: readonly WriteElement[], target: EditTarget): void {
    const ordered = [...elements].sort((a, b) => a.tag - b.tag);
    for (let i = ordered.length - 1; i >= 0; i--) {
        tasks.push({ kind: 'element', el: ordered[i] as WriteElement, out: target.out, path: target.path, root: target.root });
    }
}

/**
 * Applies the edits to one element: root-exact remove/set first (explicit
 * caller intent wins), then the recursive predicate and transform.
 * Returns `undefined` when the element is removed.
 */
function applyEdits(el: WriteElement, path: readonly Tag[], root: boolean, state: EditState): WriteElement | undefined {
    let current = el;
    if (root) {
        if (state.removed.has(current.tag)) {
            return undefined;
        }
        const replacement = state.replaced.get(current.tag);
        if (replacement !== undefined) {
            state.replaced.delete(current.tag);
            current = replacement;
        }
    }
    if (state.edits.removeWhere?.(current.tag, path) === true) {
        return undefined;
    }
    if (state.edits.mapElements === undefined) {
        return current;
    }
    return state.edits.mapElements(current, path);
}

/** Rebuilds a sequence element from its edited items once every child is done. */
function closeSequence(task: Extract<EditTask, { kind: 'sequence' }>): void {
    const items = task.items.map(edited => item(edited.elements, edited.undefinedLength));
    task.out.push({ ...task.source, value: { kind: 'sequence', items } });
}

/** Walks the write model iteratively (no recursion), applying edits at every level. */
function walkEdits(rootElements: readonly WriteElement[], state: EditState): WriteElement[] {
    const out: WriteElement[] = [];
    const tasks: EditTask[] = [];
    pushElements(tasks, rootElements, { out, path: [], root: true });
    while (tasks.length > 0) {
        const task = tasks.pop() as EditTask;
        if (task.kind === 'sequence') {
            closeSequence(task);
            continue;
        }
        const el = applyEdits(task.el, task.path, task.root, state);
        if (el === undefined) {
            continue;
        }
        if (el.value.kind !== 'sequence') {
            task.out.push(el);
            continue;
        }
        const sourceItems = el.value.items;
        const items: EditItem[] = sourceItems.map(sourceItem => ({ elements: [], undefinedLength: sourceItem.undefinedLength ?? false }));
        tasks.push({ kind: 'sequence', source: el, items, out: task.out });
        const childPath = [...task.path, el.tag];
        for (let i = sourceItems.length - 1; i >= 0; i--) {
            pushElements(tasks, (sourceItems[i] as WriteItem).elements, { out: (items[i] as EditItem).elements, path: childPath, root: false });
        }
    }
    return out;
}

/**
 * Builds a write model from a parsed dataset with edits applied
 * (parse → modify → serialize, PLAN.md item 13's edit model).
 *
 * @remarks
 * Unlike {@link serializeParsed}, this operates on a bare {@link DicomDataSet}
 * and has no visibility into whether the parse that produced it completed.
 * Passing the `dataSet` of a partial or `stopAt`-terminated
 * {@link ParseResult} silently propagates that truncation into the write model
 * (and thus into {@link writeFile}) — check `result.ok`/`result.error`/
 * `result.stoppedAt` before editing if completeness matters.
 *
 * `set`/`remove` are root-level and exact-tag; `removeWhere`/`mapElements`
 * apply at every depth, including sequence items (#42), which is what real
 * anonymization needs. Order per element: root remove, root set, then
 * `removeWhere`, then `mapElements`. `set` elements that matched nothing are
 * appended afterwards and deliberately bypass both hooks — an explicit
 * addition is not something a general rule should then delete.
 *
 * @param parsed - The parsed dataset
 * @param edits - Root set/remove plus the recursive predicate and transform
 * @returns The edited write model, in ascending tag order
 */
export function modifyDataSet(parsed: DicomDataSet, edits: DataSetEdits): WriteDataSet {
    const state: EditState = {
        removed: new Set((edits.remove ?? []).map(tag => toTag(tag))),
        replaced: new Map((edits.set ?? []).map(el => [el.tag, el])),
        edits,
    };
    const out = walkEdits(toWriteModel(parsed).elements, state);
    for (const el of state.replaced.values()) {
        out.push(el);
    }
    return buildDataSet(out);
}
