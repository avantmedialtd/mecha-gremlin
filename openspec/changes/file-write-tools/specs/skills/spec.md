## MODIFIED Requirements

### Requirement: List the skills in the developer item
`core` SHALL provide `renderCatalog(skills)`. Its text SHALL:
- start with an instruction to call `activate_skill` with a skill's name before starting a task that matches its description, and to read a skill's own files with the `read` tool, by absolute path;
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
