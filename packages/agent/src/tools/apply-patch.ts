import type { Stats } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type Hunk, applyChunks, parsePatch } from '@mecha-gremlin/core/patch';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { z } from 'zod';
import { readEditable } from './edit.ts';
import { errorCode, fenceWrite, reasonOf } from './fence.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';
import { checkReplaceable } from './write.ts';

// Adapted from Codex's apply_patch instructions. A function tool can't carry Codex's grammar, so
// this is all the guidance on the format that the model gets.
const DESCRIPTION = `Add, change, move or delete files with a patch. Nothing is changed unless the whole patch applies. The patch is text in this envelope:

*** Begin Patch
[one or more file sections]
*** End Patch

Each section starts with one of these headers:
*** Add File: <path> creates a file, or replaces one. Every line after it starts with +.
*** Delete File: <path> removes a file. Nothing follows it.
*** Update File: <path> changes a file in place. To rename it too, put *** Move to: <new path> on the next line. Then come one or more chunks, each starting with @@. A chunk's lines start with a space for an unchanged line, - for a removed one and + for an added one. Show 3 unchanged lines above and below each change, copied exactly. When the lines a chunk changes occur more than once, write the line that comes before them, such as a function's first line, after the @@, as in @@ def greet():, to pick the place.

Paths are relative to the working directory. Name each file in one section only.

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch`;

const ApplyPatchArgs = z.strictObject({ patch: z.string() });

const REPLACE_INSTEAD = 'Change part of it with an *** Update File section instead.';

/** One hunk's change, worked out before any file is touched. */
type Change = {
    /** Its line in the report: `A`, `M` or `D`, and the path as the patch gives it. */
    readonly line: string;
    readonly apply: () => Promise<void>;
};

type Claim = (path: string) => Promise<Result<string, string>>;

const writeCreating = async (target: string, contents: string): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
};

const checkDeletable = async (target: string, name: string): Promise<Result<undefined, string>> => {
    let info: Stats;

    try {
        info = await stat(target);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return err(`No such file: ${name}.`);
        }

        throw error;
    }

    return info.isDirectory() ? err(`${name} is a directory.`) : ok(undefined);
};

// A deleted or moved path is removed as the patch names it, so a link goes, not what it points to.
const plan = async (root: string, hunk: Hunk, claim: Claim): Promise<Result<Change, string>> => {
    const name = JSON.stringify(hunk.path);
    const source = await claim(hunk.path);

    if (!source.ok) {
        return source;
    }

    switch (hunk.type) {
        case 'add': {
            const existing = await checkReplaceable(source.value, name, REPLACE_INSTEAD);

            if (!existing.ok) {
                return existing;
            }

            return ok({
                line: `A ${hunk.path}`,
                apply: () => writeCreating(source.value, hunk.contents),
            });
        }
        case 'delete': {
            const deletable = await checkDeletable(source.value, name);

            if (!deletable.ok) {
                return deletable;
            }

            return ok({ line: `D ${hunk.path}`, apply: () => unlink(resolve(root, hunk.path)) });
        }
        case 'update': {
            const text = await readEditable(source.value, name);

            if (!text.ok) {
                return text;
            }

            const updated = applyChunks(text.value, hunk.chunks, hunk.path);

            if (!updated.ok) {
                return updated;
            }

            if (hunk.moveTo === undefined) {
                return ok({
                    line: `M ${hunk.path}`,
                    apply: () => writeFile(source.value, updated.value),
                });
            }

            const destination = await claim(hunk.moveTo);

            if (!destination.ok) {
                return destination;
            }

            const existing = await checkReplaceable(
                destination.value,
                JSON.stringify(hunk.moveTo),
                REPLACE_INSTEAD,
            );

            if (!existing.ok) {
                return existing;
            }

            return ok({
                line: `M ${hunk.moveTo}`,
                apply: async () => {
                    await writeCreating(destination.value, updated.value);
                    await unlink(resolve(root, hunk.path));
                },
            });
        }
    }
};

/**
 * Every hunk is checked and worked out before any file changes: its paths fenced, and the files
 * it updates or deletes read. A file named twice is refused, since each hunk is worked out from
 * the file as it is now, and a later one would undo an earlier one.
 */
const planAll = async (root: string, hunks: readonly Hunk[]): Promise<Result<Change[], string>> => {
    const claimed = new Set<string>();
    const changes: Change[] = [];

    const claim: Claim = async (path) => {
        const fenced = await fenceWrite(root, 'apply_patch', path);

        if (!fenced.ok) {
            return fenced;
        }

        const real = fenced.value;

        if (claimed.has(real)) {
            return err(
                `The patch names ${JSON.stringify(path)} more than once. Put all of a file's changes in one section.`,
            );
        }

        claimed.add(real);

        return ok(real);
    };

    for (const hunk of hunks) {
        const change = await plan(root, hunk, claim);

        if (!change.ok) {
            return change;
        }

        changes.push(change.value);
    }

    return ok(changes);
};

const applyPatch = async (root: string, patch: string): Promise<ToolOutcome> => {
    const parsed = parsePatch(patch);

    if (!parsed.ok) {
        return parsed;
    }

    let changes: Result<Change[], string>;

    try {
        changes = await planAll(root, parsed.value);
    } catch (error) {
        return err(`Can't apply the patch: ${reasonOf(error)}. No file was changed.`);
    }

    if (!changes.ok) {
        return changes;
    }

    const done: string[] = [];

    for (const change of changes.value) {
        try {
            await change.apply();
        } catch (error) {
            const before =
                done.length === 0
                    ? 'No file was changed before it.'
                    : `Changed before it, and still changed: ${done.join(', ')}.`;

            return err(`Applying ${change.line} failed (${reasonOf(error)}). ${before}`);
        }

        done.push(change.line);
    }

    return ok(['Success. Updated the following files:', ...done].join('\n'));
};

export const applyPatchTool = (root: string): ToolHandler => {
    return defineTool(
        { name: 'apply_patch', description: DESCRIPTION, schema: ApplyPatchArgs },
        ({ patch }) => applyPatch(root, patch),
    );
};
