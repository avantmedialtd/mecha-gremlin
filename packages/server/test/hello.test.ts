import { describe, expect, test } from "vitest";
import { GREETING, run } from "../src/hello.ts";
import type { Fetch } from "../src/lmstudio.ts";

const loadedBonsai = {
    models: [
        { type: "llm", key: "qwen2.5-0.5b-instruct-mlx", loaded_instances: [] },
        {
            type: "llm",
            key: "prism-ml/bonsai-27b",
            loaded_instances: [{ id: "prism-ml/bonsai-27b" }],
        },
    ],
};

function completedTurn(text: string): Response {
    const response = {
        id: "resp_1",
        object: "response",
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [
            {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text, annotations: [] }],
            },
        ],
        usage: {
            input_tokens: 9,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 16,
        },
    };
    const body = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

interface FakeLmStudio {
    models?: () => Response;
    responses?: () => Response;
}

/** Runs the hello against a fake LM Studio and captures everything it does. */
async function hello(env: Record<string, string> = {}, lmstudio: FakeLmStudio = {}) {
    const requests: { url: string; body: unknown }[] = [];
    const fetch: Fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
            url,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.endsWith("/api/v1/models"))
            return lmstudio.models?.() ?? Response.json(loadedBonsai);
        if (url.endsWith("/v1/responses"))
            return lmstudio.responses?.() ?? completedTurn("Hi there!");
        return new Response("not found", { status: 404 });
    };
    let stdout = "";
    let stderr = "";
    let clock = 0;
    const code = await run({
        env,
        fetch,
        stdout: (text) => void (stdout += text),
        stderr: (text) => void (stderr += text),
        now: () => (clock += 1500),
    });
    return { code, stdout, stderr, requests };
}

describe("run", () => {
    test("says hi to the loaded model and prints only the reply on stdout", async () => {
        const { code, stdout, stderr, requests } = await hello();

        expect(code).toBe(0);
        expect(stdout).toBe("Hi there!\n");
        expect(stderr).toContain("prism-ml/bonsai-27b");
        expect(stderr).toContain("7 output tokens");
        expect(stderr).toContain("1.5 s");

        const turn = requests.find((request) => request.url.endsWith("/v1/responses"));
        expect(turn?.url).toBe("http://127.0.0.1:1234/v1/responses");
        expect(turn?.body).toMatchObject({
            model: "prism-ml/bonsai-27b",
            input: GREETING,
            reasoning: { effort: "none" },
            stream: true,
            store: false,
        });
    });

    test("passes the configured reasoning effort through", async () => {
        const { code, requests } = await hello({ LMSTUDIO_REASONING_EFFORT: "low" });

        expect(code).toBe(0);
        const turn = requests.find((request) => request.url.endsWith("/v1/responses"));
        expect(turn?.body).toMatchObject({ reasoning: { effort: "low" } });
    });

    test("invalid config fails before any network call", async () => {
        const { code, stdout, stderr, requests } = await hello({ LMSTUDIO_BASE_URL: "lmstudio" });

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("LMSTUDIO_BASE_URL");
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

    test("a rejected token fails with a hint", async () => {
        const { code, stderr } = await hello(
            {},
            { models: () => new Response("denied", { status: 401 }) },
        );

        expect(code).toBe(1);
        expect(stderr).toContain("LMSTUDIO_API_TOKEN");
    });

    test("a configured model that isn't loaded sends no turn", async () => {
        const { code, stderr, requests } = await hello({
            LMSTUDIO_MODEL: "qwen2.5-0.5b-instruct-mlx",
        });

        expect(code).toBe(1);
        expect(stderr).toContain("lms load qwen2.5-0.5b-instruct-mlx");
        expect(requests.some((request) => request.url.endsWith("/v1/responses"))).toBe(false);
    });

    test("a failed turn prints nothing on stdout and exits 1", async () => {
        const { code, stdout, stderr } = await hello(
            {},
            {
                responses: () =>
                    Response.json({ error: { message: "model crashed" } }, { status: 500 }),
            },
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("server_error");
        expect(stderr).toContain("model crashed");
    });
});
