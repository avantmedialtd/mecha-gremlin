import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Result, err } from '@mecha-gremlin/core/result';
import { type ParsedSkill, readSkill, splitFrontmatter } from '@mecha-gremlin/core/skills';
import { parseYaml } from '@mecha-gremlin/yaml/parse';

export type LoadedSkill = {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    // Its real path, which read_file's real-path check compares against.
    readonly directory: string;
};

export type NotLoaded = {
    readonly path: string;
    readonly reason: string;
};

export type SkillWarning = {
    readonly skill: string;
    readonly warning: string;
};

export type Skills = {
    readonly skills: readonly LoadedSkill[];
    readonly notLoaded: readonly NotLoaded[];
    readonly warnings: readonly SkillWarning[];
};

const SKILL_FILE = 'SKILL.md';

const messageOf = (thrown: unknown): string => {
    return thrown instanceof Error ? thrown.message : String(thrown);
};

const readSkillFile = async (
    file: string,
    directoryName: string,
): Promise<Result<ParsedSkill, string>> => {
    let text: string;

    try {
        text = await readFile(file, 'utf8');
    } catch (thrown) {
        return err(`SKILL.md can't be read (${messageOf(thrown)})`);
    }

    const split = splitFrontmatter(text);

    if (!split.ok) {
        return split;
    }

    // On Bun the parser's message is terse, so the record names the file for a YAML linter.
    const parsed = parseYaml(split.value.frontmatter);

    if (!parsed.ok) {
        return err(`its frontmatter isn't valid YAML: ${parsed.error}`);
    }

    return readSkill(directoryName, parsed.value, split.value.body);
};

// Roots are read in the order listed and each root's subdirectories in sorted order, so a name
// goes to the same skill on every run.
export const loadSkills = async (skillsPath: string | undefined, cwd: string): Promise<Skills> => {
    const skills: LoadedSkill[] = [];
    const notLoaded: NotLoaded[] = [];
    const warnings: SkillWarning[] = [];
    // Each name's skill file, to name the skill that took it.
    const taken = new Map<string, string>();
    const roots = (skillsPath ?? '').split(':').filter((entry) => entry !== '');

    for (const entry of roots) {
        const root = resolve(cwd, entry);
        let names: string[];

        try {
            names = await readdir(root);
        } catch (thrown) {
            notLoaded.push({
                path: root,
                reason: `the skills root can't be read (${messageOf(thrown)})`,
            });
            continue;
        }

        for (const name of names.toSorted()) {
            const directory = join(root, name);
            let contents: string[];

            try {
                contents = await readdir(directory);
            } catch {
                // Not a directory, so not a skill.
                continue;
            }

            if (!contents.includes(SKILL_FILE)) {
                continue;
            }

            const file = join(directory, SKILL_FILE);
            const read = await readSkillFile(file, name);

            if (!read.ok) {
                notLoaded.push({ path: file, reason: read.error });
                continue;
            }

            const skill = read.value;
            const owner = taken.get(skill.name);

            if (owner !== undefined) {
                notLoaded.push({
                    path: file,
                    reason: `the name ${skill.name} is already taken by ${owner}`,
                });
                continue;
            }

            taken.set(skill.name, file);
            skills.push({
                name: skill.name,
                description: skill.description,
                body: skill.body,
                directory: await realpath(directory),
            });
            warnings.push(...skill.warnings.map((warning) => ({ skill: skill.name, warning })));
        }
    }

    return { skills, notLoaded, warnings };
};
