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

/** Options for the inflate helpers. */
export interface InflateOptions {
    /** Caller-supplied inflater (takes precedence over built-in paths). */
    readonly inflate?: InflateFn;
    /**
     * Maximum inflated size in bytes (deflate-bomb guard, default 1 GiB).
     * Exceeding it is a `malformed` error.
     */
    readonly maxInflatedBytes?: number;
}

/** Default inflated-size cap: 1 GiB. */
export const DEFAULT_MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

interface ZlibLike {
    inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
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
export function inflateRaw(deflated: Uint8Array, options: InflateOptions = {}): Uint8Array {
    const maxBytes = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
    let impl = options.inflate;
    if (impl === undefined) {
        const zlib = nodeZlib();
        if (zlib !== undefined) {
            impl = (data: Uint8Array): Uint8Array => zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
        }
    }
    if (impl === undefined) {
        throw new DicomError('no-inflater', 'deflated transfer syntax: no synchronous inflater available — use parseAsync() or supply options.inflate');
    }
    let inflated: Uint8Array;
    try {
        inflated = impl(deflated);
    } catch (cause) {
        throw new DicomError('malformed', 'deflated transfer syntax: inflate failed (corrupt stream or output over maxInflatedBytes)', { cause });
    }
    if (inflated.length > maxBytes) {
        throw new DicomError('malformed', `deflated transfer syntax: inflated size ${inflated.length} exceeds maxInflatedBytes (${maxBytes})`);
    }
    return inflated;
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
export async function inflateRawAsync(deflated: Uint8Array, options: InflateOptions = {}): Promise<Uint8Array> {
    if (options.inflate !== undefined || hasSyncInflate()) {
        return inflateRaw(deflated, options);
    }
    const maxBytes = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
    try {
        return await inflateViaDecompressionStream(deflated, maxBytes);
    } catch (cause) {
        if (cause instanceof DicomError) {
            throw cause;
        }
        throw new DicomError('malformed', 'deflated transfer syntax: inflate failed (corrupt deflate stream)', { cause });
    }
}

/** Streams through DecompressionStream, enforcing the size cap per chunk. */
async function inflateViaDecompressionStream(deflated: Uint8Array, maxBytes: number): Promise<Uint8Array> {
    const stream = new Blob([deflated as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            throw new DicomError('malformed', `deflated transfer syntax: inflated size exceeds maxInflatedBytes (${maxBytes})`);
        }
        chunks.push(value);
    }
    const inflated = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        inflated.set(chunk, at);
        at += chunk.length;
    }
    return inflated;
}
