import { describe, expect, test, vi } from "vitest";
import { type LogFormat, type Logger, createLogger, logFormat } from "../../src/log/log.ts";

const NOW = new Date(Date.UTC(2026, 9, 12, 7, 15, 51, 250));

/** NOW on the local clock. Pinning the time zone instead didn't take in every test runner. */
const CLOCK = [NOW.getHours(), NOW.getMinutes(), NOW.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

function written(format: LogFormat, log: (logger: Logger) => void): string[] {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
    });

    log(createLogger(format));
    return lines;
}

describe("logFormat", () => {
    test.each([
        [undefined, "pretty"],
        ["", "pretty"],
        ["pretty", "pretty"],
        ["json", "json"],
        ["JSON", undefined],
        ["xml", undefined],
    ])("%j means %j", (value, format) => {
        expect(logFormat(value)).toBe(format);
    });
});

describe("Formatted output", () => {
    test("a record is a line: the local time, the level and the message", () => {
        expect(written("pretty", (log) => log.info("asking"))).toEqual([`${CLOCK} INFO  asking`]);
    });

    test("levels line up", () => {
        const lines = written("pretty", (log) => {
            log.info("one");
            log.warn("two");
            log.error("three");
        });

        expect(lines).toEqual([`${CLOCK} INFO  one`, `${CLOCK} WARN  two`, `${CLOCK} ERROR three`]);
    });

    test("fields follow as key=value, in order", () => {
        const lines = written("pretty", (log) =>
            log.info("turn", { number: 1, seconds: 1.5, cached: true, usage: null, file: "a.txt" }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  turn number=1 seconds=1.5 cached=true usage=null file=a.txt`,
        ]);
    });

    test("a string that could be misread is quoted", () => {
        const lines = written("pretty", (log) =>
            log.info("asking", {
                question: "What runs?",
                empty: "",
                quote: 'say "hi"',
                pair: "a=b",
            }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  asking question="What runs?" empty="" quote="say \\"hi\\"" pair="a=b"`,
        ]);
    });

    test("objects and arrays are compact JSON", () => {
        const lines = written("pretty", (log) =>
            log.info("tool call", { arguments: { path: "a.txt" }, list: [1, "two"] }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  tool call arguments={"path":"a.txt"} list=[1,"two"]`,
        ]);
    });

    test("a multi-line string gets a block under the line", () => {
        const lines = written("pretty", (log) =>
            log.info("answer", { text: "It runs:\n\n    bun run check", tool: "read_file" }),
        );

        expect(lines).toEqual([
            `${CLOCK} INFO  answer tool=read_file\n  text:\n    It runs:\n    \n        bun run check`,
        ]);
    });

    test("an undefined field is left out", () => {
        const lines = written("pretty", (log) => log.info("turn", { number: 1, usage: undefined }));

        expect(lines).toEqual([`${CLOCK} INFO  turn number=1`]);
    });
});

describe("JSON output", () => {
    test("one JSON object per record, fields after the time, level and message", () => {
        const lines = written("json", (log) => {
            log.info("tool call", { tool: "read_file", arguments: { path: "a.txt" } });
            log.warn("tool failed", { error: "one\ntwo" });
            log.error("stopped", { usage: undefined });
        });

        expect(lines).toEqual([
            '{"time":"2026-10-12T07:15:51.250Z","level":"info","message":"tool call","tool":"read_file","arguments":{"path":"a.txt"}}',
            '{"time":"2026-10-12T07:15:51.250Z","level":"warn","message":"tool failed","error":"one\\ntwo"}',
            '{"time":"2026-10-12T07:15:51.250Z","level":"error","message":"stopped"}',
        ]);
    });
});
