import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts'],
        // The app reads globals that its tests fake; no fake may outlive its test.
        restoreMocks: true,
        unstubEnvs: true,
        unstubGlobals: true,
    },
});
