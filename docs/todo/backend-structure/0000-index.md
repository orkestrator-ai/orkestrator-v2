# Backend structure

Refactors of the backend's internal structure: storage repositories, the native agent service, runtime state ownership, domain folders and the Claude bridge prompt stream.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Status** says who can act on the file's open tasks and
**Needs you** names the part only the user can do
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [8324-backend-core-root-groups.md](8324-backend-core-root-groups.md) | Low | backlog | — | What to-do 0012 (retired 2026-11-26, every planned domain moved) left at the `core/` root: which of the remaining groups (`graph-*`, `linear-*`, the host model catalogue, …) become domain folders, and the lint patterns five existing folders lack. | The busiest domains are already enforced; the rest is organisational, though `graph-*` and the five folders keep no boundary. |
| 2 | [7543-effect-adoption-follow-ups.md](7543-effect-adoption-follow-ups.md) | Low | blocked | Waits on: a parked-cancel or prompt-timeout bug recurring in a bridge (task 5). | What the 2026-11-07 Effect review left: the registered error codes, renderer display, backend timing helpers and bridge bounded wait are done (2026-11-10), and the content, media, MCP read and command invoker timeouts now cancel their work (2026-11-11); left is an optional Cursor parked-cancel pilot. | The defects the review found are fixed; the remainder only matters if parked-cancel bugs recur. |
