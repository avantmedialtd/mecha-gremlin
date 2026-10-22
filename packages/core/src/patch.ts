// The V4A patch format of OpenAI's Codex, as its apply-patch crate parses and applies it
// (codex-rs/apply-patch: parser.rs, streaming_parser.rs, seek_sequence.rs, file_update.rs and
// text_file.rs). Errors keep Codex's wording, which models trained on it recognise.
import { type Err, type Result, err, ok } from './result.ts';

/** One `@@` section of an Update File hunk. */
export type Chunk = {
    /** The line of an `@@ <line>` header, found first to place the chunk. */
    readonly context: string | undefined;
    /** The lines to find in the file: the chunk's context and removed lines, in order. */
    readonly oldLines: readonly string[];
    /** The lines that replace them: its context and added lines, in order. */
    readonly newLines: readonly string[];
    /** Where each context line sits in `oldLines` and in `newLines`. */
    readonly contextLines: readonly (readonly [number, number])[];
    /** Set by `*** End of File`: the old lines end the file. */
    readonly endOfFile: boolean;
};

export type Hunk =
    | { readonly type: 'add'; readonly path: string; readonly contents: string }
    | { readonly type: 'delete'; readonly path: string }
    | {
          readonly type: 'update';
          readonly path: string;
          readonly moveTo: string | undefined;
          readonly chunks: readonly Chunk[];
      };

type ChunkDraft = {
    context: string | undefined;
    oldLines: string[];
    newLines: string[];
    contextLines: [number, number][];
    endOfFile: boolean;
};

type Line = { readonly text: string; readonly number: number };

type Mode = 'add' | 'delete' | 'update' | 'ended';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const HEADER = '@@';
const HEADER_WITH_CONTEXT = '@@ ';

const invalidPatch = (message: string): Err<string> => {
    return err(`invalid patch: ${message}`);
};

const invalidHunk = (number: number, message: string): Err<string> => {
    return err(`invalid hunk at line ${number}, ${message}`);
};

const notAHeader = (line: string): string => {
    return `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`;
};

