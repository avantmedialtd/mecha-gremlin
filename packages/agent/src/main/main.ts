import { renderCatalog } from '@mecha-gremlin/core/skills';
import { listMcpServers } from '@mecha-gremlin/store/mcp-server';
import { closeStore, openStore } from '@mecha-gremlin/store/store';
import { type FileTools, loadConfig, loadLogFormat } from '../config/config.ts';
import { createLogger } from '../log/log.ts';
import { type LeftOut, createMcpServers } from '../mcp/servers.ts';
import { createSession } from '../session/session.ts';
import { loadSkills } from '../skills/skills.ts';
import { activateSkillTool } from '../tools/activate-skill.ts';
import { applyPatchTool } from '../tools/apply-patch.ts';
import { editTool } from '../tools/edit.ts';
import { readTool } from '../tools/read.ts';
import { createShell } from '../tools/shell.ts';
import type { ToolHandler } from '../tools/tool-handler.ts';
import { writeTool } from '../tools/write.ts';
import { readTask } from './args.ts';
import { failure } from './failure.ts';
import { modelCallFields, parsed } from './fields.ts';

// 128 plus the signal's number, as a shell reports a process that a signal ended.
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

type HandledSignal = keyof typeof EXIT_CODES;

const HANDLED: readonly HandledSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Sent as a developer item, not as `instructions`, which LM Studio reportedly ignores (Brief C1). */
const instructions = (workDir: string, fileTools: FileTools): string => {
    const tools =
        fileTools === 'apply-patch'
            ? 'You have a shell, read for reading text files, and apply_patch for writing and changing them.'
            : 'You have a shell, read for reading text files, write for creating or replacing a file, and edit for changing part of one.';

    return `You carry out tasks on this computer. ${tools} The working directory is ${workDir}, and paths that commands print are relative to it. Keep your final answer brief.`;
};

// Last in the instructions: the parts before it stay the same for a configuration, so the prompt
// cache keeps them, and a run that left no server out sends the instructions it always did.
const leftOutNote = (leftOut: readonly LeftOut[]): string => {
    return [
        "These MCP servers couldn't start, so their tools aren't available:",
        ...leftOut.map(({ name, reason }) => `- ${name}: ${reason}`),
    ].join('\n');
};

// The two sets are never offered together, and the order stays fixed for the prompt cache.
const fileToolsFor = (fileTools: FileTools, workDir: string): ToolHandler[] => {
    return fileTools === 'apply-patch'
        ? [applyPatchTool(workDir)]
        : [writeTool(workDir), editTool(workDir)];
};

const run = async (args: readonly string[]): Promise<number> => {
    // An invalid LOG_FORMAT is one of the errors loadConfig reports, which still need a format.
    const log = createLogger(loadLogFormat(process.env) ?? 'pretty');
    const fail = (message: string): number => {
        log.error(message);
        return 1;
    };

    const loaded = loadConfig(process.env);
    // Read whatever the configuration's problems, to report its own with them.
    const task = await readTask(args);

    if (!loaded.ok || !task.ok) {
        const problems = [...(loaded.ok ? [] : loaded.error), ...(task.ok ? [] : [task.error])];

        for (const problem of problems) {
            log.error(problem);
        }

        return 1;
    }

    // A misspelt key, such as mcps, shows here, and a note's tags don't fail the run (D48).
    for (const key of task.value.ignored) {
        log.warn('frontmatter key ignored', { key });
    }

    const config = loaded.value;
    const { workDir, dataDir } = config;
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

    // Before any network request: a store that won't open fails the run first, and better-sqlite3's
    // first open on Linux can stall for seconds while sockets are open (its #1527, Brief R17.6).
    const opened = await openStore(dataDir);

    if (!opened.ok) {
        return fail(opened.error);
    }

    const { store, migrated } = opened.value;

    if (migrated.length > 0) {
        log.info('migrated', { names: migrated });
    }

    // Before the MCP servers, which carry the run's ID: the shell's sweep and the tests' signal
    // guard find their processes by it. Creating the shell only builds an environment.
    const runId = crypto.randomUUID().slice(0, 8);
    const shell = createShell({ workDir, runId, parentEnv: process.env });
    const mcp = createMcpServers({
        parentEnv: process.env,
        runId,
        workDir,
        dataDir,
        store,
        log,
    });
    let interrupted: HandledSignal | undefined;
    let finishing: Promise<void> | undefined;

    // Logged once, whichever path awaits it first. The MCP servers close first, those still
    // connecting included, so that the sweep, the backstop, finds none of their processes.
    const finish = (): Promise<void> => {
        finishing ??= (async () => {
            await mcp.close();
            const stopped = await shell.dispose();

            if (!stopped.ok) {
                log.warn('cleanup failed', { error: stopped.error });
            } else if (stopped.value > 0) {
                log.info('stopped', { count: stopped.value });
            }

            await closeStore(store);
            await mcp.removeDirectory();
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
        const listed = await listMcpServers(store);

        if (!listed.ok) {
            return fail(listed.error);
        }

        const connected = await mcp.connect(listed.value, task.value.mcp);

        // Cut short by a signal: the handler exits once everything is stopped.
        if (interrupted !== undefined) {
            return EXIT_CODES[interrupted];
        }

        if (!connected.ok) {
            for (const problem of connected.error) {
                log.error(problem);
            }

            return 1;
        }

        const { tools, leftOut } = connected.value;
        const developer = [
            instructions(workDir, config.fileTools),
            ...(skills.length > 0 ? [renderCatalog(skills)] : []),
            ...(leftOut.length > 0 ? [leftOutNote(leftOut)] : []),
        ].join('\n\n');
        const created = await createSession(config, {
            tools: [
                readTool(workDir),
                ...fileToolsFor(config.fileTools, workDir),
                shell.handler,
                ...(skills.length > 0 ? [activateSkillTool(skills)] : []),
                ...tools,
            ],
            history: [
                { kind: 'instruction', text: developer },
                { kind: 'user', text: task.value.text },
            ],
            maxSteps: config.maxSteps,
        });

        if (!created.ok) {
            return fail(created.error);
        }

        const session = created.value;

        log.info('asking', {
            model: session.model,
            baseUrl: config.baseUrl,
            run: runId,
            workDir,
            dataDir,
            task: task.value.text,
            taskFile: task.value.file,
            mcp: task.value.mcp,
        });

        for await (const step of session.steps) {
            // The session is stopping: the signal handler exits once its processes are stopped.
            if (interrupted !== undefined) {
                return EXIT_CODES[interrupted];
            }

            if ('stats' in step) {
                log.info('model call', modelCallFields(step.stats));
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
