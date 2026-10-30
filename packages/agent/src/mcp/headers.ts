// An MCP server's own headers. Both runtimes' errors for a bad header value print the value, so
// values are checked before any Headers object exists (Brief R18.1).

// RFC 9110's token.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// The transport sets these itself, or the protocol depends on them.
const RESERVED = new Set([
    'accept',
    'content-type',
    'content-length',
    'host',
    'connection',
    'transfer-encoding',
    'last-event-id',
    'dpop',
]);

// A control character other than tab, or a character beyond Latin-1.
const REFUSED = /(?!\t)\p{Cc}|[\u{100}-\u{10ffff}]/u;

export const headerNameProblems = (names: readonly string[]): string[] => {
    const seen = new Set<string>();

    return names.flatMap((name) => {
        const lower = name.toLowerCase();
        const shown = JSON.stringify(name);

        if (!TOKEN.test(name)) {
            return [`The header name ${shown} isn't an RFC 9110 token.`];
        }

        if (RESERVED.has(lower) || lower.startsWith('mcp-')) {
            return [`The header ${name} is the transport's own, and can't be set.`];
        }

        if (seen.has(lower)) {
            return [`The header ${name} is given twice, ignoring case.`];
        }

        seen.add(lower);

        return [];
    });
};

/** Why a header's value can't be sent, without quoting it. */
export const headerValueProblems = (where: string, value: string): string[] => {
    if (value === '') {
        return [`${where} is empty.`];
    }

    return REFUSED.test(value)
        ? [`${where} holds a control character, or a character beyond U+00FF.`]
        : [];
};
