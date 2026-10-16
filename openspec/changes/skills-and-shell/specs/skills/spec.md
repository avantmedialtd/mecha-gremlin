## ADDED Requirements

### Requirement: Find skills in the directories SKILLS_PATH lists
The server SHALL load skills from the skills roots that `SKILLS_PATH` lists, separated by `:` as in `PATH`. A relative entry SHALL resolve against the current directory, and an empty entry SHALL be ignored. Every subdirectory of a root that holds a file named exactly `SKILL.md` SHALL be read as a skill. Other entries SHALL be skipped without a record, and nothing deeper SHALL be searched. Each skill's directory SHALL be recorded by its real path, with symbolic links resolved.
- Roots SHALL be read in the order listed, and each root's subdirectories in sorted order. A skill whose name is already taken, by a skill in the same root or an earlier one, SHALL NOT be loaded.
- A `warn` record `skill not loaded`, with the fields `path` and `reason`, SHALL report:
  - each skill left out because its name was taken; the reason names the skill that took it;
  - each root that doesn't exist or isn't a directory.

  The other skills SHALL still load.
- With `SKILLS_PATH` unset or blank, no skill SHALL be loaded.

#### Scenario: A skill in a root
- **WHEN** `SKILLS_PATH` names a root holding `pdf/SKILL.md`, whose name is `pdf` and which has a description
- **THEN** the skill `pdf` is loaded, with its directory's real path

#### Scenario: Entries that aren't skills
- **WHEN** the root also holds `notes/`, a directory without `SKILL.md`, and `README.md`, a file
- **THEN** neither is loaded, and no record mentions them

#### Scenario: A relative root and empty entries
- **WHEN** `SKILLS_PATH` is `:skills:`, and the current directory holds `skills/pdf/SKILL.md`
- **THEN** `pdf` is loaded, and no record mentions the empty entries

#### Scenario: The earlier root wins
- **WHEN** `SKILLS_PATH` lists root A and then root B, and both hold a skill named `pdf`
- **THEN** A's `pdf` is loaded, and a `warn` record `skill not loaded` has the path of B's `pdf` and a reason naming A's

#### Scenario: Two skills in one root with the same name
- **WHEN** a root holds `pdf/` and `pdf-old/`, and both declare the name `pdf`
- **THEN** the skill in `pdf/` is loaded, and a `warn` record `skill not loaded` has the path of `pdf-old/` and a reason naming the skill in `pdf/`

#### Scenario: A missing root
- **WHEN** `SKILLS_PATH` lists a directory that doesn't exist, then a root holding the skill `pdf`
- **THEN** a `warn` record `skill not loaded` names the missing directory, and `pdf` is loaded

#### Scenario: A linked skill
- **WHEN** a root holds `pdf`, a symbolic link to a skill directory elsewhere
- **THEN** the skill is loaded, and its directory is the link's target

#### Scenario: No skills configured
- **WHEN** `SKILLS_PATH` is unset, or holds only spaces
- **THEN** no skill is loaded

### Requirement: Read SKILL.md leniently
Reading a skill's SKILL.md SHALL take three steps:
1. `core`'s `splitFrontmatter(text)` splits it. The text SHALL start with a `---` line, and its frontmatter SHALL end at the next `---` line; CRLF line endings SHALL be accepted.
2. The server SHALL parse the frontmatter with `parseYaml` from `@mecha-gremlin/yaml/parse`, which writes nothing to stdout or stderr.
3. `core`'s `readSkill(directoryName, frontmatter, body)` checks the parsed frontmatter.

`splitFrontmatter` and `readSkill` SHALL return `Result`s. Reading SHALL fail, with a reason, when:
- there is no frontmatter;
- the frontmatter isn't valid YAML, or isn't a mapping;
- `description` is missing, isn't a string, or is blank once trimmed.

Otherwise it SHALL succeed with:
- `name`: the trimmed `name`, or the directory's name when `name` is missing, not a string, or blank;
- `description`: the trimmed description;
- `body`: the text after the frontmatter, trimmed;
- `warnings`: one for each of:
  - a name that is missing, not a string or blank;
  - a name that differs from the directory's;
  - a name longer than 64 characters;
  - a description longer than 1,024 characters.

Every other key SHALL be ignored, `allowed-tools` included. When the server finds a skill it can't read, it SHALL skip it with a `warn` record `skill not loaded`, giving the skill's path and the reason. For each warning about a skill it loads, it SHALL log a `warn` record `skill warning` with the fields `skill` and `warning`.

#### Scenario: A skill as the spec describes it
- **WHEN** the text is a `---` line, `name: pdf`, `description: Work with PDFs.`, a `---` line, then `# PDF` and a blank line, in the directory `pdf`
- **THEN** it succeeds with the name `pdf`, the description "Work with PDFs.", the body "# PDF" and no warnings

#### Scenario: Windows line endings
- **WHEN** the same text uses CRLF line endings
- **THEN** it succeeds with the same name, description and body

#### Scenario: Frontmatter that isn't valid YAML
- **WHEN** the frontmatter is `name: [pdf`
- **THEN** it fails, and the reason says the frontmatter isn't valid YAML

#### Scenario: Frontmatter that isn't a mapping
- **WHEN** the frontmatter is `- pdf`
- **THEN** it fails, and the reason says the frontmatter isn't a mapping

#### Scenario: YAML warnings stay quiet
- **WHEN** the frontmatter is `name: pdf` and `description: !thing Work with PDFs.`
- **THEN** it succeeds with the description "Work with PDFs.", and nothing is written to stderr

