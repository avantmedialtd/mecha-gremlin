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

// Every control character but tab: the line breaks are gone once the text is split into lines.
const CONTROL = /(?!\t)\p{Cc}/gu;

// JSON.stringify escapes U+0000 to U+001F, but leaves DEL and the C1 controls as they are.
const UNESCAPED = /[\u{7f}-\u{9f}]/gu;

const BARE = /^[^\s"=\p{Cc}]+$/u;

const escaped = (character: string): string => {
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
};

// A server's text reaches records, and written as it is, a control character could move the
// cursor, or start a terminal's escape sequence that hides a record.
const plain = (text: string): string => {
    return text.replaceAll(CONTROL, escaped);
};

const json = (value: Json): string => {
    return JSON.stringify(value).replaceAll(UNESCAPED, escaped);
};

/** Bare when it can't be misread as more than one value; JSON otherwise. */
const inline = (value: Json): string => {
    return typeof value === 'string' && BARE.test(value) ? value : json(value);
};

const indent = (line: string): string => {
    return `    ${line}`;
};

const pretty = (time: Date, level: Level, message: string, fields: readonly Field[]): string => {
    const [first, ...rest] = message.split(LINE_BREAK).map(plain);
    const line = [time.toTimeString().slice(0, 8), level.toUpperCase().padEnd(5), first];
    const blocks = rest.map(indent);

    for (const [key, value] of fields) {
        if (typeof value === 'string' && value.includes('\n')) {
            blocks.push(`  ${key}:`, ...value.split(LINE_BREAK).map(plain).map(indent));
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
                    : json({
                          time: time.toISOString(),
                          level,
                          message,
                          ...Object.fromEntries(defined),
                      });
            console.log(record);
        };

    return { info: write('info'), warn: write('warn'), error: write('error') };
};