const unexpected = (line: string): string => {
    return `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
};

const expectedHeader = (line: string): string => {
    return `Expected update hunk to start with a @@ context marker, got: '${line}'`;
};

/** The hunk that a header starts, and its path; undefined for any other line. */
const startOf = (line: string): { readonly mode: Mode; readonly path: string } | undefined => {
    const starts = [
        [ADD, 'add'],
        [DELETE, 'delete'],
        [UPDATE, 'update'],
    ] as const;

    for (const [marker, mode] of starts) {
        if (line.startsWith(marker)) {
            return { mode, path: line.slice(marker.length) };
        }
    }

    return undefined;
};

const newChunk = (context: string | undefined): ChunkDraft => {
    return { context, oldLines: [], newLines: [], contextLines: [], endOfFile: false };
};

/** The lines between `*** Begin Patch` and `*** End Patch`, and the end marker's line number. */
const bounded = (
    lines: readonly Line[],
): Result<{ readonly body: readonly Line[]; readonly end: number }, string> => {
    const [first, ...rest] = lines;
    const last = rest.at(-1);

    if (first?.text.trim() !== BEGIN) {
        return invalidPatch("The first line of the patch must be '*** Begin Patch'");
    }

    if (last?.text.trim() !== END) {
        return invalidPatch("The last line of the patch must be '*** End Patch'");
    }

    return ok({ body: rest.slice(0, -1), end: last.number });
};

/**
 * Numbers the lines as the model wrote them, drops the blank lines around the patch, and strips
 * a heredoc wrapper, which models write when they take the tool for a shell command.
 */
const findPatch = (
    patch: string,
): Result<{ readonly body: readonly Line[]; readonly end: number }, string> => {
    const all = patch.split(/\r?\n/).map((line, index) => ({ text: line, number: index + 1 }));
    const lines = all.slice(
        all.findIndex((line) => line.text.trim() !== ''),
        all.findLastIndex((line) => line.text.trim() !== '') + 1,
    );
    const opening = lines.at(0)?.text.trim();
    const closing = lines.at(-1)?.text.trim();
    const wrapped =
        closing?.endsWith('EOF') &&
        ['<<EOF', "<<'EOF'", '<<"EOF"'].some((marker) => marker === opening);

    return bounded(wrapped ? lines.slice(1, -1) : lines);
};

/**
 * Parses a patch in Codex's V4A format into its hunks, in order. Like Codex's parser, it ignores
 * whitespace around markers and reads an empty line in an update as an empty context line.
 */
export const parsePatch = (patch: string): Result<Hunk[], string> => {
    const found = findPatch(patch);

    if (!found.ok) {
        return found;
    }

    const hunks: Hunk[] = [];
    // The hunk being read: what it is, its header's line, and what it holds so far. A header sets
    // them all before any line of its hunk is read.
    let mode: Mode | undefined;
    let start: number;
    let path: string;
    let moveTo: string | undefined;
    let added: string[];
    let chunks: ChunkDraft[];

    // A hunk ends at the next hunk's header or the end marker, and must hold something.
    const finish = (line: string, number: number): Result<undefined, string> => {
        if (mode === 'add') {
            if (added.length === 0) {
                return invalidHunk(start, `Add file hunk for path '${path}' is empty`);
            }

            hunks.push({ type: 'add', path, contents: `${added.join('\n')}\n` });
        }

        if (mode === 'delete') {
            hunks.push({ type: 'delete', path });
        }

        if (mode === 'update') {
            const last = chunks.at(-1);

            if (last === undefined) {
                return invalidHunk(start, `Update file hunk for path '${path}' is empty`);
            }

            if (last.oldLines.length === 0 && last.newLines.length === 0) {
                return invalidHunk(
                    number,
                    line === END ? 'Update hunk does not contain any lines' : unexpected(line),
                );
            }

            hunks.push({ type: 'update', path, moveTo, chunks });
        }

        return ok(undefined);
    };

    /** Takes a hunk's header or the end marker; `ok(false)` for any other line. */
    const header = (line: string, number: number): Result<boolean, string> => {
        const started = startOf(line);

        if (started === undefined && line !== END) {
            return ok(false);
        }

        const finished = finish(line, number);

        if (!finished.ok) {
            return finished;
        }

        if (started === undefined) {
            mode = 'ended';

            return ok(true);
        }

        mode = started.mode;
        path = started.path;
        start = number;
        moveTo = undefined;
        added = [];
        chunks = [];

        return ok(true);
    };

    const currentChunk = (): ChunkDraft => {
        const last = chunks.at(-1);

        if (last !== undefined) {
            return last;
        }

        const first = newChunk(undefined);
        chunks.push(first);

        return first;
    };

    // Markers count only with nothing before them: an indented one is a context line.
    const takeUpdate = (text: string, number: number): Result<undefined, string> => {
        const line = text.trimEnd();
        const started = header(line, number);

        if (!started.ok) {
            return started;
        }

        if (started.value) {
            return ok(undefined);
        }

        const last = chunks.at(-1);
        const opensChunk = line === HEADER || line.startsWith(HEADER_WITH_CONTEXT);
        const lastIsEmpty =
            last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0;

        if (last?.endOfFile) {
            if (line === '') {
                return ok(undefined);
            }

            if (!opensChunk) {
                return invalidHunk(number, expectedHeader(text));
            }
        }

        if (chunks.length === 0 && moveTo === undefined && line.startsWith(MOVE)) {
            moveTo = line.slice(MOVE.length);

            return ok(undefined);
        }

        if (opensChunk) {
            if (lastIsEmpty) {
                return invalidHunk(number, unexpected(text));
            }

            chunks.push(
                newChunk(line === HEADER ? undefined : line.slice(HEADER_WITH_CONTEXT.length)),
            );

            return ok(undefined);
        }

        if (line === END_OF_FILE) {
            if (lastIsEmpty) {
                return invalidHunk(number, 'Update hunk does not contain any lines');
            }

            if (last !== undefined) {
                last.endOfFile = true;
            }

            return ok(undefined);
        }

        if (text === '' || text.startsWith(' ')) {
            const chunk = currentChunk();
            chunk.contextLines.push([chunk.oldLines.length, chunk.newLines.length]);
            chunk.oldLines.push(text.slice(1));
            chunk.newLines.push(text.slice(1));

            return ok(undefined);
        }

        if (text.startsWith('+')) {
            currentChunk().newLines.push(text.slice(1));

            return ok(undefined);
        }

        if (text.startsWith('-')) {
            currentChunk().oldLines.push(text.slice(1));

            return ok(undefined);
        }

        return invalidHunk(
            number,
            last === undefined || lastIsEmpty ? unexpected(text) : expectedHeader(text),
        );
    };

    const take = (text: string, number: number): Result<undefined, string> => {
        if (mode === 'ended') {
            return text.trim() === ''
                ? ok(undefined)
                : invalidPatch("The last line of the patch must be '*** End Patch'");
        }

        if (mode === 'update') {
            return takeUpdate(text, number);
        }

        const line = text.trim();
        const started = header(line, number);

        if (!started.ok) {
            return started;
        }

        if (started.value) {
            return ok(undefined);
        }

        if (mode === 'add' && text.startsWith('+')) {
            added.push(text.slice(1));

            return ok(undefined);
        }

        return invalidHunk(number, notAHeader(line));
    };

    for (const { text: line, number } of found.value.body) {
        const taken = take(line, number);

        if (!taken.ok) {
            return taken;
        }
    }

    const finished = finish(END, found.value.end);

    if (!finished.ok) {
        return finished;
    }

    return hunks.length === 0
        ? invalidPatch(
              "The patch has no hunks: it needs at least one '*** Add File: {path}', '*** Delete File: {path}' or '*** Update File: {path}' section",
          )
        : ok(hunks);
};

const same = (line: string): string => {
    return line;
};

const trimEnd = (line: string): string => {
    return line.trimEnd();
};

const trim = (line: string): string => {
    return line.trim();
};

/** Codex's table: typographic dashes, quotes and spaces read as their ASCII counterparts. */
const fold = (line: string): string => {
    return line
        .trim()
        .replace(/[‐-―−]/g, '-')
        .replace(/[‘-‛]/g, "'")
        .replace(/[“-‟]/g, '"')
        .replace(/[  -   　]/g, ' ');
};

/**
 * Where `pattern` first occurs in `lines` as a run, from `start` on. Each pass is more lenient
 * than the one before, and the first pass that finds it decides. With `endOfFile`, the search
 * starts no earlier than where the pattern would end the file.
 */
const seek = (
    lines: readonly string[],
    pattern: readonly string[],
    start: number,
    endOfFile: boolean,
): number | undefined => {
    const first = endOfFile ? Math.max(lines.length - pattern.length, start) : start;

    for (const normalise of [same, trimEnd, trim, fold]) {
        const wanted = pattern.map(normalise);

        for (let at = first; at + pattern.length <= lines.length; at++) {
            const run = lines.slice(at, at + pattern.length);

            if (run.every((line, index) => normalise(line) === wanted[index])) {
                return at;
            }
        }
    }

    return undefined;
};

type Replacement = {
    readonly start: number;
    readonly removed: number;
    readonly added: readonly string[];
};

/** Which of the file's lines each chunk replaces, and with what, in the file's order. */
const replacementsOf = (
    lines: readonly string[],
    chunks: readonly Chunk[],
    path: string,
): Result<Replacement[], string> => {
    const replacements: Replacement[] = [];
    let position = 0;

    for (const chunk of chunks) {
        if (chunk.context !== undefined) {
            const at = seek(lines, [chunk.context], position, false);

            if (at === undefined) {
                return err(`Failed to find context '${chunk.context}' in ${path}`);
            }

            position = at + 1;
        }

        if (chunk.oldLines.length === 0) {
            replacements.push({ start: lines.length, removed: 0, added: chunk.newLines });
            continue;
        }

        let pattern = chunk.oldLines;
        let added = chunk.newLines;
        let at = seek(lines, pattern, position, chunk.endOfFile);

        // A last empty line often stands for the file's final line break, which isn't a line.
        if (at === undefined && pattern.at(-1) === '') {
            pattern = pattern.slice(0, -1);
            added = added.at(-1) === '' ? added.slice(0, -1) : added;
            at = seek(lines, pattern, position, chunk.endOfFile);
        }

        if (at === undefined) {
            return err(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`);
        }

        // Context lines stay as the file has them, so a lenient match doesn't rewrite them: only
        // the runs between them are replaced, an empty run by nothing.
        let oldStart = 0;
        let newStart = 0;

        for (const [oldIndex, newIndex] of chunk.contextLines) {
            if (oldIndex >= pattern.length || newIndex >= added.length) {
                break;
            }

            replacements.push({
                start: at + oldStart,
                removed: oldIndex - oldStart,
                added: added.slice(newStart, newIndex),
            });
            oldStart = oldIndex + 1;
            newStart = newIndex + 1;
        }

        replacements.push({
            start: at + oldStart,
            removed: pattern.length - oldStart,
            added: added.slice(newStart),
        });
        position = at + pattern.length;
    }

    return ok(replacements.toSorted((a, b) => a.start - b.start));
};

