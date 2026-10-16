import type { FunctionTool, ResponseOutputItem } from 'openai/resources/responses/responses';
import { type Err, type Result, err, ok } from './result.ts';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from './standard-schema.ts';

export type ToolSchema<Args> = StandardSchemaV1<unknown, Args> &
    StandardJSONSchemaV1<unknown, Args>;

export type Tool<Args = unknown> = {
    /** Keep it snake_case: LM Studio converts tool names to snake_case for the model (Brief R5.2). */
    readonly name: string;
    readonly description: string;
    readonly schema: ToolSchema<Args>;
};

/** A failure's error is shown to the model, so write it for the model to act on. */
export type ToolOutcome = Result<string, string>;

export type ToolCall = Extract<ResponseOutputItem, { type: 'function_call' }>;

export type Reply =
    | { readonly kind: 'calls'; readonly calls: readonly ToolCall[] }
    | { readonly kind: 'final'; readonly text: string }
    | { readonly kind: 'empty' };

/**
 * Draft-07 is the dialect the `openai` SDK's own helpers request, and `$schema` constrains
 * nothing. `strict` makes OpenAI constrain generation to the schema; LM Studio ignores it, so
 * `validateArgs` still checks every call.
 */
export const toFunctionTool = (tool: Tool): FunctionTool => {
    const { $schema: _dialect, ...parameters } = tool.schema['~standard'].jsonSchema.input({
        target: 'draft-07',
    });

    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters,
        strict: true,
    };
};

/**
 * Calls win over text because models pair a call with a blank or chatty message (Brief R11). A
 * refusal counts as the answer, so the user sees it instead of "no answer".
 */
export const classify = (output: readonly ResponseOutputItem[]): Reply => {
    const calls = output.filter((item): item is ToolCall => item.type === 'function_call');

    if (calls.length > 0) {
        return { kind: 'calls', calls };
    }

    let text = '';

    for (const item of output) {
        if (item.type !== 'message') {
            continue;
        }

        for (const part of item.content) {
            text += part.type === 'refusal' ? part.refusal : part.text;
        }
    }

    text = text.trim();

    return text === '' ? { kind: 'empty' } : { kind: 'final', text };
};

const issuePath = (issue: StandardSchemaV1.Issue): string => {
    const path = issue.path ?? [];

    if (path.length === 0) {
        return '(root)';
    }

    return path
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.');
};

const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

/** Errors end with the expected JSON Schema, so the model can correct its next call (Brief 4.5). */
export const validateArgs = async <Args>(
    tool: Tool<Args>,
    raw: string,
): Promise<Result<Args, string>> => {
    const fail = (problem: string): Err<string> => {
        let schema: string;

        // `jsonSchema.input` may throw for a target the library doesn't support.
        try {
            schema = JSON.stringify(toFunctionTool(tool).parameters);
        } catch {
            return err(problem);
        }

        return err(`${problem}\nThe arguments must match this JSON Schema: ${schema}`);
    };

    // Some models send no arguments at all to a tool that takes none.
    let value: unknown = {};

    if (raw.trim() !== '') {
        try {
            value = JSON.parse(raw);
        } catch (error) {
            return fail(`The arguments for ${tool.name} are not valid JSON (${reasonOf(error)}).`);
        }
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(`The arguments for ${tool.name} must be a JSON object.`);
    }

    let result: StandardSchemaV1.Result<Args>;

    try {
        result = await tool.schema['~standard'].validate(value);
    } catch (error) {
        return fail(`Validating the arguments for ${tool.name} failed (${reasonOf(error)}).`);
    }

    if (result.issues === undefined) {
        return ok(result.value);
    }

    const issues = result.issues.map((issue) => `- ${issuePath(issue)}: ${issue.message}`);

    return fail(`The arguments for ${tool.name} don't match its schema:\n${issues.join('\n')}`);
};
