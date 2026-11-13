# Design canvas

The design canvas and its agent tools: cross-version evidence, perf-harness checks and the optimisations deferred until measured.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [8011-design-ask-agent-and-resume-across-versions.md](8011-design-ask-agent-and-resume-across-versions.md) | Low | backlog | — | Ask agent and Resume across the desktop pairing with the published v2.22.3 release, in both directions, on a loopback model (split from 0036 task 6, retired 2026-11-13; the canvas journey passed both ways on 2026-11-13). | Compatibility evidence for two dialogs only: the canvas journey already passed both ways, and the old-backend link fallback is unit-tested. |
| 2 | [7820-design-perf-cdp-frames-transient.md](7820-design-perf-cdp-frames-transient.md) | Low | backlog | — | The client perf harness's 12-cycle leak check failed once on `cdpFrames` reading 10 instead of 9 on two late samples, ending at 9, on a heavily loaded host (found 2026-11-11 while verifying 7440's fix): name the frame, then decide whether the check should tolerate it. | Evidence quality only: one run of nine, every other leak signal converged, and the 2140 growth stays fixed. |
| 3 | [8010-design-canvas-deferred-optimisations.md](8010-design-canvas-deferred-optimisations.md) | Low | blocked | Waits on: 7568 (0036 (retired) task 9, whether thumbnails are wanted) and, for the rest, a measurement showing the cost | Thumbnails, a capture cache, a second render worker, a warm context pool and a storage redesign, each gated on a measurement (moved from 0036 task 9 on 2026-11-13). | Nothing measured so far makes a case for any of them; they are kept so nobody builds them speculatively. |
