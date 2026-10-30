import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type Opened, type Store, closeStore, openStore } from '../src/store.ts';

// The data folders and stores a test opens, closed and removed when it ends.
const folders: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
    for (const store of stores.splice(0)) {
        await closeStore(store);
    }

    for (const folder of folders.splice(0)) {
        await rm(folder, { recursive: true, force: true });
    }
});

export const dataFolder = async (): Promise<string> => {
    const folder = await mkdtemp(join(tmpdir(), 'store-'));
    folders.push(folder);

    return folder;
};

/** Opens a store in the folder, or in a new one, and fails the test if it can't. */
export const open = async (folder?: string): Promise<Opened> => {
    const opened = await openStore(folder ?? (await dataFolder()));

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    stores.push(opened.value.store);

    return opened.value;
};
