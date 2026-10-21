import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ToolOutcome, toFunctionTool } from '@mecha-gremlin/core/tools';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { LoadedSkill } from '../../src/skills/skills.ts';
import { activateSkillTool } from '../../src/tools/activate-skill.ts';

let dir: string;

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'activate-')));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, text = ''): Promise<void> => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
};

const skill = (name: string, path = name): LoadedSkill => {
    return { name, description: `About ${name}.`, body: `# ${name}`, directory: join(dir, path) };
};

const activate = (
    tool: ReturnType<typeof activateSkillTool>,
    name: string,
): Promise<ToolOutcome> => {
    return tool.invoke(JSON.stringify({ name }));
};

const resourcesOf = (outcome: ToolOutcome): string[] => {
    expect(outcome.ok).toBe(true);

    const text = outcome.ok ? outcome.value : '';
    const start = text.indexOf('<skill_resources>\n') + '<skill_resources>\n'.length;

    return text.slice(start, text.indexOf('</skill_resources>')).split('\n').slice(0, -1);
};

describe('Activate a skill with activate_skill', () => {
    test("the model sees a closed schema with the skills' names", () => {
        const tool = toFunctionTool(activateSkillTool([skill('browser'), skill('pdf')]).tool);

        expect(tool).toMatchObject({ type: 'function', name: 'activate_skill', strict: true });
        expect(tool.description).toBe(
            "Load a skill's full instructions, with its directory and the list of its files. Name a skill from the available_skills list in your instructions.",
        );
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: { name: { type: 'string', enum: ['browser', 'pdf'] } },
            required: ['name'],
            additionalProperties: false,
        });
    });

    test('activating a skill', async () => {
        await write('pdf/SKILL.md', '---\nname: pdf\n---\n# pdf');
        await write('pdf/scripts/fill.py');
        await write('pdf/references/forms.md');

        expect(await activate(activateSkillTool([skill('pdf')]), 'pdf')).toEqual({
            ok: true,
            value: [
                '<skill_content name="pdf">',
                '# pdf',
                '',
                `Skill directory: ${join(dir, 'pdf')}`,
                "Paths to this skill's own files, such as references/…, are relative to the skill directory.",
                '',
                '<skill_resources>',
                '<file>references/forms.md</file>',
                '<file>scripts/fill.py</file>',
                '</skill_resources>',
                '</skill_content>',
            ].join('\n'),
        });
    });

    test('the named skill, of several', async () => {
        await write('browser/SKILL.md');
        await write('pdf/SKILL.md');

        const outcome = await activate(activateSkillTool([skill('browser'), skill('pdf')]), 'pdf');

        expect(outcome).toMatchObject({ ok: true, value: expect.stringContaining('# pdf') });
        expect(outcome).not.toMatchObject({ value: expect.stringContaining('browser') });
    });

    test('hidden files are left out', async () => {
        await write('pdf/SKILL.md');
        await write('pdf/.DS_Store');
        await write('pdf/.git/config');
        await write('pdf/references/forms.md');

        expect(resourcesOf(await activate(activateSkillTool([skill('pdf')]), 'pdf'))).toEqual([
            '<file>references/forms.md</file>',
        ]);
    });

    test('a skill under a hidden directory', async () => {
        await write('.agents/skills/pdf/SKILL.md');
        await write('.agents/skills/pdf/references/forms.md');
        const tool = activateSkillTool([skill('pdf', '.agents/skills/pdf')]);

        expect(resourcesOf(await activate(tool, 'pdf'))).toEqual([
            '<file>references/forms.md</file>',
        ]);
    });

    test('many files', async () => {
        await write('pdf/SKILL.md');

        for (let n = 0; n < 150; n++) {
            await write(`pdf/refs/${String(n).padStart(3, '0')}.md`);
        }

        for (let n = 0; n < 500; n++) {
            await write(`pdf/.git/objects/${n}`);
        }

        const resources = resourcesOf(await activate(activateSkillTool([skill('pdf')]), 'pdf'));

        expect(resources).toHaveLength(101);
        expect(resources[0]).toBe('<file>refs/000.md</file>');
        expect(resources[99]).toBe('<file>refs/099.md</file>');
        expect(resources[100]).toBe('(50 more files)');
    });

    test('the files are listed when the skill is activated', async () => {
        await write('pdf/SKILL.md');
        const tool = activateSkillTool([skill('pdf')]);
        await write('pdf/later.md');

        expect(resourcesOf(await activate(tool, 'pdf'))).toEqual(['<file>later.md</file>']);
    });

    test('symbolic links are neither followed nor listed', async () => {
        await write('pdf/SKILL.md');
        await write('pdf/docs/guide.md');
        await symlink(join(dir, 'pdf'), join(dir, 'pdf/docs/loop'));
        await symlink(join(dir, 'pdf/docs/guide.md'), join(dir, 'pdf/docs/alias.md'));

        expect(resourcesOf(await activate(activateSkillTool([skill('pdf')]), 'pdf'))).toEqual([
            '<file>docs/guide.md</file>',
        ]);
    });

    test.skipIf(process.getuid?.() === 0)(
        "hidden directories aren't walked, so one that can't be read doesn't matter",
        async () => {
            await write('pdf/SKILL.md');
            await write('pdf/references/forms.md');
            await mkdir(join(dir, 'pdf/.secret'), { mode: 0o000 });

            try {
                expect(
                    resourcesOf(await activate(activateSkillTool([skill('pdf')]), 'pdf')),
                ).toEqual(['<file>references/forms.md</file>']);
            } finally {
                await chmod(join(dir, 'pdf/.secret'), 0o700);
            }
        },
    );

    test('an unknown name fails validation, and the error shows the names it accepts', async () => {
        const outcome = await activate(
            activateSkillTool([skill('browser'), skill('pdf')]),
            'excel',
        );

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringContaining('"enum":["browser","pdf"]'),
        });
    });

    test('a second activation', async () => {
        await write('pdf/SKILL.md');
        const tool = activateSkillTool([skill('pdf')]);

        const first = await activate(tool, 'pdf');
        const second = await activate(tool, 'pdf');

        expect(first).toMatchObject({ ok: true, value: expect.stringContaining('# pdf') });
        expect(second).toEqual({
            ok: true,
            value: 'The skill pdf is already active: its instructions are earlier in this conversation.',
        });
    });

    test('a second activation of one skill leaves the others', async () => {
        await write('browser/SKILL.md');
        await write('pdf/SKILL.md');
        const tool = activateSkillTool([skill('browser'), skill('pdf')]);

        await activate(tool, 'pdf');
        const browser = await activate(tool, 'browser');

        expect(browser).toMatchObject({ ok: true, value: expect.stringContaining('# browser') });
    });
});
