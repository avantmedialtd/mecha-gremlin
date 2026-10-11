import { run } from "./hello.ts";

if (import.meta.main) {
    process.exitCode = await run({
        env: process.env,
        fetch: (input, init) => fetch(input, init),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
    });
}
