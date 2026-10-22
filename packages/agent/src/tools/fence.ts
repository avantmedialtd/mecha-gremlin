import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';

export const isInside = (root: string, target: string): boolean => {
    const path = relative(root, target);

    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export const isInsideAny = (directories: readonly string[], target: string): boolean => {
    return directories.some((directory) => isInside(directory, target));
};

/** Files named `.env*` hold secrets by convention; direnv's `.envrc` is meant to match too. */
export const isEnvFile = (path: string): boolean => {
    return basename(path).startsWith('.env');
};

/** `Object()` wraps anything thrown, null and strings too, so reading from it can't fail. */
export const errorCode = (error: unknown): unknown => {
    return Object(error).code;
};

export const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

// lstat doesn't follow a link, so a broken link exists too.
const exists = async (path: string): Promise<boolean> => {
    try {
        await lstat(path);
    } catch {
        return false;
    }

    return true;
};

/**
 * The read tool's check: the path must be inside the root or a skill directory, as written and
 * with links resolved, and neither name may be an environment file's. Gives the real path to read.
 * A missing file, like any other I/O error, rejects, for the tool to report. The skill directories
 * are real paths already, as loadSkills records them.
 */
export const fenceRead = async (
    root: string,
    skillDirectories: readonly string[],
    path: string,
): Promise<Result<string, string>> => {
    const name = JSON.stringify(path);
    const outside = err(`${name} is outside the directories the read tool may read.`);
    const secret = err(
        `${name} is an environment file. The read tool doesn't read those: they hold secrets.`,
    );
    // A path that's outside lexically is refused without touching the disk at all.
    const target = resolve(root, path);

    if (!isInsideAny([resolve(root), ...skillDirectories], target)) {
        return outside;
    }

    if (isEnvFile(target)) {
        return secret;
    }

    // Again with symbolic links resolved, so a link can't lead outside or to a secret.
    const real = await realpath(target);

    if (!isInsideAny([await realpath(root), ...skillDirectories], real)) {
        return outside;
    }

    return isEnvFile(real) ? secret : ok(real);
};

/**
 * The check of the tools that write: the path must be inside the root, which skill directories
 * aren't, as written and with links resolved, and neither name may be an environment file's. The
 * target need not exist: then the real path of its nearest existing ancestor decides, so a linked
 * directory can't lead outside even when the tool creates directories below it. Gives the
 * target's real path. Messages name the tool, since several tools share them.
 */
export const fenceWrite = async (
    root: string,
    tool: string,
    path: string,
): Promise<Result<string, string>> => {
    const name = JSON.stringify(path);
    const outside = err(
        `${name} is outside the working directory, the only place the ${tool} tool may write.`,
    );
    const secret = err(
        `${name} is an environment file. The ${tool} tool doesn't write those: they hold secrets.`,
    );
    const target = resolve(root, path);

    if (!isInside(resolve(root), target)) {
        return outside;
    }

    if (isEnvFile(target)) {
        return secret;
    }

    let existing = target;

    while (!(await exists(existing))) {
        existing = dirname(existing);
    }

    let real: string;

    try {
        real = await realpath(existing);
    } catch {
        // A broken link: writing through it would create its target wherever it points.
        return outside;
    }

    const realTarget = join(real, relative(existing, target));

    if (!isInside(await realpath(root), realTarget)) {
        return outside;
    }

    return isEnvFile(realTarget) ? secret : ok(realTarget);
};
