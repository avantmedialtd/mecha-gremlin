import { type Result, err, ok } from './result.ts';

export type SplitText = {
    readonly frontmatter: string;
    readonly body: string;
};

export type ParsedSkill = {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly warnings: readonly string[];
};

export type CatalogEntry = {
    readonly name: string;
    readonly description: string;
};

export type ActivatedSkill = {
    readonly name: string;
    readonly body: string;
    readonly directory: string;
};

const DELIMITER = '---';

// The Agent Skills spec's limits. A longer value still works, so it only gets a warning.
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

// More would cost context the model may never need: it can still list the rest with the shell.
const MAX_FILES = 100;

const CATALOG_INSTRUCTION =
    "Skills give you instructions for particular kinds of task. When a task matches a skill's description, call activate_skill with the skill's name before you start, then follow its instructions. Read a skill's own files with the read tool, by absolute path.";

// Paths that commands print, such as playwright-cli's snapshots, are relative to the working
// directory, so the line speaks only of the skill's own files.
const PATHS_NOTE =
    "Paths to this skill's own files, such as references/…, are relative to the skill directory.";

export const splitFrontmatter = (text: string): Result<SplitText, string> => {
    const [first, ...lines] = text.split(/\r?\n/);

    if (first !== DELIMITER) {
        return err('it has no frontmatter: SKILL.md must start with a --- line');
    }

    const end = lines.indexOf(DELIMITER);

    if (end === -1) {
        return err("its frontmatter doesn't end: no --- line closes it");
    }

    return ok({
        frontmatter: lines.slice(0, end).join('\n'),
        body: lines
            .slice(end + 1)
            .join('\n')
            .trim(),
    });
};

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// An emoji is one character, not the two UTF-16 units that `length` counts.
const characters = (text: string): number => {
    return Array.from(text).length;
};

export const readSkill = (
    directoryName: string,
    frontmatter: unknown,
    body: string,
): Result<ParsedSkill, string> => {
    if (!isMapping(frontmatter)) {
        return err("its frontmatter isn't a mapping");
    }

    const { description } = frontmatter;

    // The description is all the model sees of a skill before activating it.
    if (typeof description !== 'string' || description.trim() === '') {
        return err('it has no description');
    }

    const warnings: string[] = [];
    let name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';

    if (name === '') {
        name = directoryName;
        warnings.push(`its name is missing, so it takes its directory's name, ${directoryName}`);
    } else if (name !== directoryName) {
        warnings.push(`its name, ${name}, differs from its directory's, ${directoryName}`);
    }

    const nameLength = characters(name);

    if (nameLength > MAX_NAME) {
        warnings.push(
            `its name is ${nameLength} characters long, more than the spec's ${MAX_NAME}`,
        );
    }

    const trimmed = description.trim();
    const descriptionLength = characters(trimmed);

    if (descriptionLength > MAX_DESCRIPTION) {
        warnings.push(
            `its description is ${descriptionLength} characters long, more than the spec's ${MAX_DESCRIPTION}`,
        );
    }

    return ok({ name, description: trimmed, body, warnings });
};

const escapeXml = (text: string): string => {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
};

// An attribute's value also ends at a double quote.
const escapeAttribute = (text: string): string => {
    return escapeXml(text).replaceAll('"', '&quot;');
};

// In code-unit order, as the `skills` record and the loader sort names, so that the developer item
// stays byte-identical between runs with the same skills, whatever the locale or the runtime, as
// the prompt cache wants (Brief 4.6). Names are unique once the skills are loaded.
export const renderCatalog = (skills: readonly CatalogEntry[]): string => {
    const entries = skills
        .map((skill) => skill.name)
        .toSorted()
        .flatMap((name) => skills.filter((skill) => skill.name === name))
        .map((skill) =>
            [
                '<skill>',
                `<name>${escapeXml(skill.name)}</name>`,
                `<description>${escapeXml(skill.description)}</description>`,
                '</skill>',
            ].join('\n'),
        );

    return [CATALOG_INSTRUCTION, '', '<available_skills>', ...entries, '</available_skills>'].join(
        '\n',
    );
};

// Hidden is judged on the path relative to the skill's directory, so a skill under a hidden
// directory such as ~/.agents/skills still lists its files.
const isListed = (path: string): boolean => {
    return path !== 'SKILL.md' && !path.split('/').some((segment) => segment.startsWith('.'));
};

export const renderActivation = (skill: ActivatedSkill, files: readonly string[]): string => {
    const listed = files.filter(isListed).toSorted();
    const shown = listed.slice(0, MAX_FILES).map((file) => `<file>${escapeXml(file)}</file>`);
    const more = listed.length - shown.length;

    if (more > 0) {
        shown.push(`(${more} more ${more === 1 ? 'file' : 'files'})`);
    }

    return [
        `<skill_content name="${escapeAttribute(skill.name)}">`,
        skill.body,
        '',
        `Skill directory: ${skill.directory}`,
        PATHS_NOTE,
        '',
        '<skill_resources>',
        ...shown,
        '</skill_resources>',
        '</skill_content>',
    ].join('\n');
};
