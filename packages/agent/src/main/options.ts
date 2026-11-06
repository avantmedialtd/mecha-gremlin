import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { err, ok } from '@mecha-gremlin/core/result';

/** The sentences that end a refusal: one for an unknown option, and one for an option's value. */
export type Hints = {
    readonly unknown: string;
    readonly value: string;
};

type OptionToken = {
    readonly name: string;
    readonly rawName: string;
    readonly value?: string;
    readonly inlineValue?: boolean;
};

// What strict parsing refuses in an option, given its type: a name it doesn't know; a value for a
// boolean one; and no value, or one taken from the next argument that starts with -, which is most
// often the next option. Such a value is given by the long name, since a short option takes the =
// into its value.
const refusalsOf = (
    type: 'string' | 'boolean' | undefined,
    hints: Hints,
    { name, rawName, value, inlineValue }: OptionToken,
): string[] => {
    if (type === undefined) {
        return [`The option ${rawName} isn't known. ${hints.unknown}`];
    }

    if (type === 'boolean') {
        if (value === undefined) {
            return [];
        }

        return [`The option ${rawName} takes no value. ${hints.value}`];
    }

    if (
        value === undefined ||
        (inlineValue === false && value.length > 1 && value.startsWith('-'))
    ) {
        return [
            `The option ${rawName} needs a value; one that starts with - is given as --${name}=<value>. ${hints.value}`,
        ];
    }

    return [];
};

// Strict parsing names the argument it can't read only in its error's text, so a lenient reading of
// the same arguments finds the first one first, to name it. Without one, strict parsing, the
// default, can't fail, and gives the values their types.
export const parse = <T extends ParseArgsOptionsConfig>(
    args: readonly string[],
    options: T,
    hints: Hints,
) => {
    const { tokens } = parseArgs({
        args,
        options,
        strict: false,
        allowPositionals: true,
        tokens: true,
    });
    // Own options only: `constructor` is no option.
    const typeOf = (name: string): 'string' | 'boolean' | undefined => {
        return Object.entries(options).find(([option]) => option === name)?.[1].type;
    };
    const [refusal] = tokens.flatMap((token) => {
        if (token.kind !== 'option') {
            return [];
        }

        return refusalsOf(typeOf(token.name), hints, token);
    });

    if (refusal !== undefined) {
        return err(refusal);
    }

    return ok(parseArgs({ args, options, allowPositionals: true, tokens: true }));
};
