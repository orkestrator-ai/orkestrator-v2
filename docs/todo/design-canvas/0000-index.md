# Design canvas

The design canvas and its agent tools: the optimisations deferred until a measurement shows their cost.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [8010-design-canvas-deferred-optimisations.md](8010-design-canvas-deferred-optimisations.md) | Low | blocked | Waits on: 7568 (0036 (retired) task 9, whether thumbnails are wanted) and, for the rest, a measurement showing the cost | Thumbnails, a capture cache, a second render worker, a warm context pool and a storage redesign, each gated on a measurement (moved from 0036 task 9 on 2026-11-13). | Nothing measured so far makes a case for any of them; they are kept so nobody builds them speculatively. |
