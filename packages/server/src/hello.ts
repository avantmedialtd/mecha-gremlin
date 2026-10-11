import { runTurn } from "@mecha-gremlin/core";
import OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { type Env, loadConfig } from "./config.ts";
import { type Fetch, keyRejected, resolveModel } from "./model.ts";

export const GREETING = "Hi!";

export interface HelloIO {
    env: Env;
    fetch: Fetch;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /** Milliseconds, for the elapsed-time report. Defaults to `performance.now`. */
    now?: () => number;
}

/**
 * Says hi to the configured model and prints its reply. The reply goes to stdout; progress,
 * usage and errors go to stderr. Returns the process exit code.
 */
export async function run(io: HelloIO): Promise<number> {
    const now = io.now ?? (() => performance.now());
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

    io.stderr(`Saying hi to ${choice.model} at ${config.baseUrl}…\n`);
    const client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        maxRetries: 0,
        fetch: io.fetch,
    });
    const started = now();
    const result = await runTurn(client, {
        model: choice.model,
        input: GREETING,
        ...(config.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: config.reasoningEffort } }),
    });
    const seconds = (now() - started) / 1000;

    if (!result.ok) {
        if (result.error === "auth") {
            return fail(keyRejected(config, result.status ?? 401));
        }
        if (result.error === "unreachable") {
            return fail(`Can't reach ${config.baseUrl} (${result.detail}). Check MODEL_BASE_URL.`);
        }
        const status = result.status === undefined ? "" : `, HTTP ${result.status}`;
        return fail(`The turn failed (${result.error}${status}): ${result.detail}`);
    }

    if (result.text === "") {
        io.stderr("(The model replied with no text.)\n");
    }
    io.stdout(`${result.text}\n`);
    io.stderr(`${usageLine(result.usage, seconds)}\n`);
    return 0;
}

function usageLine(usage: ResponseUsage | undefined, seconds: number): string {
    const elapsed = `${seconds.toFixed(1)} s`;
    if (usage === undefined) {
        return `(${elapsed})`;
    }
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
    return `(${usage.output_tokens} output tokens, ${reasoning} reasoning, ${elapsed})`;
}
