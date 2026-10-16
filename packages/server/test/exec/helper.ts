// A process for the shell's and the sweep's tests, started with process.execPath: node, or Bun,
// never one of Apple's own binaries, whose environment macOS hides from ps. Each mode prints
// `ready` once its handlers are installed, and ends on its own after 30 s, like `sleep 30`, if no
// test stops it.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const LIFETIME_MS = 30_000;

const [mode = '', ...args] = process.argv.slice(2);

const stay = (): void => {
    setTimeout(() => {
        process.exit(0);
    }, LIFETIME_MS);
};

// Node and Bun ignore SIGPIPE, so a write to a closed pipe fails with EPIPE instead of ending the
// process. Each stream's failure is reported in a file of its own.
const writeUntilClosed = (report: string): void => {
    let open = 2;

    for (const [name, stream] of [
        ['stdout', process.stdout],
        ['stderr', process.stderr],
    ] as const) {
        stream.on('error', (error) => {
            const code: unknown = Object(error).code;
            writeFileSync(`${report}-${name}`, String(code));
            open--;

            if (open === 0) {
                process.exit(0);
            }
        });

        const write = (): void => {
            stream.write('late\n', (error) => {
                if (!error) {
                    setTimeout(write, 20);
                }
            });
        };

        setTimeout(write, 50);
    }
};

switch (mode) {
    case 'ignore-term':
        process.on('SIGTERM', () => {});
        console.log('ready');
        stay();
        break;
    case 'cleanup': {
        const [file = '', delay = '0'] = args;
        process.on('SIGTERM', () => {
            setTimeout(() => {
                writeFileSync(file, 'cleaned up');
                process.exit(0);
            }, Number(delay));
        });
        console.log('ready');
        stay();
        break;
    }
    // A child that leads a group of its own and carries no run ID, started in one of the modes
    // here: `idle`, `family` or `brief`. With `ignore`, this process ignores SIGTERM. It prints the
    // child's pid after `ready`, then whatever the child printed after its own.
    case 'child': {
        const [onTerm, ...childArgs] = args;

        if (onTerm === 'ignore') {
            process.on('SIGTERM', () => {});
        }

        const child = spawn(process.execPath, [SELF, ...childArgs], {
            detached: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { PATH: process.env.PATH },
        });
        child.stdout.setEncoding('utf8');
        child.stdout.once('data', (line: string) => {
            console.log(`ready ${child.pid}${line.trim().slice('ready'.length)}`);
        });
        stay();
        break;
    }
    // With a child of its own in its process group.
    case 'family': {
        const grandchild = spawn(process.execPath, [SELF, 'idle'], { stdio: 'ignore' });
        console.log(`ready ${grandchild.pid}`);
        stay();
        break;
    }
    case 'brief':
        console.log('ready');
        setTimeout(() => {
            process.exit(0);
        }, Number(args[0]));
        break;
    // Starts a process in a session of its own, as playwright-cli does with its daemon, prints its
    // pid and exits. With `hold`, the process keeps stdout and stderr and writes to them.
    case 'leave': {
        const [hold, report = ''] = args;
        const child = spawn(
            process.execPath,
            hold === 'hold' ? [SELF, 'write', report] : [SELF, 'idle'],
            {
                detached: true,
                stdio: hold === 'hold' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
            },
        );
        console.log(child.pid);
        child.unref();
        break;
    }
    case 'write':
        writeUntilClosed(args[0] ?? '');
        stay();
        break;
    default:
        console.log('ready');
        stay();
}
