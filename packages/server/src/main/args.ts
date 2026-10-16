// It exercises the whole path: the skill's activation, the shell, the browser and the sweep. A
// small local model answers it quickly and reliably, and the answer is known: "Example Domain".
const DEFAULT_TASK = 'Use the playwright-cli skill to find the title of https://example.com';

// The task's words are joined, but the shell reads `?`, `*`, `&`, `;`, `!` and `$` itself, and
// zsh stops at an unquoted `?`, so the README quotes every task.
export const parseArgs = (args: readonly string[]): string => {
    return args.length > 0 ? args.join(' ') : DEFAULT_TASK;
};
