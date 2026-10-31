// What a run checks before any network request: each enabled entry again, since a row may predate
// a check or have been written by hand, then what only a run can, once its references resolve.
// Nothing here quotes a resolved value.
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { Env } from '../config/config.ts';
import { serverEnv } from '../exec/env.ts';
import { checkEntry } from './entry.ts';
import { headerValueProblems } from './headers.ts';
import { type Template, render, resolve } from './references.ts';
import { urlProblems } from './urls.ts';

export type StdioConnection = {
    readonly transport: 'stdio';
    /** The absolute path the command resolved to. */
    readonly program: string;
    readonly args: readonly string[];
    /** The whole environment, from `serverEnv`. */
    readonly env: Readonly<Record<string, string>>;
    /** Undefined for the run's directory. */
    readonly cwd: string | undefined;
};

export type HttpConnection = {
    readonly transport: 'http';
    readonly url: string;
    /** The url as the entry writes it, references unresolved: its saved logins' key. */
    readonly writtenUrl: string;
    readonly headers: Readonly<Record<string, string>>;
};

export type ServerConfig = {
    readonly name: string;
    readonly prefix: string;
    readonly includeTools: readonly string[] | undefined;
    readonly excludeTools: readonly string[];
    readonly startupTimeoutMs: number;
    readonly toolTimeoutMs: number;
    readonly connection: StdioConnection | HttpConnection;
    /** The values its references resolved to, which its texts are redacted of. */
    readonly secrets: readonly string[];
};

/** A server as the store keeps it. */
export type Row = {
    readonly name: string;
    readonly prefix: string;
    readonly entry: unknown;
};

/** The whole message for a server's problem, which says how to run without the server. */
export const serverProblem = (name: string, problem: string): string => {
    return `The MCP server ${name} can't start. ${problem} To run without it: bun run mcp disable ${name}.`;
};

// The template as written, which holds no resolved value.
const asWritten = (template: Template): string => {
    return render(template, (variable) => `\${${variable}}`);
};

const isExecutableFile = (path: string): boolean => {
    try {
        accessSync(path, constants.X_OK);

        return statSync(path).isFile();
    } catch {
        // Missing, not executable, or out of reach.
    }

    return false;
};

const isDirectory = (path: string): boolean => {
    try {
        return statSync(path).isDirectory();
    } catch {
        // Missing, or out of reach.
    }

    return false;
};

// Only absolute entries: a relative or empty one would resolve against a directory the server
// or the agent happens to start in, and Node and Bun treat an empty one differently (Brief R18.1).
const findOnPath = (name: string, path: string | undefined): string | undefined => {
    return path
        ?.split(':')
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, name))
        .find(isExecutableFile);
};

type Resolver = {
    readonly text: (template: Template) => string;
    readonly missing: () => readonly string[];
    readonly values: () => readonly string[];
};

// Resolves every template of one server, gathering what is missing rather than stopping at it.
const resolverFor = (env: Env): Resolver => {
    const missing = new Set<string>();
    const values: string[] = [];

    return {
        text: (template) => {
            const resolved = resolve(template, env);

            for (const variable of resolved.missing) {
                missing.add(variable);
            }

            values.push(...resolved.values);

            return resolved.text;
        },
        missing: () => [...missing],
        values: () => values,
    };
};

const stdioConnection = (
    entry: {
        readonly command: Template;
        readonly args: readonly Template[];
        readonly env: readonly (readonly [string, Template])[];
        readonly cwd: Template | undefined;
    },
    resolver: Resolver,
    parentEnv: Env,
    runId: string,
): Result<StdioConnection, string[]> => {
    const command = resolver.text(entry.command);
    const args = entry.args.map((arg) => resolver.text(arg));
    const own = Object.fromEntries(entry.env.map(([name, value]) => [name, resolver.text(value)]));
    const cwd = entry.cwd === undefined ? undefined : resolver.text(entry.cwd);
    const env = serverEnv(parentEnv, own, runId);

    if (resolver.missing().length > 0) {
        return err([]);
    }

    const program = command.includes('/') ? command : findOnPath(command, env.PATH);
    const problems = [
        ...(isAbsolute(command) || !command.includes('/')
            ? []
            : [
                  'Its command, with its references resolved, must be an absolute path, or a name without a slash.',
              ]),
        ...(cwd === undefined || (isAbsolute(cwd) && isDirectory(cwd))
            ? []
            : [
                  'Its cwd, with its references resolved, must be an absolute path to a directory that exists.',
              ]),
    ];

    if (program === undefined) {
        return err([
            `Its command, ${asWritten(entry.command)}, is in none of the absolute directories of its PATH: give the command's absolute path, or set PATH in its env.`,
            ...problems,
        ]);
    }

    return problems.length > 0
        ? err(problems)
        : ok({ transport: 'stdio', program, args, env, cwd });
};

const httpConnection = (
    entry: {
        readonly url: Template;
        readonly writtenUrl: string;
        readonly headers: readonly (readonly [string, Template])[];
    },
    resolver: Resolver,
): Result<HttpConnection, string[]> => {
    const url = resolver.text(entry.url);
    const headers = entry.headers.map(([name, value]) => [name, resolver.text(value)] as const);

    if (resolver.missing().length > 0) {
        return err([]);
    }

    const problems = [
        ...urlProblems('The url, with its references resolved,', url),
        ...headers.flatMap(([name, value]) =>
            headerValueProblems(`The header ${name}, with its references resolved,`, value),
        ),
    ];

    return problems.length > 0
        ? err(problems)
        : ok({
              transport: 'http',
              url,
              writtenUrl: entry.writtenUrl,
              headers: Object.fromEntries(headers),
          });
};

/**
 * Checks an enabled server's entry, resolves its references from the agent's environment, and
 * checks what they resolved to. Every problem is reported, each as a whole message.
 */
export const resolveServer = (
    { name, prefix, entry: stored }: Row,
    parentEnv: Env,
    runId: string,
): Result<ServerConfig, string[]> => {
    const checked = checkEntry(stored);

    if (!checked.ok) {
        return err(checked.error.map((problem) => serverProblem(name, problem)));
    }

    const { entry } = checked.value;
    const resolver = resolverFor(parentEnv);
    const connection =
        entry.transport === 'stdio'
            ? stdioConnection(entry, resolver, parentEnv, runId)
            : httpConnection(entry, resolver);
    const missing = resolver.missing().map((variable) => {
        return serverProblem(
            name,
            `It refers to ${variable}, which is unset or blank: set it in .env.`,
        );
    });

    if (!connection.ok) {
        return err([
            ...missing,
            ...connection.error.map((problem) => serverProblem(name, problem)),
        ]);
    }

    return ok({
        name,
        prefix,
        includeTools: entry.includeTools,
        excludeTools: entry.excludeTools,
        startupTimeoutMs: entry.startupTimeoutMs,
        toolTimeoutMs: entry.toolTimeoutMs,
        connection: connection.value,
        secrets: resolver.values(),
    });
};
