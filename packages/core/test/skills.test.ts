import { describe, expect, test } from 'vitest';
import {
    type CatalogEntry,
    readSkill,
    renderActivation,
    renderCatalog,
    splitFrontmatter,
} from '../src/skills.ts';

const SKILL_MD = '---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n';

const DESCRIPTION = 'Work with PDFs.';

describe('splitFrontmatter', () => {
    test('a skill as the spec describes it', () => {
        expect(splitFrontmatter(SKILL_MD)).toEqual({
            ok: true,
            value: { frontmatter: 'name: pdf\ndescription: Work with PDFs.', body: '# PDF' },
        });
    });

    test('Windows line endings', () => {
        expect(splitFrontmatter(SKILL_MD.replaceAll('\n', '\r\n'))).toEqual(
            splitFrontmatter(SKILL_MD),
        );
    });

    test('no frontmatter', () => {
        expect(splitFrontmatter('# PDF\n')).toEqual({
            ok: false,
            error: 'it has no frontmatter: SKILL.md must start with a --- line',
        });
    });

    test('a first line that only starts like a delimiter', () => {
        expect(splitFrontmatter('--- \nname: pdf\n---\n')).toMatchObject({ ok: false });
    });

    test("frontmatter that doesn't end", () => {
        expect(splitFrontmatter('---\nname: pdf\n')).toEqual({
            ok: false,
            error: "its frontmatter doesn't end: no --- line closes it",
        });
    });

    test('the first --- line ends it, and the body keeps any later one', () => {
        expect(splitFrontmatter('---\na: 1\n----\nb: 2\n---\nabove\n---\nbelow')).toEqual({
            ok: true,
            value: { frontmatter: 'a: 1\n----\nb: 2', body: 'above\n---\nbelow' },
        });
    });

    test('empty frontmatter, and nothing after it', () => {
        expect(splitFrontmatter('---\n---')).toEqual({
            ok: true,
            value: { frontmatter: '', body: '' },
        });
    });

    test('the body is trimmed at both ends only', () => {
        expect(splitFrontmatter('---\na: 1\n---\n\n  line 1\n  line 2  \n\n')).toEqual({
            ok: true,
            value: { frontmatter: 'a: 1', body: 'line 1\n  line 2' },
        });
    });
});

describe('readSkill', () => {
    test('a skill as the spec describes it', () => {
        expect(readSkill('pdf', { name: 'pdf', description: DESCRIPTION }, '# PDF')).toEqual({
            ok: true,
            value: { name: 'pdf', description: DESCRIPTION, body: '# PDF', warnings: [] },
        });
    });

    test.each([
        ['an array', ['pdf']],
        ['null', null],
        ['a string', 'pdf'],
        ['a number', 42],
    ])("frontmatter that isn't a mapping: %s", (_kind, frontmatter) => {
        expect(readSkill('pdf', frontmatter, '')).toEqual({
            ok: false,
            error: "its frontmatter isn't a mapping",
        });
    });

    test.each([
        ['missing', { name: 'pdf' }],
        ['only spaces', { name: 'pdf', description: '   ' }],
        ['not a string', { name: 'pdf', description: 42 }],
    ])('no description: %s', (_kind, frontmatter) => {
        expect(readSkill('pdf', frontmatter, '')).toEqual({
            ok: false,
            error: 'it has no description',
        });
    });

    test('a name that differs from its directory', () => {
        expect(readSkill('pdf-tools', { name: 'pdf', description: DESCRIPTION }, '')).toEqual({
            ok: true,
            value: {
                name: 'pdf',
                description: DESCRIPTION,
                body: '',
                warnings: ["its name, pdf, differs from its directory's, pdf-tools"],
            },
        });
    });

    test.each([
        ['missing', {}],
        ['blank', { name: '  ' }],
        ['not a string', { name: 42 }],
    ])('a name that is %s', (_kind, name) => {
        expect(readSkill('pdf', { ...name, description: DESCRIPTION }, '')).toMatchObject({
            ok: true,
            value: {
                name: 'pdf',
                warnings: ["its name is missing, so it takes its directory's name, pdf"],
            },
        });
    });

    test('the name and the description are trimmed', () => {
        expect(readSkill('pdf', { name: ' pdf ', description: `  ${DESCRIPTION}\n` }, '')).toEqual({
            ok: true,
            value: { name: 'pdf', description: DESCRIPTION, body: '', warnings: [] },
        });
    });

    test('long values', () => {
        const name = 'p'.repeat(65);

        expect(readSkill(name, { name, description: 'd'.repeat(1025) }, '')).toMatchObject({
            ok: true,
            value: {
                name,
                warnings: [
                    "its name is 65 characters long, more than the spec's 64",
                    "its description is 1025 characters long, more than the spec's 1024",
                ],
            },
        });
    });

    test('values at the limits', () => {
        const name = 'p'.repeat(64);

        expect(readSkill(name, { name, description: 'd'.repeat(1024) }, '')).toMatchObject({
            ok: true,
            value: { warnings: [] },
        });
    });

    test('an emoji counts as one character', () => {
        const name = '📄'.repeat(64);

        expect(readSkill(name, { name, description: '📄'.repeat(1024) }, '')).toMatchObject({
            ok: true,
            value: { warnings: [] },
        });
    });

    test('a fallback name is held to the limit too', () => {
        const directory = 'p'.repeat(65);

        expect(readSkill(directory, { description: DESCRIPTION }, '')).toMatchObject({
            ok: true,
            value: {
                warnings: [
                    `its name is missing, so it takes its directory's name, ${directory}`,
                    "its name is 65 characters long, more than the spec's 64",
                ],
            },
        });
    });

    test('keys from other clients change nothing', () => {
        const frontmatter = {
            name: 'pdf',
            description: DESCRIPTION,
            license: 'MIT',
            compatibility: 'any',
            'allowed-tools': 'Bash(pdftotext:*)',
            homepage: 'https://example.com/pdf',
            metadata: { openclaw: { requires: { bins: ['pdftotext'] } } },
        };

        expect(readSkill('pdf', frontmatter, '# PDF')).toEqual(
            readSkill('pdf', { name: 'pdf', description: DESCRIPTION }, '# PDF'),
        );
    });
});

