import { type HistoryItem, type ToolOutcome, toFunctionTool } from "@mecha-gremlin/core";
import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type LoopEvent, type LoopOptions, MAX_TURNS, runLoop } from "../src/loop.ts";
import { defineTool } from "../src/tool-handler.ts";
import {
    type FakeServer,
    call,
    completed,
    fakeFetch,
    httpError,
    message,
    reasoning,
    script,
    usage,
} from "./fake-model.ts";

const START: HistoryItem[] = [
    { role: "developer", content: "Read files before answering." },
    { role: "user", content: "What does the check script run?" },
];

/** A `read_file` stand-in that records the paths it is asked for. */
function recordingTool(
    run: (path: string) => Promise<ToolOutcome> = async (path) => ({
        ok: true,
        output: `contents of ${path}`,
    }),
) {
    const paths: string[] = [];
    const handler = defineTool(
        {
            name: "read_file",
            description: "Read a file",
            schema: z.strictObject({ path: z.string() }),
        },
        async ({ path }) => {
            paths.push(path);
            return run(path);
        },
    );
    return { handler, paths };
}

function output(callId: string, text: string): HistoryItem {
    return { type: "function_call_output", call_id: callId, output: text };
}

/** Runs the loop against a scripted model, with the recording tool unless told otherwise. */
async function loop(server: FakeServer, options: Partial<LoopOptions> = {}) {
    const { fetch, turnBodies } = fakeFetch(server);
    const client = new OpenAI({
        apiKey: "test-key",
        baseURL: "http://model.test/v1",
        maxRetries: 0,
        fetch,
    });
    const tool = recordingTool();
    const events: LoopEvent[] = [];
    let clock = 0;
    const result = await runLoop(client, {
        model: "test-model",
        tools: [tool.handler],
        history: START,
        onEvent: (event) => events.push(event),
        now: () => (clock += 1500),
        ...options,
    });
    return { result, bodies: turnBodies(), paths: tool.paths, events, handler: tool.handler };
}

const roundTrip = [reasoning(), call("read_file", { path: "package.json" }, "call_1")];

/** The model reads `package.json`, then answers. */
function readThenAnswer() {
    return script(
        () => completed(roundTrip),
        () => completed([message("Done.")]),
    );
}

describe("Alternate model turns and tool calls until the model answers", () => {
    test("an answer without tools", async () => {
        const { result, bodies } = await loop({
            responses: script(() => completed([message("42")])),
        });
        expect(result).toEqual({ ok: true, text: "42", history: [...START, message("42")] });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({
            model: "test-model",
            input: START,
            stream: true,
            store: false,
        });
    });

    test("one tool round trip replays the whole history", async () => {
        const { result, bodies } = await loop({
            responses: script(
                () => completed(roundTrip),
                () => completed([message("\n\nIt runs the checks.")]),
            ),
        });
        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toEqual([
            ...START,
            ...roundTrip,
            output("call_1", "contents of package.json"),
        ]);
        expect(result).toEqual({
            ok: true,
            text: "It runs the checks.",
            history: [
                ...START,
                ...roundTrip,
                output("call_1", "contents of package.json"),
                message("\n\nIt runs the checks."),
            ],
        });
    });

    test("tools are frozen for the run", async () => {
        const { bodies, handler } = await loop({ responses: readThenAnswer() });
        expect(bodies[0]?.tools).toEqual([toFunctionTool(handler.tool)]);
        expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    });

    test("reasoning settings go with every turn, when given", async () => {
        const withEffort = await loop(
            { responses: readThenAnswer() },
            { reasoning: { effort: "low" } },
        );
        expect(withEffort.bodies.map((body) => body?.reasoning)).toEqual([
            { effort: "low" },
            { effort: "low" },
        ]);

        const without = await loop({ responses: readThenAnswer() });
        expect(without.bodies.map((body) => body && "reasoning" in body)).toEqual([false, false]);
    });
});

describe("Run every call in order and answer each exactly once", () => {
    test("two calls in one turn", async () => {
        const a = call("read_file", { path: "a.txt" }, "call_a");
        const b = call("read_file", { path: "b.txt" }, "call_b");
        const { result, paths } = await loop({
            responses: script(
                () => completed([a, b]),
                () => completed([message("Done.")]),
            ),
        });
        expect(paths).toEqual(["a.txt", "b.txt"]);
        expect(result.history).toEqual([
            ...START,
            a,
            b,
            output("call_a", "contents of a.txt"),
            output("call_b", "contents of b.txt"),
            message("Done."),
        ]);
    });

    test("an unknown tool", async () => {
        const note = defineTool(
            {
                name: "take_note",
                description: "Take a note",
                schema: z.strictObject({ text: z.string() }),
            },
            async () => ({ ok: true, output: "noted" }),
        );
        const { bodies } = await loop(
            {
                responses: script(
                    () => completed([call("write_file", { path: "x.txt" })]),
                    () => completed([message("Done.")]),
                ),
            },
            { tools: [recordingTool().handler, note] },
        );
        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toContainEqual(
            output(
                "call_1",
                'Error: unknown tool "write_file"; available tools: read_file, take_note',
            ),
        );
    });

    test("invalid arguments", async () => {
        const { bodies, paths } = await loop({
            responses: script(
                () => completed([call("read_file", { file: "x.txt" })]),
                () => completed([message("Done.")]),
            ),
        });
        expect(paths).toEqual([]);
        expect(bodies[1]?.input).toContainEqual(
            output(
                "call_1",
                expect.stringMatching(
                    /^Error: The arguments for read_file don't match its schema:\n- path: /,
                ),
            ),
        );
    });

    test.each([
        [new Error("disk on fire"), "Error: read_file failed: disk on fire"],
        ["a thrown string", "Error: read_file failed: a thrown string"],
    ])("a handler that throws %j", async (thrown, expected) => {
        const failing = recordingTool(async () => {
            throw thrown;
        });
        const { bodies } = await loop(
            { responses: readThenAnswer() },
            { tools: [failing.handler] },
        );
        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toContainEqual(output("call_1", expected));
    });
});

