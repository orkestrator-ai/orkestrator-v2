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
| 1 | [0014-cli-qualification.md](0014-cli-qualification.md) | Medium | blocked | Waits on: 7568 (0014 task 1, the credentialed Pi, Cursor and Grok `live-session` runs) | Pi, Cursor and Grok qualification: the credentialed live runs are on the manual-test checklist; left here is the `PROVIDER_COMPLETION` flip for each provider whose run passes (task 1, waits on 7568). Done 2026-10-25: per-run model record, macOS packaging, config directory and `--profile` checks, OpenCode browser question and approval cards, the foreign-owner Docker decoy scenario, and start-up, failure-time, flake and cleanup measurements. Done 2026-11-01: lost-response recovery for `environment start/stop/recreate/delete --wait` and `exec --wait`, re-run under load (flake 0440 resolved). Done 2026-11-06: fresh credential-free Linux evidence (local 10/10, container 8/8 through the test-only Docker shim on a full address pool, `smoke:cli`). Done 2026-11-11: a live run's manifest records the token usage its backend recorded (task 4; the paid measurement run is on the checklist). Holds the CLI evidence log. | Pi, Cursor and Grok are still unqualified for request-specific completion, so scripts on them cannot use `run wait` as a success signal (a qualification run for secondary providers). |
| 2 | [8105-schedule-list-scheduler-status.md](8105-schedule-list-scheduler-status.md) | Medium | backlog | — | `orkestrator schedule list` carries and prints the scheduler status, so a CLI user on a paused backend is told schedules will not fire (the user's decision of 2026-11-14 on 5160 task 3; no older-version adapter). | A functional gap: the CLI lists schedules as if they will fire on a backend that is not firing them, while Settings already says so. |
