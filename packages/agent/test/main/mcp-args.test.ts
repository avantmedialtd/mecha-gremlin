import { describe, expect, test } from 'vitest';
import { type Command, readCommand } from '../../src/main/mcp-args.ts';

const SEE_HELP = 'bun run mcp help explains the command.';

const SHAPE = `add takes a server's name, and then a URL or, after --, a command: bun run mcp add <name> <url> [options], or bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`;

const ADVICE =
    "Give it as a reference, such as ${NAME}, to a variable set in .env, in single quotes, so that your shell leaves it alone. A secret typed on a command line is in the shell's history: change it.";

const DOCS = 'https://docs.example.com/mcp';

const TIMEOUTS = { startupTimeoutMs: 30000, toolTimeoutMs: 120000 };

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

type Added = Extract<Command, { readonly kind: 'add' }>;

/** What `add` read from these arguments, which must be readable. */
const added = (...args: readonly string[]): Added => {
    const read = readCommand(['add', ...args]);

    if (!read.ok) {
        throw new Error(read.error.join('\n'));
    }

    expect(read.value.kind).toBe('add');

    return read.value as Added;
};

const stored = (...args: readonly string[]): object => {
    return added(...args).checked.stored;
};

const problems = (...args: readonly string[]): string[] => {
    const read = readCommand(['add', ...args]);

    return read.ok ? [] : read.error;
};

const unknown = (option: string): string => {
    return `The option ${option} isn't known. A local server's command, with its own options, comes after --: bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`;
};

const needs = (option: string): string => {
    return `The option ${option} needs a value; one that starts with - is given as ${option}=<value>. ${SEE_HELP}`;
};

describe('The subcommands and their operands', () => {
    test('list, and the subcommands that take a name', () => {
        expect(readCommand(['list'])).toEqual({ ok: true, value: { kind: 'list' } });

        for (const kind of ['get', 'remove', 'disable', 'enable', 'logout']) {
            expect(readCommand([kind, 'docs'])).toEqual({
                ok: true,
                value: { kind, name: 'docs' },
            });
        }
    });

    test.each([
        [['list', 'extra'], `list takes no arguments. ${SEE_HELP}`],
        [['get'], `get takes a server's name: bun run mcp get <name>. ${SEE_HELP}`],
        [['remove'], `remove takes a server's name: bun run mcp remove <name>. ${SEE_HELP}`],
        [
            ['disable', 'a', 'b'],
            `disable takes a server's name: bun run mcp disable <name>. ${SEE_HELP}`,
        ],
        [['enable'], `enable takes a server's name: bun run mcp enable <name>. ${SEE_HELP}`],
        [['logout'], `logout takes a server's name: bun run mcp logout <name>. ${SEE_HELP}`],
        [
            ['start'],
            `Give one of the subcommands: add <name> <url>, add <name> -- <command>, list, get <name>, remove <name>, disable <name>, enable <name>, login <name> or logout <name>. ${SEE_HELP}`,
        ],
    ])('the usage error for %j', (args, problem) => {
        expect(readCommand(args)).toEqual({ ok: false, error: [problem] });
    });
});

