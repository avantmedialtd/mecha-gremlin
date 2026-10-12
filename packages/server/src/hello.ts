import OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { type Config, type Env, loadConfig } from "./config.ts";
import { type LoopEvent, type LoopResult, MAX_TURNS, runLoop } from "./loop.ts";
import { type Fetch, keyRejected, resolveModel } from "./model.ts";
import { readFileTool } from "./read-file.ts";

export const DEFAULT_FILE = "package.json";
/** Unanswerable without reading the file, so it shows the tool loop at work. */
export const DEFAULT_QUESTION = "What exact command does the check script run? Quote it.";
export const FILE_QUESTION = "What is this file for? Answer in two or three sentences.";

/** Standing instructions, sent as a developer item rather than `instructions` (Brief C1). */
const INSTRUCTIONS =
    "You answer questions about files in the working directory. Before answering a question about a file, read it with the read_file tool. Keep your answers brief.";

export interface HelloIO {
    env: Env;
    fetch: Fetch;
    /** The command-line arguments: `[file] [question…]`. */
    args: readonly string[];
    /** The working directory. `read_file` reads files under it and nowhere else. */
    cwd: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /** Milliseconds, for each turn's elapsed time. Defaults to `performance.now`. */
    now?: () => number;
}

/**
 * Asks the configured model a question about a file, letting it read the file with `read_file`,
 * and prints the answer. The answer goes to stdout; progress, usage and errors go to stderr.
 * Returns the process exit code.
 */
export async function run(io: HelloIO): Promise<number> {
    const fail = (message: string): number => {
        io.stderr(`✗ ${message}\n`);
        return 1;
    };

    const loaded = loadConfig(io.env);
    if (!loaded.ok) {
        for (const problem of loaded.problems) {
            io.stderr(`✗ ${problem}\n`);
        }
        return 1;
    }
    const { config } = loaded;

    const choice = await resolveModel(config, io.fetch);
    if (!choice.ok) {
        return fail(choice.reason);
    }
    if (choice.note) {
        io.stderr(`${choice.note}\n`);
    }

    const { file, question } = parseArgs(io.args);
    io.stderr(`Asking ${choice.model} at ${config.baseUrl} about ${file}…\n`);
    const client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        maxRetries: 0,
        fetch: io.fetch,
    });
    const result = await runLoop(client, {
        model: choice.model,
        ...(config.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: config.reasoningEffort } }),
        tools: [readFileTool(io.cwd)],
        history: [
            { role: "developer", content: INSTRUCTIONS },
            { role: "user", content: `File: ${file}\nQuestion: ${question}` },
        ],
        onEvent: (event) => io.stderr(`${progress(event)}\n`),
        now: io.now,
    });

    if (!result.ok) {
        return fail(failure(result, config));
    }
    io.stdout(`${result.text}\n`);
    return 0;
}

/** `[file] [question…]`: the question's words can go unquoted. */
export function parseArgs(args: readonly string[]): { file: string; question: string } {
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
