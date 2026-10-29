# structured-log Specification

## Purpose

The agent's logger: records with a level, a message and JSON fields, written to stdout, formatted for `LOG_FORMAT=pretty` and as JSON lines for `json`.
## Requirements
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

### Requirement: JSON output on request
With `LOG_FORMAT` set to `json`, each record SHALL be written as one line holding a JSON object. The object holds `time` (ISO 8601), `level` and `message`, then the fields.

#### Scenario: A record as JSON
- **WHEN** `LOG_FORMAT` is `json` and an `info` record "tool call" is logged with the fields `tool: "read"` and `arguments: { path: "a.txt" }`
- **THEN** the line is a JSON object with `time`, `level` `info`, `message` "tool call", `tool` and `arguments` as an object

### Requirement: The log format is checked first
`LOG_FORMAT` SHALL be read like the agent's other settings: its value is trimmed, and a value that is blank once trimmed counts as unset. It SHALL be required, with `pretty` and `json` as its only accepted values. An unset, blank or invalid value SHALL fail startup, make no network call and exit with code 1. The agent SHALL check it first to choose the diagnostic output format, but SHALL still check and report all independently checkable configuration errors before exiting. If `LOG_FORMAT` is invalid or missing, the agent SHALL use formatted output only for those startup diagnostics, including an error naming `LOG_FORMAT`; this diagnostic path SHALL NOT accept `pretty` as a configuration default.

#### Scenario: An unknown log format
- **WHEN** `LOG_FORMAT` is `xml`
- **THEN** the formatted output holds an `ERROR` line naming `LOG_FORMAT` and `xml`, no network call is made, and the exit code is 1

#### Scenario: An unset or blank log format
- **WHEN** `LOG_FORMAT` is unset or contains only spaces
- **THEN** the agent reports that `LOG_FORMAT` is required, makes no network call and exits with code 1

#### Scenario: Other errors accompany an invalid log format
- **WHEN** `LOG_FORMAT` is invalid and independently checkable settings such as `MAX_STEPS` and `WORK_DIR` are also invalid
- **THEN** formatted startup diagnostics name all three settings before the agent exits with code 1, without making a network call

#### Scenario: Whitespace around the log format
- **WHEN** `LOG_FORMAT` is ` json `
- **THEN** records are written as JSON

### Requirement: Formatted output for pretty
When `LOG_FORMAT` is `pretty`, each record SHALL be written formatted for reading:
- the local time as `HH:MM:SS`, the level in capitals padded to five characters, and the message;
- then each field as `key=value`, in order;
- a string value bare when it has no whitespace, `"` or `=`, and as JSON otherwise;
- other values as compact JSON;
- a string value that spans several lines in a block after the line instead: its key, then each of its lines indented.

A message that spans several lines SHALL keep its first line in place. Each of its other lines SHALL follow the record's line, indented by four spaces, before any block. Lines SHALL be split at `\n` and at `\r\n`, so no line keeps a `\r` at its end.

#### Scenario: A record with fields
- **WHEN** an `info` record "model call" is logged at 07:15:51 local time with `step: 1`, `seconds: 1.5` and `file: "a.txt"`
- **THEN** the line is `07:15:51 INFO  model call step=1 seconds=1.5 file=a.txt`

#### Scenario: A string that could be misread
- **WHEN** a field's value is `What runs?`
- **THEN** it is written as `question="What runs?"`

#### Scenario: A multi-line value
- **WHEN** an `answer` record has a `text` field with two lines
- **THEN** the record's line is followed by `  text:` and each of the two lines, indented by four spaces

#### Scenario: A multi-line message
- **WHEN** an `error` record's message is "The model call failed." and "Try again." on two lines, with `tool: "read"`
- **THEN** the record's line is `HH:MM:SS ERROR The model call failed. tool=read`, and the next line is `    Try again.`

#### Scenario: Windows line breaks
- **WHEN** a field's value is "one\r\ntwo"
- **THEN** the lines of its block are `    one` and `    two`, without a `\r`

#### Scenario: Levels line up
- **WHEN** records are logged at `info`, `warn` and `error`
- **THEN** their messages start in the same column

