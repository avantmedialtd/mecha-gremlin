import { describe, expect, test } from 'vitest';
import { commandEnv, copyVariables, serverEnv } from '../../src/exec/env.ts';

const NON_INTERACTIVE = {
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    DEBIAN_FRONTEND: 'noninteractive',
};

const FIXED = { ...NON_INTERACTIVE, PLAYWRIGHT_MCP_IDLE_TIMEOUT: '900000' };

const PARENT = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/example',
    USER: 'example',
    LOGNAME: 'example',
    TMPDIR: '/tmp/example/',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'C',
    MODEL_API_KEY: 'sk-secret',
    SHELL: '/bin/zsh',
};

const COPIED = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/example',
    USER: 'example',
    LOGNAME: 'example',
    TMPDIR: '/tmp/example/',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'C',
};

describe("The command's environment", () => {
    test('the copied variables that are set, the fixed values and the run', () => {
        const parentEnv = {
            PATH: '/usr/bin:/bin',
            HOME: '/Users/example',
            USER: 'example',
            LOGNAME: 'example',
            TMPDIR: '/tmp/example/',
            LANG: 'en_GB.UTF-8',
            LC_ALL: 'C',
            MODEL_API_KEY: 'sk-secret',
            SHELL: '/bin/zsh',
        };

        expect(commandEnv(parentEnv, 'a1b2c3d4')).toEqual({
            PATH: '/usr/bin:/bin',
            HOME: '/Users/example',
            USER: 'example',
            LOGNAME: 'example',
            TMPDIR: '/tmp/example/',
            LANG: 'en_GB.UTF-8',
            LC_ALL: 'C',
            ...FIXED,
            GREMLIN_RUN_ID: 'a1b2c3d4',
            PLAYWRIGHT_CLI_SESSION: 'gremlin-a1b2c3d4',
        });
    });

    test('unset variables are left out', () => {
        expect(commandEnv({ PATH: '/bin', HOME: undefined }, 'a1b2c3d4')).toStrictEqual({
            PATH: '/bin',
            ...FIXED,
            GREMLIN_RUN_ID: 'a1b2c3d4',
            PLAYWRIGHT_CLI_SESSION: 'gremlin-a1b2c3d4',
        });
    });

    test('only the names given are copied, and an empty value counts as set', () => {
        expect(copyVariables({ CI: 'false', PATH: '' }, ['PATH'])).toEqual({ PATH: '' });
    });
});

describe("An MCP server's environment", () => {
    test("the copied and non-interactive variables, the server's own, then the run", () => {
        expect(
            serverEnv(PARENT, { DOCS_TOKEN: 't0k', PATH: '/opt/bin' }, 'a1b2c3d4'),
        ).toStrictEqual({
            ...COPIED,
            ...NON_INTERACTIVE,
            DOCS_TOKEN: 't0k',
            PATH: '/opt/bin',
            GREMLIN_RUN_ID: 'a1b2c3d4',
        });
    });

    test("without playwright-cli's variables, and with the run's own ID whatever the server says", () => {
        const env = serverEnv({}, { GREMLIN_RUN_ID: 'mine', TERM: 'xterm' }, 'a1b2c3d4');

        expect(env).toStrictEqual({
            ...NON_INTERACTIVE,
            TERM: 'xterm',
            GREMLIN_RUN_ID: 'a1b2c3d4',
        });
        expect(Object.keys(env)).not.toContain('PLAYWRIGHT_MCP_IDLE_TIMEOUT');
        expect(Object.keys(env)).not.toContain('PLAYWRIGHT_CLI_SESSION');
    });
});
