import { type HistoryItem, type ToolOutcome, toFunctionTool } from "@mecha-gremlin/core";
import OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
    type LoopOptions,
    type LoopStep,
    MAX_TURNS,
    type TurnStats,
    runLoop,
} from "../../src/loop/loop.ts";
import { defineTool } from "../../src/tools/tool-handler.ts";
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
} from "../fake-model.ts";

const START: HistoryItem[] = [
    { role: "developer", content: "Read files before answering." },
    { role: "user", content: "What does the check script run?" },
];

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

function clientFor(fetch: ReturnType<typeof fakeFetch>["fetch"]): OpenAI {
    return new OpenAI({
        apiKey: "test-key",
        baseURL: "http://model.test/v1",
        maxRetries: 0,
        fetch,
    });
}

function stats(number: number, turnUsage: ResponseUsage = usage()): TurnStats {
    return { number, usage: turnUsage, seconds: 1.5 };
}

async function loop(server: FakeServer, options: Partial<LoopOptions> = {}) {
    const { fetch, turnBodies } = fakeFetch(server);
    const tool = recordingTool();
    // Every reading of the clock is 1.5 s after the last, so each turn takes 1.5 s.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1500));

    const steps: LoopStep[] = [];
    const run = runLoop(clientFor(fetch), {
        model: "test-model",
        tools: [tool.handler],
        history: START,
        ...options,
    });
    for await (const step of run) {
        steps.push(step);
    }

    return {
        steps,
        last: steps.at(-1),
        bodies: turnBodies(),
        paths: tool.paths,
        handler: tool.handler,
    };
}

const roundTrip = [reasoning(), call("read_file", { path: "package.json" }, "call_1")];

function readThenAnswer() {
    return script(
        () => completed(roundTrip),
        () => completed([message("Done.")]),
    );
}

describe("Alternate model turns and tool calls until the model answers", () => {
    test("an answer without tools", async () => {
        const { steps, bodies } = await loop({
            responses: script(() => completed([message("42")])),
        });

        expect(steps).toEqual([
            { kind: "answer", turn: stats(1), text: "42", history: [...START, message("42")] },
        ]);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({
            model: "test-model",
            input: START,
            stream: true,
            store: false,
        });
    });

    test("one tool round trip replays the whole history", async () => {
        const afterCall = [...START, ...roundTrip, output("call_1", "contents of package.json")];
        const { steps, bodies } = await loop({
            responses: script(
                () => completed(roundTrip, usage({ input_tokens: 100 })),
                () => completed([message("\n\nIt runs the checks.")], usage({ input_tokens: 200 })),
            ),
        });

        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toEqual(afterCall);
        expect(steps).toEqual([
            {
                kind: "calls",
                turn: stats(1, usage({ input_tokens: 100 })),
                calls: [
                    {
                        call: roundTrip[1],
                        outcome: { ok: true, output: "contents of package.json" },
                    },
                ],
                history: afterCall,
            },
            {
                kind: "answer",
                turn: stats(2, usage({ input_tokens: 200 })),
                text: "It runs the checks.",
                history: [...afterCall, message("\n\nIt runs the checks.")],
            },
        ]);
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
        const { last, paths } = await loop({
            responses: script(
                () => completed([a, b]),
                () => completed([message("Done.")]),
            ),
        });

        expect(paths).toEqual(["a.txt", "b.txt"]);
        expect(last?.history).toEqual([
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
        const { steps, last, bodies, paths } = await loop(endless);

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
        expect(steps.map((step) => step.kind)).toEqual([...Array(7).fill("calls"), "stop"]);
        expect(last).toEqual({
            kind: "stop",
            reason: "turn_limit",
            detail: "the model was still calling tools after 8 turns",
            turn: stats(8),
            history: expect.any(Array),
        });
        expect(last?.history.at(-1)).toEqual(
            output("call_7", "Error: not run: the turn limit was reached"),
        );
    });

    test("the caller can set another limit", async () => {
        const { last, bodies, paths } = await loop(endless, { maxTurns: 2 });

        expect(bodies).toHaveLength(2);
        expect(paths).toEqual(["f0.txt"]);
        expect(last).toMatchObject({ kind: "stop", reason: "turn_limit" });
    });
});

describe("End with a stop step, with the history so far", () => {
    test("a later turn fails", async () => {
        const { last } = await loop({
            responses: script(
                () => completed(roundTrip),
                () => httpError(500, "the engine fell over"),
            ),
        });

        expect(last).toEqual({
            kind: "stop",
            reason: "turn_failed",
            error: "server_error",
            status: 500,
            detail: expect.stringContaining("the engine fell over"),
            history: [...START, ...roundTrip, output("call_1", "contents of package.json")],
        });
    });

    test("no answer", async () => {
        const { steps, bodies } = await loop({
            responses: script(() => completed([reasoning()])),
        });

        expect(steps).toEqual([
            {
                kind: "stop",
                reason: "empty",
                detail: "the model's turn had neither tool calls nor text",
                turn: stats(1),
                history: [...START, reasoning()],
            },
        ]);
        expect(bodies).toHaveLength(1);
    });

    test("a history that can't be replayed", async () => {
        const broken = [...START, { type: "made_up" } as unknown as HistoryItem];
        const { steps, bodies } = await loop({}, { history: broken });

        expect(steps).toEqual([
            {
                kind: "stop",
                reason: "history",
                detail: expect.stringContaining("made_up"),
                history: broken,
            },
        ]);
        expect(bodies).toHaveLength(0);
    });
});

describe("Yield the result of each turn as it completes", () => {
    test("a turn's step comes before the next turn starts", async () => {
        const { fetch, turnBodies } = fakeFetch({ responses: readThenAnswer() });
        const steps = runLoop(clientFor(fetch), {
            model: "test-model",
            tools: [recordingTool().handler],
            history: START,
        });

        expect((await steps.next()).value).toMatchObject({ kind: "calls" });
        expect(turnBodies()).toHaveLength(1);

        expect((await steps.next()).value).toMatchObject({ kind: "answer" });
        expect(turnBodies()).toHaveLength(2);

        expect(await steps.next()).toEqual({ done: true, value: undefined });
    });

    test("a turn's calls carry their outcomes, failures included", async () => {
        const euro = recordingTool(async () => ({ ok: true, output: "€" }));
        const a = call("read_file", { path: "a" }, "call_a");
        const b = call("read_file", {}, "call_b");
        const { steps } = await loop(
            {
                responses: script(
                    () => completed([a, b]),
                    () => completed([message("Done.")]),
                ),
            },
            { tools: [euro.handler] },
        );

        expect(steps[0]).toMatchObject({
            kind: "calls",
            calls: [
                { call: a, outcome: { ok: true, output: "€" } },
                {
                    call: b,
                    outcome: {
                        ok: false,
                        error: expect.stringContaining("don't match its schema"),
                    },
                },
            ],
        });
    });
});
