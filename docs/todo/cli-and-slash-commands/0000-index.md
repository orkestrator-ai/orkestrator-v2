# CLI and slash commands

The public `orkestrator` CLI and the slash-command catalogue: missing features, catalogue cleanup and live qualification.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0014-cli-qualification.md](0014-cli-qualification.md) | Medium | No | Live Pi, Cursor and Grok qualification runs (blocked on API-key credentials on the qualifying host) and the token cost of live runs. Done 2026-10-25: per-run model record, macOS packaging, config directory and `--profile` checks, OpenCode browser question and approval cards, the foreign-owner Docker decoy scenario, and start-up, failure-time, flake and cleanup measurements. Holds the CLI evidence log. | Pi, Cursor and Grok are still unqualified for request-specific completion, so scripts on them cannot use `run wait` as a success signal (a qualification run for secondary providers). |
| 2 | [0017-cli-command-surface.md](0017-cli-command-surface.md) | Low | No | Post-release CLI surface: selected slash commands with `--literal`, durable `--enqueue`, `--attach`, cascade project removal, local-only `project init` and shell completion shipped and live-qualified on Claude (2026-10-25); left: optional event-stream following, worker-scoped CLI credentials, and on-demand `apply`/auto-start. | Everything left is optional or deferred by decision: polling already follows transcripts, and Control MCP credentials cover scoped automation until the CLI gets its own. |
| 3 | [0015-slash-command-qualification.md](0015-slash-command-qualification.md) | Low | No | Live slash-command qualification record (all six providers, host and container browser runs, Pi, Codex disabled skills, mixed-version fakes, catalogue performance); left: a run against real v2.21.0 builds (the oldest in 0034's support window; pre-#827 builds are outside it). | The only remaining item is a mixed-version run against real old builds, now unblocked and narrowed to v2.21.0; everything shipped is proved live (the container picker lag under host load is tracked as flake 0710). |
| 4 | [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md) | Low | No | Legacy command-catalogue routes retired, unavailable command classes decided, Codex cold plugin skills fixed and the picker qualified live on Claude, Pi and Grok (2026-10-24); left: the Claude terminal marker. | The only remaining item waits on the Agent SDK adding a terminal marker to `SlashCommand`. |
