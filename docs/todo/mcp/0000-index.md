# MCP

MCP server management across providers, MCP delivery into environments, and the Control MCP voice surface.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0039-mcp-management.md](0039-mcp-management.md) | High | No | Keep the per-provider MCP editor faithful to current pins, collect live evidence. Code items done 2026-10-25 (OpenCode in-place reload, Codex turn evidence, live row join, inventory polish); Claude's lingering replaced process is blocked upstream behind a canary. | MCP editing and apply are on for every provider, but the live probes and provider matrix, including the new OpenCode and Codex outcomes, have not run with a model under the corrected checks, and Grok's rules need re-deriving at its 1.0.67 pin. |
| 2 | [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md) | Medium | No | Durable container-private MCP overlay, Cursor delivery, and truthful scope, network and auth behaviour outside the backend host. | Code and real-Docker qualification are done; what remains is a live run with real provider sessions in a container, a remote-browser check and a real-browser pass of the overlay UI. |
| 3 | [0041-control-mcp-voice-surface.md](0041-control-mcp-voice-surface.md) | Medium | No | Control MCP voice profile, gateway over every public action, scoped operator credentials and CLI parity: built and tested. A live command approval done 2026-10-25, plus a recording relay and scorer for misresolved targets and handle copy errors; a realtime voice runtime run remains, plus deferred `delegate` and stateful-session options. | A missing measurement on a new, opt-in surface: the script, including a real Claude command approval confirmed and approved over MCP, has run with real sessions, and real Claude Code and Codex clients use the `full` profile, but misresolution and handle-copy rates need a realtime voice runtime and a person (the relay and scorer are ready). |
| 4 | [0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md) | Low | No | Read-only Claude plugin MCP servers in the editor, from the bridge's own plugin set and the pinned CLI's `enabledPlugins` rules. Code and qualification done 2026-10-25 (parity test, credential-free run on the pinned CLI, real-app session pass); one container run remains. | An extension with only a container qualification left: plugin servers are namespaced, so saved rows are never wrong without them, and the local path is proven on the real CLI and in the app. |
