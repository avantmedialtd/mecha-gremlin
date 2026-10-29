/** Keep only explicitly named response headers; never expose credentials or arbitrary headers. */
export const selectHeaders = <K extends string>(
    headers: Headers | undefined,
    names: readonly K[],
): Partial<Record<K, string>> => {
    const selected: Partial<Record<K, string>> = {};

    if (headers !== undefined) {
        for (const name of names) {
            const value = headers.get(name);

            if (value !== null) {
                selected[name] = value;
            }
        }
    }

    return selected;
};

/** Both SDKs attach the HTTP response headers to their API errors. */
export const errorHeaders = (error: unknown): Headers | undefined => {
    const headers: unknown = Object(error).headers;

    return headers instanceof Headers ? headers : undefined;
};

/**
 * Both SDKs add the `name: value` lines of their `*_CUSTOM_HEADERS` variable to every request,
 * parsed this way. Gremlin sends only the headers its settings name, so a client's default
 * headers start by removing each of those again.
 */
export const withoutCustomHeaders = (variable: string | undefined): Record<string, null> => {
    if (variable === undefined) {
        return {};
    }

    const names = variable
        .split('\n')
        .filter((line) => line.includes(':'))
        .map((line) => line.slice(0, line.indexOf(':')).trim());

    return Object.fromEntries(names.map((name) => [name, null]));
};
