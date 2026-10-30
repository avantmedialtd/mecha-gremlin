import { describe, expect, test } from 'vitest';
import { unpinned } from '../../src/mcp/pinning.ts';

const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

describe('npm packages, through npx and bunx', () => {
    test.each(['npx', 'bunx', '/opt/homebrew/bin/npx'])('%s', (command) => {
        expect(unpinned(command, ['-y', '@playwright/mcp'])).toBe('@playwright/mcp');
        expect(unpinned(command, ['-y', '@playwright/mcp@latest'])).toBe('@playwright/mcp@latest');
        expect(unpinned(command, ['-y', '@playwright/mcp@0.0.83'])).toBeUndefined();
    });

    test.each([
        [['-y', 'task-master-ai@0.30.0', '--disk-cache'], undefined],
        [['pkg@^1'], 'pkg@^1'],
        [['pkg@~1.2.3'], 'pkg@~1.2.3'],
        [['pkg@1.x'], 'pkg@1.x'],
        [['pkg@1.2'], 'pkg@1.2'],
        [['pkg@1.2.3-beta.1'], undefined],
        [['pkg@12.34.56'], undefined],
        [['@1.2.3'], '@1.2.3'],
        [['cmd', '-p', 'pkg@1.0.0'], undefined],
        [['cmd', '--package', 'pkg@1.0.0'], undefined],
        [['cmd', '--package=pkg'], 'pkg'],
        [['--packages', 'pkg@1.0.0'], undefined],
        [['pkg@1.2.3+build.5'], undefined],
        [['pkg@1.2.3.4'], 'pkg@1.2.3.4'],
        [['@scope/pkg'], '@scope/pkg'],
        [['-p', 'pkg@1.0.0', 'cmd'], undefined],
        [['-p', 'pkg', 'cmd@1.0.0'], 'pkg'],
        [['--package', 'pkg@latest', 'cmd'], 'pkg@latest'],
        [['--package=pkg@1.0.0', 'cmd'], undefined],
        [['--package=pkg', 'cmd@1.0.0'], 'pkg'],
        [['-y'], undefined],
        [[], undefined],
    ])('npx %j', (args, spec) => {
        expect(unpinned('npx', args)).toBe(spec);
    });
});

describe('Python packages, through uvx', () => {
    test.each([
        [['mcp-server-fetch'], 'mcp-server-fetch'],
        [['mcp-server-fetch==2026.10.28'], undefined],
        [['mcp-server-fetch@2026.10.28'], undefined],
        [['mcp-server-fetch==1.0.0rc1'], undefined],
        [['mcp-server-fetch==1.0.post2'], undefined],
        [['mcp-server-fetch==1.0.dev3'], undefined],
        [['mcp-server-fetch==1.0rc12'], undefined],
        [['mcp-server-fetch==1.0.post12'], undefined],
        [['mcp-server-fetch==1.0.dev12'], undefined],
        [['mcp-server-fetch==x1.0'], 'mcp-server-fetch==x1.0'],
        [['mcp-server-fetch@1.0==x'], 'mcp-server-fetch@1.0==x'],
        [['cmd', '--from', 'pkg==1.0'], undefined],
        [['mcp-server-fetch==1.*'], 'mcp-server-fetch==1.*'],
        [['mcp-server-fetch>=1.0'], 'mcp-server-fetch>=1.0'],
        [['mcp-server-fetch@latest'], 'mcp-server-fetch@latest'],
        [['pkg[extra]==2.0'], undefined],
        [['--from', 'pkg==1.0', 'cmd'], undefined],
        [['--from', 'pkg', 'cmd==1.0'], 'pkg'],
        [['--from=pkg==1.0', 'cmd'], undefined],
    ])('uvx %j', (args, spec) => {
        expect(unpinned('uvx', args)).toBe(spec);
    });
});

describe('Images, through docker run', () => {
    test.each([
        [['run', '-i', '--rm', 'ghcr.io/example/server'], 'ghcr.io/example/server'],
        [['run', '-i', '--rm', `ghcr.io/example/server@${DIGEST}`], undefined],
        [['run', 'ghcr.io/example/server:latest'], 'ghcr.io/example/server:latest'],
        [['run', 'ghcr.io/example/server:1.2'], undefined],
        [['run', 'localhost:5000/server'], 'localhost:5000/server'],
        [['run', 'localhost:5000/server:2'], undefined],
        [['run', 'server@sha256:abc'], 'server@sha256:abc'],
        [['run', `server@${DIGEST}x`], `server@${DIGEST}x`],
        [['run', 'img:1', 'server'], undefined],
        [['run', '-e', 'A', '-e', 'B', 'img'], 'img'],
        [['run', '-it', '--rm', '-e=X', 'img:3'], undefined],
        [['run', '--rm'], undefined],
        [['ps'], undefined],
        [['--context', 'x', 'run', 'img'], undefined],
        [[], undefined],
    ])('docker %j', (args, spec) => {
        expect(unpinned('docker', args)).toBe(spec);
    });

    test.each([
        '-e',
        '--env',
        '--env-file',
        '-v',
        '--volume',
        '--mount',
        '--name',
        '--network',
        '-w',
        '--workdir',
        '-u',
        '--user',
        '-p',
        '--publish',
        '--platform',
        '--pull',
        '--entrypoint',
        '-l',
        '--label',
    ])('%s takes the next argument as its value', (option) => {
        expect(unpinned('docker', ['run', option, 'value', 'img:1'])).toBeUndefined();
        expect(unpinned('docker', ['run', option, 'value', 'img'])).toBe('img');
    });
});

test('other commands are left alone', () => {
    expect(unpinned('node', ['server.js'])).toBeUndefined();
    expect(unpinned('npm', ['exec', 'pkg'])).toBeUndefined();
});
