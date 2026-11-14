# MCP

MCP server management across providers and MCP delivery into environments.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [0039-mcp-management.md](0039-mcp-management.md) | Low | blocked | Waits on: 7568 (the upstream reports item, the Claude Code report in `docs/upstream-issues/`); an upstream Claude Code release that stops a replaced MCP server process | Keep the per-provider MCP editor faithful to current pins, collect live evidence. Code items done 2026-10-25 (OpenCode in-place reload, Codex turn evidence, live row join, inventory polish); on 2026-10-31 Grok rules re-derived at 1.0.70, Codex and Grok parity guards added, agent-account copies kept in step, and the real-browser UI matrix covered by a credential-free spec. On 2026-11-06 the rows-read-`unknown` case (task 14), the OpenCode decisions (task 11) and, **on a fake model only** (scripted loopback model, no login), the Pi rerun (task 5), the probe matrix for Claude, Codex and Pi (task 6), the Claude inactive spec in full mode and a new Codex process-wide spec (task 7) and Claude reconnect on a running CLI (task 13); containers and remote moved to 0040 (task 9; 0040 retired 2026-11-13). On 2026-11-10, also on the fake model only, through a custom OpenCode provider: OpenCode's probe cells (task 6). On 2026-11-11 the standalone repro for the upstream Claude Code report on replaced server processes that linger was written and is run beside the canary (task 1): at CLI 2.1.319 a server loaded at launch still lingers when replaced, one added through `setMcpServers` does not. Left: the canary flip once upstream fixes it (task 1). The report filing, the Grok live run (task 4), Cursor's cells (task 6) and the release decision on the all-on default (task 10) moved to 7568 on 2026-11-10; the real-login reruns of the fake-model checks (Pi, task 5; the inactive spec in full mode, task 7; a signed-in account session, task 12; Claude reconnect, task 13) were added there on 2026-11-11. Follow-ups 7220 (closed 2026-11-06) and 7221 (closed 2026-11-09). | The only agent work left is a canary flip for an upstream Claude Code bug, which is blocked upstream; the live Grok and Cursor qualification of the all-on default and its release decision are in 7568. |
