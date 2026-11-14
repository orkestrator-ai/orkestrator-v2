# Claude Agent SDK: a `terminal` flag on `SlashCommand` rows

**Tracker:** Claude Agent SDK for TypeScript, <https://github.com/anthropics/claude-agent-sdk-typescript/issues> (feature request)
**Status:** draft
**Source:** 0016 (retired) task 1 and its code item 11 (`git show 553032554^:docs/todo/cli-and-slash-commands/0016-slash-command-catalogue.md`); [native-agent-commands.md, Provider notes](../architecture/native-agent-commands.md#provider-notes) (Claude); filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item
**Filed:** —

## Issue text

**Title:** Feature request: mark terminal-only commands on `SlashCommand` (`supportedCommands()`)

**Summary.** `supportedCommands()` returns `SlashCommand` rows of `{ name, description, argumentHint, aliases?, builtin? }`. Nothing on a row says that a command is bound to the local terminal (for example `/focus`, `/exit`, `/statusline`). That information exists only on a turn's `system/init` message, as `terminal_slash_commands`. A client that builds its command menu before the first turn, from `supportedCommands()` or `initializationResult()`, cannot tell which commands it should hide.

**Reproduction.**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// A prompt stream that never yields, so no turn (and no model request) starts.
const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
const q = query({ prompt: idle, options: { cwd: process.cwd() } });
const rows = await q.supportedCommands();
console.log(rows.find((row) => row.name === "focus"));
// { name: "focus", description: "…", argumentHint: "", builtin: true }: no terminal marker
```

The same command is listed in `terminal_slash_commands` on the `system/init` message of the first turn (`SDKSystemMessage`, documented as "Subset of slash_commands whose UX is bound to the local terminal … Phone/remote UIs should hide these from command menus").

**Expected.** A field on each `SlashCommand`, for example `terminal?: true`, set for exactly the commands the init message lists in `terminal_slash_commands`, so `supportedCommands()` alone is enough to build a correct menu.

**Actual.** The marker is only on `system/init`, which a client sees only after it spends a model turn.

**Versions.** Agent SDK 0.3.319 (our pin) with Claude Code 2.1.319: `SlashCommand` has no such field. Still absent at 0.3.322, the newest published on 2026-11-11. First seen at SDK 0.3.296 with CLI 2.1.296 (`/focus` arrived as `{ name, description, argumentHint, builtin }`).

**Impact.** Our workaround remembers the `terminal_slash_commands` list per CLI version from earlier turns and applies it to `supportedCommands()` rows. On a CLI version the client has never run a turn on, the first menu still offers terminal-only commands, and choosing one returns "isn't available here yet" as local output. The alternatives are all worse: hiding every `builtin` row until the first turn (also hides `/context` and `/compact`), a fixed name list that goes stale with each release, or a model turn at startup (costs tokens and leaves a session file).

## Existing-report search

None known. Search the SDK tracker and <https://github.com/anthropics/claude-code/issues> for: `terminal_slash_commands`, `SlashCommand terminal`, `supportedCommands terminal`, `remote UI hide commands`.

## Before filing

- [ ] Check the newest published SDK's `sdk.d.ts`: if `SlashCommand` has gained a terminal marker, do not file; use it instead (per the Provider notes).
- [ ] Confirm the reproduction on the current pin and fill in the description `/focus` returns.
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed** and set **Status** to `filed`. 0016 is retired: reply to the coordinator with the URL, and add it to the Claude note in [native-agent-commands.md](../architecture/native-agent-commands.md#provider-notes).
