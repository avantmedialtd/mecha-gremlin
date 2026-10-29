import { type Result, err, ok } from '@mecha-gremlin/core/result';

// The task's words are joined, but the shell reads `?`, `*`, `&`, `;`, `!` and `$` itself, and
// zsh stops at an unquoted `?`, so the README quotes every task.
export const parseArgs = (args: readonly string[]): Result<string, string> => {
    const task = args.join(' ').trim();

    return task ? ok(task) : err('A task is required; pass the task as a command-line argument.');
};
