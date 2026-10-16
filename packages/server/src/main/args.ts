// Unanswerable without reading package.json, so it shows the tool loop at work.
const DEFAULT_TASK = 'What exact command does the check script in package.json run? Quote it.';

// The task's words are joined, but the shell reads `?`, `*`, `&`, `;`, `!` and `$` itself, and
// zsh stops at an unquoted `?`, so the README quotes every task.
export const parseArgs = (args: readonly string[]): string => {
    return args.length > 0 ? args.join(' ') : DEFAULT_TASK;
};
