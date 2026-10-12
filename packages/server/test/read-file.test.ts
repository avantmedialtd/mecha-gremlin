import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolOutcome, toFunctionTool } from "@mecha-gremlin/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { READ_LIMIT, readFileTool } from "../src/read-file.ts";

let root: string;
let outside: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "read-file-root-"));
    outside = await mkdtemp(join(tmpdir(), "read-file-outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret");

    await writeFile(join(root, "notes.txt"), "hello");
    await writeFile(join(root, "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(join(root, ".env"), "MODEL_API_KEY=sk-live-secret");
    await writeFile(join(root, ".env.local"), "OTHER_SECRET=1");
    await symlink(join(root, ".env"), join(root, "innocent.txt"));
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await symlink(join(root, "notes.txt"), join(root, "alias.txt"));
    await writeFile(join(root, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    await writeFile(join(root, "late-nul.txt"), `${"a".repeat(8 * 1024)}\0tail`);
    await writeFile(join(root, "small.txt"), "s".repeat(1000));
    await writeFile(join(root, "exact.txt"), "e".repeat(READ_LIMIT));
    await writeFile(join(root, "big.txt"), "b".repeat(40_000));
    await writeFile(join(root, "euro.txt"), "€".repeat(20_000));
    await writeFile(join(root, "continuations.txt"), new Uint8Array(40_000).fill(0x80));
    await writeFile(join(root, "locked.txt"), "locked");
    await chmod(join(root, "locked.txt"), 0o000);
});

afterAll(async () => {
    await chmod(join(root, "locked.txt"), 0o600);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

/** Calls the tool the way the loop does, with the model's raw JSON arguments. */
function read(path: string): Promise<ToolOutcome> {
    return readFileTool(root).invoke(JSON.stringify({ path }));
}

/** The error of a failed outcome; fails the test if the call succeeded. */
function errorOf(outcome: ToolOutcome): string {
    expect(outcome.ok).toBe(false);
    return (outcome as Extract<ToolOutcome, { ok: false }>).error;
}

describe("Read a UTF-8 text file under a root directory", () => {
    test("reads a file", async () => {
        expect(await read("notes.txt")).toEqual({ ok: true, output: "hello" });
    });

    test("reads a nested file", async () => {
        expect(await read("docs/guide.md")).toEqual({ ok: true, output: "# Guide\n" });
    });

    test("replaces invalid UTF-8 with U+FFFD", async () => {
        // "café!" in Latin-1: the lone 0xE9 isn't valid UTF-8.
        expect(await read("latin1.txt")).toEqual({ ok: true, output: "caf�!" });
    });

    test("reads an absolute path inside the root", async () => {
        expect(await read(join(root, "notes.txt"))).toEqual({ ok: true, output: "hello" });
    });

    test("the model sees a closed schema", () => {
        const tool = toFunctionTool(readFileTool(root).tool);
        expect(tool).toMatchObject({ type: "function", name: "read_file", strict: true });
        expect(tool.parameters).toEqual({
            type: "object",
            properties: { path: { type: "string", description: expect.any(String) } },
            required: ["path"],
            additionalProperties: false,
        });
    });

    test("the model is told what the tool reads, and how much", () => {
        const tool = toFunctionTool(readFileTool(root).tool);
        expect(tool.description).toContain("UTF-8 text file in the working directory");
        expect(tool.description).toContain("32 KiB");
        expect(tool.parameters).toMatchObject({
            properties: {
                path: { description: expect.stringContaining("relative to the working directory") },
            },
        });
    });

    test("extra arguments are rejected before any file is read", async () => {
        // Had the file been looked up, a missing one would say so.
        const error = errorOf(await readFileTool(root).invoke('{"path":"missing.txt","limit":5}'));
        expect(error).toContain('(root): Unrecognized key: "limit"');
        expect(error).not.toContain("No such file");
    });
});

describe("Never read outside the root", () => {
    test.each(["..", "../secret.txt", "/etc/hosts", "docs/../../secret.txt"])(
        "%s",
        async (path) => {
            expect(errorOf(await read(path))).toBe(
                `${JSON.stringify(path)} is outside the directory read_file may read.`,
            );
        },
    );

    test("a symbolic link pointing outside", async () => {
        const error = errorOf(await read("link.txt"));
        expect(error).toBe('"link.txt" is outside the directory read_file may read.');
        expect(error).not.toContain("top secret");
    });

    test("a symbolic link pointing inside", async () => {
        expect(await read("alias.txt")).toEqual({ ok: true, output: "hello" });
    });

    test("a name that only starts with two dots is inside", async () => {
        expect(errorOf(await read("..notes.txt"))).toBe('No such file: "..notes.txt".');
    });
});

describe("Refuse secrets, directories and binary files", () => {
    test.each([".env", ".env.local", "docs/.env.missing"])("environment file %s", async (path) => {
        const error = errorOf(await read(path));
        expect(error).toBe(
            `${JSON.stringify(path)} is an environment file. read_file doesn't read those: they hold secrets.`,
        );
    });

    test("a link to an environment file", async () => {
        const error = errorOf(await read("innocent.txt"));
        expect(error).toContain('"innocent.txt" is an environment file.');
        expect(error).not.toContain("sk-live-secret");
    });

    test("a directory", async () => {
        expect(errorOf(await read("docs"))).toBe('"docs" is a directory.');
    });

    test("a binary file", async () => {
        expect(errorOf(await read("logo.png"))).toBe('"logo.png" is a binary file.');
    });

    test("a NUL byte after the first 8 KiB doesn't make a file binary", async () => {
        expect(await read("late-nul.txt")).toEqual({
            ok: true,
            output: `${"a".repeat(8 * 1024)}\0tail`,
        });
    });

    test("a missing file", async () => {
        expect(errorOf(await read("missing.txt"))).toBe('No such file: "missing.txt".');
    });

    test.skipIf(process.getuid?.() === 0)("an unreadable file", async () => {
        expect(errorOf(await read("locked.txt"))).toMatch(/^Can't read "locked.txt": EACCES/);
    });
});

describe("Cap what it returns", () => {
    test("a small file is returned whole", async () => {
        expect(await read("small.txt")).toEqual({ ok: true, output: "s".repeat(1000) });
    });

    test("a file of exactly the limit is returned whole", async () => {
        expect(await read("exact.txt")).toEqual({ ok: true, output: "e".repeat(READ_LIMIT) });
    });

    test("a large file is cut, with a note", async () => {
        expect(await read("big.txt")).toEqual({
            ok: true,
            output: `${"b".repeat(32_768)}\n\n[truncated: showing the first 32768 of 40000 bytes]`,
        });
    });

    test("a cut never moves back past the start of the file", async () => {
        // Nothing but UTF-8 continuation bytes: no character starts anywhere before the limit.
        expect(await read("continuations.txt")).toEqual({
            ok: true,
            output: "\n\n[truncated: showing the first 0 of 40000 bytes]",
        });
    });

    test("the cut never splits a character", async () => {
        const outcome = await read("euro.txt");
        expect(outcome).toEqual({
            ok: true,
            output: `${"€".repeat(10_922)}\n\n[truncated: showing the first 32766 of 60000 bytes]`,
        });
    });
});
