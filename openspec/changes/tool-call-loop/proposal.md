## Why

The hello proves that one model turn works, but an agent needs the loop the brief describes (Part 1, component 2; Brief 4.5): call the model with tools, run the calls it makes, feed each result back tagged with its call ID, and repeat until it answers. With `store: false` (Brief C1), the client holds the chat history and replays it on every turn. A probe on 2026-10-12 showed that the local model (`prism-ml/bonsai-27b` on LM Studio 0.4.26) returns structured function calls and accepts replayed history, reasoning items included. So the smallest useful tool, `read_file`, can now prove the loop end to end through the hello.

## What Changes

- **`core`: pure building blocks for tool calling, with no new runtime dependency.**
  - **Tools.** A tool is a name, a description and an argument schema. The schema is typed against the Standard Schema v1 interface, which `core` declares itself as types; it is the same contract the `openai` SDK's own helpers accept. `toFunctionTool` turns a tool into the Responses API's `FunctionTool`, taking the JSON Schema from the schema itself.
  - **Classifying a turn.** `classify` reads a completed turn's output as tool calls, a final answer, or nothing. Any function call wins over text, and whitespace-only text counts as nothing.
  - **Validating calls.** `validateArgs` parses a call's JSON arguments and checks them against the tool's schema. It returns the typed arguments, or an error text the model can act on.
  - **History.** `toOutputItem` builds a call's `function_call_output` item. `toInput` turns the chat history (Responses items, kept as received) into the next request's input, returning a value instead of throwing.
- **`server`:**
  - **A `read_file` tool**, defined with zod 4 and confined to the working directory. It refuses paths outside that directory (symlinks included), `.env` files, directories and binary files, and caps what it returns, with a note when it truncates.
  - **An agent loop**, in the server because "the caller orchestrates" (Brief, Layering). It is an async generator that yields each turn's result as the turn completes. It runs at most 8 turns and executes each turn's calls in order. Tool failures go back to the model as outputs, and every call gets exactly one output.
  - **A hand-rolled structured logger.** Records are a message plus JSON fields, written to stdout. The output is formatted for reading by default, or one JSON object per line with `LOG_FORMAT=json`.
  - **BREAKING: the hello asks a question about a file instead of saying hi.** The command becomes `bun run hello [file] [question]`; with no arguments it asks what the `check` script in `package.json` runs. The question, each turn's token usage (cached tokens included), each tool call and the answer are all logged to stdout.
- **Not in this change** (later milestones in the brief):
  - detecting calls the model writes as text, and nudging it (C9);
  - budgets, the context check and the finalize turn (C8);
  - the pure `nextStep` policy;
  - collecting output items from `response.output_item.done` events, which matters for SIWC (M5).

## Capabilities

### New Capabilities
- `tool-calls`: `core`'s pure contract for tool calling over the Responses API: tool definitions and their `FunctionTool` form, classifying a turn's output, validating call arguments, building call outputs, and turning chat history into request input.
- `agent-loop`: the server's loop that alternates model turns and tool calls until the model answers, with its turn cap, call ordering and failure handling.
- `read-file-tool`: the server's `read_file` tool: what it may read, its limits, and how it reports what it can't do.
- `structured-log`: the server's logger: records with a level, a message and JSON fields, written to stdout, formatted by default and as JSON lines on request.

### Modified Capabilities
- `model-hello`: the hello asks a question about a file through the agent loop instead of saying hi. It takes an optional file and question, and reports each tool call and each turn's usage.

## Impact

- **Code:**
  - `packages/core/src`: new tool-calling module(s) and exports; `runTurn` is unchanged.
  - `packages/server/src`: new `read_file` tool and loop. `hello.ts` merges into `main.ts`, which reads its I/O from the process's globals instead of having it injected.
  - Tests for all of it, and the README.
- **Dependencies:**
  - `zod` 4.x, in `server` only.
  - `core` gains no dependency. It starts using one runtime function from its existing `openai` peer dependency: `toResponseInputItems`, which the SDK's README recommends for manually managed history.
- **Runtime:** a question now takes several turns. On the local bonsai-27b that was about a minute and a half (24–48 s per turn in the probe).
- **Security:** until the workspace container exists (Brief C3, D3), `read_file` runs in the server process with your permissions. Confining it to the working directory and refusing `.env` files limits what a model steered by a file's contents could read.
- **Brief:**
  - This implements part of 4.3 (`classify`, `validateArgs`, `toOutputItem`) and the tool-execution table of 4.5, using the brief's names.
  - It departs from 4.2's "one JSON Schema validator" in `core`: arguments are validated through Standard Schema instead, because C4 made every tool our own TypeScript.
  - The probe results are recorded under spike S2.
