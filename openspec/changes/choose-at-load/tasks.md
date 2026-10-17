## 1. Choose at load (`process-spawning`, `yaml-parsing`)

- [x] 1.1 `packages/process/src/spawn.ts` (design decision 1): `export const spawnProcess: Spawner = chooseSpawner(globalThis);` replaces the `spawnProcess` function, after `chooseSpawner`. The comment above `chooseSpawner` stays as it is.
- [x] 1.2 `packages/yaml/src/parse.ts`: `export const parseYaml: Parser = chooseParser(globalThis);` replaces the `parseYaml` function, after `chooseParser`. The comment above `chooseParser` stays as it is.

## 2. Tests (`process-spawning`, `yaml-parsing`)

- [x] 2.1 `packages/process/test/spawn.test.ts`, "The choice of implementation" (design decision 2): "this runtime's global object" keeps its name and expects `spawnProcess` to be `typeof Bun === 'undefined' ? spawnWithNode : spawnWithBun`. The block's other two tests don't change.
- [x] 2.2 `packages/yaml/test/parse.test.ts`, "The choice of parser": "this runtime's global object" keeps its name and expects `parseYaml` to be `typeof Bun === 'undefined' ? parseYamlWithPackage : parseYamlWithBun`. The block's other two tests don't change.

## 3. README

- [x] 3.1 README (design decision 5): "`yaml` and `process` choose their implementation on every call, from the global object" becomes "`yaml` and `process` choose their implementation once, when each module loads, from the global object". The rest of the sentence stays.

## 4. Verification

- [x] 4.1 `bun run check` passes: formatting, lint, types, and the tests on Bun and on Node
- [x] 4.2 `bun run mutation` scores 100%. Record, for the commit message:
  - how many mutants the report marks static. `main`'s last CI run had 60 of 1724, so 68 of 1722 are expected;
  - how long the run took.
- [x] 4.3 `openspec validate choose-at-load --strict` passes

## 5. CI (the session's)

- [ ] 5.1 CI passes on the branch: both jobs, with the mutation job at 100%. Note the mutation job's duration next to `main`'s last, 8 min 51 s.

## 6. After archiving (the session's)

- [ ] 6.1 After `openspec archive`, each changed requirement is still the first in its spec, and `openspec validate --all --strict` passes
