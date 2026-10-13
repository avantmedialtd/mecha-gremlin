import { type Tool, type ToolOutcome, validateArgs } from "@mecha-gremlin/core";

export interface ToolHandler {
    readonly tool: Tool;
    invoke(rawArgs: string): Promise<ToolOutcome>;
}

/**
 * The loop holds tools with different argument types in one list. Validating inside this closure
 * keeps each tool's arguments typed from its schema to its `run`.
 */
export const defineTool = <Args>(
    tool: Tool<Args>,
    run: (args: Args) => Promise<ToolOutcome>,
): ToolHandler => {
    return {
        tool,
        async invoke(rawArgs) {
            const validated = await validateArgs(tool, rawArgs);
            return validated.ok ? run(validated.args) : { ok: false, error: validated.error };
        },
    };
};
