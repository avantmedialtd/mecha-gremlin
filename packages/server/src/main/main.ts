import { loadConfig } from '../config/config.ts';
import { createLogger, logFormat } from '../log/log.ts';
import { createSession } from '../session/session.ts';
import { readFileTool } from '../tools/read-file.ts';
import { parseArgs } from './args.ts';
import { failure } from './failure.ts';
import { parsed, turnFields } from './fields.ts';

/** Sent as a developer item, not as `instructions`, which LM Studio reportedly ignores (Brief C1). */
const INSTRUCTIONS =
    'You answer questions about files in the working directory. Before answering a question about a file, read it with the read_file tool. Keep your answers brief.';

const run = async (args: readonly string[]): Promise<number> => {
    const format = logFormat(process.env.LOG_FORMAT);
    const log = createLogger(format ?? 'pretty');
    const fail = (message: string): number => {
        log.error(message);
        return 1;
    };

    if (format === undefined) {
        return fail(
            `LOG_FORMAT must be pretty or json; got ${JSON.stringify(process.env.LOG_FORMAT)}.`,
        );
    }

    const loaded = loadConfig(process.env);

    if (!loaded.ok) {
        for (const problem of loaded.error) {
            log.error(problem);
        }

        return 1;
    }

    const config = loaded.value;
    const { file, question } = parseArgs(args);

    const created = await createSession(config, {
        tools: [readFileTool(process.cwd())],
        history: [
            { role: 'developer', content: INSTRUCTIONS },
            { role: 'user', content: `File: ${file}\nQuestion: ${question}` },
        ],
    });

    if (!created.ok) {
        return fail(created.error);
    }

    const session = created.value;

    if (session.note) {
        log.info(session.note);
    }

    log.info('asking', { model: session.model, baseUrl: config.baseUrl, file, question });

    for await (const step of session.steps) {
        if ('turn' in step) {
            log.info('turn', turnFields(step.turn));
        }

        switch (step.kind) {
            case 'calls':
                for (const { call, outcome } of step.calls) {
                    log.info('tool call', { tool: call.name, arguments: parsed(call.arguments) });

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

    throw new Error("The session's steps ran out before an answer or a failure.");
};

process.exitCode = await run(process.argv.slice(2));
