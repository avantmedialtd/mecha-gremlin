// Only a process of its own can show that unref() lets its caller exit: spawn.test.ts runs this
// script and checks that it exits while the `sleep` runs on.
import { tmpdir } from 'node:os';
import { spawnWithBun, spawnWithNode } from '../src/spawn.ts';

const spawn = process.argv[2] === 'bun' ? spawnWithBun : spawnWithNode;
const spawned = await spawn(['sleep', '5'], {
    cwd: tmpdir(),
    env: { PATH: '/usr/bin:/bin' },
    detached: true,
});

if (spawned.ok) {
    await spawned.value.stdout.cancel();
    await spawned.value.stderr.cancel();
    spawned.value.unref();
    console.log(spawned.value.pid);
} else {
    console.error(spawned.error);
    process.exitCode = 1;
}
