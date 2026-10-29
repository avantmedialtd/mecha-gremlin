## RENAMED Requirements

- FROM: `### Requirement: Formatted output by default`
- TO: `### Requirement: Formatted output for pretty`

## MODIFIED Requirements

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
