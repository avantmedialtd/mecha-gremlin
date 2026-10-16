import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { renderCatalog } from '@mecha-gremlin/core/skills';
import { loadConfig, loadLogFormat, loadWorkDir } from '../config/config.ts';
import { createLogger } from '../log/log.ts';
import { createSession } from '../session/session.ts';
import { loadSkills } from '../skills/skills.ts';
import { activateSkillTool } from '../tools/activate-skill.ts';
import { readFileTool } from '../tools/read-file.ts';
import { createShell } from '../tools/shell.ts';
import { parseArgs } from './args.ts';
import { failure } from './failure.ts';
import { parsed, turnFields } from './fields.ts';

// 128 plus the signal's number, as a shell reports a process that a signal ended.
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

type HandledSignal = keyof typeof EXIT_CODES;

const HANDLED: readonly HandledSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Sent as a developer item, not as `instructions`, which LM Studio reportedly ignores (Brief C1). */
const instructions = (workDir: string): string => {
    return `You carry out tasks on this computer. You have a shell, and read_file for reading text files. The working directory is ${workDir}, and paths that commands print are relative to it. Keep your final answer brief.`;
};

// Its real path is used everywhere: on macOS /tmp and /var are links, and a path built from pwd
// would fail read_file's lexical check.
const findWorkDir = async (raw: string | undefined): Promise<Result<string, string>> => {
    const path = resolve(process.cwd(), raw ?? '');
    const problem = `WORK_DIR must name an existing directory; ${path} isn't one.`;

    try {
        const real = await realpath(path);

        return (await stat(real)).isDirectory() ? ok(real) : err(problem);
    } catch {
        return err(problem);
    }
};

const run = async (args: readonly string[]): Promise<number> => {
    const format = loadLogFormat(process.env);
    const log = createLogger(format.ok ? format.value : 'pretty');
    const fail = (message: string): number => {
        log.error(message);
        return 1;
    };

    if (!format.ok) {
        return fail(format.error);
    }

    // WORK_DIR is checked even when the other settings are wrong, so every problem is reported.
    const loaded = loadConfig(process.env);
    const workDir = await findWorkDir(loadWorkDir(process.env));

    if (!loaded.ok || !workDir.ok) {
        const problems = [
            ...(loaded.ok ? [] : loaded.error),
            ...(workDir.ok ? [] : [workDir.error]),
        ];

        for (const problem of problems) {
            log.error(problem);
        }

        return 1;
    }

    const config = loaded.value;
    const task = parseArgs(args);
    const { skills, notLoaded, warnings } = await loadSkills(config.skillsPath, process.cwd());

    for (const { path, reason } of notLoaded) {
        log.warn('skill not loaded', { path, reason });
    }

    for (const { skill, warning } of warnings) {
        log.warn('skill warning', { skill, warning });
    }

    if (skills.length > 0) {
        log.info('skills', { names: skills.map((skill) => skill.name).toSorted() });
    }

    const runId = crypto.randomUUID().slice(0, 8);
    const shell = createShell({ workDir: workDir.value, runId, parentEnv: process.env });
    let interrupted: HandledSignal | undefined;
    let finishing: Promise<void> | undefined;

    // Logged once, whichever path awaits it first.
    const finish = (): Promise<void> => {
        finishing ??= (async () => {
            const stopped = await shell.dispose();

            if (!stopped.ok) {
                log.warn('cleanup failed', { error: stopped.error });
            } else if (stopped.value > 0) {
                log.info('stopped', { count: stopped.value });
            }
        })();

        return finishing;
    };

    // A command runs in a process group of its own, which the terminal's Ctrl-C and hangup never
    // reach. Once the processes are being stopped, however the session ended, signals are
    // ignored: under `bun run`, one Ctrl-C reaches this process twice, and the sweep has a time
    // limit of its own. process.exit is needed because the session may be waiting on the model,
    // with no way to end on its own.
    const handlers = HANDLED.map((signal) => {
        const handler = (): void => {
            if (finishing !== undefined) {
                return;
            }

            interrupted = signal;
            log.warn('interrupted', { signal });
            void finish().then(() => process.exit(EXIT_CODES[signal]));
        };

        return [signal, handler] as const;
    });

    for (const [signal, handler] of handlers) {
        process.on(signal, handler);
    }

    try {
        const developer =
            skills.length > 0
                ? `${instructions(workDir.value)}\n\n${renderCatalog(skills)}`
                : instructions(workDir.value);
        const created = await createSession(config, {
            tools: [
                readFileTool(
                    workDir.value,
                    skills.map((skill) => skill.directory),
                ),
                shell.handler,
                ...(skills.length > 0 ? [activateSkillTool(skills)] : []),
            ],
            history: [
                { role: 'developer', content: developer },
                { role: 'user', content: task },
            ],
            maxTurns: config.maxTurns,
        });

        if (!created.ok) {
            return fail(created.error);
        }

        const session = created.value;

        if (session.note) {
            log.info(session.note);
        }

        log.info('asking', {
            model: session.model,
            baseUrl: config.baseUrl,
            run: runId,
            workDir: workDir.value,
            task,
        });

        for await (const step of session.steps) {
            // The session is stopping: the signal handler exits once its processes are stopped.
            if (interrupted !== undefined) {
                return EXIT_CODES[interrupted];
            }

            if ('turn' in step) {
                log.info('turn', turnFields(step.turn));
            }

            switch (step.kind) {
                case 'calls':
                    for (const { call, outcome } of step.calls) {
                        log.info('tool call', {
                            tool: call.name,
                            arguments: parsed(call.arguments),
                        });

                        if (outcome.ok) {
                            const bytes = new TextEncoder().encode(outcome.value).byteLength;
                            log.info('tool result', { tool: call.name, bytes });
                        } else {
                            log.warn('tool failed', { tool: call.name, error: outcome.error });
                        }
                    }

                    break;
                case 'final':
                    log.info('answer', { text: step.text });
                    return 0;
                default:
                    return fail(failure(step, config));
            }
        }

        // Can't run: the last step is always an answer or a failure.
        // Stryker disable next-line all
        throw new Error("The session's steps ran out before an answer or a failure.");
    } finally {
        await finish();

        for (const [signal, handler] of handlers) {
            process.off(signal, handler);
        }
    }
};

process.exitCode = await run(process.argv.slice(2));
