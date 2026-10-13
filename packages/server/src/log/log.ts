export type Json =
    | string
    | number
    | boolean
    | null
    | readonly Json[]
    | { readonly [key: string]: Json };

type RecordKey = 'time' | 'level' | 'message';

/**
 * An undefined field is left out, as `JSON.stringify` does. No field can take a name the record
 * uses itself, which in JSON would overwrite the record's own value.
 */
export type Fields = Readonly<Record<string, Json | undefined>> & {
    readonly [key in RecordKey]?: never;
};

export type LogFormat = 'pretty' | 'json';

export type Logger = {
    info(message: string, fields?: Fields): void;
    warn(message: string, fields?: Fields): void;
    error(message: string, fields?: Fields): void;
};

type Level = 'info' | 'warn' | 'error';

type Field = readonly [key: string, value: Json];

const LINE_BREAK = /\r?\n/;

/** Bare when it can't be misread as more than one value; JSON otherwise. */
const inline = (value: Json): string => {
    return typeof value === 'string' && /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
};

const indent = (line: string): string => {
    return `    ${line}`;
};

const pretty = (time: Date, level: Level, message: string, fields: readonly Field[]): string => {
    const [first, ...rest] = message.split(LINE_BREAK);
    const line = [time.toTimeString().slice(0, 8), level.toUpperCase().padEnd(5), first];
    const blocks = rest.map(indent);

    for (const [key, value] of fields) {
        if (typeof value === 'string' && value.includes('\n')) {
            blocks.push(`  ${key}:`, ...value.split(LINE_BREAK).map(indent));
        } else {
            line.push(`${key}=${inline(value)}`);
        }
    }

    return [line.join(' '), ...blocks].join('\n');
};

export const createLogger = (format: LogFormat): Logger => {
    const write =
        (level: Level) =>
        (message: string, fields: Fields = {}): void => {
            const time = new Date(Date.now());
            // Dropped first, so that an undefined `time`, `level` or `message` can't overwrite the
            // record's own.
            const defined = Object.entries(fields).filter(
                (field): field is [string, Json] => field[1] !== undefined,
            );
            const record =
                format === 'pretty'
                    ? pretty(time, level, message, defined)
                    : JSON.stringify({
                          time: time.toISOString(),
                          level,
                          message,
                          ...Object.fromEntries(defined),
                      });
            console.log(record);
        };

    return { info: write('info'), warn: write('warn'), error: write('error') };
};
