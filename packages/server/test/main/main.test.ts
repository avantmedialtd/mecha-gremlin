import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseOutputItem, ResponseUsage } from "openai/resources/responses/responses";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { MAX_TURNS } from "../../src/loop/loop.ts";
import {
    type FakeServer,
    call,
    completed,
    fakeFetch,
    httpError,
    message,
    reasoning,
    script,
} from "../fake-model.ts";

// main.ts runs as soon as it's imported, so it's never imported here at the top: `hello` fakes
// the globals it reads, then imports it afresh. Its question texts are spelled out for the same
// reason.
const DEFAULT_QUESTION = "What exact command does the check script run? Quote it.";
const FILE_QUESTION = "What is this file for? Answer in two or three sentences.";

/** Each test sets or clears all of these, so settings in your shell can't leak in. */
const SETTINGS = [
    "MODEL_PROVIDER",
    "MODEL_BASE_URL",
    "MODEL_API_KEY",
    "MODEL",
    "MODEL_REASONING_EFFORT",
] as const;
type Settings = Partial<Record<(typeof SETTINGS)[number], string>>;

const PACKAGE_JSON = `${JSON.stringify({ scripts: { check: "bun run lint && bun run test" } }, null, 4)}\n`;
const MENU = "Café crème: 3 €\n";

let cwd: string;

beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "hello-"));
    await writeFile(join(cwd, "package.json"), PACKAGE_JSON);
    await writeFile(join(cwd, "menu.txt"), MENU);
});

afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
});

afterEach(() => {
    process.exitCode = undefined;
});

/** Vitest replaces `console` in its workers, so spying on the output streams wouldn't see it. */
function capture(method: "log" | "error") {
    let text = "";
    const spy = vi.spyOn(console, method).mockImplementation((line: unknown) => {
        text += `${String(line)}\n`;
    });

    return { text: () => text, restore: () => spy.mockRestore() };
}

async function hello(env: Settings = {}, server: FakeServer = {}, args: string[] = []) {
    for (const name of SETTINGS) {
        vi.stubEnv(name, env[name]);
    }

    const { fetch, requests } = fakeFetch(server);
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    // Every reading of the clock is 1.5 s after the last, so each turn takes 1.5 s.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1500));

    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), "main.ts", ...args];
    const stdout = capture("log");
    const stderr = capture("error");
    try {
        // A module runs only once until the registry is reset.
        vi.resetModules();
        await import("../../src/main/main.ts");
    } finally {
        process.argv = argv;
        stdout.restore();
        stderr.restore();
    }

    const turns = requests.filter((request) => request.url.endsWith("/v1/responses"));
    return {
        code: process.exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        requests,
        turns,
        turn: turns[0],
    };
}

const readThenAnswer: FakeServer = {
    responses: script(
        () => completed([reasoning(), call("read_file", { path: "package.json" })]),
        () => completed([message("\n\nIt runs the checks.")]),
    ),
};

describe("Ask the model a question about a file and print the answer", () => {
    test("the default question", async () => {
        const { turn } = await hello();

        expect(turn?.body?.input).toEqual([
            { role: "developer", content: expect.stringContaining("read_file") },
            { role: "user", content: `File: package.json\nQuestion: ${DEFAULT_QUESTION}` },
        ]);
    });

    test("the file and question come from the arguments", async () => {
        const { turn } = await hello({}, {}, ["README.md", "Which", "runtime?"]);

        expect(turn?.body?.input).toContainEqual({
            role: "user",
            content: "File: README.md\nQuestion: Which runtime?",
        });
    });

    test("a file alone gets a question about its purpose", async () => {
        const { turn } = await hello({}, {}, ["README.md"]);

        expect(turn?.body?.input).toContainEqual({
            role: "user",
            content: `File: README.md\nQuestion: ${FILE_QUESTION}`,
        });
    });

    test("the model can read files with read_file", async () => {
        const { turn } = await hello();

        expect(turn?.body?.tools).toEqual([
            expect.objectContaining({ type: "function", name: "read_file", strict: true }),
        ]);
    });

    test("the answer after reading the file", async () => {
        const { code, stdout, turns } = await hello({}, readThenAnswer);

        expect(code).toBe(0);
        expect(stdout).toBe("It runs the checks.\n");
        expect(turns).toHaveLength(2);
        expect(turns[1]?.body?.input).toContainEqual({
            type: "function_call_output",
            call_id: "call_1",
            output: PACKAGE_JSON,
        });
    });
});

