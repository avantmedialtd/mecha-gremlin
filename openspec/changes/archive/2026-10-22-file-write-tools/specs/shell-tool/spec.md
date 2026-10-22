## MODIFIED Requirements

### Requirement: Report the exit code and both streams
When bash ran, the outcome SHALL succeed, whatever the exit code. Its text SHALL be, in order:
1. `exit code: N`, or `killed by` and the signal's name, such as `killed by SIGTERM`, when a signal ended bash;
2. `timed out after N s`, with N the timeout in seconds, when the timeout fired;
3. `stdout:` and the captured stdout, when it isn't empty;
4. `stderr:` and the captured stderr, when it isn't empty;
5. `(no output)`, when both streams are empty;
6. when either stream was cut, a line saying how to see the rest: write the output to a file in the working directory, then read it a part at a time with the `read` tool's `offset` and `limit`, search it with `grep`, or print the part needed with `sed -n` or `tail -c`.

The outcome SHALL fail only when bash can't be started, or when the shell has been closed. When the working directory no longer exists, the error SHALL name it and say so.

#### Scenario: Success
- **WHEN** the command is `echo hi`
- **THEN** it succeeds with "exit code: 0", then "stdout:" and "hi"

#### Scenario: A failing command
- **WHEN** the command is `echo oops >&2; exit 3`
- **THEN** it succeeds with "exit code: 3", then "stderr:" and "oops"

#### Scenario: No output
- **WHEN** the command is `true`
- **THEN** it succeeds with "exit code: 0" and "(no output)"

#### Scenario: Ended by a signal
- **WHEN** the command is `kill -TERM $$`
- **THEN** it succeeds with "killed by SIGTERM"

#### Scenario: A cut stream
- **WHEN** the command writes more than the cap to stdout
- **THEN** the outcome ends with the line saying how to see the rest of the output

#### Scenario: bash can't be started
- **WHEN** the `PATH` given to the tool holds no `bash`
- **THEN** the outcome fails saying bash couldn't be started, and no signal is sent

#### Scenario: The working directory is gone
- **WHEN** the working directory has been deleted
- **THEN** the outcome fails with an error that names the working directory and says it doesn't exist
