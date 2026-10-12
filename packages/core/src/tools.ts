import type { FunctionTool, ResponseOutputItem } from "openai/resources/responses/responses";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "./standard-schema.ts";

/** A schema that validates a tool's arguments and describes them as JSON Schema. */
export type ToolSchema<Args> = StandardSchemaV1<unknown, Args> &
    StandardJSONSchemaV1<unknown, Args>;

/** A tool the model can call: what the model is told about it, and how its arguments are checked. */
export interface Tool<Args = unknown> {
    /** Keep it snake_case: LM Studio converts tool names to snake_case for the model (Brief R5.2). */
    readonly name: string;
    readonly description: string;
    readonly schema: ToolSchema<Args>;
}

/** What a tool call produced. A failure's error goes back to the model too, so it can react. */
export type ToolOutcome = { ok: true; output: string } | { ok: false; error: string };

/** A function call the model made. */
export type ToolCall = Extract<ResponseOutputItem, { type: "function_call" }>;

/** What a completed turn asks for: running its calls, accepting its answer, or neither. */
export type Turn =
    | { kind: "calls"; calls: ToolCall[] }
    | { kind: "final"; text: string }
    | { kind: "empty" };

export type ArgsResult<Args> = { ok: true; args: Args } | { ok: false; error: string };

/**
 * The tool as the Responses API takes it. The parameters are the schema's input JSON Schema in
 * the draft-07 dialect the `openai` SDK's own helpers request, minus `$schema`, which constrains
 * nothing. `strict` makes OpenAI constrain generation to the schema; LM Studio ignores it, and
 * `validateArgs` checks every call either way.
 */
export function toFunctionTool(tool: Tool): FunctionTool {
    const { $schema: _dialect, ...parameters } = tool.schema["~standard"].jsonSchema.input({
        target: "draft-07",
    });
    return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters,
        strict: true,
    };
}

/**
 * Classifies a completed turn's output. Any function call makes it a `calls` turn, whatever text
 * comes with it: a model can pair a call with a blank message (Brief R11). Otherwise the text of
 * every message, refusals included, is the answer once trimmed, and a turn with no text is `empty`.
 */
export function classify(output: readonly ResponseOutputItem[]): Turn {
    const calls = output.filter((item): item is ToolCall => item.type === "function_call");
    if (calls.length > 0) {
        return { kind: "calls", calls };
    }

    let text = "";
    for (const item of output) {
        if (item.type !== "message") {
            continue;
        }
        for (const part of item.content) {
            text += part.type === "refusal" ? part.refusal : part.text;
        }
    }
    text = text.trim();
    return text === "" ? { kind: "empty" } : { kind: "final", text };
}

/**
 * Parses a call's raw JSON arguments and validates them against the tool's schema. A failure is a
 * value whose error tells the model what was wrong and shows the expected JSON Schema, so it can
 * correct the call (Brief 4.5).
 */
export async function validateArgs<Args>(tool: Tool<Args>, raw: string): Promise<ArgsResult<Args>> {
    const fail = (problem: string): ArgsResult<Args> => ({
        ok: false,
        error: `${problem}\nThe arguments must match this JSON Schema: ${JSON.stringify(toFunctionTool(tool).parameters)}`,
    });

    // Some models send no arguments at all to a tool that takes none.
    let value: unknown = {};
    if (raw.trim() !== "") {
        try {
            value = JSON.parse(raw);
        } catch (error) {
            // JSON.parse only throws SyntaxError.
            const reason = (error as SyntaxError).message;
            return fail(`The arguments for ${tool.name} are not valid JSON (${reason}).`);
        }
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(`The arguments for ${tool.name} must be a JSON object.`);
    }

    const result = await tool.schema["~standard"].validate(value);
    if (result.issues === undefined) {
        return { ok: true, args: result.value };
    }
    const issues = result.issues.map((issue) => `- ${issuePath(issue)}: ${issue.message}`);
    return fail(`The arguments for ${tool.name} don't match its schema:\n${issues.join("\n")}`);
}

/** An issue's path, dot-separated, or `(root)` for the arguments object itself. */
function issuePath(issue: StandardSchemaV1.Issue): string {
    const path = issue.path ?? [];
    if (path.length === 0) {
        return "(root)";
    }
    return path
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".");
}
