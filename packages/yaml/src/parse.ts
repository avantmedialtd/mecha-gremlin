import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { parse } from 'yaml';

export type Parser = (text: string) => Result<unknown, string>;

type Globals = {
    readonly Bun?: unknown;
};

// The yaml package's message goes on after its first line, which ends with a colon, with a code
// frame. Bun's messages are a single line.
const failure = (thrown: unknown): string => {
    const message = thrown instanceof Error ? thrown.message : String(thrown);

    return message.replace(/\n.*/s, '').replace(/:$/, '');
};

export const parseYamlWithBun = (text: string): Result<unknown, string> => {
    try {
        return ok(Bun.YAML.parse(text));
    } catch (thrown) {
        return err(failure(thrown));
    }
};

export const parseYamlWithPackage = (text: string): Result<unknown, string> => {
    try {
        // With its default log level, the package sends warnings, such as an unresolved tag, to
        // process.emitWarning, which prints them on stderr; 'error' keeps them off, and errors
        // still throw. Bun.YAML keeps the last of a repeated key and merges `<<` keys, and
        // `uniqueKeys: false` and `merge: true` do the same.
        const value: unknown = parse(text, {
            // '' behaves exactly like 'error': only 'silent' stops errors as well.
            // Stryker disable next-line StringLiteral
            logLevel: 'error',
            uniqueKeys: false,
            merge: true,
        });

        return ok(value);
    } catch (thrown) {
        return err(failure(thrown));
    }
};

// A function of the global object rather than a `typeof Bun` check: tests can't hide Bun's own
// global, so they reach both branches by passing objects of their own.
export const chooseParser = (globals: Globals): Parser => {
    return globals.Bun === undefined ? parseYamlWithPackage : parseYamlWithBun;
};

export const parseYaml: Parser = chooseParser(globalThis);
