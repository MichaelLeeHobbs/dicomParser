/**
 * Fuzz-run scaling and the persisted crash-regression corpus (#45).
 *
 * The in-CI fuzz suite runs a small number of iterations per property so it
 * stays inside a PR's time budget; the nightly job re-runs the same properties
 * with `FUZZ_SCALE` set high (see `.github/workflows/fuzz.yml`). Any input that
 * ever tripped the parser is checked into `tests/fuzz-corpus/` and replayed on
 * every run, so a fixed crash can never silently come back.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directory of checked-in regression seeds, replayed on every fuzz run. */
export const FUZZ_CORPUS = join(__dirname, '..', 'fuzz-corpus');

/**
 * Multiplier for every property's `numRuns`, from `FUZZ_SCALE` (default 1).
 * The nightly job sets it high; PR runs keep the fast default.
 */
export function fuzzScale(): number {
    const raw = Number(process.env.FUZZ_SCALE ?? '1');
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Scales a baseline iteration count by {@link fuzzScale}.
 *
 * @param baseline - Iterations to run at the default scale
 * @returns The scaled count (at least 1)
 */
export function runs(baseline: number): number {
    return Math.max(1, Math.round(baseline * fuzzScale()));
}

/** One checked-in regression seed. */
export interface FuzzSeed {
    /** File name, which doubles as the case label. */
    readonly name: string;
    /** The raw input bytes to re-parse. */
    readonly bytes: Uint8Array;
}

/**
 * Loads the persisted crash-regression corpus.
 *
 * @returns Every seed in {@link FUZZ_CORPUS}, sorted by name (empty when absent)
 */
export function loadFuzzCorpus(): FuzzSeed[] {
    if (!existsSync(FUZZ_CORPUS)) {
        return [];
    }
    return readdirSync(FUZZ_CORPUS)
        .filter(name => name.endsWith('.bin'))
        .sort()
        .map(name => ({ name, bytes: new Uint8Array(readFileSync(join(FUZZ_CORPUS, name))) }));
}

/**
 * Writes a counterexample where the nightly job can upload it as an artifact,
 * so a newly-found crash arrives as bytes to commit rather than a seed number
 * to re-derive. No-op unless `FUZZ_ARTIFACT_DIR` is set.
 *
 * @param name - Case label, used as the file name stem
 * @param bytes - The failing input
 */
export function recordCounterexample(name: string, bytes: Uint8Array): void {
    const dir = process.env.FUZZ_ARTIFACT_DIR;
    if (dir === undefined || dir === '') {
        return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name.replace(/[^a-z0-9._-]/gi, '_')}.bin`), bytes);
}
