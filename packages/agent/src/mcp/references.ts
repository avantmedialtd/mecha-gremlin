// References to the agent's environment in an MCP server's entry: `${NAME}` and `${env:NAME}`,
// with `$$` for a literal `$`. There are no defaults, no editor variables and no bare `$NAME`,
// whose meanings differ from client to client (Brief R18.1).
import type { Env } from '../config/config.ts';

export type Part = string | { readonly variable: string };

/** A text with its references, as literal parts and variables, in order. */
export type Template = readonly Part[];

export type ParsedTemplate = {
    readonly template: Template;
    /** What is wrong with the references, each completing "<the field> holds …". */
    readonly problems: readonly string[];
};

export type Resolved = {
    /** The text, with the reference to a variable that is unset or blank left empty. */
    readonly text: string;
    /** The non-empty values the references resolved to. */
    readonly values: readonly string[];
    /** The variables that are unset or blank, each once. */
    readonly missing: readonly string[];
};

const REFERENCE = /^(?:env:)?([A-Za-z_][A-Za-z0-9_]*)$/;

const DEFAULTED = /^(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::?[-=?+])/;

const BARE = /^[A-Za-z_][A-Za-z0-9_]*/;

// The model's key reaches only the model's provider.
const FORBIDDEN = 'MODEL_API_KEY';

const describeReference = (inner: string): string => {
    const defaulted = DEFAULTED.exec(inner);

    if (defaulted !== null) {
        return `a reference with a default, \${${defaulted[1]}…}, and defaults aren't supported: set ${defaulted[1]} itself`;
    }

    return /^[A-Za-z]+:/.test(inner)
        ? "a reference of a kind that isn't supported: only ${NAME} and ${env:NAME} are"
        : "a reference to something that isn't a variable name: write ${NAME}";
};

export const parseTemplate = (text: string): ParsedTemplate => {
    const template: Part[] = [];
    const problems: string[] = [];
    let literal = '';
    let index = 0;

    while (index < text.length) {
        const character = text[index];
        const next = text[index + 1];

        if (character !== '$') {
            literal += character;
            index++;
        } else if (next === '$') {
            literal += '$';
            index += 2;
        } else if (next === '{') {
            const close = text.indexOf('}', index + 2);

            if (close === -1) {
                problems.push('a reference without its closing }');

                break;
            }

            const inner = text.slice(index + 2, close);
            const name = REFERENCE.exec(inner)?.[1];

            if (name === undefined) {
                problems.push(describeReference(inner));
            } else if (name === FORBIDDEN) {
                problems.push(
                    `a reference to ${FORBIDDEN}, the model's key, which no server is given`,
                );
            } else {
                template.push(literal, { variable: name });
                literal = '';
            }

            index = close + 1;
        } else {
            const bare = BARE.exec(text.slice(index + 1))?.[0];

            problems.push(
                bare === undefined
                    ? 'a $ that starts no reference: write ${NAME} for a variable, or $$ for a $'
                    : `$${bare}, which isn't a reference: write \${${bare}}`,
            );
            index += 1 + (bare?.length ?? 0);
        }
    }

    template.push(literal);

    return { template: template.filter((part) => part !== ''), problems };
};

export const hasReference = (template: Template): boolean => {
    return template.some((part) => typeof part !== 'string');
};

/** The text with each reference replaced by `fill`, or by what `fill` gives for its variable. */
export const render = (
    template: Template,
    fill: string | ((variable: string) => string),
): string => {
    return template
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }

            return typeof fill === 'string' ? fill : fill(part.variable);
        })
        .join('');
};

// Own properties only: the environment inherits `constructor`, `toString` and the like from
// Object.prototype (Brief R18.1).
const lookUp = (env: Env, variable: string): string => {
    return Object.hasOwn(env, variable) ? (env[variable] ?? '').trim() : '';
};

export const resolve = (template: Template, env: Env): Resolved => {
    const missing = new Set<string>();
    const values: string[] = [];
    const text = render(template, (variable) => {
        const value = lookUp(env, variable);

        if (value === '') {
            missing.add(variable);
        } else {
            values.push(value);
        }

        return value;
    });

    return { text, values, missing: [...missing] };
};
