# Backend core root groups

## Task analysis

Analysed 2026-11-26 against `main` at `8950e12e2`, with the `commands` move
applied. From to-do 0012 (retired 2026-11-26), whose last step left this.

### Tasks

1. **Decide which remaining `core/` root groups become domain folders**, and move them one domain per pull request. Status: open.
2. **Add the lint patterns five existing folders lack**: `capabilities/`, `credentials/`, `linear-files/`, `push/` and `rich-interactions/`. Status: open.

### 1. Decide which remaining `core/` root groups become domain folders

**Problem.** To-do 0012 moved every prefix group it planned into a
lint-enforced domain folder, but its goal was a `core/` root that holds only
the shared kernel and the composition root. The root still holds 289 source
files and 271 tests, and several of them form groups as large as the domains
that moved: nothing shows or enforces their public surface, so any file can
still import their internals.

**Context.** The procedure, the codemod and the way a folder's surface and
exceptions are chosen are in
[`backend-domain-folders.md`](../../development/backend-domain-folders.md);
the boundary rules are in [`linting.md`](../../development/linting.md)
("Module boundaries"). Thirty-six domain folders exist, each with an
`index.ts`; 31 have both lint patterns (task 2 covers the other five). 0012 settled two placements before it was
retired: `keyed-record-format.ts` and `pi-model-catalog-seeding.ts` stay at
the root (the second beside `pi-catalog-probes.ts` and the
`host-model-catalog-*.ts` files), and `auto-pipeline*.ts` stays at the root.

**Investigation.** Counted on 2026-11-26 (source files without `test` in the
name, by first prefix segment): `graph-*` 58 (with 58 tests), `agent-*` 39,
`host-*` 11, `project-*` 8, `linear-*` 8 (beside the existing `linear-files/`
folder), `claude-*` 8, `worker-*` 7, `backend-*` 7, `validation-*` 6,
`bridge-*` 6, and smaller groups of four or fewer. `graph-*` is one subsystem
(the composable graphs of [`graphs.md`](../../architecture/graphs.md)).
`agent-*` is not one domain: it splits into `agent-tools*` (9),
`agent-branch-*` (6), `agent-mail-*` (3), `agent-provider-*`, `agent-voice-*`,
`agent-sign-*` and single files. `host-*` mixes the host model catalogue,
host maintenance and the suspend detector. No importer or dependency counts
were taken; they go stale within a day, so each slice measures its own.

**Decisions.**

- **How far should the root be split?**
  - **Move the cohesive groups one at a time, largest first: `graph-*`, then `linear-*` (into or beside `linear-files/`) and the host model catalogue (`host-model-catalog-*`, `host-catalog-seeds.ts`, `pi-model-catalog-seeding.ts`, `pi-catalog-probes.ts`) (recommended).**
    - Pros: each is a real subsystem with its own architecture doc or owner, so its `index.ts` is a meaningful surface; the codemod and the exception method are proven; one domain per pull request keeps conflicts small.
    - Cons: the root keeps the mixed groups (`agent-*`, `host-*` maintenance, `backend-*`) for longer.
  - **Declare what is left the shared kernel and stop.**
    - Pros: no churn; the planned domains, the busiest ones, are already enforced.
    - Cons: 289 files is not a kernel; `graph-*` alone is larger than most moved domains and keeps no boundary.
  - **Move every remaining prefix into a folder.**
    - Pros: matches 0012's goal literally.
    - Cons: `agent-*` and `host-*` are not domains; folders named after a word in a file name would group unrelated code and make the boundary meaningless.

### 2. Add the lint patterns five existing folders lack

**Problem.** `capabilities/`, `credentials/`, `linear-files/`, `push/` and
`rich-interactions/` each have an `index.ts`, but neither `.oxlintrc.json`
override has a pattern for them, so a deep import into any of them is not
reported. [`linting.md`](../../development/linting.md) asks every new domain
folder to start with both patterns.

**Context.** They were created outside 0012's waves. To-do 7800 (retired
2026-11-11) did the same for `permission-rules/`, `opencode2/` and
`self-improvement/`, and 0012's task 6 for four earlier folders.

**Investigation.** Found on 2026-11-26 by checking every folder under
`apps/backend/src/core/` for an `index.ts` and a `**/<folder>/*` pattern;
the other 31 folders have both. `capabilities/index.ts` re-exports from
`commands/agent-support.ts`, an exception module of the commands domain. Importers outside each folder were not
counted.

**Decisions.**

- **How to add them?**
  - **One change for the five: point production importers at each `index.ts`, add both patterns, and name an exception wherever routing an importer through `index.ts` closes a runtime cycle (recommended).**
    - Pros: the same procedure and validation as task 6 of 0012 and to-do 7800; no file moves, so little conflict risk.
    - Cons: five folders' exception searches in one review.
  - **One change per folder.**
    - Pros: smaller reviews.
    - Cons: five full validation runs for what is mostly specifier rewrites.

## Constraints and rationale

- Pure moves only: no behaviour, command, contract or persisted-data change,
  and no back-compat shims or re-export stubs at old paths.
- One domain per pull request, merged quickly, because every slice rewrites
  import paths that open branches touch.

## Related

- [`backend-domain-folders.md`](../../development/backend-domain-folders.md):
  the layout, the codemod, the exception method and the type-level cycle
  measurements, with the decisions of 0012's last step.
- To-do 0012 (retired 2026-11-26; read it with
  `git show 8950e12e2:docs/todo/backend-structure/0012-backend-core-domain-folders.md`).