describe("Report each tool call and turn on stderr", () => {
    test("the progress of a tool round trip", async () => {
        const { stdout, stderr } = await hello({}, readThenAnswer);

        expect(stderr).toContain(
            "Asking prism-ml/bonsai-27b at http://127.0.0.1:1234/v1 about package.json…\n",
        );
        expect(stderr).toContain('→ read_file {"path":"package.json"}\n');
        expect(stderr).toContain(`← ${Buffer.byteLength(PACKAGE_JSON)} bytes\n`);
        expect(stderr).toContain(
            "Turn 1: 349 input tokens (256 cached), 26 output (12 reasoning), 1.5 s\n",
        );
        expect(stderr).toContain("Turn 2: ");
        expect(stdout).toBe("It runs the checks.\n");
    });

    test("sizes are in bytes, not characters", async () => {
        const { stderr } = await hello(
            {},
            {
                responses: script(
                    () => completed([call("read_file", { path: "menu.txt" })]),
                    () => completed([message("A café crème costs 3 €.")]),
                ),
            },
        );

        expect(Buffer.byteLength(MENU)).toBeGreaterThan(MENU.length);
        expect(stderr).toContain(`← ${Buffer.byteLength(MENU)} bytes\n`);
    });

    test("a failed call shows its error", async () => {
        const { stderr } = await hello(
            {},
            {
                responses: script(
                    () => completed([call("read_file", { path: ".env" })]),
                    () => completed([message("I can't read that.")]),
                ),
            },
        );

        expect(stderr).toContain(
            '← Error: ".env" is an environment file. read_file doesn\'t read those: they hold secrets.\n',
        );
    });

    test("a multi-line error stays indented under its call", async () => {
        const { stderr } = await hello(
            {},
            {
                responses: script(
                    () => completed([call("read_file", { file: "package.json" })]),
                    () => completed([message("Sorry.")]),
                ),
            },
        );

        expect(stderr).toContain(
            "← Error: The arguments for read_file don't match its schema:\n  - ",
        );
    });

    test("a turn without usage still reports its time", async () => {
        const noUsage = new Response(
            `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: {
                    id: "r",
                    object: "response",
                    status: "completed",
                    output: [message("Hi.")],
                },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
        );
        const { stderr } = await hello({}, { responses: () => noUsage });

        expect(stderr).toContain("Turn 1: 1.5 s\n");
    });

    test("usage without token details counts those as zero", async () => {
        // Some OpenAI-compatible servers report only the totals.
        const totals = { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as ResponseUsage;
        const { stderr } = await hello(
            {},
            { responses: () => completed([message("Hi.")], totals) },
        );

        expect(stderr).toContain(
            "Turn 1: 10 input tokens (0 cached), 5 output (0 reasoning), 1.5 s\n",
        );
    });
});

describe("Actionable failures", () => {
    test("the turn limit", async () => {
        const { code, stdout, stderr, turns } = await hello(
            {},
            {
                responses: (n) =>
                    completed([call("read_file", { path: "package.json" }, `call_${n}`)]),
            },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(turns).toHaveLength(MAX_TURNS);
        expect(stderr).toContain(`The model didn't answer within ${MAX_TURNS} turns`);
    });

    test("no answer", async () => {
        const { code, stdout, stderr } = await hello(
            {},
            { responses: script(() => completed([reasoning()])) },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("The model gave no answer");
    });

    test("an item the SDK can't replay", async () => {
        const strange = { type: "made_up" } as unknown as ResponseOutputItem;
        const { code, stdout, stderr } = await hello(
            {},
            {
                responses: script(() =>
                    completed([strange, call("read_file", { path: "package.json" })]),
                ),
            },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("The conversation can't be continued");
        expect(stderr).toContain("made_up");
    });

    test("a failed turn prints nothing on stdout and exits 1", async () => {
        const { code, stdout, stderr } = await hello(
            {},
            { responses: () => httpError(500, "model crashed") },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("The turn failed (server_error, HTTP 500)");
        expect(stderr).toContain("model crashed");
    });

    test("a failed turn without a status", async () => {
        const { code, stderr } = await hello(
            {},
            {
                responses: () =>
                    new Response(
                        `event: response.failed\ndata: ${JSON.stringify({
                            type: "response.failed",
                            response: {
                                id: "r",
                                object: "response",
                                status: "failed",
                                output: [],
                                error: { code: "server_error", message: "it broke" },
                            },
                        })}\n\n`,
                        { headers: { "content-type": "text/event-stream" } },
                    ),
            },
        );

        expect(code).toBe(1);
        expect(stderr).toContain("The turn failed (failed): server_error: it broke");
    });

    test("an unreachable model server", async () => {
        const { code, stderr } = await hello(
            {},
            {
                responses: () => {
                    throw new TypeError("Unable to connect");
                },
            },
        );

        expect(code).toBe(1);
        expect(stderr).toContain("Can't reach http://127.0.0.1:1234/v1");
        expect(stderr).toContain("Check MODEL_BASE_URL.");
    });
});

describe("run with LM Studio (the default provider)", () => {
    test("asks the loaded model and prints only the answer on stdout", async () => {
        const { code, stdout, stderr, turn } = await hello();

        expect(code).toBe(0);
        expect(stdout).toBe("Hi there!\n");
        // With one model loaded there's no note about the choice: the first line is the question's.
        expect(stderr.split("\n")[0]).toBe(
            "Asking prism-ml/bonsai-27b at http://127.0.0.1:1234/v1 about package.json…",
        );
        expect(stderr).toContain("26 output (12 reasoning), 1.5 s");
        expect(turn?.url).toBe("http://127.0.0.1:1234/v1/responses");
        expect(turn?.body).toMatchObject({
            model: "prism-ml/bonsai-27b",
            reasoning: { effort: "none" },
            stream: true,
            store: false,
        });
    });

    test("passes the configured reasoning effort through", async () => {
        const { code, turn } = await hello({ MODEL_REASONING_EFFORT: "low" });

        expect(code).toBe(0);
        expect(turn?.body).toMatchObject({ reasoning: { effort: "low" } });
    });

    test("invalid config fails before any network call", async () => {
        const { code, stdout, stderr, requests } = await hello({ MODEL_BASE_URL: "lmstudio" });

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("MODEL_BASE_URL");
        expect(requests).toHaveLength(0);
    });

    test("an unreachable LM Studio fails with a hint", async () => {
        const { code, stdout, stderr } = await hello(
            {},
            {
                models: () => {
                    throw new TypeError("Unable to connect");
                },
            },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("lms server start");
    });

    test("a rejected key fails with LM Studio's hint", async () => {
        const { code, stderr } = await hello(
            {},
            { models: () => new Response("denied", { status: 401 }) },
        );

        expect(code).toBe(1);
        expect(stderr).toContain("Require Authentication");
        expect(stderr).toContain("MODEL_API_KEY");
    });

    test("a configured model that isn't loaded sends no turn", async () => {
        const { code, stderr, turn } = await hello({ MODEL: "qwen2.5-0.5b-instruct-mlx" });

        expect(code).toBe(1);
        expect(stderr).toContain("lms load qwen2.5-0.5b-instruct-mlx");
        expect(turn).toBeUndefined();
    });

    test("with several models loaded, says which it chose and how to choose another", async () => {
        const twoLoaded = {
            models: [
                {
                    type: "llm",
                    key: "prism-ml/bonsai-27b",
                    loaded_instances: [{ id: "prism-ml/bonsai-27b" }],
                },
                {
                    type: "llm",
                    key: "qwen2.5-0.5b-instruct-mlx",
                    loaded_instances: [{ id: "qwen2.5-0.5b-instruct-mlx" }],
                },
            ],
        };
        const { code, stderr, turn } = await hello({}, { models: () => Response.json(twoLoaded) });

        expect(code).toBe(0);
        expect(stderr).toContain(
            "Using prism-ml/bonsai-27b, the first of 2 loaded models (prism-ml/bonsai-27b, qwen2.5-0.5b-instruct-mlx). Set MODEL to choose another.\n",
        );
        expect(turn?.body).toMatchObject({ model: "prism-ml/bonsai-27b" });
    });
});

describe("run with another OpenAI-compatible provider", () => {
    const openai = { MODEL_PROVIDER: "openai", MODEL_API_KEY: "sk-test", MODEL: "gpt-test" };

    test("uses the named model without asking LM Studio, and the model's own reasoning default", async () => {
        const { code, stdout, requests, turn } = await hello(openai);

        expect(code).toBe(0);
        expect(stdout).toBe("Hi there!\n");
        expect(requests.some((request) => request.url.endsWith("/api/v1/models"))).toBe(false);
        expect(turn).toMatchObject({
            url: "https://api.openai.com/v1/responses",
            authorization: "Bearer sk-test",
            body: { model: "gpt-test" },
        });
        expect(turn?.body).not.toHaveProperty("reasoning");
    });

    test("needs MODEL and MODEL_API_KEY, and fails before any network call", async () => {
        const { code, stderr, requests } = await hello({ MODEL_PROVIDER: "openai" });

        expect(code).toBe(1);
        expect(stderr).toContain("MODEL_API_KEY is required");
        expect(stderr).toContain("MODEL is required");
        expect(requests).toHaveLength(0);
    });

    test("a rejected key points at MODEL_API_KEY, not at LM Studio", async () => {
        const { code, stderr } = await hello(openai, {
            responses: () => httpError(401, "bad key"),
        });

        expect(code).toBe(1);
        expect(stderr).toContain("MODEL_API_KEY");
        expect(stderr).not.toContain("LM Studio");
    });

    test("a forbidden key reports its own status", async () => {
        const { code, stderr } = await hello(openai, {
            responses: () => httpError(403, "forbidden"),
        });

        expect(code).toBe(1);
        expect(stderr).toContain("rejected the API key (HTTP 403)");
    });
});