#### Scenario: No description
- **WHEN** the frontmatter has a name and no description, or a description of only spaces
- **THEN** it fails, and the reason says the skill has no description

#### Scenario: No frontmatter
- **WHEN** the text starts with `# PDF`
- **THEN** it fails, and the reason says it has no frontmatter

#### Scenario: A name that differs from its directory
- **WHEN** the directory is `pdf-tools` and the name is `pdf`
- **THEN** it succeeds with the name `pdf`, and a warning names both

#### Scenario: A missing or blank name
- **WHEN** the frontmatter has a description and no name, or the name `"  "`, in the directory `pdf`
- **THEN** it succeeds with the name `pdf`, and a warning says the name was missing

#### Scenario: Long values
- **WHEN** the name is 65 characters long and matches its directory, and the description is 1,025 characters long
- **THEN** it succeeds, with one warning about the name's length and one about the description's

#### Scenario: Keys from other clients
- **WHEN** the frontmatter also holds `allowed-tools`, `homepage`, and a `metadata` mapping nested several levels deep in flow style with trailing commas
- **THEN** it succeeds, and none of those keys changes the skill

#### Scenario: The server reports a skill it can't use
- **WHEN** a root holds `pdf/SKILL.md` without frontmatter
- **THEN** `pdf` isn't loaded, and a `warn` record `skill not loaded` has its path and a reason saying it has no frontmatter

#### Scenario: The server reports a warning
- **WHEN** a root holds `pdf-tools/SKILL.md`, whose name is `pdf`
- **THEN** `pdf` is loaded, and a `warn` record `skill warning` has the skill `pdf` and a warning naming both names

### Requirement: List the skills in the developer item
`core` SHALL provide `renderCatalog(skills)`. Its text SHALL:
- start with an instruction to call `activate_skill` with a skill's name before starting a task that matches its description, and to read a skill's own files with `read_file`, by absolute path;
- then list every skill in an `<available_skills>` element, each as a `<skill>` element holding a `<name>` and a `<description>` element, sorted by name;
- escape `&`, `<` and `>` in names and descriptions.

#### Scenario: Sorted by name
- **WHEN** the skills are `pdf` and then `browser`
- **THEN** `browser` is listed before `pdf`

#### Scenario: Escaped text
- **WHEN** a description is "Compare <a> & <b>"
- **THEN** the catalog holds "Compare &lt;a&gt; &amp; &lt;b&gt;"

#### Scenario: Same skills, same text
- **WHEN** the catalog is rendered twice for the same skills, given in different orders
- **THEN** both texts are identical

### Requirement: Activate a skill with activate_skill
When at least one skill is loaded, the server SHALL offer an `activate_skill` tool. Its arguments SHALL be exactly one required string, `name`, restricted to the loaded skills' names, and no other property SHALL be allowed. Its output, built by `core`'s `renderActivation`, SHALL be a `<skill_content name="…">` element holding:
1. the skill's body, without its frontmatter;
2. the line `Skill directory: ` followed by the skill's directory, and a line saying that paths to the skill's own files are relative to that directory;
3. a `<skill_resources>` element with a `<file>` element for each file below the skill's directory, as a path relative to it, sorted.
   - It SHALL leave out `SKILL.md` at the top of the skill's directory, and every path that, taken relative to that directory, has a segment starting with `.`.
   - When more than 100 files remain, it SHALL list the first 100, then, inside `<skill_resources>`, a line giving how many more files there are.

The files SHALL be listed when the skill is activated, and not read. When a skill is activated again in the same session, the output SHALL be a short note saying it's already active, instead of its instructions. When no skill is loaded, the server SHALL NOT offer `activate_skill`.

#### Scenario: The model sees a closed schema with the skills' names
- **WHEN** the skills `browser` and `pdf` are loaded, and `activate_skill` is converted with `toFunctionTool`
- **THEN** its parameters require a string `name` whose `enum` holds `browser` and `pdf`, and set `additionalProperties` to false

#### Scenario: Activating a skill
- **WHEN** the skill `pdf` has the body "# PDF" and the files `SKILL.md`, `scripts/fill.py` and `references/forms.md`, and `activate_skill` is called with `{"name":"pdf"}`
- **THEN** the output is a `skill_content` element named `pdf` holding "# PDF", the skill's directory, and the files `references/forms.md` and `scripts/fill.py`, in that order

#### Scenario: Hidden files are left out
- **WHEN** the skill's directory also holds `.DS_Store` and `.git/config`
- **THEN** neither is listed

#### Scenario: A skill under a hidden directory
- **WHEN** the skill's directory is `.agents/skills/pdf` inside a temporary directory, and holds `references/forms.md`
- **THEN** `references/forms.md` is listed

#### Scenario: Many files
- **WHEN** the skill's directory holds 150 files besides `SKILL.md`, and a `.git` directory of 500 more
- **THEN** the first 100, in sorted order, are listed, followed by a line saying there are 50 more files

#### Scenario: An unknown name
- **WHEN** `activate_skill` is called with `{"name":"excel"}`, and no skill has that name
- **THEN** the arguments fail validation, and the error shows the names it accepts

#### Scenario: A second activation
- **WHEN** `activate_skill` is called for `pdf` twice in one session
- **THEN** the second output says `pdf` is already active, and doesn't repeat its instructions

#### Scenario: No skills, no tool
- **WHEN** no skill is loaded
- **THEN** the tools offered to the model don't include `activate_skill`
