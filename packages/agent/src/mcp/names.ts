// Names every provider accepts: Anthropic requires ^[a-zA-Z0-9_-]{1,128}$, OpenAI documents 64
// characters, and LM Studio converts names to snake_case (Brief R17.3, R18.2).
import { createHash } from 'node:crypto';

export type ServerTool = {
    readonly server: string;
    readonly prefix: string;
    /** The tool's name as the server lists it. */
    readonly tool: string;
};

const LONGEST = 64;

const KEPT = 55;

export const toolPart = (tool: string): string => {
    return tool
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replaceAll(/[^a-z0-9_]/g, '_');
};

const hashed = (name: string, { server, tool }: ServerTool): string => {
    const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex');

    return `${name.slice(0, KEPT)}_${hash.slice(0, 8)}`;
};

const plainName = ({ prefix, tool }: ServerTool): string => {
    return `mcp__${prefix}__${toolPart(tool)}`;
};

/**
 * Each tool with its model-facing name, in the order given. A name over 64 characters, and every
 * name two tools would share, takes a hashed form, which stays the same from run to run.
 */
export const withModelNames = <T extends ServerTool>(
    tools: readonly T[],
): (T & { readonly modelName: string })[] => {
    const names = tools.map(plainName);

    return tools.map((tool) => {
        const name = plainName(tool);
        const shared = names.indexOf(name) !== names.lastIndexOf(name);

        return { ...tool, modelName: name.length > LONGEST || shared ? hashed(name, tool) : name };
    });
};
