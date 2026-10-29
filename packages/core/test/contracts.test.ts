import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { HistoryItem } from '../src/history.ts';
import { ok } from '../src/result.ts';

describe('provider-neutral core contracts', () => {
    test('core has no provider SDK dependency', async () => {
        const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

        for (const group of ['dependencies', 'peerDependencies', 'devDependencies']) {
            expect(pkg[group] ?? {}).not.toHaveProperty('openai');
            expect(pkg[group] ?? {}).not.toHaveProperty('@anthropic-ai/sdk');
        }
    });

    test('core source imports neither provider SDK', async () => {
        const dir = new URL('../src/', import.meta.url);

        for (const name of (await readdir(dir)).filter((item) => item.endsWith('.ts'))) {
            const source = await readFile(new URL(name, dir), 'utf8');

            expect(source).not.toMatch(
                /(?:from\s+|import\s*\()\s*['"](?:openai|@anthropic-ai\/sdk)/,
            );
        }
    });

    test('native replay data is retained as provider-tagged history', () => {
        const native = [{ type: 'thinking', signature: 'sig', thinking: 'reasoning' }];
        const history: HistoryItem[] = [
            { kind: 'instruction', text: 'Be brief' },
            { kind: 'user', text: 'Hello' },
            { kind: 'native', provider: 'anthropic', data: native },
            { kind: 'tool_result', callId: 'a', outcome: ok('result') },
        ];

        expect(history[2]).toEqual({ kind: 'native', provider: 'anthropic', data: native });
    });
});