/**
 * Applies an Update File hunk's chunks to a file's contents. Each line keeps its own line ending,
 * and inserted lines take the file's first one, or `\n`. As in Codex, every line of the result
 * ends with a line break, the last one included.
 */
export const applyChunks = (
    contents: string,
    chunks: readonly Chunk[],
    path: string,
): Result<string, string> => {
    const lines: { readonly text: string; readonly ending: string }[] = [];
    let start = 0;

    for (const match of contents.matchAll(/\r\n|\r|\n/g)) {
        lines.push({ text: contents.slice(start, match.index), ending: match[0] });
        start = match.index + match[0].length;
    }

    if (start < contents.length) {
        lines.push({ text: contents.slice(start), ending: '' });
    }

    const replaced = replacementsOf(
        lines.map((line) => line.text),
        chunks,
        path,
    );

    if (!replaced.ok) {
        return replaced;
    }

    const ending = lines.find((line) => line.ending !== '')?.ending ?? '\n';
    const result: { readonly text: string; readonly ending: string }[] = [];
    let index = 0;

    for (const replacement of replaced.value) {
        result.push(
            ...lines.slice(index, replacement.start),
            ...replacement.added.map((text) => ({ text, ending })),
        );
        index = replacement.start + replacement.removed;
    }

    result.push(...lines.slice(index));

    return ok(result.map((line) => line.text + (line.ending || ending)).join(''));
};
