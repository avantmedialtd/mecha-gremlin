import { type Tool, type ToolOutcome, validateArgs } from "@mecha-gremlin/core";

/** A tool together with the code that runs it, as the agent loop sees it. */
export interface ToolHandler {
    readonly tool: Tool;
    /** Validates the model's raw JSON arguments, and runs the tool only if they pass. */
    invoke(rawArgs: string): Promise<ToolOutcome>;
}

/**
 * Pairs a tool with the function that runs it. The tool's schema types the arguments all the way
 * to `run`, which only ever sees arguments that passed validation.
 */
export function defineTool<Args>(
    tool: Tool<Args>,
    run: (args: Args) => Promise<ToolOutcome>,
): ToolHandler {
    return {
        tool,
        async invoke(rawArgs) {
            const validated = await validateArgs(tool, rawArgs);
            return validated.ok ? run(validated.args) : { ok: false, error: validated.error };
        },
    };
}
