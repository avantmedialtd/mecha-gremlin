import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { toolPart, withModelNames } from '../../src/mcp/names.ts';

const hashOf = (server: string, tool: string): string => {
    return createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
};

describe("A tool's part of its name", () => {
    test.each([
        ['resolve-library-id', 'resolve_library_id'],
        ['getUser', 'get_user'],
        ['get2Users', 'get2_users'],
        ['HTMLParser', 'htmlparser'],
        ['x.y z', 'x_y_z'],
        ['naïve', 'na_ve'],
        ['ALL_CAPS', 'all_caps'],
        ['aBcD', 'a_bc_d'],
    ])('%s becomes %s', (tool, part) => {
        expect(toolPart(tool)).toBe(part);
    });
});

describe('Model-facing names', () => {
    test('the prefix and the part, in the order given', () => {
        expect(
            withModelNames([
                { server: 'Docs', prefix: 'docs', tool: 'search' },
                { server: 'a-b', prefix: 'a_b', tool: 'getUser' },
            ]).map(({ modelName }) => modelName),
        ).toEqual(['mcp__docs__search', 'mcp__a_b__get_user']);
    });

    test('the other fields are kept', () => {
        expect(withModelNames([{ server: 's', prefix: 's', tool: 't', extra: 1 }])).toEqual([
            { server: 's', prefix: 's', tool: 't', extra: 1, modelName: 'mcp__s__t' },
        ]);
    });

    test('64 characters stay as they are, and 65 take the hashed form', () => {
        const fits = 'x'.repeat(64 - 'mcp__s__'.length);
        const over = `${fits}y`;
        const [kept, cut] = withModelNames([
            { server: 'S', prefix: 's', tool: fits },
            { server: 'S', prefix: 's', tool: over },
        ]).map(({ modelName }) => modelName);

        expect(kept).toBe(`mcp__s__${fits}`);
        expect(cut).toBe(`${`mcp__s__${over}`.slice(0, 55)}_${hashOf('S', over)}`);
        expect(cut).toHaveLength(64);
    });

    test('names two tools would share all take the hashed form, by their own names', () => {
        expect(
            withModelNames([
                { server: 'S', prefix: 's', tool: 'get_user' },
                { server: 'S', prefix: 's', tool: 'getUser' },
                { server: 'S', prefix: 's', tool: 'other' },
            ]).map(({ modelName }) => modelName),
        ).toEqual([
            `mcp__s__get_user_${hashOf('S', 'get_user')}`,
            `mcp__s__get_user_${hashOf('S', 'getUser')}`,
            'mcp__s__other',
        ]);
    });
});
