import type { Env } from '../config/config.ts';

const COPIED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'];

// C3's variables against prompts and pagers, and NO_COLOR and TERM against colour codes.
const NON_INTERACTIVE = {
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    DEBIAN_FRONTEND: 'noninteractive',
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

// Built from scratch, never from the agent process's own environment, which holds the user's
// shell's variables and .env's: a process that dumps or logs its environment can't leak them by
// accident (Brief C12). It doesn't stop a process that goes looking for them.
const baseEnv = (parentEnv: Env): Readonly<Record<string, string>> => {
    return { ...copyVariables(parentEnv, COPIED), ...NON_INTERACTIVE };
};

export const commandEnv = (parentEnv: Env, runId: string): Readonly<Record<string, string>> => {
    return {
        ...baseEnv(parentEnv),
        // playwright-cli's idle timeout, in milliseconds: an abandoned browser closes after 15
        // minutes rather than the default hour.
        PLAYWRIGHT_MCP_IDLE_TIMEOUT: '900000',
        GREMLIN_RUN_ID: runId,
        // A browser of the run's own, rather than the `default` session every caller shares.
        PLAYWRIGHT_CLI_SESSION: `gremlin-${runId}`,
    };
};

// Without the playwright-cli variables, which would configure @playwright/mcp too (Brief R18.3).
// The run's ID comes last, so that the server's own can't replace it: the sweep and the tests'
// signal guard find the server's processes by it.
export const serverEnv = (
    parentEnv: Env,
    own: Readonly<Record<string, string>>,
    runId: string,
): Readonly<Record<string, string>> => {
    return { ...baseEnv(parentEnv), ...own, GREMLIN_RUN_ID: runId };
};
