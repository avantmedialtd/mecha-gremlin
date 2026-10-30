import { ADVICE } from './secrets.ts';

// The fetch standard's bad ports (fetch.spec.whatwg.org, "port blocking"): Node's fetch refuses
// them, and Bun's connects (Brief R18.1).
const BAD_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
    103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
    512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
    995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
    6669, 6679, 6697, 10080,
]);

/**
 * Where a URL's authority ends in its text: the scheme, userinfo, host and port come before it.
 * A text without `://` has none, so all of it counts.
 */
export const authorityEnd = (text: string): number => {
    const start = text.indexOf('://');

    if (start === -1) {
        return text.length;
    }

    const end = text.slice(start + 3).search(/[/?#]/);

    return end === -1 ? text.length : start + 3 + end;
};

/** What breaks the rules for an MCP server's URL, without quoting it. */
export const urlProblems = (where: string, text: string): string[] => {
    let url: URL;

    try {
        url = new URL(text);
    } catch {
        return [`${where} isn't a URL.`];
    }

    const problems: string[] = [];

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push(`${where} must start with https:// or http://.`);
    }

    if (url.username !== '' || url.password !== '') {
        problems.push(`${where} holds a user name or a password. ${ADVICE}`);
    }

    // An empty fragment leaves its # in the URL, though the hash reads as empty.
    if (url.href.includes('#')) {
        problems.push(`${where} has a fragment.`);
    }

    // A URL without a port reads as port 0, which isn't on the list.
    if (BAD_PORTS.has(Number(url.port))) {
        problems.push(`${where} has the port ${url.port}, which fetch refuses.`);
    }

    return problems;
};
