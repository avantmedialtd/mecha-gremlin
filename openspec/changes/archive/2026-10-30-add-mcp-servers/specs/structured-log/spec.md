## MODIFIED Requirements

### Requirement: JSON output on request
With `LOG_FORMAT` set to `json`, each record SHALL be written as one line holding a JSON object. The object holds `time` (ISO 8601), `level` and `message`, then the fields. The characters U+007F to U+009F, which JSON leaves as they are, SHALL be written as `\u` escapes, as JSON writes the other control characters.

#### Scenario: A record as JSON
- **WHEN** `LOG_FORMAT` is `json` and an `info` record "tool call" is logged with the fields `tool: "read"` and `arguments: { path: "a.txt" }`
- **THEN** the line is a JSON object with `time`, `level` `info`, `message` "tool call", `tool` and `arguments` as an object

#### Scenario: Control characters as JSON
- **WHEN** `LOG_FORMAT` is `json`, and a record's message holds ESC and U+009B
- **THEN** the line holds `\u001b` and `\u009b` and neither character itself, and its `message` parses back to the message logged

### Requirement: Formatted output for pretty
When `LOG_FORMAT` is `pretty`, each record SHALL be written formatted for reading:
- the local time as `HH:MM:SS`, the level in capitals padded to five characters, and the message;
- then each field as `key=value`, in order;
- a string value bare when it has no whitespace, `"`, `=` or control character, and as JSON otherwise;
- other values as compact JSON;
- a string value that spans several lines in a block after the line instead: its key, then each of its lines indented.

A message that spans several lines SHALL keep its first line in place. Each of its other lines SHALL follow the record's line, indented by four spaces, before any block. Lines SHALL be split at `\n` and at `\r\n`, so no line keeps a `\r` at its end.

No control character, U+0000 to U+001F or U+007F to U+009F, SHALL be written as it is, other than tabs and the line breaks that split lines, so that text from a server can't move the cursor or start a terminal's escape sequence. A value written as JSON SHALL keep JSON's own escapes. Every other control character SHALL be written as `\u` and four lowercase hexadecimal digits.

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

#### Scenario: Control characters
- **WHEN** an `error` record's message is "bad" followed by ESC and `[2J`, with a field `name` holding "x" followed by ESC
- **THEN** the line is `HH:MM:SS ERROR bad\u001b[2J name="x\u001b"`, and holds no ESC

#### Scenario: A carriage return inside a block
- **WHEN** a field's value is "one\ntwo\rthree"
- **THEN** the lines of its block are `    one` and `    two\u000dthree`

#### Scenario: C1 controls
- **WHEN** a field `name`'s value is "a", U+009B and "b"
- **THEN** it is written as `name="a\u009bb"`, and the line holds no U+009B
