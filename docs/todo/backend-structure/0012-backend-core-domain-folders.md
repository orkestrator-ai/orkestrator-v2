# Backend core domain folders

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Wave 1 (leaves)**: move `opencode`, `web-annotations`, `http-bridge`, `control-mcp`; give `mcp-management/` and `public-api/` an `index.ts` and lint patterns; place `keyed-record-format.ts`. Status: open.
2. **Wave 2 (mid-tier)**: eleven domains from `plan-usage` to `native-agent`. Status: open.
3. **Wave 3 (hubs)**: `terminals`, `tmux`, `recurring`, `containers`, `environments`, `storage`. Status: open.
4. **Last: `commands`**. Status: open (its prerequisite, 0011, is done).
5. **Record the type-level import cycle**: re-measure and record it here. Status: open.
6. **Folders created since the plan**: `nodes/`, `change-tracking/`, `transcript-artifacts/` and `scheduled-jobs/` exist without an `index.ts` or lint pattern. Status: open (not in the file's list).
7. **Open questions**: where `keyed-record-format.ts` and `pi-model-catalog-seeding.ts` go, and whether `storage` and `native-agent` move before or after their splits. Status: partly done (the 0009/0010 splits have landed).

### 1. Wave 1 (leaves)

**Problem.** `apps/backend/src/core/` is one flat directory whose domains exist only as file-name prefixes, so nothing shows or enforces a domain's public surface. Every backend contributor pays for it when reading or reviewing; the cost grows with every feature.

**Context.** The plan moves low-dependency domains first to prove the codemod procedure. Only `design/` is done (#979, `0466ebd0`), with an `index.ts` and patterns in both `.oxlintrc.json` overrides (`apps/backend/src/**` at line 177, pattern at 188; `tests/unit/**` at 216, pattern at 223).

**Investigation.** Nothing has moved since #979, and the root has grown fast: 521 source files and 446 tests (the file says 378 and 299). Wave 1 prefix counts today: `opencode-*` 41 source / 33 tests (was 29/22), `web-annotation-*` 29/25 (28/22), `http-bridge-*` 18/14 (13/11), `control-mcp-*` 20/9 (2/1). `mcp-management/` (29 source, 27 tests) and `public-api/` (42, 20) still have no `index.ts`. The codemod `scripts/move-backend-modules.ts` and its test `tests/unit/move-backend-modules.test.ts` still exist (last touched for Bun 1.4.4 in #1229). `mise run build:backend` and `mise run verify:packaged-backend` exist in `mise.toml`.

**Decisions.**

- **Is the one-domain-per-PR plan still worth starting, given the root grew by about 40 per cent in twelve days?**
  - **Yes, start with `control-mcp` or `http-bridge` as the procedure proof (recommended).**
    - Pros: the longer it waits the more importers each slice rewrites; a small leaf proves the codemod against today's tree with low conflict risk.
    - Cons: each slice disrupts open branches touching that domain; the benefit is organisational only.
  - **Require new domains to start in a folder and leave existing prefixes alone.**
    - Pros: no churn on existing files; stops the root growing.
    - Cons: the existing 521 files stay flat, so the main goal (a reviewable surface per domain) is not reached.
  - **Retire the plan.**
    - Pros: no disruption.
    - Cons: the root keeps growing with no boundary enforcement; the Medium rating says this is a real readability and risk cost.
- **Do the `index.ts` files for `mcp-management/` and `public-api/` first, before any move?**
  - **Yes (recommended).** They need no file moves, only an `index.ts`, importer rewrites and two lint patterns.
    - Pros: lowest-risk way to exercise steps 3 to 5 of the procedure; no rename conflicts for open branches.
    - Cons: delivers enforcement for only two folders.
  - **Bundle them with the first moved domain.**
    - Pros: one PR.
    - Cons: mixes two kinds of change in the review.

### 2. Wave 2 (mid-tier)

**Problem.** Eleven mid-tier domains stay flat.

**Context.** `plan-usage`, `features`, `coordinator`, `agent-accounts`, `worktrees`, `previews`, `git`, `workflows`, `review`, `build-pipeline`, `native-agent`.

**Investigation.** Prefix counts today (source / tests): `coordinator-*` 11/10, `agent-accounts*` 10/10, `preview-*` 8/9, `git-*` 4/2, `github*` 12/6, `pr-*` 3/4, `workflow-*` 11/9, review prefixes (`multi-review-*`, `review-*`, `looped-review-*`) 34/35, `build-pipeline-*` 25/21, `native-agent-*` 39/59. `native-agent-service.ts` (4,276 lines) and `native-agent-transcript-projection.ts` (5,589) are the subject of the open size todo [0057](0057-native-agent-service-size.md).

**Decisions.**

- **Should `native-agent` move before or after 0057's splits?**
  - **After 0057 (recommended).**
    - Pros: moves the files once, under their final names; avoids a rename colliding with a large split diff.
    - Cons: the busiest domain stays flat for as long as 0057 is unscheduled.
  - **Before 0057.**
    - Pros: the new collaborators are created inside the folder from the start.
    - Cons: every open native-agent branch rebases twice.

### 3. Wave 3 (hubs)

**Problem.** The hub domains are imported by many files, some from outside `core/`, so their slices touch the most files.

**Context.** `terminals`, `tmux`, `recurring`, `containers`, `environments`, `storage`.

**Investigation.** Counts today: `terminal-*` 2/2 and `transcript-*` 1/2, `tmux*` 11/3, `recurring-*` 4/2, `container-*` 23/11 and `docker-*` 7/2, `environment-*` 12/9, `storage*` 36/38. The storage repositories now exist (0009 and 0163 merged), so the `storage` slice can be done once, but two storage files are still to be split ([0214](0214-storage-files-over-size-limit.md)), and the tmux module state is still to move into the runtime ([0133](0133-backend-module-state-beyond-0066.md)).

**Decisions.**

- **Should `storage` and `tmux` wait for 0214 and 0133?**
  - **Yes, sequence each slice after its refactor (recommended).**
    - Pros: same reasoning as `native-agent`: move files once.
    - Cons: both refactors are rated Low and may not be scheduled soon.
  - **Move them in wave order regardless.**
    - Pros: the wave plan stays independent of other todos.
    - Cons: the later refactors land in moved files, so the rename and the split both conflict with in-flight work.

### 4. Last: `commands`

**Problem.** `commands*` is the largest prefix group and depends on most other domains.

**Context.** The file required 0011 to land first.

**Investigation.** 0011 merged (`8290f2ca`, #1209); `commands-runtime-state.ts` is gone and its state is in `BackendRuntime`. `commands*` is now 61 source files and 46 tests (was 51/35).

**Decisions.**

- **Keep `commands` last?**
  - **Yes (recommended).**
    - Pros: its `index.ts` can then import every other domain through its own `index.ts`, so the slice is mostly specifier rewrites.
    - Cons: the largest group stays flat the longest.
  - **Split `commands` by domain instead (for example `commands-registry-native.ts` into `native-agent/`).**
    - Pros: registry handlers sit beside their domain, which is where readers look.
    - Cons: no longer a pure move; it changes how the command registry is assembled, outside this file's "pure moves" rule.

### 5. Record the type-level import cycle

**Problem.** The file asks for a re-measured type-level cycle across `core/` (112 files on 2026-10-14) recorded here.

**Context.** Runtime cycles are already blocked by `import/no-cycle` and `tests/unit/module-import-cycles.test.ts`, whose `KNOWN_CYCLES` is empty (`:39`).

**Investigation.** No script in the repository computes the type-level cycle; the 2026-10-14 number was measured ad hoc. No newer measurement is recorded.

**Decisions.**

- **How to measure it?**
  - **A one-off measurement recorded here at the start of wave 1, repeated at the end (recommended).**
    - Pros: gives a baseline and a result for the plan; no tooling to maintain.
    - Cons: the method lives in prose.
  - **Extend `module-import-cycles.test.ts` to report type-only cycles too.**
    - Pros: repeatable and visible in CI.
    - Cons: the file says the number is not expected to reach zero, so a test would need a moving threshold; more test machinery for a measurement.

### 6. Folders created since the plan

**Problem.** Four domain folders were created after this file was written, none with an `index.ts` or lint pattern: `nodes/` (26 source, 21 tests; from #1127 onwards), `change-tracking/` (27, 14; #1107), `transcript-artifacts/` (57, 34; #1103) and `scheduled-jobs/` (6, 2). Production files outside each folder import their internals directly.

**Context.** The file lists only `mcp-management/` and `public-api/` as unenforced folders. Under the README, new work goes into a new numbered file, but bringing these under the same procedure is arguably a correction of the "Current state" scope.

**Investigation.** A grep of production importers outside each folder finds roughly 10 for `nodes/`, 8 for `change-tracking/`, 8 for `scheduled-jobs/` and 4 for `transcript-artifacts/`. Each would get an `index.ts` and the two patterns, the same as `mcp-management/`.

**Decisions.**

- **Where to track them?**
  - **Treat them as part of wave 1's `index.ts` step, recording that correction in this file (recommended).**
    - Pros: the same procedure and validation as `mcp-management/` and `public-api/`; no moves needed.
    - Cons: stretches the README's "never add new todos" rule; an argument for a new file instead.
  - **A new numbered todo for the four folders.**
    - Pros: follows the README rule exactly.
    - Cons: splits one procedure across two files.
- **Should new domains be required to start with an `index.ts`?**
  - **Yes, as a line in `docs/development/linting.md` "Module boundaries" (recommended).**
    - Pros: stops the list of unenforced folders growing while the waves run.
    - Cons: a rule in prose, not enforced until a lint pattern is added.
  - **No rule.**
    - Pros: no process change.
    - Cons: the four folders above show folders keep being created without one.

### 7. Open questions

**Problem.** Three placements are undecided.

**Context.** Listed under "Open questions".

**Investigation.** `keyed-record-format.ts` is no longer imported only by `build-pipeline-transcript-*`: `transcript-artifacts/store.ts` imports it too, alongside `build-pipeline-transcript-store.ts` and `build-pipeline-transcript-legacy-manifests.ts`. `pi-model-catalog-seeding.ts` now sits beside `pi-catalog-probes.ts` (from 0066, owned by `runtime.localServers.piCatalog`). The third question is settled: the 0009 and 0010 inheritance splits merged (#1276, #1180), so `storage` and `native-agent` are no longer about to be rewritten by those, though 0214 and 0057 are follow-ups (see tasks 2 and 3).

**Decisions.**

- **Where does `keyed-record-format.ts` go?**
  - **The shared kernel at the `core/` root (recommended).**
    - Pros: it now has importers in two domains, which is what the kernel is for.
    - Cons: one more root file.
  - **`build-pipeline/`, exported from its `index.ts`.**
    - Pros: the file's original suggestion.
    - Cons: `transcript-artifacts/` would then depend on `build-pipeline/` for a format helper.
- **Where does `pi-model-catalog-seeding.ts` go?**
  - **With `pi-catalog-probes.ts`, in whichever domain owns the model catalogues when it is touched (recommended).**
    - Pros: keeps the two Pi catalogue files together; defers a choice nothing yet forces.
    - Cons: stays unplaced for now.
  - **The kernel now.**
    - Pros: settles it.
    - Cons: the kernel should hold shared primitives, not one provider's catalogue code.

`apps/backend/src/core/` holds several hundred source files in one directory,
and its domains exist only as file-name prefixes (`opencode-*`,
`web-annotation-*`, …). Nothing shows or enforces what a domain offers the
rest of the backend: any file can import any other file's internals. The goal
is one folder per domain with an explicit `index.ts`, enforced by
`no-restricted-imports`, so each domain's public surface is reviewable in one
file and a deep import is a lint error. The shared kernel stays at the root.

## Current state

- Done: `core/design/` (22 source files, 12 tests) with an `index.ts` that
  exports `DesignService`, `createDesignMcp`, `registerDesignCommandHandlers`
  and `resolveDesignDestination` (#979).
- Folders without an `index.ts` or a lint pattern: `core/mcp-management/`
  (19 source files, 18 tests) and `core/public-api/` (27 source files, 6
  tests).
- The `core/` root holds 378 non-test `.ts` files and 299 tests.
- Prefix counts at the root:

  | Domain | Prefixes | Source | Tests |
  | --- | --- | ---: | ---: |
  | opencode | `opencode-*` | 29 | 22 |
  | web-annotations | `web-annotation-*` | 28 | 22 |
  | http-bridge | `http-bridge-*` | 13 | 11 |
  | control-mcp | `control-mcp-*` | 2 | 1 |
  | keyed-records | `keyed-record-*` | 1 | 0 |
  | plan-usage | `plan-usage*` | 2 | 2 |
  | features | `feature-*` | 3 | 3 |
  | coordinator | `coordinator-*` | 7 | 5 |
  | agent-accounts | `agent-accounts*` | 7 | 7 |
  | worktrees | `worktree-*` | 6 | 4 |
  | previews | `preview-*` | 7 | 5 |
  | git | `git-*`, `github*`, `pr-*` | 11 | 8 |
  | workflows | `workflow-*` | 9 | 7 |
  | review | `multi-review-*`, `review-*`, `looped-review-*` | 26 | 26 |
  | build-pipeline | `build-pipeline-*` | 23 | 16 |
  | native-agent | `native-agent-*` | 30 | 40 |
  | terminals | `terminal-*`, `transcript-*` | 3 | 3 |
  | tmux | `tmux*` | 10 | 0 |
  | recurring | `recurring-*` | 4 | 2 |
  | containers | `container-*`, `docker-*` | 18 | 4 |
  | environments | `environment-*` | 11 | 9 |
  | storage | `storage*` | 25 | 30 |
  | commands | `commands*` | 51 | 35 |
  | (unplaced) | `pi-model-catalog-seeding.ts` | 1 | 1 |

  These are file counts only. Importer and dependency counts go stale within a
  day, so each slice re-measures them (step 1 below).
- `keyed-record-*` is now one file, `keyed-record-format.ts`: the keyed-record
  engine went with #969. Its only importers are `build-pipeline-transcript-*`
  files.
- Codemod: `bun scripts/move-backend-modules.ts --prefix <prefix> --into
  <folder> [--dry-run]`, or `--map <file.json>`, tested by
  `tests/unit/move-backend-modules.test.ts`. It moves the files, drops the
  prefix, rewrites relative specifiers (including `import()`, `require()` and
  `mock.module()`) and path strings in tracked text files, stages every move in
  one `git add`, and runs `bun fmt` on what it touched. It does not rewrite bare
  file names in prose.
- Lint: each domain has a pattern in two `.oxlintrc.json` overrides. The
  `apps/backend/src/**` override comes before the tests-off override (so
  co-located tests and test-support files may reach internals) and repeats the
  global `@orkestrator/protocol/testing/*` pattern. A later `tests/unit/**`
  override restricts deep imports again, using the
  `**/backend/src/core/<domain>/*` form so it does not catch renderer paths
  such as `@/components/design/*`.

## Outstanding work

### Code

Order: move the domains few others depend on first, so the procedure is proven
before the busy ones move.

1. **Wave 1 (leaves):** `opencode`, `web-annotations`, `http-bridge`,
   `control-mcp`. Add an `index.ts` and both lint patterns to
   `mcp-management/` and `public-api/`. Place `keyed-record-format.ts` rather
   than giving it a folder (see "Open questions").
2. **Wave 2 (mid-tier):** `plan-usage`, `features`, `coordinator`,
   `agent-accounts`, `worktrees`, `previews`, `git`, `workflows`, `review`,
   `build-pipeline`, `native-agent`.
3. **Wave 3 (hubs):** `terminals`, `tmux`, `recurring`, `containers`,
   `environments`, `storage`. Many files import these, and `containers` and
   `previews` are also imported from outside `core/`, so these slices touch the
   most files.
4. **Last: `commands`.** It depends on most other domains. Its former
   `commands-runtime-state.ts` was deleted by
   [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md);
   the state now lives in `BackendRuntime` (`backend-runtime.ts`,
   `terminal-runtime.ts`, `local-server-runtime.ts`,
   `environment-operations.ts`).
5. **Record the type-level import cycle.** Re-measure the type-level cycle
   across `core/` (112 files on 2026-10-14) and record it here. It is not
   expected to reach zero, but cross-domain type cycles should run through
   `index.ts` files, where they are visible. Runtime cycles are already
   blocked by `import/no-cycle` and `tests/unit/module-import-cycles.test.ts`.

Procedure for one slice, one domain per PR, pure moves only (no behaviour
change, no edits beyond paths, the new `index.ts` and the lint patterns):

1. **Measure.** List the domain's files, its importers outside the domain and
   the symbols they use. That symbol list is the `index.ts`.
2. **Move with the codemod** from a clean tree, `--dry-run` first. If a run
   fails midway, reset with `git reset -q && git checkout -- . && rm -rf <new
   folder>` and run it again.
3. **Write `index.ts`** with explicit named re-exports only
   (`export { X } from "./x.js"`, never `export *`). Point production
   importers outside the folder at `<domain>/index.js`. White-box tests and
   test support outside the folder may keep deep imports where they use
   internals no other domain needs.
4. **Add the pattern** to both lint overrides.
5. **Validate** with `mise run format:check`, `mise run lint`,
   `mise run typecheck`, `mise run test`, `mise run build:backend` and
   `mise run verify:packaged-backend`. The last two catch a bundled entry point
   or worker that names a moved file.
6. **Merge quickly** and announce it, so open branches rebase promptly.

Done when:

- every domain above is a folder with an explicit `index.ts` and an
  enforcement pattern, and `mise run lint` is clean;
- the `core/` root holds only the shared kernel and `index.ts` (the backend
  composition root);
- the type-level cycle has been re-measured and recorded.

## Constraints and rationale

Things a move can break:

- `mock.module()` paths and `spyOn(namespace, …)` targets in tests;
- source files read as text by tests or scripts (for example
  `scripts/efficiency/workloads-transcripts.ts` loads bridge modules by path);
- worker and bundle entry points in `apps/backend/scripts/build.ts`, and worker
  sources that embed a function body with `.toString()` (such as
  `review-validation-worker.ts`);
- relative specifiers that leave the package (`../../../…`), which gain a level
  when a file moves one directory deeper;
- bare file names in prose in living docs and source comments, which the
  codemod does not rewrite.

Rules that keep slices safe:

- Keep each slice to pure moves and import rewrites. Git's rename detection
  carries most in-flight edits across a pure rename; if a rebase misses one,
  retry with `-X find-renames=40%`.
- Prefer quiet windows: move a domain while nobody has an open branch in it.
- Co-located tests may reach domain internals; `tests/unit/**` may not.
- Shared-kernel files (`shell.ts`, `constants.ts`, `models.ts`,
  `path-safety.ts`, …) stay at the `core/` root. Do not create `core/shared/`
  or `core/utils/`; it would become the next catch-all module.
- Inside a folder, drop the domain prefix from file names
  (`design/service.ts`, not `design/design-service.ts`).
- `no-restricted-imports` overrides replace one another rather than merging, so
  the backend override must keep repeating the global protocol-testing pattern
  (see `linting.md` "Module boundaries").

## Open questions

- Where `keyed-record-format.ts` goes. Its only importers are
  `build-pipeline-transcript-*`, so moving it with the `build-pipeline` slice
  looks right; the alternative is the shared kernel.
- Where `pi-model-catalog-seeding.ts` belongs: next to the native-agent model
  catalogue code, or the kernel. Decide when it is touched.
- Whether `storage` and `native-agent` should move before or after their
  inheritance chains are split
  ([0009-storage-service-repositories.md](0009-storage-service-repositories.md),
  [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md)).
  Splitting first avoids moving files that are about to be rewritten.

## Related

- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md),
  which must land before the `commands` slice.
- [0009-storage-service-repositories.md](0009-storage-service-repositories.md) and
  [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md).
- [`linting.md`](../../development/linting.md) ("Module boundaries").

## Replaces

- `docs/2026-10-14/core-domain-folders.md`
