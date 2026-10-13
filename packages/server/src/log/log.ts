export type Json =
    | string
    | number
    | boolean
    | null
    | readonly Json[]
    | { readonly [key: string]: Json };

/** An undefined field is left out, as `JSON.stringify` does. */
export type Fields = Readonly<Record<string, Json | undefined>>;

export type LogFormat = 'pretty' | 'json';

export type Logger = {
    info(message: string, fields?: Fields): void;
    warn(message: string, fields?: Fields): void;
    error(message: string, fields?: Fields): void;
};

type Level = 'info' | 'warn' | 'error';

/** Unset or empty means the default, `pretty`; anything but `pretty` or `json` is no format at all. */
export const logFormat = (value: string | undefined): LogFormat | undefined => {
    if (value === undefined || value === '' || value === 'pretty') {
        return 'pretty';
    }

    return value === 'json' ? 'json' : undefined;
};

/** Bare when it can't be misread as more than one value; JSON otherwise. */
const inline = (value: Json): string => {
    return typeof value === 'string' && /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
};

const pretty = (time: Date, level: Level, message: string, fields: Fields): string => {
    const line = [time.toTimeString().slice(0, 8), level.toUpperCase().padEnd(5), message];
    const blocks: string[] = [];

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }

        if (typeof value === 'string' && value.includes('\n')) {
            blocks.push(`  ${key}:`, ...value.split('\n').map((text) => `    ${text}`));
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
            const record =
                format === 'pretty'
                    ? pretty(time, level, message, fields)
                    : JSON.stringify({ time: time.toISOString(), level, message, ...fields });
            console.log(record);
        };

    return { info: write('info'), warn: write('warn'), error: write('error') };
};
