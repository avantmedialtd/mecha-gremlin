import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts'],
        // The app reads globals that its tests fake; no fake may outlive its test.
        restoreMocks: true,
        unstubEnvs: true,
        unstubGlobals: true,
        // Under Bun, Vitest's own import of zod comes back without its `z` export, so zod goes
        // through Vite instead. Another package that loses an export this way joins the list;
        // the line can go once the tests pass on Bun without it.
        server: { deps: { inline: ['zod'] } },
    },
});
