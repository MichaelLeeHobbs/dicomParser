import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        // Browser-mode smoke tests run under vitest.browser.config.ts, not here.
        exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/index.ts'],
            thresholds: {
                statements: 95,
                branches: 90,
                functions: 95,
                lines: 95,
            },
        },
    },
});