const catalogOf = (...skills: readonly CatalogEntry[]): string => {
    return renderCatalog(skills);
};

describe('renderCatalog', () => {
    test('the instruction, then each skill', () => {
        expect(catalogOf({ name: 'pdf', description: DESCRIPTION })).toBe(
            [
                "Skills give you instructions for particular kinds of task. When a task matches a skill's description, call activate_skill with the skill's name before you start, then follow its instructions. Read a skill's own files with read_file, by absolute path.",
                '',
                '<available_skills>',
                '<skill>',
                '<name>pdf</name>',
                '<description>Work with PDFs.</description>',
                '</skill>',
                '</available_skills>',
            ].join('\n'),
        );
    });

    test('sorted by name', () => {
        const catalog = catalogOf(
            { name: 'pdf', description: 'PDFs.' },
            { name: 'browser', description: 'Browsers.' },
        );

        expect(catalog.indexOf('<name>browser</name>')).toBeLessThan(
            catalog.indexOf('<name>pdf</name>'),
        );
    });

    test('escaped text', () => {
        const catalog = catalogOf({ name: 'a&b<c>', description: 'Compare <a> & <b>' });

        expect(catalog).toContain('<name>a&amp;b&lt;c&gt;</name>');
        expect(catalog).toContain('<description>Compare &lt;a&gt; &amp; &lt;b&gt;</description>');
    });

    test('in code-unit order, whatever the locale', () => {
        const catalog = catalogOf(
            { name: 'pdf', description: 'PDFs.' },
            { name: 'browser', description: 'Browsers.' },
            { name: 'PDF-tools', description: 'More PDFs.' },
        );
        const names = [...catalog.matchAll(/<name>(.*)<\/name>/g)].map((match) => match[1]);

        expect(names).toEqual(['PDF-tools', 'browser', 'pdf']);
    });

    test('same skills, same text', () => {
        const pdf = { name: 'pdf', description: 'PDFs.' };
        const browser = { name: 'browser', description: 'Browsers.' };
        const excel = { name: 'excel', description: 'Spreadsheets.' };

        expect(catalogOf(pdf, browser, excel)).toBe(catalogOf(excel, pdf, browser));
    });
});

const SKILL = { name: 'pdf', body: '# PDF', directory: '/skills/pdf' };

const resourcesOf = (files: readonly string[]): string[] => {
    const text = renderActivation(SKILL, files);
    const start = text.indexOf('<skill_resources>\n') + '<skill_resources>\n'.length;

    return text.slice(start, text.indexOf('</skill_resources>')).split('\n').slice(0, -1);
};

const numbered = (count: number, prefix: string): string[] => {
    return Array.from({ length: count }, (_, n) => `${prefix}${String(n).padStart(3, '0')}.md`);
};

describe('renderActivation', () => {
    test("the body, the directory and the skill's files", () => {
        expect(
            renderActivation(SKILL, ['SKILL.md', 'scripts/fill.py', 'references/forms.md']),
        ).toBe(
            [
                '<skill_content name="pdf">',
                '# PDF',
                '',
                'Skill directory: /skills/pdf',
                "Paths to this skill's own files, such as references/…, are relative to the skill directory.",
                '',
                '<skill_resources>',
                '<file>references/forms.md</file>',
                '<file>scripts/fill.py</file>',
                '</skill_resources>',
                '</skill_content>',
            ].join('\n'),
        );
    });

    test('hidden files and paths are left out, and a SKILL.md below the top stays', () => {
        expect(
            resourcesOf([
                '.DS_Store',
                '.git/config',
                'docs/.drafts/plan.md',
                'docs/notes.v2.md',
                'docs/SKILL.md',
                'SKILL.md',
            ]),
        ).toEqual(['<file>docs/SKILL.md</file>', '<file>docs/notes.v2.md</file>']);
    });

    test('no files', () => {
        expect(resourcesOf(['SKILL.md'])).toEqual([]);
    });

    test('the name and the file paths are escaped', () => {
        const text = renderActivation({ ...SKILL, name: 'a"b<c>&' }, [
            '</skill_resources>.md',
            'a&b.md',
        ]);

        expect(text).toMatch(/^<skill_content name="a&quot;b&lt;c&gt;&amp;">\n/);
        expect(resourcesOf(['</skill_resources>.md', 'a&b.md'])).toEqual([
            '<file>&lt;/skill_resources&gt;.md</file>',
            '<file>a&amp;b.md</file>',
        ]);
        expect(text.match(/<\/skill_resources>/g)).toHaveLength(1);
    });

    test('many files: the first 100, then how many more, hidden ones not counted', () => {
        const files = [...numbered(500, '.git/objects/'), ...numbered(150, 'refs/')].toReversed();

        expect(resourcesOf(files)).toEqual([
            ...numbered(100, 'refs/').map((file) => `<file>${file}</file>`),
            '(50 more files)',
        ]);
    });

    test('one more file', () => {
        expect(resourcesOf(numbered(101, 'refs/')).at(-1)).toBe('(1 more file)');
    });

    test('exactly 100 files', () => {
        expect(resourcesOf(numbered(100, 'refs/'))).toHaveLength(100);
    });
});
