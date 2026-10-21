## MODIFIED Requirements

### Requirement: Log structured records to stdout
The agent SHALL log through a structured logger of its own, with no logging library. A record SHALL have:
- a time;
- a level: `info`, `warn` or `error`;
- a message;
- fields whose values are JSON values. A field whose value is undefined SHALL be left out.

A field SHALL NOT be named `time`, `level` or `message`, which are the record's own. The logger's types SHALL reject such a field, and one whose value is undefined SHALL leave the record as it is.

Every record SHALL go to stdout.

#### Scenario: Records go to stdout
- **WHEN** the agent logs a record at any level
- **THEN** the record is written to stdout

#### Scenario: An undefined field is left out
- **WHEN** a record is logged with a field whose value is undefined
- **THEN** the field appears in neither output format

#### Scenario: A field can't take the record's names
- **WHEN** code logs a field named `time`, `level` or `message` with a value
- **THEN** it doesn't type-check

#### Scenario: An undefined field by one of those names
- **WHEN** a record is logged as JSON with the field `time` set to undefined
- **THEN** the record's own `time` is still written

### Requirement: The log format is checked first
`LOG_FORMAT` SHALL be read like the agent's other settings: its value is trimmed, and a value that is blank once trimmed counts as unset. It SHALL default to `pretty` when it is unset. Any value other than `pretty` or `json` SHALL fail the start-up: the agent SHALL log an error naming `LOG_FORMAT` in the formatted output, make no network call, and exit with code 1.

#### Scenario: An unknown log format
- **WHEN** `LOG_FORMAT` is `xml`
- **THEN** the formatted output holds one `ERROR` line naming `LOG_FORMAT` and "xml", no network call is made, and the exit code is 1

#### Scenario: A blank log format
- **WHEN** `LOG_FORMAT` is " "
- **THEN** the records are written formatted for reading

#### Scenario: Whitespace around the log format
- **WHEN** `LOG_FORMAT` is " json "
- **THEN** the records are written as JSON
