# Coordinator and Multi Review

The two multi-agent features: the Coordinator (read-only enforcement, async delegation, agent mail) and Multi Review (reviewer panels, consolidation, the flow graph).

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md) | High | No | Opt-in live suite (read-only, async, family, peer) proving read-only enforcement, async delegation and mail wake-ups on every qualified platform; status wakes and mail tiles still to prove. | Status wakes and mail tiles are on by default but unproven live on any platform; Grok has not run (Pi passed all four scenarios on 2026-10-23). |
| 2 | [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md) | High | No | Wider live qualification: more samples, cases and consolidation models; a cache measurement of real same-model reviewer panels; overlap from default two-reviewer panels. Overlap metric, corpus, cache-read capture and a first Claude round are done. Then decide presets, lenses and adaptive stopping. | Compact consolidation is on by default and has been checked on only one model with two samples, and the first measurement suggests the stable reviewer prefix may not be cached on Claude at all. |
| 3 | [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md) | Medium | No | Per-platform decisions and adapter work so the coordinator read-only policy gives the same outcome everywhere. | Read-only coordinator outcomes still differ by platform; it is close to an isolation boundary, so it leads the medium files. |
| 4 | [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md) | Medium | No | Fix the post-SQLite fence-check regression, retire rollback gates and fallbacks, make the benchmark deterministic, collect scale evidence. | Rollback gates, the transcript fallback and scale evidence remain; the earlier regressions are fixed. |
| 5 | [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md) | Medium | No | Smaller coordinator parity gaps (OpenCode/Grok steer, poll guards, conversation limits) and deliberately deferred product surfaces. | One functional gap (auto-closing empty coordinator drafts); the rest is deliberately deferred product surface. |
| 6 | [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md) | Low | No | Flow graph follow-ups: live qualification of provisional findings, and gaps found building them. | Every redesign follow-up is built; only live qualification of provisional findings and minor gaps remain. |
