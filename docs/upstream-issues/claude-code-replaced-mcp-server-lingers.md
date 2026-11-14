# Claude Code: a replaced MCP server process keeps running

**Tracker:** Claude Code, <https://github.com/anthropics/claude-code/issues> (bug report)
**Status:** draft
**Source:** [0039](../todo/mcp/0039-mcp-management.md) task 1 and code item 8; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; reproduction [`claude-mcp-replace-linger.live-probe.ts`](../../bridges/claude-bridge/src/services/claude-mcp-replace-linger.live-probe.ts)
**Filed:** —

## Issue text

**Title:** `Query.setMcpServers`: replacing a stdio server loaded at launch never stops the old process

**Summary.** Replacing a stdio MCP server's configuration under the same name with `Query.setMcpServers` connects a new process but never stops the old one when the old one was loaded at launch (from the SDK's `mcpServers` option, or from `mcpServers` in `.claude.json`). The old process keeps running, with its old environment, until the CLI exits. A server first added through `setMcpServers` is stopped correctly when it is replaced.

**Reproduction.** The attached `claude-mcp-replace-linger.live-probe.ts` is one self-contained file (it imports only `@anthropic-ai/claude-agent-sdk` and Node built-ins and is its own fixture MCP server). It needs no login and sends no prompt: each CLI runs in a temporary `HOME` and `CLAUDE_CONFIG_DIR` with non-essential traffic off.

```sh
bun add @anthropic-ai/claude-agent-sdk
bun claude-mcp-replace-linger.live-probe.ts
# optional: CLAUDE_CLI_PATH=<claude executable> to test a specific CLI
```

For each scenario it loads a server `alpha` (version 1, env `FIXTURE_SECRET=secret-v1`), calls `setMcpServers({ alpha: <version 2, secret-v2> })`, waits until `mcpServerStatus()` reports version 2 connected, and checks which fixture processes are alive. Exit status 1 means reproduced; the last line is `REPLACE_LINGER_RESULT <json>`.

**Result** (Claude Code 2.1.319, Agent SDK 0.3.319, Linux x86-64; three runs, identical):

| Scenario | How `alpha` v1 was loaded | After the replacement | After the CLI exits |
| --- | --- | --- | --- |
| `options` | the SDK's `mcpServers` option at launch | v2 connected; v1 and v2 running | none running |
| `dynamic` | an earlier `setMcpServers` call | v2 connected; v1 stopped | none running |
| `settings` | `mcpServers` in `.claude.json` | v2 connected; v1 and v2 running | none running |

Probe output on the current pin:

```text
<paste the probe's output here>
```

**Expected.** When `setMcpServers` replaces a server, the previous process for that name is stopped, as in the `dynamic` scenario.

**Actual.** For a server loaded at launch, the old process stays alive alongside the new one until the CLI exits. Only the new one is connected and offered to the model.

**Versions.** First seen on Claude Code 2.1.309 with Agent SDK 0.3.309; table above from 2.1.319 / 0.3.319 (2026-11-11). Current pins: Agent SDK 0.3.319 (`bridges/claude-bridge/package.json`), Claude Code 2.1.319 (`packages/toolchain/src/manifest.ts`).

**Impact.** A host that lets the user edit a running session's MCP server (for example to change a token in its environment) leaves the old process running with the old credentials for the rest of the CLI's life, and every edit adds another process.

## Existing-report search

None known; the sources record no search. Search terms: `setMcpServers`, `MCP server process not killed`, `MCP server orphan`, `replace MCP server`, `stdio server lingers`, `mcp process leak`.

## Before filing

- [ ] Run the probe once on the current pin and paste its output above; update the versions if the pin has moved.
- [ ] If it exits 0 on a newer release, do not file: flip the canary instead (0039 task 1).
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and link the issue in [0039](../todo/mcp/0039-mcp-management.md) task 1 and code item 8.
