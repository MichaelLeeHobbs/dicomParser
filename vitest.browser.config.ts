import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Browser smoke suite (PLAN.md §9): proves the dependency-free bundle actually
// loads and runs in a real browser — no leaked Node APIs — and that the browser
// inflate path (DecompressionStream) works end to end. Runs only `*.browser.test.ts`.
//
// Locally (default) it uses the system-installed Chrome via Playwright's `chrome`
// channel — no chromium download needed. CI has no system Chrome, so it installs
// Playwright's bundled chromium and sets BROWSER_CHANNEL=chromium to select it
// (an empty launch config) — see .github/workflows/ci.yml.
const channel = process.env.BROWSER_CHANNEL ?? 'chrome';
const launch = channel === 'chromium' ? {} : { channel };

export default defineConfig({
    test: {
        include: ['tests/**/*.browser.test.ts'],
        browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium', launch }],
        },
    },
});
