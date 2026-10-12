import OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { type Config, loadConfig } from "./config.ts";
import { type LoopEvent, type LoopResult, MAX_TURNS, runLoop } from "./loop.ts";
import { keyRejected, resolveModel } from "./model.ts";
import { readFileTool } from "./read-file.ts";

const DEFAULT_FILE = "package.json";
/** Unanswerable without reading the file, so it shows the tool loop at work. */
const DEFAULT_QUESTION = "What exact command does the check script run? Quote it.";
const FILE_QUESTION = "What is this file for? Answer in two or three sentences.";

/** Sent as a developer item, not as `instructions`, which LM Studio reportedly ignores (Brief C1). */
const INSTRUCTIONS =
    "You answer questions about files in the working directory. Before answering a question about a file, read it with the read_file tool. Keep your answers brief.";

process.exitCode = await run(process.argv.slice(2));

async function run(args: readonly string[]): Promise<number> {
    const loaded = loadConfig(process.env);
    if (!loaded.ok) {
        for (const problem of loaded.problems) {
            console.error(`✗ ${problem}`);
        }

        return 1;
    }

    const { config } = loaded;

    const choice = await resolveModel(config);
    if (!choice.ok) {
        return fail(choice.reason);
    }

    if (choice.note) {
        console.error(choice.note);
    }

    const { file, question } = parseArgs(args);
    console.error(`Asking ${choice.model} at ${config.baseUrl} about ${file}…`);
    const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, maxRetries: 0 });
    const result = await runLoop(client, {
        model: choice.model,
        ...(config.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: config.reasoningEffort } }),
        tools: [readFileTool(process.cwd())],
        history: [
            { role: "developer", content: INSTRUCTIONS },
            { role: "user", content: `File: ${file}\nQuestion: ${question}` },
        ],
        onEvent: (event) => console.error(progress(event)),
    });

    if (!result.ok) {
        return fail(failure(result, config));
    }

    // stdout carries the answer alone, so it can be piped: `bun run hello | pbcopy`.
    console.log(result.text);
    return 0;
}

function fail(message: string): number {
    console.error(`✗ ${message}`);
    return 1;
}

/** The question's words are joined, so it needn't be quoted. */
function parseArgs(args: readonly string[]): { file: string; question: string } {
    const [file, ...words] = args;
    if (file === undefined) {
        return { file: DEFAULT_FILE, question: DEFAULT_QUESTION };
    }

    return { file, question: words.length > 0 ? words.join(" ") : FILE_QUESTION };
}

function progress(event: LoopEvent): string {
    switch (event.type) {
        case "turn":
            return turnLine(event.turn, event.usage, event.seconds);
        case "call":
            return `→ ${event.name} ${event.arguments}`;
        case "result":
            return event.ok
                ? `← ${event.bytes} bytes`
                : `← Error: ${event.error.replaceAll("\n", "\n  ")}`;
    }
}

function turnLine(turn: number, usage: ResponseUsage | undefined, seconds: number): string {
    const elapsed = `${seconds.toFixed(1)} s`;
    if (usage === undefined) {
        return `Turn ${turn}: ${elapsed}`;
    }

    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
    return `Turn ${turn}: ${usage.input_tokens} input tokens (${cached} cached), ${usage.output_tokens} output (${reasoning} reasoning), ${elapsed}`;
}

function failure(result: Extract<LoopResult, { ok: false }>, config: Config): string {
    switch (result.reason) {
        case "turn_failed": {
            if (result.error === "auth") {
                return keyRejected(config, result.status ?? 401);
            }

            if (result.error === "unreachable") {
                return `Can't reach ${config.baseUrl} (${result.detail}). Check MODEL_BASE_URL.`;
            }

            const status = result.status === undefined ? "" : `, HTTP ${result.status}`;
            return `The turn failed (${result.error}${status}): ${result.detail}`;
        }
        case "turn_limit":
            return `The model didn't answer within ${MAX_TURNS} turns: it was still calling tools. Try a narrower question.`;
        case "empty":
            return "The model gave no answer: its turn had neither text nor tool calls. Try again, or rephrase the question.";
        case "history":
            return `The conversation can't be continued (${result.detail}). The model sent something the openai SDK can't replay; try updating it.`;
    }
}
