# Todo

Outstanding work, grouped by area. Each folder's index ranks its files by
criticality and gives each file a status
([choosing a status](../README.md#choosing-a-status)). An area to-do holds
only work an agent can build or work that is blocked:

- **backlog**: an agent can start and finish at least one open task now.
- **blocked**: nothing can start yet; the row's **Needs you** cell names what
  it waits on (another to-do, a checklist item in 7568, a release, a CI run,
  a recurrence or a date).

Everything that needs you (manual tests and live checks, real logins, your
real install and data, hardware the fleet lacks, decisions and outward
actions) is one `- [ ]` item in the
[manual-test checklist](manual-test/7568-manual-test-checklist.md), the only
**requires user input** row ([human-only work](../README.md#human-only-work)).
There are no **done** rows: a finished file is retired in the same change.

The counts below match the folder indexes; update them in the same change as
any row's status.

| Folder | backlog | blocked | requires user input | done | Total | Covers |
| --- | --- | --- | --- | --- | --- | --- |
| [Agent engines and provider SDKs](agent-engines/0000-index.md) | 14 | 9 | 0 | 0 | 23 | How native agent sessions run across providers: interactions and permissions, steer and interrupt, accounts and sign-in, model parameters, session lifecycle and history, and SDK surfaces not yet adopted. |
| [Backend structure](backend-structure/0000-index.md) | 4 | 0 | 0 | 0 | 4 | Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream. |
| [CLI and slash commands](cli-and-slash-commands/0000-index.md) | 4 | 0 | 0 | 0 | 4 | The public `orkestrator` CLI and the slash-command catalogue: missing features, catalogue cleanup and live qualification. |
| [Containers and environments](containers-and-environments/0000-index.md) | 14 | 9 | 0 | 0 | 23 | Docker environment containers: platform qualification, rebuild state, network and credential isolation, resource budgets, state observation and cleanup. |
| [Coordinator and Multi Review](coordinator-and-multi-review/0000-index.md) | 26 | 4 | 0 | 0 | 30 | The two multi-agent features: the Coordinator (read-only enforcement, async delegation, agent mail) and Multi Review (reviewer panels, consolidation, the flow graph). |
| [Cross-cutting](cross-cutting/0000-index.md) | 35 | 17 | 0 | 0 | 52 | Work that spans the product: CI and test health, live provider and platform qualification, mixed-version support, dependency upgrades, and remote host upgrades. |
| [Design canvas](design-canvas/0000-index.md) | 3 | 0 | 0 | 0 | 3 | The design canvas and its agent tools: qualification evidence, operation recovery edges, design-to-agent conversation links and accessibility findings. |
| [MCP](mcp/0000-index.md) | 4 | 0 | 0 | 0 | 4 | MCP server management across providers, MCP delivery into environments, and the Control MCP voice surface. |
| [Service previews and web annotations](previews-and-annotations/0000-index.md) | 6 | 3 | 0 | 0 | 9 | Service previews (desktop tunnel, private origins, relay, embedded and discovered services) and web-page annotations (qualification, known limitations, extensions). |
| [Transcripts, observation and bandwidth](transcripts-and-observation/0000-index.md) | 20 | 3 | 0 | 0 | 23 | How sessions are read and kept fresh: rich transcripts, history efficiency, idle observation, recurring work, reconnects and remote bandwidth. |
| [Manual test](manual-test/0000-index.md) | 0 | 0 | 1 | 0 | 1 | One checklist of everything that needs you: manual tests and live checks first, then decisions, approvals and outward actions, each naming its source to-do and task. |
| **Total** | 130 | 45 | 1 | 0 | 176 | |
