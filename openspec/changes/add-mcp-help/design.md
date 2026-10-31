## Context

The `mcp` command (`add-mcp-servers`, archived 2026-10-30) reports only through the structured logger, in the format `LOG_FORMAT` chooses, and checks `DATA_DIR` and `LOG_FORMAT` before it does anything. Its only usage message is the `error` record for an unknown subcommand, which names the five subcommands and nothing else, and `--help`, `-h` and `help` are unknown subcommands. The README's "MCP servers" section explains everything, but nothing in the terminal points there.

## Goals / Non-Goals

**Goals:**
- Let someone at the terminal learn, from the command itself and before any setting exists, what the subcommands are, what an entry is and how to give one safely, and what the command needs.
- Have every usage error say where help is.

**Non-Goals:**
- Replacing the README: the text is one screen, and sends the reader there for the rules.
- Help for one subcommand at a time, or help for the agent's own entry point.
- Changing any check of an entry, or its message.

## Decisions

- **Plain text on stdout, not records.** Help is read by a person, who may have no `LOG_FORMAT` yet, so the text is written as it is whatever the format, with `console.log`, as the logger writes its records. This is the one exception to the command's "records only" rule, and the spec says so. A `json` reader loses nothing: help is never asked for by a program.
- **No settings, no store.** The request is parsed before the settings are read, so `--help` can't be answered with "DATA_DIR is required", and no database is created by asking a question.
- **Exit codes as `git`'s.** `help`, `--help` and `-h` exit with 0. No arguments at all prints the same text and exits with 1, since nothing was done. The two cases share one text, so a user who runs the bare command learns as much as one who asks.
- **`help` ignores what follows it.** `bun run mcp help add` prints the same screen rather than "help takes no arguments": a request for help shouldn't fail.
- **One template literal, in `main/mcp-help.ts`.** The text is one string, so Stryker gives it one mutant, and `mcp.ts` stays about dispatch. `main/` already holds the entry points' helpers. The tests assert the terms the spec names, not the whole text, so wording can change without a spec change.
- **Only usage errors point to help.** An unknown subcommand and a wrong number of arguments end with `bun run mcp help explains the command.` The errors for an entry name their problem and its fix already, and pointing every one of them at the same screen would add noise to a list that may be ten lines long.

## Risks / Trade-offs

- [The text and the README drift apart] → the text states only what is unlikely to change (the subcommands, the entry's shape, the two timeouts, references, the settings) and sends the reader to the README for the rest.
- [Plain text among JSON records, if a script ran `help` with `LOG_FORMAT=json`] → no script has a reason to; accepted.
