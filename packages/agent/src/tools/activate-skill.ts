import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ok } from '@mecha-gremlin/core/result';
import { renderActivation } from '@mecha-gremlin/core/skills';
import { z } from 'zod';
import type { LoadedSkill } from '../skills/skills.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';

const DESCRIPTION =
    "Load a skill's full instructions, with its directory and the list of its files. Name a skill from the available_skills list in your instructions.";

// Hidden entries are skipped as the walk goes, so a cloned skill's .git isn't read on every
// activation; hidden is judged below the skill's directory, as renderActivation judges it. Only
// regular files are listed: a link could lead back up the tree, or out of it.
const listFiles = async (directory: string, below: string): Promise<string[]> => {
    const entries = await readdir(join(directory, below), { withFileTypes: true });
    const lists = await Promise.all(
        entries
            .filter((entry) => !entry.name.startsWith('.'))
            .map(async (entry) => {
                const path = join(below, entry.name);

                if (entry.isDirectory()) {
                    return listFiles(directory, path);
                }

                return entry.isFile() ? [path] : [];
            }),
    );

    return lists.flat();
};

export const activateSkillTool = (skills: readonly LoadedSkill[]): ToolHandler => {
    const active = new Set<string>();
    // The model can only name a loaded skill: validateArgs rejects any other name, and its error
    // lists the ones the schema accepts.
    const schema = z.strictObject({ name: z.enum(skills.map((skill) => skill.name)) });

    return defineTool(
        { name: 'activate_skill', description: DESCRIPTION, schema },
        async ({ name }) => {
            for (const skill of skills) {
                if (skill.name === name && !active.has(name)) {
                    // Listed now, not when the skills were loaded, so the list is current.
                    const files = await listFiles(skill.directory, '');
                    active.add(name);

                    return ok(renderActivation(skill, files));
                }
            }

            // The schema admits only the loaded skills' names, so only a skill already active
            // gets here. Its instructions are already in the conversation (the client guide's
            // deduplication).
            return ok(
                `The skill ${name} is already active: its instructions are earlier in this conversation.`,
            );
        },
    );
};
