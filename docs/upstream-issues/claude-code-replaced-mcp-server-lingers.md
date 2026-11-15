# Claude Code: a replaced MCP server process keeps running

**Tracker:** Claude Code, <https://github.com/anthropics/claude-code/issues> (bug report)
**Status:** ready to file, as a comment on [anthropics/claude-code#79740](https://github.com/anthropics/claude-code/issues/79740) (2026-11-15): reproduced on the current pin, and that open issue reports what is probably the same defect through `/mcp` reconnect; post the issue text there, keeping the **Related** paragraph, rather than opening a new issue.
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

**Result** (Claude Code 2.1.319, Agent SDK 0.3.319, Linux x86-64; three runs, identical. Also reproduced on macOS arm64 (Darwin 27.2) on 2026-11-15, one run, the same result in every scenario):

| Scenario | How `alpha` v1 was loaded | After the replacement | After the CLI exits |
| --- | --- | --- | --- |
| `options` | the SDK's `mcpServers` option at launch | v2 connected; v1 and v2 running | none running |
| `dynamic` | an earlier `setMcpServers` call | v2 connected; v1 stopped | none running |
| `settings` | `mcpServers` in `.claude.json` | v2 connected; v1 and v2 running | none running |

Probe output on the current pin (macOS arm64, 2026-11-15, exit status 1):

```text
Claude Code: 2.1.319 (Claude Code)
options: connected v2; processes v1 running, v2 running; 0 alive after the CLI exited -> the replaced process lingered
dynamic: connected v2; processes v1 stopped, v2 running; 0 alive after the CLI exited
settings: connected v2; processes v1 running, v2 running; 0 alive after the CLI exited -> the replaced process lingered
REPRODUCED
REPLACE_LINGER_RESULT {"claudeCode":"2.1.319 (Claude Code)","scenarios":[{"scenario":"options","connected":["2"],"processes":[{"version":"1","alive":true},{"version":"2","alive":true}],"aliveAfterExit":0,"lingering":true},{"scenario":"dynamic","connected":["2"],"processes":[{"version":"1","alive":false},{"version":"2","alive":true}],"aliveAfterExit":0,"lingering":false},{"scenario":"settings","connected":["2"],"processes":[{"version":"1","alive":true},{"version":"2","alive":true}],"aliveAfterExit":0,"lingering":true}],"reproduced":true}
```

**Related.** #79740 reports the same leak through `/mcp` reconnect after a `.mcp.json` edit (the old process gets no stdin EOF and no signal, and lives until the CLI exits; a reconnect with an unchanged configuration stops it). This report is the Agent SDK path to what is probably the same defect: a launch-loaded server whose configuration changed is replaced without its old connection being closed.

**Expected.** When `setMcpServers` replaces a server, the previous process for that name is stopped, as in the `dynamic` scenario.

**Actual.** For a server loaded at launch, the old process stays alive alongside the new one until the CLI exits. Only the new one is connected and offered to the model.

**Versions.** First seen on Claude Code 2.1.309 with Agent SDK 0.3.309; table above from 2.1.319 / 0.3.319 (2026-11-11, Linux x86-64), re-run on 2.1.319 / 0.3.319 on macOS arm64 on 2026-11-15 (reproduced). Not yet tried on the newest published, Claude Code 2.1.325 / Agent SDK 0.3.325 (2026-11-13). Current pins, unchanged on 2026-11-15: Agent SDK 0.3.319 (`bridges/claude-bridge/package.json`), Claude Code 2.1.319 (`packages/toolchain/src/manifest.ts`).

**Impact.** A host that lets the user edit a running session's MCP server (for example to change a token in its environment) leaves the old process running with the old credentials for the rest of the CLI's life, and every edit adds another process.

## Existing-report search

Searched 2026-11-15 (`gh search issues`, open and closed) in anthropics/claude-code and anthropics/claude-agent-sdk-typescript for: `setMcpServers`, `MCP server process not killed`, `MCP server orphan`, `replace MCP server`, `stdio server lingers`, `mcp process leak`, `mcp_set_servers`, `MCP reconnect old process`, `MCP server config change old process still running`, `stdio MCP server orphaned`.

- **Likely the same defect:** [anthropics/claude-code#79740](https://github.com/anthropics/claude-code/issues/79740), "[BUG] stdio MCP server orphaned on /mcp reconnect after a .mcp.json edit - no kill, no stdin close, leaks until session exit" (open, labels `area:mcp`, `reproduced`; filed 2026-07-21 on 2.1.216 Windows, confirmed in comments on Linux 2.1.233 and macOS 2.1.283). Same symptom (a launch-loaded stdio server whose configuration changed is replaced, the old process gets neither EOF nor a signal and lives until the CLI exits; an unchanged-configuration replacement stops it), reached through `/mcp` reconnect instead of `Query.setMcpServers`. Not filed for the SDK path, and it has no credential-free, scriptable reproduction.
- Different bugs: [#1935](https://github.com/anthropics/claude-code/issues/1935) (MCP servers not terminated when Claude Code exits; here they are), [#40207](https://github.com/anthropics/claude-code/issues/40207), [#88940](https://github.com/anthropics/claude-code/issues/88940) (servers killed too early), [#64784](https://github.com/anthropics/claude-code/issues/64784), [#31339](https://github.com/anthropics/claude-code/issues/31339) (other `mcp_set_servers` / SDK-server bugs), [claude-agent-sdk-typescript#292](https://github.com/anthropics/claude-agent-sdk-typescript/issues/292) (tools added through `setMcpServers` not visible mid-query).
- The SDK tracker has no report of a lingering replaced process.

Decision (2026-11-15): post this reproduction (the `options` and `settings` scenarios, and the probe file) as a comment on #79740 rather than opening a new issue. It is the same symptom and very likely the same root cause, and a comment keeps the scriptable, credential-free reproduction where the maintainers already track the bug; a separate issue would most likely be closed as a duplicate. If #79740 is closed or fixed by the time it is posted, file it as a new issue that links it instead. Repeat the search right before posting.

## Before filing

- [x] Run the probe once on the current pin and paste its output above; update the versions if the pin has moved. Done 2026-11-15 on macOS arm64, 2.1.319 / 0.3.319 (pin unchanged): exit status 1, reproduced in `options` and `settings`, not in `dynamic`.
- [x] If it exits 0 on a newer release, do not file: flip the canary instead (0039 task 1). Not applicable on 2026-11-15: it exited 1 on the pin. The newest release (2.1.325) was not tried; it would need its own binary, so re-run there when the pin moves.
- [x] Search for duplicates. Done 2026-11-15: #79740 is likely the same defect (see above).
- [x] Decide between a comment on #79740 and a separate report linking it. Decided 2026-11-15: a comment on #79740 (above).

## After filing

Record the comment's (or issue's) URL and date under **Filed**, set **Status** to `filed`, and link the issue in [0039](../todo/mcp/0039-mcp-management.md) task 1 and code item 8.
