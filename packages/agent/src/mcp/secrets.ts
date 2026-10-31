// Literal secrets in an MCP server's entry. An entry gives secrets only as references to the
// agent's environment, so a slot whose name says it holds a credential must hold one, and text
// shaped like a secret is refused wherever it is. Vendors' snippets carry literal and placeholder
// secrets, and clients accept them (Brief R18.1).
import { type Template, hasReference, parseTemplate } from './references.ts';

// Whole words, so that GITHUB_OAUTH_CALLBACK_PORT isn't one, as a substring match on AUTH would
// have it (Brief R18.1).
const CREDENTIAL_WORDS = new Set([
    'KEY',
    'KEYS',
    'APIKEY',
    'TOKEN',
    'TOKENS',
    'SECRET',
    'SECRETS',
    'PASSWORD',
    'PASSWORDS',
    'PASSWD',
    'PASS',
    'PASSPHRASE',
    'PAT',
    'AUTH',
    'AUTHORIZATION',
    'CREDENTIAL',
    'CREDENTIALS',
    'COOKIE',
]);

// Such as PRIVATE_KEY_PATH, which says where a secret is rather than holding it.
const LOCATION_WORDS = new Set(['PATH', 'FILE', 'DIR']);

// Settings such as MAX_TOKENS=4096 and AUTH_TYPE=none.
const SETTING = /^(?:-?\d+(?:\.\d+)?|true|false|none)$/i;

// A known prefix, at the start or after a character that isn't a letter or a digit, and enough
// characters after it: without both, sk- would refuse task-master-ai and --disk-cache.
const TOKEN =
    /(?:^|[^A-Za-z0-9])(?:ghp_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|sk-|sk_live_|rk_live_|ntn_|lin_api_)[A-Za-z0-9_-]{16}/;

const AWS_KEY = /(?:^|[^A-Za-z0-9])AKIA[A-Z0-9]{16}/;

const JWT = /eyJ[\w-]+\.eyJ[\w-]+\./;

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// RFC 9110's token68, after the scheme.
const WRITTEN_OUT = /(?:^|[^A-Za-z0-9])(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]+=*)/gi;

// A password in a URL, as in a connection string: whatever the scheme, after it come a user's
// name, a colon and the password.
const USERINFO = /:\/\/[^/?#@\s:]*:([^/?#@\s]+)@/g;

// In double quotes, the shell replaces a reference with the variable's value before `add` sees it.
export const ADVICE =
    "Give it as a reference, such as ${NAME}, to a variable set in .env, in single quotes, so that your shell leaves it alone. A secret typed on a command line is in the shell's history: change it.";

export const wordsOf = (name: string): string[] => {
    return name
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[ ._-]/)
        .filter((word) => word !== '')
        .map((word) => word.toUpperCase());
};

/** Whether a slot with this name, such as an env variable or an option, holds a credential. */
export const isCredentialName = (name: string): boolean => {
    const words = wordsOf(name);

    return (
        words.some((word) => CREDENTIAL_WORDS.has(word)) &&
        !LOCATION_WORDS.has(String(words.at(-1)))
    );
};

/** A credential slot must hold a reference, unless its value is a setting such as `none`. */
export const holdsLiteralSecret = (value: Template, raw: string): boolean => {
    return !hasReference(value) && !SETTING.test(raw);
};

// "Basic Authentication" in a description is prose; a credential has a digit or a symbol, or
// mixes cases beyond a capital first letter, as base64 does.
const credentialLike = (token: string): boolean => {
    return /[\d._~+/=-]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1)));
};

// A password made only of references is no literal secret.
const literalPassword = (password: string): boolean => {
    return parseTemplate(password).template.some((part) => typeof part === 'string');
};

/** What a text holds that is shaped like a secret, if anything. */
export const secretShape = (text: string): string | undefined => {
    if (TOKEN.test(text) || AWS_KEY.test(text)) {
        return 'text shaped like a token';
    }

    if ([...text.matchAll(WRITTEN_OUT)].some((match) => credentialLike(String(match[1])))) {
        return 'a credential written out';
    }

    if (JWT.test(text)) {
        return 'a JSON Web Token';
    }

    if (PRIVATE_KEY.test(text)) {
        return 'a private key';
    }

    if ([...text.matchAll(USERINFO)].some((match) => literalPassword(String(match[1])))) {
        return 'a password in a URL';
    }

    return undefined;
};
