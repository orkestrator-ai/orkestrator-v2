# MCP

MCP server management across providers, MCP delivery into environments, and the Control MCP voice surface.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0039-mcp-management.md](0039-mcp-management.md) | High | No | Keep the per-provider MCP editor faithful to current pins (Claude retained runtime), close apply paths that stop at pending or restart, collect live evidence. | MCP editing is on for every provider, but live apply probes and the provider matrix are not re-qualified under the corrected checks. |
| 2 | [0040-mcp-environment-delivery.md](0040-mcp-environment-delivery.md) | Medium | No | Durable container-private MCP overlay, Cursor delivery, and truthful scope, network and auth behaviour outside the backend host. | Code and real-Docker qualification are done; what remains is a live run with real provider sessions in a container, a remote-browser check and a real-browser pass of the overlay UI. |
| 3 | [0041-control-mcp-voice-surface.md](0041-control-mcp-voice-surface.md) | Medium | No | Control MCP voice profile: small core tools, gateway meta-tools over the public actions, scoped operator credentials, and parity with the CLI. | A new surface (gateway, scoped credentials, voice tools); nothing shipped is broken while it waits. |
