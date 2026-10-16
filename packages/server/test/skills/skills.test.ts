import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseYaml } from '@mecha-gremlin/yaml/parse';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadSkills } from '../../src/skills/skills.ts';

const DESCRIPTION = 'Work with PDFs.';

let dir: string;

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'skills-')));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, text: string): Promise<string> => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);

    return full;
};

const skillText = (name: string, description = DESCRIPTION, body = `# ${name}`): string => {
    return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
};

const skill = (name: string, path = name) => {
    return { name, description: DESCRIPTION, body: `# ${name}`, directory: join(dir, path) };
};

describe('Find skills in the directories SKILLS_PATH lists', () => {
    test('a skill in a root', async () => {
        await write('root/pdf/SKILL.md', skillText('pdf'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [skill('pdf', 'root/pdf')],
            notLoaded: [],
            warnings: [],
        });
    });

    test("entries that aren't skills are skipped without a record", async () => {
        await write('root/pdf/SKILL.md', skillText('pdf'));
        await write('root/notes/todo.md', 'Not a skill.');
        await write('root/README.md', 'Not a skill either.');
        await write('root/lower/skill.md', skillText('lower'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [skill('pdf', 'root/pdf')],
            notLoaded: [],
            warnings: [],
        });
    });

    test('nothing deeper than the subdirectories is searched', async () => {
        await write('root/group/pdf/SKILL.md', skillText('pdf'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [],
            notLoaded: [],
            warnings: [],
        });
    });

    test('a relative root and empty entries', async () => {
        await write('skills/pdf/SKILL.md', skillText('pdf'));
        // Were an empty entry the current directory, this would load too.
        await write('stray/SKILL.md', skillText('stray'));

        expect(await loadSkills(':skills:', dir)).toEqual({
            skills: [skill('pdf', 'skills/pdf')],
            notLoaded: [],
            warnings: [],
        });
    });

    test.each([undefined, ''])('no skills configured: %j', async (skillsPath) => {
        await write('pdf/SKILL.md', skillText('pdf'));

        expect(await loadSkills(skillsPath, dir)).toEqual({
            skills: [],
            notLoaded: [],
            warnings: [],
        });
    });

    test('a missing root', async () => {
        await write('root/pdf/SKILL.md', skillText('pdf'));
        const missing = join(dir, 'missing');

        expect(await loadSkills(`${missing}:${join(dir, 'root')}`, dir)).toEqual({
            skills: [skill('pdf', 'root/pdf')],
            notLoaded: [
                {
                    path: missing,
                    reason: expect.stringMatching(/^the skills root can't be read \(ENOENT: .*\)$/),
                },
            ],
            warnings: [],
        });
    });

    test('a root that is a file', async () => {
        const file = await write('skills.txt', 'Not a directory.');

        expect(await loadSkills(file, dir)).toEqual({
            skills: [],
            notLoaded: [
                {
                    path: file,
                    reason: expect.stringMatching(
                        /^the skills root can't be read \(ENOTDIR: .*\)$/,
                    ),
                },
            ],
            warnings: [],
        });
    });

    test("a linked skill is loaded from the link's target", async () => {
        await write('elsewhere/pdf-real/SKILL.md', skillText('pdf'));
        await mkdir(join(dir, 'root'));
        await symlink(join(dir, 'elsewhere/pdf-real'), join(dir, 'root/pdf'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [skill('pdf', 'elsewhere/pdf-real')],
            notLoaded: [],
            warnings: [],
        });
    });

    test('the earlier root wins', async () => {
        await write('a/pdf/SKILL.md', skillText('pdf'));
        const later = await write('b/pdf/SKILL.md', skillText('pdf', 'Another.'));

        expect(await loadSkills(`${join(dir, 'a')}:${join(dir, 'b')}`, dir)).toEqual({
            skills: [skill('pdf', 'a/pdf')],
            notLoaded: [
                {
                    path: later,
                    reason: `the name pdf is already taken by ${join(dir, 'a/pdf/SKILL.md')}`,
                },
            ],
            warnings: [],
        });
    });

    test('two skills in one root with the same name: the first in sorted order wins', async () => {
        const old = await write('root/pdf-old/SKILL.md', skillText('pdf'));
        await write('root/pdf/SKILL.md', skillText('pdf'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [skill('pdf', 'root/pdf')],
            notLoaded: [
                {
                    path: old,
                    reason: `the name pdf is already taken by ${join(dir, 'root/pdf/SKILL.md')}`,
                },
            ],
            // pdf-old's name differs from its directory's, but it isn't loaded.
            warnings: [],
        });
    });
});

describe('Read SKILL.md leniently', () => {
    test('the server reports a skill without frontmatter', async () => {
        const file = await write('root/pdf/SKILL.md', '# PDF\n');

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [],
            notLoaded: [
                {
                    path: file,
                    reason: 'it has no frontmatter: SKILL.md must start with a --- line',
                },
            ],
            warnings: [],
        });
    });

    test("frontmatter that isn't valid YAML", async () => {
        const file = await write('root/pdf/SKILL.md', '---\nname: [pdf\n---\n# PDF\n');
        const parsed = parseYaml('name: [pdf');

        expect(parsed.ok).toBe(false);
        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [],
            notLoaded: [
                {
                    path: file,
                    reason: `its frontmatter isn't valid YAML: ${parsed.ok ? '' : parsed.error}`,
                },
            ],
            warnings: [],
        });
    });

    test('a skill without a description', async () => {
        const file = await write('root/pdf/SKILL.md', '---\nname: pdf\n---\n# PDF\n');

        expect(await loadSkills(join(dir, 'root'), dir)).toMatchObject({
            notLoaded: [{ path: file, reason: 'it has no description' }],
        });
    });

    test("a SKILL.md that can't be read", async () => {
        const file = join(dir, 'root/pdf/SKILL.md');
        await mkdir(file, { recursive: true });

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [],
            notLoaded: [
                {
                    path: file,
                    reason: expect.stringMatching(/^SKILL\.md can't be read \(EISDIR: .*\)$/),
                },
            ],
            warnings: [],
        });
    });

    test('the server reports a warning', async () => {
        await write('root/pdf-tools/SKILL.md', skillText('pdf'));

        expect(await loadSkills(join(dir, 'root'), dir)).toEqual({
            skills: [skill('pdf', 'root/pdf-tools')],
            notLoaded: [],
            warnings: [
                { skill: 'pdf', warning: "its name, pdf, differs from its directory's, pdf-tools" },
            ],
        });
    });

    test('frontmatter in the shapes real skills use, quietly', async () => {
        const warnings = vi.spyOn(process, 'emitWarning');
        const stdout = vi.spyOn(process.stdout, 'write');
        const stderr = vi.spyOn(process.stderr, 'write');
        await write(
            'root/pdf/SKILL.md',
            [
                '---',
                'name: pdf',
                'description: "Use `pdftotext`: it extracts the text, as in `a: b`."',
                'homepage: https://example.com/pdf',
                'metadata: { "openclaw": { "requires": { "bins": ["pdftotext",], }, }, }',
                'license: !thing MIT',
                'allowed-tools: Bash(pdftotext:*)',
                '---',
                '# PDF',
            ].join('\n'),
        );

        const loaded = await loadSkills(join(dir, 'root'), dir);

        expect(loaded).toEqual({
            skills: [
                {
                    ...skill('pdf', 'root/pdf'),
                    description: 'Use `pdftotext`: it extracts the text, as in `a: b`.',
                    body: '# PDF',
                },
            ],
            notLoaded: [],
            warnings: [],
        });
        expect([...warnings.mock.calls, ...stdout.mock.calls, ...stderr.mock.calls]).toEqual([]);
    });

    test('a custom tag reads as the text after it', async () => {
        await write(
            'root/pdf/SKILL.md',
            '---\nname: pdf\ndescription: !thing Work with PDFs.\n---\n',
        );

        expect(await loadSkills(join(dir, 'root'), dir)).toMatchObject({
            skills: [{ name: 'pdf', description: DESCRIPTION }],
        });
    });
});
