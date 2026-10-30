import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { DataSource } from 'typeorm';

export type Store = { readonly path: string };

type Queue = <T>(work: () => Promise<T>) => Promise<T>;

type Connection = {
    readonly dataSource: DataSource;
    readonly queue: Queue;
};

// A closed store has no connection here, so the work asked of it is refused.
const connections = new WeakMap<Store, Connection>();

export const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

// TypeORM gives a DataSource one connection and one query runner on SQLite, so work that
// overlaps lands in another's transaction (Brief R17.2): each piece waits for the one before.
const createQueue = (): Queue => {
    let last: Promise<unknown> = Promise.resolve();

    return <T>(work: () => Promise<T>): Promise<T> => {
        const next = last.then(work);
        // A failure reaches only its own caller: the work queued after it still runs.
        last = next.catch(() => undefined);

        return next;
    };
};

/** For a DataSource that is initialised and migrated, with the database at `path`. */
export const connect = (path: string, dataSource: DataSource): Store => {
    const store: Store = { path };
    connections.set(store, { dataSource, queue: createQueue() });

    return store;
};

/** `action` completes the error's "Can't …", as in "save the credential". */
export const withDataSource = async <T>(
    store: Store,
    action: string,
    work: (dataSource: DataSource) => Promise<T>,
): Promise<Result<T, string>> => {
    const connection = connections.get(store);

    if (connection === undefined) {
        return err(`Can't ${action}: the store at ${store.path} is closed.`);
    }

    try {
        return ok(await connection.queue(() => work(connection.dataSource)));
    } catch (error) {
        return err(`Can't ${action} in the database at ${store.path}: ${reasonOf(error)}`);
    }
};

export const closeStore = async (store: Store): Promise<void> => {
    const connection = connections.get(store);

    if (connection === undefined) {
        return;
    }

    connections.delete(store);
    await connection.queue(() => connection.dataSource.destroy());
};
