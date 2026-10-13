const DEFAULT_FILE = "package.json";
/** Unanswerable without reading the file, so it shows the tool loop at work. */
const DEFAULT_QUESTION = "What exact command does the check script run? Quote it.";
const FILE_QUESTION = "What is this file for? Answer in two or three sentences.";

/** The question's words are joined, so it needn't be quoted. */
export const parseArgs = (args: readonly string[]): { file: string; question: string } => {
    const [file, ...words] = args;

    if (file === undefined) {
        return { file: DEFAULT_FILE, question: DEFAULT_QUESTION };
    }

    return { file, question: words.length > 0 ? words.join(" ") : FILE_QUESTION };
};
