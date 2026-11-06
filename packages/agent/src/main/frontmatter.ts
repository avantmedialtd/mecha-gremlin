import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { findFrontmatter } from '@mecha-gremlin/core/skills';
import { parseYaml } from '@mecha-gremlin/yaml/parse';
import { NAME } from '../mcp/entry.ts';
import { parseListItem } from '../mcp/task-list.ts';

export type TaskText = {
    /** Without its frontmatter. */
    readonly text: string;
    /** The mcp list as written, each name with its ?, or undefined without one. */
    readonly mcp: readonly string[] | undefined;
    /** The keys the run doesn't read, in the block's order, but whole numbers first. */
    readonly ignored: readonly string[];
};

type Block = Readonly<Record<string, unknown>>;

const HINT =
    'List each server once, as in mcp: [docs], or give mcp: [] for none; a ? after a name marks a server the task can go without.';

// A mapping, or null, as both parsers read an empty block. A block that parses as anything else,
// such as a sentence between two horizontal rules, isn't frontmatter (D45).
const isFrontmatter = (value: unknown): value is Block | null => {
    return typeof value === 'object' && !Array.isArray(value);
};

// Counted in the trimmed task, whose line 1 is the opening ---, so that both runtimes give the
// same lines: only the yaml package's reason names a line of its own (Brief R23).
const linesOf = (frontmatter: string): string => {
    const last = frontmatter.split('\n').length + 1;

    if (last === 2) {
        return 'line 2';
    }

    return `lines 2 to ${last}`;
};

const namesOf = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const names = value.filter((item): item is string => {
        return typeof item === 'string' && NAME.test(parseListItem(item).name);
    });

    if (names.length !== value.length) {
        return undefined;
    }

    return names;
};

// `mcp: docs` is refused, not read as a list of one: a second way to write the same list.
const mcpOf = (value: unknown, where: string): Result<readonly string[], string> => {
    const names = namesOf(value);

    if (names === undefined) {
        return err(
            `In the frontmatter of the ${where}, mcp isn't a list of MCP server names. ${HINT}`,
        );
    }

    const bare = names.map((item) => parseListItem(item).name);
    const repeated = bare.find((name, index) => bare.indexOf(name) !== index);

    if (repeated !== undefined) {
        return err(`In the frontmatter of the ${where}, mcp names ${repeated} twice. ${HINT}`);
    }

    return ok(names);
};

/** `where` names the task in the errors, as in `task file "/tasks/daily.md"`. */
export const readFrontmatter = (text: string, where: string): Result<TaskText, string> => {
    const whole = { text, mcp: undefined, ignored: [] };
    const found = findFrontmatter(text);

    if (found === undefined) {
        return ok(whole);
    }

    const parsed = parseYaml(found.frontmatter);

    if (!parsed.ok) {
        return err(
            `The frontmatter of the ${where}, on ${linesOf(found.frontmatter)}, isn't valid YAML: ${parsed.error}`,
        );
    }

    if (!isFrontmatter(parsed.value)) {
        return ok(whole);
    }

    const block: Block = parsed.value ?? {};
    const { mcp, ...others } = block;
    const list = mcp === undefined ? ok(undefined) : mcpOf(mcp, where);

    if (!list.ok) {
        return list;
    }

    if (found.body === '') {
        return err(`The ${where} is blank once its frontmatter is stripped.`);
    }

    return ok({ text: found.body, mcp: list.value, ignored: Object.keys(others) });
};
