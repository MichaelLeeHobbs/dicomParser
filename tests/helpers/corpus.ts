import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Shared corpus walker for the in-repo `testImages/` fixtures. Lives under
// `tests/` (not `tests/**/*.test.ts`) so vitest's suite `include` and the
// coverage `include: ['src/**']` both ignore it — it is test support, not a
// suite and not production code.

/** Absolute path to the in-repo fixture corpus. */
export const TEST_IMAGES = join(__dirname, '..', '..', 'testImages');

/**
 * Collects every DICOM fixture under {@link TEST_IMAGES} via an iterative queue
 * walk (no recursion — this file feeds parsers of untrusted input, and the
 * project standard bans recursion). Matches files ending `.dcm` or `_dfl`.
 *
 * @param root - Directory to walk; defaults to {@link TEST_IMAGES}.
 * @returns Absolute paths of matching fixtures.
 */
export function collectTestImages(root: string = TEST_IMAGES): string[] {
    const files: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
        const dir = queue.pop() as string;
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                queue.push(path);
            } else if (entry.endsWith('.dcm') || entry.endsWith('_dfl')) {
                files.push(path);
            }
        }
    }
    return files;
}
