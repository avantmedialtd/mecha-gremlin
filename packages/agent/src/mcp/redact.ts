// A server's text, before it reaches a record or the model. Only references can hold a secret,
// since `add` refuses literal ones, so only the values they resolved to are replaced: redacting
// every value in the entry would garble the text for nothing.

export const REDACTED = '[redacted]';

export type Redact = (text: string) => string;

/** Replaces each non-empty value, longest first, so that a value inside a longer one goes too. */
export const redactor = (values: readonly string[]): Redact => {
    const secrets = [...new Set(values)]
        .filter((value) => value !== '')
        .toSorted((first, second) => second.length - first.length);

    return (text) => {
        return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
    };
};
