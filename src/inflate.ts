/**
 * Inflate strategy for the deflated transfer syntax (1.2.840.10008.1.2.1.99).
 *
 * Replaces upstream's global `pako` sniffing (#270/#125/#109) with three
 * explicit paths, in order of preference:
 *
 * 1. A caller-injected inflate function (works everywhere, sync).
 * 2. `node:zlib` via `process.getBuiltinModule` (Node ≥ 20.16; no static
 *    import, so browser bundles never see the module).
 * 3. `DecompressionStream('deflate-raw')` (Baseline browsers + Node ≥ 18) —
 *    async only, used by `parseAsync`.
 *
 * @module inflate
 */

import { DicomError } from './errors';

/** A synchronous raw-deflate inflater supplied by the caller. */
export type InflateFn = (deflated: Uint8Array) => Uint8Array;

interface ZlibLike {
    inflateRawSync(data: Uint8Array): Uint8Array;
}

function nodeZlib(): ZlibLike | undefined {
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
        return undefined;
    }
    return process.getBuiltinModule('node:zlib');
}

/** Whether a synchronous inflate path exists without an injected inflater. */
export function hasSyncInflate(): boolean {
    return nodeZlib() !== undefined;
}

/**
 * Inflates raw-deflate bytes synchronously.
 *
 * @param deflated - The raw deflate stream (no zlib header)
 * @param inflate - Optional caller-supplied inflater (takes precedence)
 * @returns The inflated bytes
 * @throws DicomError `no-inflater` when no sync path exists;
 *         `malformed` (with cause) when the deflate stream is corrupt
 */
export function inflateRaw(deflated: Uint8Array, inflate?: InflateFn): Uint8Array {
    let impl = inflate;
    if (impl === undefined) {
        const zlib = nodeZlib();
        if (zlib !== undefined) {
            impl = (data: Uint8Array): Uint8Array => zlib.inflateRawSync(data);
        }
    }
    if (impl === undefined) {
        throw new DicomError('no-inflater', 'deflated transfer syntax: no synchronous inflater available — use parseAsync() or supply options.inflate');
    }
    try {
        return impl(deflated);
    } catch (cause) {
        throw new DicomError('malformed', 'deflated transfer syntax: inflate failed (corrupt deflate stream)', { cause });
    }
}

/**
 * Inflates raw-deflate bytes, preferring sync paths and falling back to
 * `DecompressionStream('deflate-raw')`.
 *
 * @param deflated - The raw deflate stream (no zlib header)
 * @param inflate - Optional caller-supplied inflater (takes precedence)
 * @returns The inflated bytes
 * @throws DicomError `malformed` (with cause) when the deflate stream is corrupt
 */
export async function inflateRawAsync(deflated: Uint8Array, inflate?: InflateFn): Promise<Uint8Array> {
    if (inflate !== undefined || hasSyncInflate()) {
        return inflateRaw(deflated, inflate);
    }
    try {
        const stream = new Blob([deflated as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (cause) {
        throw new DicomError('malformed', 'deflated transfer syntax: inflate failed (corrupt deflate stream)', { cause });
    }
}
