// Where the login's redirect comes back (D38): a listener on 127.0.0.1 alone, since a listen()
// without a host takes every interface (Brief R17.5), serving the redirect URI's one path. While
// it listens, a line on stdin that holds the address the browser ended on counts as the redirect,
// which is what works over SSH, as Codex, Claude Code and pi allow.
import { type Server, createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { type Result, err, ok } from '@mecha-gremlin/core/result';

export type RedirectOptions = {
    /** `--redirect-uri`, as loopbackUri() accepts it. */
    readonly given: URL | undefined;
    /** The redirect URI the saved client registered, used again while its port is free. */
    readonly registered: string | undefined;
    /** Where a pasted address comes from: stdin. */
    readonly input: Readonly<NodeJS.ReadableStream>;
    /** Says what was wrong with a line that was pasted. */
    readonly warn: (text: string) => void;
};

export type Redirect = {
    /** The redirect URI to send. */
    readonly uri: string;
    /** The redirect's parameters, from the browser or pasted, or why none came. */
    readonly wait: () => Promise<Result<URLSearchParams, string>>;
    /** Stops listening, and reading stdin. */
    readonly close: () => Promise<void>;
};

type Listening = {
    readonly server: Server;
    readonly uri: string;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

// Port 0 leaves the port to the system.
const ANY_PORT = 'http://127.0.0.1:0/callback';

const WAIT_MS = 5 * 60_000;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>mecha-gremlin</title>
<p>The login goes on in the terminal. You can close this tab.</p>
`;

/** A redirect URI that a listener here can take: http, on 127.0.0.1 or localhost, with a port. */
export const loopbackUri = (text: string): URL | undefined => {
    const url = URL.parse(text);

    return url !== null && url.protocol === 'http:' && LOOPBACK.has(url.hostname) && url.port !== ''
        ? url
        : undefined;
};

// The browser gets its page before the redirect counts, so that closing the listener then can't
// cut the page short.
const listenAt = async (
    target: URL,
    take: (parameters: URLSearchParams) => void,
): Promise<Result<Listening, string>> => {
    const server = createServer((request, response) => {
        const url = new URL(String(request.url), target);

        if (url.pathname !== target.pathname) {
            response.writeHead(404, { connection: 'close' }).end();

            return;
        }

        response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
            .end(PAGE, () => {
                take(url.searchParams);
            });
    });
    // The port it got, which for port 0 the system picked.
    const listened = await new Promise<Result<number, string>>((resolve) => {
        const failed = (error: Readonly<Error>): void => {
            resolve(err(error.message));
        };

        server.once('error', failed);
        server.listen(Number(target.port), '127.0.0.1', () => {
            resolve(ok(Number(Object(server.address()).port)));
        });
    });

    if (!listened.ok) {
        return err(`Can't listen for the redirect on 127.0.0.1:${target.port}: ${listened.error}`);
    }

    const uri = new URL(target);
    uri.port = String(listened.value);

    return ok({ server, uri: uri.href });
};

/**
 * Listens for the redirect on `--redirect-uri`'s port, else the registered one while it's free,
 * else one the system picks, and reads stdin for a pasted address.
 */
export const listenForRedirect = async ({
    given,
    registered,
    input,
    warn,
}: RedirectOptions): Promise<Result<Redirect, string>> => {
    const { promise, resolve } = Promise.withResolvers<Result<URLSearchParams, string>>();
    const take = (parameters: URLSearchParams): void => {
        resolve(ok(parameters));
    };
    let listening = await listenAt(
        given ?? loopbackUri(String(registered)) ?? new URL(ANY_PORT),
        take,
    );

    // Only a port asked for is kept to; a registered one that is taken gives way.
    if (!listening.ok && given === undefined) {
        listening = await listenAt(new URL(ANY_PORT), take);
    }

    if (!listening.ok) {
        return listening;
    }

    const { server, uri } = listening.value;
    const lines = createInterface({ input });
    let timer: ReturnType<typeof setTimeout> | undefined;

    lines.on('line', (line) => {
        const text = line.trim();
        const url = URL.parse(text);

        if (url !== null && (url.searchParams.has('code') || url.searchParams.has('error'))) {
            take(url.searchParams);
        } else if (text !== '') {
            warn(
                "That line isn't the address the browser ended on: paste all of it, which holds code= or error=.",
            );
        }
    });

    return ok({
        uri,
        wait: () => {
            timer = setTimeout(() => {
                resolve(err('The login waited 5 minutes for the redirect, which never came.'));
            }, WAIT_MS);

            return promise;
        },
        close: async () => {
            clearTimeout(timer);
            lines.close();
            await new Promise((closed) => {
                server.close(closed);
                // Node's close() waits for every connection, one whose request never ends too;
                // Bun's ends them itself, so mutation testing, which runs on Bun, can't tell.
                // Stryker disable next-line CallExpression
                server.closeAllConnections();
            });
        },
    });
};