describe('Describe a server with flags', () => {
    test('a remote server', () => {
        const { name, checked } = added(
            'github',
            'https://api.githubcopilot.com/mcp/',
            '--header',
            'Authorization: Bearer ${GITHUB_PAT}',
        );

        expect(name).toBe('github');
        expect(checked).toMatchObject({
            entry: { transport: 'http' },
            disabled: false,
            warnings: [],
        });
        expect(JSON.stringify(checked.stored)).toBe(
            '{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${GITHUB_PAT}"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
    });

    test('a local server', () => {
        const { name, checked } = added('playwright', '--', 'npx', '-y', '@playwright/mcp@0.0.83');

        expect(name).toBe('playwright');
        expect(checked).toMatchObject({ entry: { transport: 'stdio' }, warnings: [] });
        expect(JSON.stringify(checked.stored)).toBe(
            '{"command":"npx","args":["-y","@playwright/mcp@0.0.83"],"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
    });

    test("the command's own options", () => {
        expect(stored('tool', '--', 'server', '--header', 'x', '--env', 'y')).toEqual({
            command: 'server',
            args: ['--header', 'x', '--env', 'y'],
            ...TIMEOUTS,
        });
    });

    test('everything after the first --, another -- included', () => {
        expect(stored('tool', '--', 'server', '--', '--disabled')).toEqual({
            command: 'server',
            args: ['--', '--disabled'],
            ...TIMEOUTS,
        });
    });

    test('options before the name, and after it, with = or without', () => {
        expect(stored('--tool-timeout', '5m', 'docs', DOCS)).toEqual({
            url: DOCS,
            startupTimeoutMs: 30000,
            toolTimeoutMs: 300000,
        });
        expect(stored('--tool-timeout=5m', 'docs2', DOCS)).toEqual({
            url: DOCS,
            startupTimeoutMs: 30000,
            toolTimeoutMs: 300000,
        });
        expect(stored('docs', '--startup-timeout=1m', DOCS, '--tool-timeout', '1h')).toEqual({
            url: DOCS,
            startupTimeoutMs: 60000,
            toolTimeoutMs: 3600000,
        });
        expect(added('--disabled', 'local', '--cwd=/srv', '--', 'server').checked).toMatchObject({
            stored: { command: 'server', cwd: '/srv' },
            disabled: true,
        });
    });

    test('a variable passed through', () => {
        expect(
            stored('gh', '--env', 'GITHUB_TOKEN', '--env', 'LOG_LEVEL=info', '--', 'server'),
        ).toEqual({
            command: 'server',
            env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG_LEVEL: 'info' },
            ...TIMEOUTS,
        });
    });

    test('times', () => {
        expect(stored('docs', DOCS, '--startup-timeout', '90s', '--tool-timeout', '10m')).toEqual({
            url: DOCS,
            startupTimeoutMs: 90000,
            toolTimeoutMs: 600000,
        });
        expect(problems('docs', DOCS, '--tool-timeout', '30')).toEqual([
            '--tool-timeout needs a unit, as in 30s: ms, s, m or h.',
        ]);
        expect(problems('docs', DOCS, '--startup-timeout', '1.5m')).toEqual([
            '--startup-timeout must be a whole number and a unit, ms, s, m or h, as in 90s.',
        ]);
    });

    test('a command without --', () => {
        expect(problems('playwright', 'npx', '-y', '@playwright/mcp@0.0.83')).toEqual([
            `The option -y isn't known. A local server's command, with its own options, comes after --: bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`,
        ]);
    });

    test('not a URL', () => {
        const notUrl = `The second argument isn't a URL. A remote server's URL begins with https:// or http://, and a local server's command comes after --: bun run mcp add <name> <url> [options], or bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`;

        expect(problems('docs', 'docs.example.com/mcp')).toEqual([notUrl]);
        expect(problems('docs', ' https://docs.example.com/mcp')).toEqual([notUrl]);
        expect(problems('docs', 'xhttps://docs.example.com/mcp')).toEqual([notUrl]);
        expect(problems('docs', 'https:/docs.example.com/mcp')).toEqual([notUrl]);
        expect(problems('docs', 'HTTPS://docs.example.com/mcp')).toEqual([notUrl]);
    });

    test('both kinds, or neither', () => {
        expect(problems('docs', DOCS, '--', 'server')).toEqual([SHAPE]);
        expect(problems('docs', DOCS, '--')).toEqual([SHAPE]);
        expect(problems('docs')).toEqual([SHAPE]);
        expect(problems('docs', '--')).toEqual([SHAPE]);
        expect(problems()).toEqual([SHAPE]);
        expect(problems('--', 'server')).toEqual([SHAPE]);
        expect(problems('docs', DOCS, 'extra')).toEqual([SHAPE]);
        expect(problems('docs', 'extra', '--', 'server')).toEqual([SHAPE]);
    });

    test('an option for the other kind', () => {
        expect(problems('docs', DOCS, '--env', 'A=1', '--cwd', '/srv')).toEqual([
            '--env is for a local server only, whose command comes after --.',
            '--cwd is for a local server only, whose command comes after --.',
        ]);
        expect(problems('docs', DOCS, '--cwd', '/srv')).toEqual([
            '--cwd is for a local server only, whose command comes after --.',
        ]);
        expect(problems('files', '--header', 'A: b', '--', 'server')).toEqual([
            '--header is for a remote server only, whose URL follows its name.',
        ]);
    });

    test('an option without its value', () => {
        expect(problems('docs', DOCS, '--header')).toEqual([needs('--header')]);
        expect(problems('docs', DOCS, '--header', '--disabled')).toEqual([needs('--header')]);
        expect(problems('files', '--cwd', '-x', '--', 'server')).toEqual([needs('--cwd')]);
        expect(problems('files', '--cwd', '--', 'server')).toEqual([needs('--cwd')]);
    });

    test('a value that starts with -, after = or alone', () => {
        const relative = ['cwd must be an absolute path.'];

        expect(problems('files', '--cwd=-x', '--', 'server')).toEqual(relative);
        expect(problems('files', '--cwd', '-', '--', 'server')).toEqual(relative);
    });

    test('a value for --disabled', () => {
        expect(problems('docs', DOCS, '--disabled=true')).toEqual([
            `The option --disabled takes no value. ${SEE_HELP}`,
        ]);
    });

    test('an unknown option, by the name it was given', () => {
        expect(problems('docs', DOCS, '--colour=blue')).toEqual([unknown('--colour')]);
        expect(problems('docs', DOCS, '--Header', 'A: b')).toEqual([unknown('--Header')]);
        expect(problems('docs', DOCS, '-abc')).toEqual([unknown('-a')]);
        expect(problems('docs', DOCS, '--constructor')).toEqual([unknown('--constructor')]);
    });

    test('options that can be read, before one that cannot', () => {
        expect(problems('docs', DOCS, '--header', 'A: b', '--bogus')).toEqual([unknown('--bogus')]);
        expect(problems('docs', DOCS, '--disabled', '--bogus')).toEqual([unknown('--bogus')]);
        expect(problems('files', '--cwd=-x', '--bogus', '--', 'server')).toEqual([
            unknown('--bogus'),
        ]);
        expect(problems('files', '--cwd', '-', '--bogus', '--', 'server')).toEqual([
            unknown('--bogus'),
        ]);
    });

    test('only the first argument that cannot be read, and nothing else', () => {
        expect(problems('my docs', DOCS, '--bogus', '--header')).toEqual([unknown('--bogus')]);
        expect(problems('my docs', DOCS, '--header', '--bogus')).toEqual([needs('--header')]);
    });

    test('disabled at the start', () => {
        expect(added('docs', DOCS, '--disabled').checked).toMatchObject({
            stored: { url: DOCS, ...TIMEOUTS },
            disabled: true,
        });
        expect(added('docs', DOCS, '--disabled').checked.stored).not.toHaveProperty('disabled');
    });

    test('filters', () => {
        expect(stored('docs', DOCS, '--include-tool', 'a', '--include-tool', 'b')).toEqual({
            url: DOCS,
            includeTools: ['a', 'b'],
            ...TIMEOUTS,
        });
        expect(stored('docs', DOCS, '--exclude-tool', 'c')).toEqual({
            url: DOCS,
            excludeTools: ['c'],
            ...TIMEOUTS,
        });
        expect(problems('docs', DOCS, '--include-tool', 'b', '--exclude-tool', 'b')).toEqual([
            'includeTools and excludeTools both name "b".',
        ]);
    });

    test('every problem at once', () => {
        expect(
            problems('my docs', DOCS, '--tool-timeout', '30', '--header', 'Authorization'),
        ).toEqual([
            `The name "my docs" isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
            "A --header has no colon: give each as --header 'Name: value'.",
            '--tool-timeout needs a unit, as in 30s: ms, s, m or h.',
        ]);
    });

    test("every problem at once, the entry's own included", () => {
        expect(
            problems(
                'docs',
                'https://docs.example.com:6000/mcp',
                '--startup-timeout',
                '500ms',
                '--header',
                'Mcp-Session-Id: x',
            ),
        ).toEqual([
            '--startup-timeout must be from 1s to 2147483647ms, about 24 days.',
            'The url has the port 6000, which fetch refuses.',
            "The header Mcp-Session-Id is the transport's own, and can't be set.",
        ]);
    });

    test('a shape that is wrong, with the problems of its flags', () => {
        expect(problems('my docs', '--env', '=x', '--startup-timeout', '5')).toEqual([
            `The name "my docs" isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
            SHAPE,
            "An --env has no variable's name: give each as --env NAME=value, or --env NAME.",
            '--startup-timeout needs a unit, as in 30s: ms, s, m or h.',
        ]);
    });
});

describe('Headers and variables', () => {
    test('a header is split at its first colon, and its value trimmed', () => {
        expect(
            stored(
                'docs',
                DOCS,
                '--header',
                'X-Origin:  https://a.example/b  ',
                '--header',
                'X-Team:docs',
            ),
        ).toEqual({
            url: DOCS,
            headers: { 'X-Origin': 'https://a.example/b', 'X-Team': 'docs' },
            ...TIMEOUTS,
        });
    });

    test("a header's name is taken as written", () => {
        expect(problems('docs', DOCS, '--header', 'X-Team : docs')).toEqual([
            'The header name "X-Team " isn\'t an RFC 9110 token.',
        ]);
    });

    test('headers without a colon are reported once', () => {
        expect(
            problems('docs', DOCS, '--header', 'A', '--header', 'B: c', '--header', 'D'),
        ).toEqual(["A --header has no colon: give each as --header 'Name: value'."]);
    });

    test('a header given twice, as written or in another case', () => {
        expect(
            problems('docs', DOCS, '--header', 'A: 1', '--header', 'A: 2', '--header', 'A: 3'),
        ).toEqual(['--header names "A" twice.']);
        expect(problems('docs', DOCS, '--header', 'A: 1', '--header', 'a: 2')).toEqual([
            'The header a is given twice, ignoring case.',
        ]);
    });

    test('a variable is split at its first =', () => {
        expect(
            stored('files', '--env', 'A=b=c', '--env', 'B=', '--env', 'C', '--', 'server'),
        ).toEqual({
            command: 'server',
            env: { A: 'b=c', B: '', C: '${C}' },
            ...TIMEOUTS,
        });
    });

    test('a variable without a name', () => {
        const nameless = [
            "An --env has no variable's name: give each as --env NAME=value, or --env NAME.",
        ];

        expect(problems('files', '--env', '=x', '--', 'server')).toEqual(nameless);
        expect(problems('files', '--env', '', '--', 'server')).toEqual(nameless);
    });

    test('a variable given twice', () => {
        expect(problems('files', '--env', 'A=1', '--env', 'A', '--', 'server')).toEqual([
            '--env names "A" twice.',
        ]);
    });

    test('a variable named __proto__ is a variable like any other', () => {
        const entry = stored('files', '--env', '__proto__=x', '--', 'server');

        expect(JSON.stringify(entry)).toBe(
            '{"command":"server","env":{"__proto__":"x"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
    });
});

describe('Keep each server as an mcpServers entry', () => {
    test('the stored entry', () => {
        const { checked } = added('docs', DOCS);

        expect(JSON.stringify(checked.stored)).toBe(
            '{"url":"https://docs.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
        expect(checked.disabled).toBe(false);
    });

    test("every field of a local server, in the format's order", () => {
        expect(
            JSON.stringify(
                stored(
                    'files',
                    '--tool-timeout',
                    '30s',
                    '--exclude-tool',
                    'write',
                    '--include-tool',
                    'read',
                    '--cwd',
                    '/srv',
                    '--env',
                    'A=1',
                    '--startup-timeout',
                    '1m',
                    '--',
                    'server',
                    'x',
                ),
            ),
        ).toBe(
            '{"command":"server","args":["x"],"env":{"A":"1"},"cwd":"/srv","includeTools":["read"],"excludeTools":["write"],"startupTimeoutMs":60000,"toolTimeoutMs":30000}',
        );
    });

    test('a relative path', () => {
        expect(problems('files', '--', './server')).toEqual([
            "The command must be an absolute path, or a name without a slash that the server's PATH finds.",
        ]);
        expect(problems('files', '--cwd', 'servers/docs', '--', 'server')).toEqual([
            'cwd must be an absolute path.',
        ]);
    });

    test('a control character', () => {
        const found = problems('files', '--', 'server', 'ok', 'two\u0001words');

        expect(found).toEqual(['Argument 2 holds a control character.']);
        expect(found.join()).not.toContain('two\u0001words');
    });
});

describe('Give secrets only as references', () => {
    test('a header from the environment', () => {
        expect(stored('docs', DOCS, '--header', 'Authorization: Bearer ${DOCS_TOKEN}')).toEqual({
            url: DOCS,
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
            ...TIMEOUTS,
        });
    });

    test('a literal token', () => {
        const found = problems('docs', DOCS, '--header', 'Authorization: Bearer abc123def');

        expect(found).toEqual([`The header Authorization holds a literal secret. ${ADVICE}`]);
        expect(found.join()).not.toContain('abc123def');
    });

    test('a credential variable', () => {
        expect(problems('files', '--env', 'API_KEY=abc', '--', 'server')).toEqual([
            `The env variable API_KEY holds a literal secret. ${ADVICE}`,
        ]);

        for (const env of ['API_KEY=${API_KEY}', 'API_KEY']) {
            expect(stored('files', '--env', env, '--', 'server')).toEqual({
                command: 'server',
                env: { API_KEY: '${API_KEY}' },
                ...TIMEOUTS,
            });
        }
    });

    test("settings that aren't secrets", () => {
        expect(
            problems(
                'files',
                '--env',
                'MAX_TOKENS=4096',
                '--env',
                'AUTH_TYPE=none',
                '--env',
                'PRIVATE_KEY_PATH=/home/me/key.pem',
                '--',
                'server',
            ),
        ).toEqual([]);
    });

    test('a key in an option', () => {
        const found = problems('files', '--', 'server', '--api-key=abc123def');

        expect(found).toEqual([
            `The --api-key option in argument 1 holds a literal secret. ${ADVICE}`,
        ]);
        expect(found.join()).not.toContain('abc123def');
    });

    test('prefixes inside ordinary words', () => {
        expect(
            added('files', '--', 'npx', '-y', 'task-master-ai@0.30.0', '--disk-cache').checked
                .warnings,
        ).toEqual([]);
    });

    test("a token's shape", () => {
        const found = problems('files', '--', 'server', TOKEN);

        expect(found).toEqual([`Argument 1 holds text shaped like a token. ${ADVICE}`]);
        expect(found.join()).not.toContain(TOKEN);
    });

    test('a reference in the arguments', () => {
        expect(added('files', '--', 'server', '--api-key', '${KEY}').checked.warnings).toEqual([
            {
                message: 'mcp server secret in arguments',
                reason: 'Argument 2, after --api-key, holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.',
            },
        ]);
    });

    test('a default or a bare variable', () => {
        const defaulted = problems('files', '--env', 'TOKEN=${TOKEN:-abc123}', '--', 'server');

        expect(defaulted).toEqual([
            "The env variable TOKEN holds a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself.",
        ]);
        expect(defaulted.join()).not.toContain('abc123');
        expect(problems('files', '--env', 'DIR=$HOME/x', '--', 'server')).toEqual([
            "The env variable DIR holds $HOME, which isn't a reference: write ${HOME}.",
        ]);
    });

    test('a literal dollar', () => {
        expect(stored('files', '--', 'server', '$$5')).toEqual({
            command: 'server',
            args: ['$$5'],
            ...TIMEOUTS,
        });
    });

    test("the model's key", () => {
        expect(
            problems('docs', DOCS, '--header', 'Authorization: Bearer ${MODEL_API_KEY}'),
        ).toEqual([
            "The header Authorization holds a reference to MODEL_API_KEY, the model's key, which no server is given.",
        ]);
    });

    test('userinfo', () => {
        const found = problems('docs', 'https://user:pw@docs.example.com/mcp');

        expect(found).toEqual([`The url holds a user name or a password. ${ADVICE}`]);
        expect(found.join()).not.toContain('pw');
    });

    test('a reference in the host', () => {
        expect(problems('docs', 'https://${DOCS_HOST}/mcp')).toEqual([
            "The url holds a reference outside its path and query: a reference may appear only in a URL's path and query.",
        ]);
    });
});

describe('Check headers, URLs and timeouts', () => {
    test.each(['Mcp-Session-Id: x', 'content-type: text/plain'])(
        'a reserved header: %s',
        (header) => {
            const [name] = header.split(':');

            expect(problems('docs', DOCS, '--header', header)).toEqual([
                `The header ${name} is the transport's own, and can't be set.`,
            ]);
        },
    );

    test.each(['a\nb', '5 €'])("a header's value of %j", (value) => {
        expect(problems('docs', DOCS, '--header', `A: ${value}`)).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
        ]);
    });

    test('a bad port', () => {
        expect(problems('docs', 'https://docs.example.com:6000/mcp')).toEqual([
            'The url has the port 6000, which fetch refuses.',
        ]);
    });

    test('plain HTTP with a reference', () => {
        const plainHttp =
            'The url is plain http, but it or a header holds a reference: use https, since even a request to 127.0.0.1 may go through a proxy.';

        expect(
            problems('docs', 'http://127.0.0.1:8080/mcp', '--header', 'Authorization: Bearer ${T}'),
        ).toEqual([plainHttp]);
        expect(problems('docs', 'http://docs.example.com/s/${DOCS_SECRET}/mcp')).toEqual([
            plainHttp,
        ]);
        expect(stored('docs', 'http://127.0.0.1:8080/mcp')).toEqual({
            url: 'http://127.0.0.1:8080/mcp',
            ...TIMEOUTS,
        });
    });

    test.each(['500ms', '600h'])('seconds for milliseconds: %s', (time) => {
        expect(problems('docs', DOCS, '--tool-timeout', time)).toEqual([
            '--tool-timeout must be from 1s to 2147483647ms, about 24 days.',
        ]);
    });
});

describe('Warn about unpinned packages', () => {
    test('npx with a dist-tag', () => {
        expect(added('pw', '--', 'npx', '-y', '@playwright/mcp@latest').checked.warnings).toEqual([
            {
                message: 'mcp server unpinned',
                reason: "@playwright/mcp@latest isn't pinned to an exact version, so a run may start a version published later. Pin it, as in package@1.2.3.",
            },
        ]);
    });
});

type LoggingIn = Extract<Command, { readonly kind: 'login' }>;

const LOGIN_SHAPE = `login takes a server's name, and its options: bun run mcp login <name> [options]. ${SEE_HELP}`;

const REDIRECT_URI =
    '--redirect-uri must be an http address on 127.0.0.1 or localhost, with its port, as in http://127.0.0.1:8765/callback.';

const loginOf = (...args: readonly string[]): LoggingIn['login'] => {
    const read = readCommand(['login', ...args]);

    if (!read.ok) {
        throw new Error(read.error.join('\n'));
    }

    return (read.value as LoggingIn).login;
};

const loginProblems = (...args: readonly string[]): string[] => {
    const read = readCommand(['login', ...args]);

    return read.ok ? [] : read.error;
};

describe('Log in with options', () => {
    test('a name alone', () => {
        expect(readCommand(['login', 'docs'])).toEqual({
            ok: true,
            value: {
                kind: 'login',
                name: 'docs',
                login: {
                    clientId: undefined,
                    clientSecret: undefined,
                    redirectUri: undefined,
                    scope: undefined,
                },
            },
        });
    });

    test('every option, with = or without, before the name or after it', () => {
        const login = loginOf(
            '--client-id',
            'abc',
            'docs',
            '--client-secret=${DOCS_SECRET}',
            '--redirect-uri',
            'http://127.0.0.1:8765/callback',
            '--scope=read write',
        );

        expect(login).toEqual({
            clientId: 'abc',
            clientSecret: [{ variable: 'DOCS_SECRET' }],
            redirectUri: new URL('http://127.0.0.1:8765/callback'),
            scope: 'read write',
        });
    });

    test.each([[[]], [['docs', 'more']], [['--scope', 'read']]])(
        'a shape that is wrong: %j',
        (args) => {
            expect(loginProblems(...args)).toEqual([LOGIN_SHAPE]);
        },
    );

    test('an unknown option, and one that cannot be read', () => {
        expect(loginProblems('docs', '--client-ID', 'abc')).toEqual([
            `The option --client-ID isn't known. ${SEE_HELP}`,
        ]);
        expect(loginProblems('docs', '--constructor')).toEqual([
            `The option --constructor isn't known. ${SEE_HELP}`,
        ]);
        expect(loginProblems('docs', '--scope')).toEqual([needs('--scope')]);
        expect(loginProblems('docs', '--client-id', '--scope', 'read')).toEqual([
            needs('--client-id'),
        ]);
        expect(loginProblems('docs', '--client-id=-x', '--bogus')).toEqual([
            `The option --bogus isn't known. ${SEE_HELP}`,
        ]);
    });

    test.each([
        ['a literal', 'sesame'],
        ['a literal beside a reference', 'x${DOCS_SECRET}'],
        ['nothing', ''],
    ])('a client secret that is %s: refused, and not shown', (_name, secret) => {
        const refused = loginProblems('docs', '--client-id', 'abc', '--client-secret', secret);

        expect(refused).toEqual([`--client-secret holds a literal secret. ${ADVICE}`]);
    });

    test('a reference that breaks the rules', () => {
        expect(
            loginProblems('docs', '--client-id', 'abc', '--client-secret', '${SECRET:-x}'),
        ).toEqual([
            "--client-secret holds a reference with a default, ${SECRET…}, and defaults aren't supported: set SECRET itself.",
        ]);
    });

    test('two references, each a variable', () => {
        expect(
            loginOf('docs', '--client-id', 'abc', '--client-secret', '${A}${B}').clientSecret,
        ).toEqual([{ variable: 'A' }, { variable: 'B' }]);
    });

    test('a client secret without a client', () => {
        expect(loginProblems('docs', '--client-secret', '${DOCS_SECRET}')).toEqual([
            '--client-secret needs --client-id: it is the secret of the client that --client-id names.',
        ]);
    });

    test.each([
        'http://localhost:8765/oauth/back',
        'http://127.0.0.1:1/callback',
        'http://127.0.0.1:65535/',
    ])('a redirect URI a listener here can take: %s', (uri) => {
        expect(loginOf('docs', '--redirect-uri', uri).redirectUri).toEqual(new URL(uri));
    });

    test.each([
        'https://127.0.0.1:8765/callback',
        'http://example.com:8765/callback',
        'http://127.0.0.1/callback',
        'http://[::1]:8765/callback',
        'not a URL',
    ])('a redirect URI a listener here cannot take: %s', (uri) => {
        expect(loginProblems('docs', '--redirect-uri', uri)).toEqual([REDIRECT_URI]);
    });

    test('every problem at once', () => {
        expect(
            loginProblems('--client-secret', 'sesame', '--redirect-uri', 'https://x.example/'),
        ).toEqual([
            LOGIN_SHAPE,
            '--client-secret needs --client-id: it is the secret of the client that --client-id names.',
            `--client-secret holds a literal secret. ${ADVICE}`,
            REDIRECT_URI,
        ]);
    });
});
