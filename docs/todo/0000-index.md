# Todo

Outstanding work, grouped by area. Each folder's index ranks its files by
criticality and gives each file a status
([choosing a status](../README.md#choosing-a-status)):

- **backlog**: an agent can start and finish at least one open task now.
- **blocked**: nothing can start yet; the row's **Needs you** cell names what
  it waits on (another to-do, a release, a CI run, a recurrence or a date).
- **requires user input**: every open task needs you; the row's **Needs you**
  cell says what to provide or decide.
- **done**: every task is finished. A finished file is normally retired in
  the same change; a `done` row remains only where the file is deliberately
  kept, and its **Why this rating** cell says why.

The counts below match the folder indexes; update them in the same change as
any row's status.

| Folder | backlog | blocked | requires user input | done | Total | Covers |
| --- | --- | --- | --- | --- | --- | --- |
| [Agent engines and provider SDKs](agent-engines/0000-index.md) | 11 | 4 | 14 | 0 | 29 | How native agent sessions run across providers: interactions and permissions, steer and interrupt, accounts and sign-in, model parameters, session lifecycle and history, and SDK surfaces not yet adopted. |
| [Backend structure](backend-structure/0000-index.md) | 4 | 0 | 0 | 0 | 4 | Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream. |
| [CLI and slash commands](cli-and-slash-commands/0000-index.md) | 3 | 0 | 2 | 0 | 5 | The public `orkestrator` CLI and the slash-command catalogue: missing features, catalogue cleanup and live qualification. |
| [Containers and environments](containers-and-environments/0000-index.md) | 24 | 3 | 10 | 2 | 39 | Docker environment containers: platform qualification, rebuild state, network and credential isolation, resource budgets, state observation and cleanup. |
| [Coordinator and Multi Review](coordinator-and-multi-review/0000-index.md) | 21 | 1 | 25 | 0 | 47 | The two multi-agent features: the Coordinator (read-only enforcement, async delegation, agent mail) and Multi Review (reviewer panels, consolidation, the flow graph). |
| [Cross-cutting](cross-cutting/0000-index.md) | 30 | 7 | 27 | 2 | 66 | Work that spans the product: CI and test health, live provider and platform qualification, mixed-version support, dependency upgrades, remote host upgrades and mobile layout. |
| [Design canvas](design-canvas/0000-index.md) | 3 | 0 | 0 | 0 | 3 | The design canvas and its agent tools: qualification evidence, operation recovery edges, design-to-agent conversation links and accessibility findings. |
| [MCP](mcp/0000-index.md) | 3 | 0 | 1 | 0 | 4 | MCP server management across providers, MCP delivery into environments, and the Control MCP voice surface. |
| [Service previews and web annotations](previews-and-annotations/0000-index.md) | 5 | 2 | 5 | 1 | 13 | Service previews (desktop tunnel, private origins, relay, embedded and discovered services) and web-page annotations (qualification, known limitations, extensions). |
| [Transcripts, observation and bandwidth](transcripts-and-observation/0000-index.md) | 15 | 4 | 6 | 1 | 26 | How sessions are read and kept fresh: rich transcripts, history efficiency, idle observation, recurring work, reconnects and remote bandwidth. |
| **Total** | 119 | 21 | 90 | 6 | 236 | |
