import type { Config } from "../config/config.ts";
import { keyRejected } from "../model/model.ts";
import { MAX_TURNS, type SessionStep } from "../session/session.ts";

export const failure = (
    step: Exclude<SessionStep, { kind: "calls" | "final" }>,
    config: Config,
): string => {
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
};
