import { describe, expect, test } from 'vitest';
import { commandEnv, copyVariables } from '../../src/exec/env.ts';

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
