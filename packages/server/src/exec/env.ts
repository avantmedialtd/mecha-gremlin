import type { Env } from '../config/config.ts';

const COPIED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'];

// C3's variables against prompts and pagers, NO_COLOR and TERM against colour codes, and
// playwright-cli's idle timeout, in milliseconds: an abandoned browser closes after 15 minutes
// rather than the default hour.
const FIXED = {
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    DEBIAN_FRONTEND: 'noninteractive',
    PLAYWRIGHT_MCP_IDLE_TIMEOUT: '900000',
};

export const copyVariables = (
    parentEnv: Env,
    names: readonly string[],
): Readonly<Record<string, string>> => {
    return Object.fromEntries(
        names.flatMap((name) => {
            const value = parentEnv[name];

            return value === undefined ? [] : [[name, value]];
        }),
    );
};

// Built from scratch, never from the server's own environment, which holds the user's shell's
// variables and .env's: a command that dumps or logs its environment can't leak them by accident
// (Brief C12). It doesn't stop a command that goes looking for them.
export const commandEnv = (parentEnv: Env, runId: string): Readonly<Record<string, string>> => {
    return {
        ...copyVariables(parentEnv, COPIED),
        ...FIXED,
        GREMLIN_RUN_ID: runId,
        // A browser of the run's own, rather than the `default` session every caller shares.
        PLAYWRIGHT_CLI_SESSION: `gremlin-${runId}`,
    };
};