describe("Stop at the turn limit", () => {
    const endless: FakeServer = {
        responses: (n) => completed([call("read_file", { path: `f${n}.txt` }, `call_${n}`)]),
    };

    test("the model never stops calling tools", async () => {
        expect(MAX_TURNS).toBe(8);
        const { result, bodies, paths } = await loop(endless);
        expect(bodies).toHaveLength(8);
        expect(paths).toEqual([
            "f0.txt",
            "f1.txt",
            "f2.txt",
            "f3.txt",
            "f4.txt",
            "f5.txt",
            "f6.txt",
        ]);
        expect(result).toMatchObject({
            ok: false,
            reason: "turn_limit",
            detail: "the model was still calling tools after 8 turns",
        });
        expect(result.history.at(-1)).toEqual(
            output("call_7", "Error: not run: the turn limit was reached"),
        );
    });

    test("the caller can set another limit", async () => {
        const { result, bodies, paths } = await loop(endless, { maxTurns: 2 });
        expect(bodies).toHaveLength(2);
        expect(paths).toEqual(["f0.txt"]);
        expect(result).toMatchObject({ ok: false, reason: "turn_limit" });
    });
});

describe("Return failures as values, with the history so far", () => {
    test("a later turn fails", async () => {
        const { result } = await loop({
            responses: script(
                () => completed(roundTrip),
                () => httpError(500, "the engine fell over"),
            ),
        });
        expect(result).toEqual({
            ok: false,
            reason: "turn_failed",
            error: "server_error",
            status: 500,
            detail: expect.stringContaining("the engine fell over"),
            history: [...START, ...roundTrip, output("call_1", "contents of package.json")],
        });
    });

    test("no answer", async () => {
        const { result, bodies } = await loop({
            responses: script(() => completed([reasoning()])),
        });
        expect(result).toEqual({
            ok: false,
            reason: "empty",
            detail: "the model's turn had neither tool calls nor text",
            history: [...START, reasoning()],
        });
        expect(bodies).toHaveLength(1);
    });

    test("a history that can't be replayed", async () => {
        const broken = [...START, { type: "made_up" } as unknown as HistoryItem];
        const { result, bodies } = await loop({}, { history: broken });
        expect(result).toEqual({
            ok: false,
            reason: "history",
            detail: expect.stringContaining("made_up"),
            history: broken,
        });
        expect(bodies).toHaveLength(0);
    });
});

describe("Report progress as it happens", () => {
    test("progress for a tool round trip", async () => {
        const { events } = await loop({
            responses: script(
                () => completed(roundTrip, usage({ input_tokens: 100 })),
                () => completed([message("Done.")], usage({ input_tokens: 200 })),
            ),
        });
        expect(events).toEqual([
            { type: "turn", turn: 1, usage: usage({ input_tokens: 100 }), seconds: 1.5 },
            { type: "call", name: "read_file", arguments: '{"path":"package.json"}' },
            { type: "result", name: "read_file", ok: true, bytes: 24 },
            { type: "turn", turn: 2, usage: usage({ input_tokens: 200 }), seconds: 1.5 },
        ]);
    });

    test("sizes are in bytes, and failures carry their error", async () => {
        const euro = recordingTool(async () => ({ ok: true, output: "€" }));
        const { events } = await loop(
            {
                responses: script(
                    () =>
                        completed([
                            call("read_file", { path: "a" }, "call_a"),
                            call("read_file", {}, "call_b"),
                        ]),
                    () => completed([message("Done.")]),
                ),
            },
            { tools: [euro.handler] },
        );
        expect(events.filter((event) => event.type === "result")).toEqual([
            { type: "result", name: "read_file", ok: true, bytes: 3 },
            {
                type: "result",
                name: "read_file",
                ok: false,
                error: expect.stringContaining("don't match its schema"),
            },
        ]);
    });

    test("turns are timed with performance.now unless told otherwise", async () => {
        const { events } = await loop(
            { responses: script(() => completed([message("Done.")])) },
            { now: undefined },
        );
        const seconds = events.map((event) => (event.type === "turn" ? event.seconds : -1));
        expect(seconds).toHaveLength(1);
        expect(Number.isFinite(seconds[0])).toBe(true);
        expect(seconds[0]).toBeGreaterThanOrEqual(0);
    });
});
