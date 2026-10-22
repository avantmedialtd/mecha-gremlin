import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Result, ok } from '@mecha-gremlin/core/result';
import { z } from 'zod';
import type { Env } from '../config/config.ts';
import { commandEnv } from '../exec/env.ts';
import { type RunResult, runCommand } from '../exec/run.ts';
import { sweep } from '../exec/sweep.ts';
import { READ_LIMIT } from './read.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';

export type Limits = {
    readonly timeoutMs: number;
    readonly graceMs: number;
    readonly pipeWaitMs: number;
    readonly captureBytes: number;
};

// As much as one call of the read tool returns, so a typical page's snapshot arrives whole.
export const DEFAULT_LIMITS: Limits = {
    timeoutMs: 120_000,
    graceMs: 2000,
    pipeWaitMs: 1000,
    captureBytes: READ_LIMIT,
};

export type ShellOptions = {
    readonly workDir: string;
    readonly runId: string;
    readonly parentEnv: Env;
    readonly limits?: Limits;
};

export type Shell = {
    readonly handler: ToolHandler;
    readonly dispose: () => Promise<Result<number, string>>;
};

// The model can't choose a timeout: strict mode would need a required, nullable field, and
// nothing needs more than the fixed limit yet.
const ShellArgs = z.strictObject({ command: z.string() });

const describeShell = ({ timeoutMs, captureBytes }: Limits): string => {
    return `Run a command with bash in the working directory, and get its exit code and output. Each call is a fresh shell, so cd and variables don't carry over, and stdin is closed. Background processes stop when the command ends, unless they leave its process group, as playwright-cli's browser does. Each output stream keeps its first and last ${captureBytes / 2 / 1024} KiB, and a command is stopped after ${timeoutMs / 1000} s. Commands run on this computer as its user, so stop only what you started: close a playwright-cli browser with \`playwright-cli close\`, never \`kill-all\` or \`close-all\`, which reach other tools' browsers. The session's processes are stopped when it ends anyway.`;
};

// Explicit snapshots of large pages are cut, so this is on the skill's main path.
const CUT_NOTE =
    "The output was cut. To see the rest, run the command again with its output written to a file in the working directory, then read the file a part at a time with the read tool's offset and limit, search it with grep, or print the part you need with sed -n or tail -c.";

// An `ok` outcome whatever the exit code: the model needs the output to act on a failure
// (Brief 4.5).
const describeRun = (run: RunResult, timeoutMs: number): string => {
    const lines = [run.signal === null ? `exit code: ${run.exitCode}` : `killed by ${run.signal}`];
    const stdout = run.stdout.trimEnd();
    const stderr = run.stderr.trimEnd();

    if (run.timedOut) {
        lines.push(`timed out after ${timeoutMs / 1000} s`);
    }

    if (stdout !== '') {
        lines.push('stdout:', stdout);
    }

    if (stderr !== '') {
        lines.push('stderr:', stderr);
    }

    if (stdout === '' && stderr === '') {
        lines.push('(no output)');
    }

    if (run.cut) {
        lines.push(CUT_NOTE);
    }

    return lines.join('\n');
};

export const createShell = ({
    workDir,
    runId,
    parentEnv,
    limits = DEFAULT_LIMITS,
}: ShellOptions): Shell => {
    const env = commandEnv(parentEnv, runId);
    const stopping = new AbortController();
    // The session runs one call at a time.
    let running: Promise<unknown> = Promise.resolve();
    let disposed: Promise<Result<number, string>> | undefined;

    const handler = defineTool(
        { name: 'shell', description: describeShell(limits), schema: ShellArgs },
        async ({ command }) => {
            // playwright-cli scopes `list` and `close-all` to the sessions started from the
            // directory that holds .playwright/ (Brief R12.2), and works without one. Not
            // recursive, which would bring back a working directory that was deleted.
            await mkdir(join(workDir, '.playwright')).catch(() => undefined);

            const run = runCommand(command, {
                cwd: workDir,
                env,
                ...limits,
                signal: stopping.signal,
            });

            running = run;
            const result = await run;

            return result.ok ? ok(describeRun(result.value, limits.timeoutMs)) : result;
        },
    );

    // Closing the shell first matters: killing the running command resumes the session, which
    // could otherwise start a command after the listing that would outlive the run.
    const dispose = (): Promise<Result<number, string>> => {
        disposed ??= (async () => {
            stopping.abort();
            await Promise.allSettled([running]);

            return sweep(runId, { graceMs: limits.graceMs, parentEnv });
        })();

        return disposed;
    };

    return { handler, dispose };
};
