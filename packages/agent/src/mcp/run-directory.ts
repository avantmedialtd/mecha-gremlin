// The directory stdio servers run in when their entries name none (D36). npm reads the .npmrc of
// the nearest directory above its working directory that holds a package.json or a node_modules,
// so an empty node_modules here makes it read none above: not one the file tools wrote into
// WORK_DIR, nor one a repository brought there (Brief R18.1). One that a shell command writes to
// ~/.npmrc still counts.
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { isInside } from '../tools/fence.ts';

/** Makes the run's directory, mode 0700, in the OS's temporary directory. */
export const makeRunDirectory = async (
    workDir: string,
    dataDir: string,
): Promise<Result<string, string>> => {
    let temporary: string;

    try {
        temporary = await realpath(tmpdir());
    } catch {
        return err(
            `The temporary directory, ${tmpdir()}, doesn't exist, so stdio MCP servers can't get a directory of their own: set TMPDIR to one that does.`,
        );
    }

    if (isInside(workDir, temporary) || isInside(dataDir, temporary)) {
        return err(
            `The temporary directory, ${temporary}, is inside WORK_DIR or DATA_DIR, where the agent's tools could change what a stdio MCP server reads: set TMPDIR to a directory outside both.`,
        );
    }

    const directory = await mkdtemp(join(temporary, 'gremlin-mcp-'));
    await mkdir(join(directory, 'node_modules'));

    return ok(directory);
};
