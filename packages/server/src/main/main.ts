import type { ToolOutcome } from "@mecha-gremlin/core";
import OpenAI from "openai";
import { type Config, loadConfig } from "../config/config.ts";
import { type LoopStep, MAX_TURNS, type TurnStats, runLoop } from "../loop/loop.ts";
import { keyRejected, resolveModel } from "../model/model.ts";
import { readFileTool } from "../tools/read-file.ts";

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
    const steps = runLoop(client, {
        model: choice.model,
        ...(config.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: config.reasoningEffort } }),
        tools: [readFileTool(process.cwd())],
        history: [
            { role: "developer", content: INSTRUCTIONS },
            { role: "user", content: `File: ${file}\nQuestion: ${question}` },
        ],
    });

    for await (const step of steps) {
        if (step.turn !== undefined) {
            console.error(turnLine(step.turn));
        }

        if (step.kind === "stop") {
            return fail(failure(step, config));
        }

        if (step.kind === "answer") {
            // stdout carries the answer alone, so it can be piped: `bun run hello | pbcopy`.
            console.log(step.text);
            return 0;
        }

        for (const { call, outcome } of step.calls) {
            console.error(`→ ${call.name} ${call.arguments}`);
            console.error(outcomeLine(outcome));
        }
    }

    throw new Error("The agent loop ended without an answer or a stop step.");
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

function turnLine({ number, usage, seconds }: TurnStats): string {
    const elapsed = `${seconds.toFixed(1)} s`;
    if (usage === undefined) {
        return `Turn ${number}: ${elapsed}`;
    }

    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
    return `Turn ${number}: ${usage.input_tokens} input tokens (${cached} cached), ${usage.output_tokens} output (${reasoning} reasoning), ${elapsed}`;
}

function outcomeLine(outcome: ToolOutcome): string {
    return outcome.ok
        ? `← ${new TextEncoder().encode(outcome.output).byteLength} bytes`
        : `← Error: ${outcome.error.replaceAll("\n", "\n  ")}`;
}

function failure(step: Extract<LoopStep, { kind: "stop" }>, config: Config): string {
    switch (step.reason) {
        case "turn_failed": {
            if (step.error === "auth") {
                return keyRejected(config, step.status ?? 401);
            }

            if (step.error === "unreachable") {
                return `Can't reach ${config.baseUrl} (${step.detail}). Check MODEL_BASE_URL.`;
            }

            const status = step.status === undefined ? "" : `, HTTP ${step.status}`;
            return `The turn failed (${step.error}${status}): ${step.detail}`;
        }
        case "turn_limit":
            return `The model didn't answer within ${MAX_TURNS} turns: it was still calling tools. Try a narrower question.`;
        case "empty":
            return "The model gave no answer: its turn had neither text nor tool calls. Try again, or rephrase the question.";
        case "history":
            return `The conversation can't be continued (${step.detail}). The model sent something the openai SDK can't replay; try updating it.`;
    }
}
