# CLI and slash commands

The public `orkestrator` CLI and the slash-command catalogue: live qualification. What the CLI deliberately leaves out is in [`public-cli.md`](../../architecture/public-cli.md#not-built) and the catalogue decisions are in [`native-agent-commands.md`](../../architecture/native-agent-commands.md) (to-dos 0016 and 0017, retired on 2026-11-11).

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [0014-cli-qualification.md](0014-cli-qualification.md) | Medium | backlog | — | Pi, Cursor and Grok qualification: the credentialed live runs are on the manual-test checklist; left here are the `PROVIDER_COMPLETION` flip for each provider whose run passes (task 1, waits on 7568) and recording a live run's token usage in the scenario manifest (task 4). Done 2026-10-25: per-run model record, macOS packaging, config directory and `--profile` checks, OpenCode browser question and approval cards, the foreign-owner Docker decoy scenario, and start-up, failure-time, flake and cleanup measurements. Done 2026-11-01: lost-response recovery for `environment start/stop/recreate/delete --wait` and `exec --wait`, re-run under load (flake 0440 resolved). Done 2026-11-06: fresh credential-free Linux evidence (local 10/10, container 8/8 through the test-only Docker shim on a full address pool, `smoke:cli`). Holds the CLI evidence log. | Pi, Cursor and Grok are still unqualified for request-specific completion, so scripts on them cannot use `run wait` as a success signal (a qualification run for secondary providers). |
| 2 | [0015-slash-command-qualification.md](0015-slash-command-qualification.md) | Low | backlog | — | Live slash-command qualification record (all six providers, host and container browser runs, Pi, Codex disabled skills, mixed-version fakes, catalogue performance; host user Claude skills and Grok commands staged into containers 2026-11-01); left: a credential-free run against real v2.21.0 builds (task 1, the oldest in 0034's support window; pre-#827 builds are outside it) and the login-free check of shared and linked skills in a live container (task 4). The credentialed Claude and Codex pairings and the logged-in Grok and Cursor picker check are on the manual-test checklist. | The remaining items are a mixed-version run against real old builds, now unblocked and narrowed to v2.21.0, and a container staging check; everything shipped is proved live (the container picker lag under host load is tracked as flake 0710). |
