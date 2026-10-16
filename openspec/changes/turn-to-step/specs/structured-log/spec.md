## MODIFIED Requirements

### Requirement: Formatted output by default
Unless `LOG_FORMAT` is `json`, each record SHALL be written formatted for reading:
- the local time as `HH:MM:SS`, the level in capitals padded to five characters, and the message;
- then each field as `key=value`, in order;
- a string value bare when it has no whitespace, `"` or `=`, and as JSON otherwise;
- other values as compact JSON;
- a string value that spans several lines in a block after the line instead: its key, then each of its lines indented.

A message that spans several lines SHALL keep its first line in place. Each of its other lines SHALL follow the record's line, indented by four spaces, before any block. Lines SHALL be split at `\n` and at `\r\n`, so no line keeps a `\r` at its end.

#### Scenario: A record with fields
- **WHEN** an `info` record "model call" is logged at 07:15:51 local time with the fields `step: 1`, `seconds: 1.5` and `file: "a.txt"`
- **THEN** the line is `07:15:51 INFO  model call step=1 seconds=1.5 file=a.txt`

#### Scenario: A string that could be misread
- **WHEN** a field's value is `What runs?`
- **THEN** it is written as `question="What runs?"`

#### Scenario: A multi-line value
- **WHEN** an `answer` record has the field `text` with two lines
- **THEN** the record's line is followed by `  text:` and each of the two lines, indented by four spaces

#### Scenario: A multi-line message
- **WHEN** an `error` record's message is "The model call failed." and "Try again." on two lines, with the field `tool: "read_file"`
- **THEN** the record's line is `HH:MM:SS ERROR The model call failed. tool=read_file`, and the next line is `    Try again.`

#### Scenario: Windows line breaks
- **WHEN** a field's value is "one\r\ntwo"
- **THEN** the lines of its block are `    one` and `    two`, without a `\r`

#### Scenario: Levels line up
- **WHEN** records are logged at `info`, `warn` and `error`
- **THEN** their messages start in the same column
