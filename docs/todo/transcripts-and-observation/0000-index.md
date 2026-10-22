# Transcripts, observation and bandwidth

How sessions are read and kept fresh: rich transcripts, history efficiency, idle observation, recurring work, reconnects and remote bandwidth.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md) | High | No | Fix recurring-work instrumentation, collect live freshness and cost evidence against the latency budgets, decide measured candidates, then remove the rollback drivers. | Recurring work is on by default but its live freshness and cost evidence (isolated profile, PR monitoring, `fs.watch`, real-browser QA) is still owed. |
| 2 | [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md) | High | No | Event coverage that lets idle Claude, Codex and HTTP-bridge sessions back off, and shared reads across views. | Idle backoff is unproven live per provider; a missed final event can leave a session looking busy or stale. |
| 3 | [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md) | Medium | No | Remaining whole-transcript reads (build-stage supervision, Claude cold hydration), frontend history structure, measurement gaps, live qualification. | Remaining whole-transcript reads and Codex row-boundary gaps cost reads on every run; the most open work in the folder. |
| 4 | [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md) | Medium | No | Jittered reconnect for the remaining transports; visible stale, degraded and disconnected state in event-led views. | Event-led views do not yet show stale or disconnected state, and some transports still reconnect without jitter. |
| 5 | [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md) | Medium | No | Measure remote traffic through the supported proxy before changing compression or terminal transport defaults; decide the client-local data-saving mode. | A measurement gap: compression and terminal transport defaults must not change until the remote baseline exists. |
| 6 | [0053-rich-transcripts.md](0053-rich-transcripts.md) | Medium | No | Implementation status of the rich-transcript specification and its real-stack evidence; the one item left is publishing the preview worker image. | Shipped and qualified on all six providers; the one item left is release plumbing a maintainer has to run. |
