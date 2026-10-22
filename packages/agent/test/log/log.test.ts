import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { type Fields, type LogFormat, type Logger, createLogger } from '../../src/log/log.ts';

const NOW = new Date(Date.UTC(2026, 9, 12, 7, 15, 51, 250));

/** NOW on the local clock. Pinning the time zone instead didn't take in every test runner. */
const CLOCK = [NOW.getHours(), NOW.getMinutes(), NOW.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');

const written = (format: LogFormat, log: (logger: Logger) => void): string[] => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
    });

    log(createLogger(format));

    return lines;
};

describe('Fields', () => {
    test("can't take the names the record uses itself", () => {
        expectTypeOf({ tool: 'read', usage: undefined }).toExtend<Fields>();
        expectTypeOf({ time: 'noon' }).not.toExtend<Fields>();
        expectTypeOf({ level: 'info' }).not.toExtend<Fields>();
        expectTypeOf({ message: 'hi' }).not.toExtend<Fields>();
    });
});

describe('Formatted output', () => {
    test('a record is a line: the local time, the level and the message', () => {
        expect(written('pretty', (log) => log.info('asking'))).toEqual([`${CLOCK} INFO  asking`]);
    });

    test('levels line up', () => {
        const lines = written('pretty', (log) => {
            log.info('one');
            log.warn('two');
            log.error('three');
        });

        expect(lines).toEqual([`${CLOCK} INFO  one`, `${CLOCK} WARN  two`, `${CLOCK} ERROR three`]);
    });

    test('fields follow as key=value, in order', () => {
        const lines = written('pretty', (log) =>
            log.info('model call', {
                step: 1,
                seconds: 1.5,
                cached: true,
                usage: null,
                file: 'a.txt',
            }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  model call step=1 seconds=1.5 cached=true usage=null file=a.txt`,
        ]);
    });

    test('a string that could be misread is quoted', () => {
        const lines = written('pretty', (log) =>
            log.info('asking', {
                question: 'What runs?',
                empty: '',
                quote: 'say "hi"',
                pair: 'a=b',
            }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  asking question="What runs?" empty="" quote="say \\"hi\\"" pair="a=b"`,
        ]);
    });

    test('objects and arrays are compact JSON', () => {
        const lines = written('pretty', (log) =>
            log.info('tool call', { arguments: { path: 'a.txt' }, list: [1, 'two'] }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  tool call arguments={"path":"a.txt"} list=[1,"two"]`,
        ]);
    });

    test('a multi-line string gets a block under the line', () => {
        const lines = written('pretty', (log) =>
            log.info('answer', { text: 'It runs:\n\n    bun run check', tool: 'read' }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  answer tool=read\n  text:\n    It runs:\n    \n        bun run check`,
        ]);
    });

    test('an undefined field is left out', () => {
        const lines = written('pretty', (log) =>
            log.info('model call', { step: 1, usage: undefined }),
        );

        expect(lines).toEqual([`${CLOCK} INFO  model call step=1`]);
    });

    test('a multi-line message keeps its first line in place, and its other lines come first', () => {
        const lines = written('pretty', (log) =>
            log.error('The model call failed.\nTry again.', {
                tool: 'read',
                text: 'one\ntwo',
            }),
        );

        expect(lines).toEqual([
            `${CLOCK} ERROR The model call failed. tool=read\n    Try again.\n  text:\n    one\n    two`,
        ]);
    });

    test('\\r\\n breaks lines as \\n does', () => {
        const lines = written('pretty', (log) => log.info('one\r\ntwo', { text: 'three\r\nfour' }));

        expect(lines).toEqual([`${CLOCK} INFO  one\n    two\n  text:\n    three\n    four`]);
    });
});

describe('JSON output', () => {
    test('one JSON object per record, fields after the time, level and message', () => {
        const lines = written('json', (log) => {
            log.info('tool call', { tool: 'read', arguments: { path: 'a.txt' } });
            log.warn('tool failed', { error: 'one\ntwo' });
            log.error('stopped', { usage: undefined });
        });

        expect(lines).toEqual([
            '{"time":"2026-10-12T07:15:51.250Z","level":"info","message":"tool call","tool":"read","arguments":{"path":"a.txt"}}',
            '{"time":"2026-10-12T07:15:51.250Z","level":"warn","message":"tool failed","error":"one\\ntwo"}',
            '{"time":"2026-10-12T07:15:51.250Z","level":"error","message":"stopped"}',
        ]);
    });

    test("an undefined field can't overwrite the record's own time, level or message", () => {
        const lines = written('json', (log) =>
            log.info('model call', { time: undefined, level: undefined, message: undefined }),
        );

        expect(lines).toEqual([
            '{"time":"2026-10-12T07:15:51.250Z","level":"info","message":"model call"}',
        ]);
    });
});
