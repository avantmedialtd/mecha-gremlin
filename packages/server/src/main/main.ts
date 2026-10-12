import { type Config, loadConfig } from "../config/config.ts";
import { type Fields, type Json, createLogger, logFormat } from "../log/log.ts";
import { keyRejected } from "../model/model.ts";
import { MAX_TURNS, type SessionStep, type TurnStats, createSession } from "../session/session.ts";
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
    const format = logFormat(process.env.LOG_FORMAT);
    const log = createLogger(format ?? "pretty");
    const fail = (message: string): number => {
        log.error(message);
        return 1;
    };

    if (format === undefined) {
        return fail(
            `LOG_FORMAT must be pretty or json; got ${JSON.stringify(process.env.LOG_FORMAT)}.`,
        );
    }

    const loaded = loadConfig(process.env);

    if (!loaded.ok) {
        for (const problem of loaded.problems) {
            log.error(problem);
        }

        return 1;
    }

    const { config } = loaded;
    const { file, question } = parseArgs(args);

    const session = await createSession(config, {
        tools: [readFileTool(process.cwd())],
        history: [
            { role: "developer", content: INSTRUCTIONS },
            { role: "user", content: `File: ${file}\nQuestion: ${question}` },
        ],
    });

    if (!session.ok) {
        return fail(session.reason);
    }

    if (session.note) {
        log.info(session.note);
    }

    log.info("asking", { model: session.model, baseUrl: config.baseUrl, file, question });

    for await (const step of session.steps) {
        if ("turn" in step) {
            log.info("turn", turnFields(step.turn));
        }

        if (step.kind === "final") {
            log.info("answer", { text: step.text });
            return 0;
        }

        if (step.kind !== "calls") {
            return fail(failure(step, config));
        }

        for (const { call, outcome } of step.calls) {
            log.info("tool call", { tool: call.name, arguments: parsed(call.arguments) });

            if (outcome.ok) {
                const bytes = new TextEncoder().encode(outcome.output).byteLength;
                log.info("tool result", { tool: call.name, bytes });
            } else {
                log.warn("tool failed", { tool: call.name, error: outcome.error });
            }
        }
    }

    throw new Error("The session's steps ran out before an answer or a failure.");
}

/** The question's words are joined, so it needn't be quoted. */
function parseArgs(args: readonly string[]): { file: string; question: string } {
    const [file, ...words] = args;

    if (file === undefined) {
        return { file: DEFAULT_FILE, question: DEFAULT_QUESTION };
    }

    return { file, question: words.length > 0 ? words.join(" ") : FILE_QUESTION };
}

/** Arguments that parse are logged as data; the rest as the model sent them. */
function parsed(raw: string): Json {
    try {
        return JSON.parse(raw) as Json;
    } catch {
        return raw;
    }
}

function turnFields({ number, usage, seconds }: TurnStats): Fields {
    return {
        number,
        inputTokens: usage?.input_tokens,
        cachedTokens: usage?.input_tokens_details?.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        seconds: Math.round(seconds * 10) / 10,
    };
}

function failure(step: Exclude<SessionStep, { kind: "calls" | "final" }>, config: Config): string {
    switch (step.kind) {
        case "turn_failed": {
            const { error, detail, status } = step.failure;

            if (error === "auth") {
                return keyRejected(config, status ?? 401);
            }

            if (error === "unreachable") {
                return `Can't reach ${config.baseUrl} (${detail}). Check MODEL_BASE_URL.`;
            }

            const http = status === undefined ? "" : `, HTTP ${status}`;
            return `The turn failed (${error}${http}): ${detail}`;
        }
        case "turn_limit":
            return `The model didn't answer within ${MAX_TURNS} turns: it was still calling tools. Try a narrower question.`;
        case "empty":
            return "The model gave no answer: its turn had neither text nor tool calls. Try again, or rephrase the question.";
        case "history":
            return `The conversation can't be continued (${step.detail}). The model sent something the openai SDK can't replay; try updating it.`;
    }
}
