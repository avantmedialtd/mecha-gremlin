import { describe, expect, test } from 'vitest';
import { headerNameProblems, headerValueProblems } from '../../src/mcp/headers.ts';
import { authorityEnd, urlProblems } from '../../src/mcp/urls.ts';

const ADVICE =
    "Give it as a reference, such as ${NAME}, to a variable set in .env, in single quotes, so that your shell leaves it alone. A secret typed on a command line is in the shell's history: change it.";

describe("Find where a URL's authority ends", () => {
    test.each([
        ['https://docs.example.com/mcp', 24],
        ['https://docs.example.com?q', 24],
        ['https://docs.example.com#f', 24],
        ['https://docs.example.com', 24],
        ['https://user:pw@host:8080/x', 25],
        ['no scheme here', 14],
        ['ab/cd', 5],
        ['x://', 4],
    ])('%s', (text, end) => {
        expect(authorityEnd(text)).toBe(end);
    });
});

describe("Check an MCP server's URL", () => {
    test.each([
        'https://docs.example.com/mcp',
        'http://127.0.0.1:8080/mcp?x=1',
        'https://docs.example.com:443/mcp',
        'https://docs.example.com:8443/mcp',
    ])('%s is fine', (url) => {
        expect(urlProblems('The url', url)).toEqual([]);
    });

    test.each([
        ['not a url', ["The url isn't a URL."]],
        ['ftp://docs.example.com/mcp', ['The url must start with https:// or http://.']],
        [
            'https://user:pw@docs.example.com/mcp',
            [`The url holds a user name or a password. ${ADVICE}`],
        ],
        [
            'https://user@docs.example.com/mcp',
            [`The url holds a user name or a password. ${ADVICE}`],
        ],
        [
            'https://:pw@docs.example.com/mcp',
            [`The url holds a user name or a password. ${ADVICE}`],
        ],
        ['https://docs.example.com/mcp#part', ['The url has a fragment.']],
        ['https://docs.example.com/mcp#', ['The url has a fragment.']],
        ['https://docs.example.com:6000/mcp', ['The url has the port 6000, which fetch refuses.']],
        ['http://127.0.0.1:10080/', ['The url has the port 10080, which fetch refuses.']],
        ['http://127.0.0.1:1/', ['The url has the port 1, which fetch refuses.']],
    ])('%s', (url, problems) => {
        expect(urlProblems('The url', url)).toEqual(problems);
        expect(JSON.stringify(problems)).not.toContain('pw');
    });

    test('every problem at once', () => {
        expect(urlProblems('The url', 'ws://u:p@h:6666/#f')).toEqual([
            'The url must start with https:// or http://.',
            `The url holds a user name or a password. ${ADVICE}`,
            'The url has a fragment.',
            'The url has the port 6666, which fetch refuses.',
        ]);
    });
});

describe("Check an MCP server's headers", () => {
    test('token names, given once ignoring case', () => {
        expect(headerNameProblems(['Authorization', 'X-Api-Key', "!#$%&'*+.^_`|~"])).toEqual([]);
        expect(headerNameProblems(['X-Trace', 'x-trace', 'X-TRACE'])).toEqual([
            'The header x-trace is given twice, ignoring case.',
            'The header X-TRACE is given twice, ignoring case.',
        ]);
        expect(headerNameProblems(['X Y', '', 'a:b'])).toEqual([
            'The header name "X Y" isn\'t an RFC 9110 token.',
            'The header name "" isn\'t an RFC 9110 token.',
            'The header name "a:b" isn\'t an RFC 9110 token.',
        ]);
    });

    test.each([
        'Accept',
        'Content-Type',
        'content-type',
        'Content-Length',
        'Host',
        'Connection',
        'Transfer-Encoding',
        'Last-Event-ID',
        'DPoP',
        'Mcp-Session-Id',
        'MCP-Protocol-Version',
        'mcp-x',
    ])('%s is the transport own', (name) => {
        expect(headerNameProblems([name])).toEqual([
            `The header ${name} is the transport's own, and can't be set.`,
        ]);
    });

    test('a name that only starts like a reserved one', () => {
        expect(headerNameProblems(['Mcp', 'Accept-Language', 'X-Mcp-Session'])).toEqual([]);
    });

    test('values', () => {
        expect(headerValueProblems('The header A', 'Bearer ${T}\t crème ÿ')).toEqual([]);
        expect(headerValueProblems('The header A', '')).toEqual(['The header A is empty.']);
        expect(headerValueProblems('The header A', 'a\nb')).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
        ]);
        expect(headerValueProblems('The header A', 'a\u007fb')).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
        ]);
        expect(headerValueProblems('The header A', '5 €')).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
        ]);
        expect(headerValueProblems('The header A', '\u{1F600}')).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
        ]);
    });
});
