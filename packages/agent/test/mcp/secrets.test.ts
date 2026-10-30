import { describe, expect, test } from 'vitest';
import { parseTemplate } from '../../src/mcp/references.ts';
import {
    holdsLiteralSecret,
    isCredentialName,
    secretShape,
    wordsOf,
} from '../../src/mcp/secrets.ts';

// Long enough for a token's shape.
const TAIL = 'A1b2C3d4E5f6G7h8I9j0';

describe('Split a name into words', () => {
    test.each([
        ['API_KEY', ['API', 'KEY']],
        ['x-api-key', ['X', 'API', 'KEY']],
        ['--api-key', ['API', 'KEY']],
        ['apiKey', ['API', 'KEY']],
        ['oauth2Token', ['OAUTH2', 'TOKEN']],
        ['APIKey', ['APIKEY']],
        ['db.password', ['DB', 'PASSWORD']],
        ['a b', ['A', 'B']],
    ])('%s', (name, words) => {
        expect(wordsOf(name)).toEqual(words);
    });
});

describe('Tell a credential slot by its name', () => {
    test.each([
        'API_KEY',
        'KEYS',
        'APIKEY',
        'GITHUB_TOKEN',
        'TOKENS',
        'CLIENT_SECRET',
        'SECRETS',
        'DB_PASSWORD',
        'PASSWORDS',
        'PASSWD',
        'PASS',
        'PASSPHRASE',
        'GITHUB_PAT',
        'AUTH',
        'Authorization',
        'CREDENTIAL',
        'CREDENTIALS',
        'Cookie',
        'x-api-key',
        '--api-key',
    ])('%s is one', (name) => {
        expect(isCredentialName(name)).toBe(true);
    });

    test.each([
        'GITHUB_OAUTH_CALLBACK_PORT',
        'PRIVATE_KEY_PATH',
        'TOKEN_FILE',
        'KEY_DIR',
        'MONKEY',
        'DEBUG',
        '',
    ])('%s is not', (name) => {
        expect(isCredentialName(name)).toBe(false);
    });
});

describe('A credential slot holds a reference', () => {
    test.each([
        ['abc', true],
        ['Bearer abc', true],
        ['${TOKEN}', false],
        ['Bearer ${TOKEN}', false],
        ['4096', false],
        ['-1.5', false],
        ['12.25', false],
        ['true', false],
        ['FALSE', false],
        ['none', false],
        ['12abc', true],
        ['nonexistent', true],
    ])('%s: literal secret %s', (raw, literal) => {
        expect(holdsLiteralSecret(parseTemplate(raw).template, raw)).toBe(literal);
    });
});

describe('Text shaped like a secret', () => {
    test.each([
        'ghp_',
        'github_pat_',
        'glpat-',
        'xoxb-',
        'xoxp-',
        'xoxa-',
        'sk-',
        'sk_live_',
        'rk_live_',
        'ntn_',
        'lin_api_',
    ])('a token starting %s, at the start or after a symbol', (prefix) => {
        expect(secretShape(`${prefix}${TAIL}`)).toBe('text shaped like a token');
        expect(secretShape(`--token=${prefix}${TAIL}`)).toBe('text shaped like a token');
        expect(secretShape(`x${prefix}${TAIL}`)).toBeUndefined();
        expect(secretShape(`${prefix}${TAIL.slice(0, 15)}`)).toBeUndefined();
    });

    test('a token with - and _ among its characters', () => {
        expect(secretShape('sk-proj_abc-DEF_123-456_78')).toBe('text shaped like a token');
    });

    test('prefixes inside ordinary words', () => {
        expect(secretShape('task-master-ai@0.30.0')).toBeUndefined();
        expect(secretShape('--disk-cache')).toBeUndefined();
        expect(secretShape('the1sk-abcdefghijklmnopqrstu')).toBeUndefined();
    });

    test('an AWS access key', () => {
        const key = `AKIA${'Q'.repeat(16)}`;

        expect(secretShape(key)).toBe('text shaped like a token');
        expect(secretShape(`id=AKIA${'7'.repeat(16)}`)).toBe('text shaped like a token');
        expect(secretShape(`AKIA${'q'.repeat(16)}`)).toBeUndefined();
        expect(secretShape(`X${key}`)).toBeUndefined();
        expect(secretShape(key.slice(0, -1))).toBeUndefined();
    });

    test.each([
        'Bearer abc123def',
        'bearer abc.def',
        `Basic ${btoa('user:pass')}`,
        'Authorization: Bearer YOUR_TOKEN',
        '{"Authorization":"Bearer x-y"}',
        `Basic\t${btoa('Aladdin:open')}==`,
        'BASIC a~b',
        'Bearer a+b',
        'Bearer a/b',
        'Bearer ab=',
        'Bearer  abc123def',
    ])('a credential written out: %s', (text) => {
        expect(secretShape(text)).toBe('a credential written out');
    });

    test.each([
        'Bearer ${TOKEN}',
        'Basic Authentication is supported',
        'basic usage',
        'Bearer TOKEN',
        'Basic ABCDEFGH',
        'xBearer abc123',
        'Bearer <your-token>',
    ])('not a credential written out: %s', (text) => {
        expect(secretShape(text)).toBeUndefined();
    });

    test('a JSON Web Token', () => {
        expect(secretShape('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')).toBe(
            'a JSON Web Token',
        );
        expect(secretShape('t=eyJ-_.eyJ_-.')).toBe('a JSON Web Token');
        expect(secretShape('eyJhbGciOiJIUzI1NiJ9.plain.x')).toBeUndefined();
        expect(secretShape('eyJ.eyJ.')).toBeUndefined();
    });

    test('a private key', () => {
        expect(secretShape('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('a private key');
        expect(secretShape('-----BEGIN PRIVATE KEY-----')).toBe('a private key');
        expect(secretShape('-----BEGIN PUBLIC KEY-----')).toBeUndefined();
    });

    test('a password in a URL, unless it is a reference', () => {
        expect(secretShape('mongodb+srv://username:password@cluster.example.net/db')).toBe(
            'a password in a URL',
        );
        expect(secretShape('postgres://u:pw@127.0.0.1/db and more')).toBe('a password in a URL');
        expect(secretShape('postgres://u:${DB_PASSWORD}@127.0.0.1/db')).toBeUndefined();
        expect(secretShape('postgres://u:${A}${B}@127.0.0.1/db')).toBeUndefined();
        expect(secretShape('postgres://u:x${A}@127.0.0.1/db')).toBe('a password in a URL');
        expect(secretShape('ssh://git@github.com/org/repo')).toBeUndefined();
        expect(secretShape('https://docs.example.com/a:b@c')).toBeUndefined();
    });

    test('ordinary text', () => {
        expect(secretShape('@playwright/mcp@0.0.83')).toBeUndefined();
        expect(secretShape('')).toBeUndefined();
    });
});
