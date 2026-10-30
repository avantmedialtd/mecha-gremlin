// Whether a stdio server's launcher runs an exact version. Unpinned, an unattended run starts
// whatever was published last; SEP-2633 says stdio entries SHOULD pin (Brief R18.1).
import { basename } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// A version after the last == or @: PEP 440's release, pre-, post- and development segments,
// without a wildcard or a range. A version holds no = or @, so the one matched is the last.
const PYTHON_PIN = /(?:==|@)\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

const DIGEST = /@sha256:[0-9a-f]{64}$/;

// A tag after the image's last slash: a colon before it is a registry's port.
const TAG = /:([^/]*)$/;

// The options of `docker run` that take the next argument as their value.
const DOCKER_VALUES = new Set([
    '-e',
    '--env',
    '--env-file',
    '-v',
    '--volume',
    '--mount',
    '--name',
    '--network',
    '-w',
    '--workdir',
    '-u',
    '--user',
    '-p',
    '--publish',
    '--platform',
    '--pull',
    '--entrypoint',
    '-l',
    '--label',
]);

const isOption = (arg: string): boolean => {
    return arg.startsWith('-');
};

/** The value of `--name value` or `--name=value`, wherever it is, or else the first positional. */
const packageOf = (args: readonly string[], options: readonly string[]): string | undefined => {
    for (const [index, arg] of args.entries()) {
        const equals = arg.indexOf('=');
        const name = equals === -1 ? arg : arg.slice(0, equals);

        if (options.includes(name)) {
            return equals === -1 ? args[index + 1] : arg.slice(equals + 1);
        }
    }

    return args.find((arg) => !isOption(arg));
};

// `@scope/name@1.2.3` or `name@1.2.3`; a dist-tag such as `latest`, or a range, doesn't pin.
const npmPinned = (spec: string): boolean => {
    const at = spec.lastIndexOf('@');

    return at > 0 && SEMVER.test(spec.slice(at + 1));
};

// `name==1.2.3` or `name@1.2.3`, extras allowed.
const pythonPinned = (spec: string): boolean => {
    return PYTHON_PIN.test(spec);
};

// A digest, or a tag other than `latest`.
const imagePinned = (image: string): boolean => {
    const at = image.indexOf('@');
    const named = at === -1 ? image : image.slice(0, at);

    return DIGEST.test(image) || (TAG.exec(named)?.[1] ?? 'latest') !== 'latest';
};

// Only `docker run`: the image is its first positional, past the options and their values.
const dockerImage = (args: readonly string[]): string | undefined => {
    const run = args.findIndex((arg) => !isOption(arg));
    let value = false;

    if (args[run] !== 'run') {
        return undefined;
    }

    for (const arg of args.slice(run + 1)) {
        if (value) {
            value = false;
        } else if (DOCKER_VALUES.has(arg)) {
            value = true;
        } else if (!isOption(arg)) {
            return arg;
        }
    }

    return undefined;
};

type Launcher = {
    readonly spec: (args: readonly string[]) => string | undefined;
    readonly pinned: (spec: string) => boolean;
};

const npm: Launcher = { spec: (args) => packageOf(args, ['-p', '--package']), pinned: npmPinned };

const LAUNCHERS = new Map<string, Launcher>([
    ['npx', npm],
    ['bunx', npm],
    ['uvx', { spec: (args) => packageOf(args, ['--from']), pinned: pythonPinned }],
    ['docker', { spec: dockerImage, pinned: imagePinned }],
]);

/**
 * The package or image a launcher would run unpinned, if it would. Only `npx`, `bunx`, `uvx`
 * and `docker run` are known.
 */
export const unpinned = (command: string, args: readonly string[]): string | undefined => {
    const launcher = LAUNCHERS.get(basename(command));

    if (launcher === undefined) {
        return undefined;
    }

    const spec = launcher.spec(args);

    return spec === undefined || launcher.pinned(spec) ? undefined : spec;
};
