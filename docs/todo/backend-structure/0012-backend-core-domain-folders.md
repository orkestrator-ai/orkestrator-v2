# Backend core domain folders

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; tasks 1 and 6 re-checked 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Wave 1 (leaves)**: move `opencode`, `web-annotations`, `http-bridge`, `control-mcp`; give `mcp-management/` and `public-api/` an `index.ts` and lint patterns; place `keyed-record-format.ts`. Status: partly done: the `index.ts` step for `mcp-management/` and `public-api/` is done (2026-11-03), the `http-bridge` move is done (2026-11-06, the procedure proof) and the `web-annotations` move is done (2026-11-11; see "Assumptions and decisions"); the `opencode` and `control-mcp` moves and placing `keyed-record-format.ts` are open, one domain per change.
2. **Wave 2 (mid-tier)**: eleven domains from `plan-usage` to `native-agent`. Status: open.
3. **Wave 3 (hubs)**: `terminals`, `tmux`, `recurring`, `containers`, `environments`, `storage`. Status: open.
4. **Last: `commands`**. Status: open (its prerequisite, 0011, is done).
5. **Record the type-level import cycle**: re-measure and record it here. Status: done for the baseline (2026-10-28, see "Current state"); re-measure when the waves finish.
6. **Folders created since the plan**: `nodes/`, `change-tracking/`, `transcript-artifacts/` and `scheduled-jobs/` exist without an `index.ts` or lint pattern. Status: done (2026-10-28): each has an `index.ts` and both lint patterns, production importers go through it, and `linting.md` asks new domain folders to start with one. Three more folders without one (`permission-rules/`, `opencode2/`, `self-improvement/`) were found on 2026-11-11 and are tracked in [7800](7800-domain-folders-without-index.md).
7. **Open questions**: where `keyed-record-format.ts` and `pi-model-catalog-seeding.ts` go, and whether `storage` and `native-agent` move before or after their splits. Status: partly done (the 0009/0010 splits have landed).

### 1. Wave 1 (leaves)

**Problem.** `apps/backend/src/core/` is one flat directory whose domains exist only as file-name prefixes, so nothing shows or enforces a domain's public surface. Every backend contributor pays for it when reading or reviewing; the cost grows with every feature.

**Context.** The plan moves low-dependency domains first to prove the codemod procedure. Only `design/` is done (#979, `0466ebd0`), with an `index.ts` and patterns in both `.oxlintrc.json` overrides (`apps/backend/src/**` at line 177, pattern at 188; `tests/unit/**` at 216, pattern at 223).

**Investigation.** Nothing has moved since #979, and the root has grown fast: 521 source files and 446 tests (the file says 378 and 299). Wave 1 prefix counts today: `opencode-*` 41 source / 33 tests (was 29/22), `web-annotation-*` 29/25 (28/22), `http-bridge-*` 18/14 (13/11), `control-mcp-*` 20/9 (2/1). `mcp-management/` (29 source, 27 tests) and `public-api/` (42, 20) still have no `index.ts`. The codemod `scripts/move-backend-modules.ts` and its test `tests/unit/move-backend-modules.test.ts` still exist (last touched for Bun 1.4.4 in #1229). `mise run build:backend` and `mise run verify:packaged-backend` exist in `mise.toml`. Re-measured 2026-11-11 on `14df96544`: `opencode-*` 55 source / 53 tests, `control-mcp-*` 39/27, and `web-annotation-*` 29/27 before its move. `core/opencode2/` (36/43, #2009) now sits beside the `opencode-*` files, with four `opencode2-*.ts` files still at the root, so the `opencode` slice also has to decide where those four files go.

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

**Investigation.** Counts today: `terminal-*` 2/2 and `transcript-*` 1/2, `tmux*` 11/3, `recurring-*` 4/2, `container-*` 23/11 and `docker-*` 7/2, `environment-*` 12/9, `storage*` 36/38. The storage repositories now exist (0009 and 0163 merged) and the over-limit storage files are split (todo 0214, retired on 2026-10-29; see [`storage.md`](../../architecture/storage.md#code-layout)), so the `storage` slice can be done once, and the tmux module state has since moved into the runtime (`runtime.tmux`, see [`backend-runtime.md`](../../architecture/backend-runtime.md)).

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

**Context.** Runtime cycles are already blocked by oxlint's `import/no-cycle` rule (`.oxlintrc.json`, set to `error`; type-only imports are exempt). It is the only runtime-cycle guard: `tests/unit/module-import-cycles.test.ts`, which duplicated it with an empty `KNOWN_CYCLES`, was removed on 2026-11-10.

**Investigation.** No script in the repository computes the type-level cycle; the 2026-10-14 number was measured ad hoc. No newer measurement is recorded.

**Decisions.**

- **How to measure it?**
  - **A one-off measurement recorded here at the start of wave 1, repeated at the end (recommended).**
    - Pros: gives a baseline and a result for the plan; no tooling to maintain.
    - Cons: the method lives in prose.
  - **Add a type-only cycle report to the guard stage (`scripts/guards.ts`), beside `import/no-cycle`.**
    - Pros: repeatable and visible in CI; `import/no-cycle` cannot do it, because it exempts type-only imports by design.
    - Cons: the file says the number is not expected to reach zero, so a guard would need a moving threshold; more machinery for a measurement.

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
- Done (task 6, 2026-10-28): `core/nodes/`, `core/change-tracking/`,
  `core/transcript-artifacts/` and `core/scheduled-jobs/` each have an
  `index.ts` and both lint patterns, and production importers outside each
  folder go through it. Six leaf modules are named exceptions in the
  `apps/backend/src/**` pattern, because routing them through `index.ts` would
  close a runtime import cycle: `nodes/node-store-format.ts`,
  `change-tracking/ledger-schema.ts`, `transcript-artifacts/store-layout.ts`
  and `scheduled-jobs/layout.ts` and `store.ts` (imported by the storage
  layer), and `scheduled-jobs/tools.ts` (imported by `agent-tools.ts` and
  `control-mcp-coordinator-tools.ts`). See "Assumptions and decisions".
- Done (task 1's `index.ts` step, 2026-11-03): `core/mcp-management/` and
  `core/public-api/` each have an `index.ts` and both lint patterns, and
  production importers outside each folder go through it. Six leaf modules of
  `public-api/` are named exceptions in the `apps/backend/src/**` pattern,
  because `public-api/index.ts` reaches most of the backend through
  `registry.js`: `attention-cursor.js`, `dispatch.js`, `errors.js`,
  `exec-control.js`, `operation-ledger.js` and `revisions.js`.
  `mcp-management/` needs none. That left no domain folder without an
  `index.ts` at the time except `permission-rules/` (2026-10-27), which was
  missed; it and the later `opencode2/` and `self-improvement/` are tracked in
  [7800](7800-domain-folders-without-index.md).
- Done (task 1's `http-bridge` slice, 2026-11-06, against `main` at
  `c1724ab7`): the 20 `http-bridge-*` source files and their 20 tests are in
  `core/http-bridge/` without the prefix (`http-bridge/provider.ts`,
  `http-bridge/transport.ts`, …), with an `index.ts` and both lint
  patterns. `index.ts` re-exports the six symbols the seven production
  importers outside the folder use (`HttpBridgeProvider`, `boundedJson`,
  `bridgeFetch`, `openCodeSdkFetch` and the types `HttpBridgeAgent` and
  `HttpBridgeProviderDependencies`), and all seven import it. No named
  exceptions were needed: routing them through `index.ts` closes no runtime
  cycle.
- Done (task 1's `web-annotations` slice, 2026-11-11, against `main` at
  `14df96544`): the 29 `web-annotation-*` source files (test helpers and
  support included) and their 27 tests are in `core/web-annotations/`
  without the prefix (`web-annotations/service.ts`,
  `web-annotations/storage.ts`, …), with an `index.ts` and both lint
  patterns. `index.ts` re-exports the 23 symbols the six production importers
  outside the folder use. Two leaf modules are named exceptions in the
  `apps/backend/src/**` pattern, because routing their importer through
  `index.ts` would close a runtime import cycle: `store-layout.js`
  (imported by `storage-stores.ts`) and `tools.js` (imported by
  `agent-tools.ts`). See "Assumptions and decisions".
- Type-level import cycle (task 5, measured 2026-10-28 on `79f3bc97`): the
  largest strongly connected component of `core/` holds **292 files** (244 at
  the root, 32 in `public-api/`, 6 in `nodes/`, 4 in `change-tracking/`, 3 in
  `scheduled-jobs/`, 2 in `transcript-artifacts/`, 1 in `permission-rules/`),
  plus four small components of 5, 5, 4 and 2 files (308 files in cycles out
  of 754). With task 6's `index.ts` files the largest component is **300
  files** (316 in cycles out of 758): the four `index.ts` files join it, and a
  type import through an `index.ts` now reaches every module that file
  re-exports, which pulls in four more domain files. That is the intended
  trade: cross-domain type edges run through `index.ts`, where they are
  visible. Method: every non-test `.ts` file under `apps/backend/src/core/`
  (excluding `*test-support*`, `*test-helpers*`, `*test-harness*` and
  `fixtures/`); an edge for every relative `import … from`/`export … from`,
  value or `type`, and every `import("…")` type expression; Tarjan's strongly
  connected components; count the components larger than one file. Without
  the `import("…")` edges the largest component is 289 (base) and 297 (with
  task 6). The 2026-10-14 figure of 112 files used an unrecorded method and is
  not comparable.
- The `core/` root holds 378 non-test `.ts` files and 299 tests (the
  2026-10-15 count; after the `http-bridge` slice on 2026-11-06 it holds 827
  and 842, and after the `web-annotations` slice on 2026-11-11 it holds 883
  and 925).
- Prefix counts at the root:

  | Domain | Prefixes | Source | Tests |
  | --- | --- | ---: | ---: |
  | opencode | `opencode-*` | 29 | 22 |
  | web-annotations | `web-annotation-*` | done (29 / 27 moved, 2026-11-11) | |
  | http-bridge | `http-bridge-*` | done (20 / 20 moved, 2026-11-06) | |
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
  file names in prose, and since 2026-11-11 (todo 7490, retired) it leaves a
  path that follows a Git revision and a colon (`git show 0d254a3a^:apps/…`,
  `` `ff4026b4e^:apps/…:72-110` ``) under its old name, because at that
  revision the file had it. A revision here is a hex SHA of 7 to 40
  characters, `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `main`, `master`, an
  `origin/` or `upstream/` name, a `refs/` name or a `vX.Y.Z` tag, each with
  any `^`/`~` steps; a path after any other `word:` is rewritten.
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

1. **Wave 1 (leaves):** `opencode`, `control-mcp`.
   (Done: an `index.ts` and both lint patterns for `mcp-management/` and
   `public-api/`; the `http-bridge` and `web-annotations` moves.) Place `keyed-record-format.ts` rather
   than giving it a folder (see "Open questions").
2. **Wave 2 (mid-tier):** `plan-usage`, `features`, `coordinator`,
   `agent-accounts`, `worktrees`, `previews`, `git`, `workflows`, `review`,
   `build-pipeline`, `native-agent`.
3. **Wave 3 (hubs):** `terminals`, `tmux`, `recurring`, `containers`,
   `environments`, `storage`. Many files import these, and `containers` and
   `previews` are also imported from outside `core/`, so these slices touch the
   most files.
4. **Last: `commands`.** It depends on most other domains. Its former
   `commands-runtime-state.ts` was deleted by todo 0011;
   the state now lives in `BackendRuntime` (`backend-runtime.ts`,
   `terminal-runtime.ts`, `local-server-runtime.ts`,
   `environment-operations.ts`).
5. **Record the type-level import cycle.** Re-measure the type-level cycle
   across `core/` (112 files on 2026-10-14) and record it here. Baseline
   recorded 2026-10-28 in "Current state" (292 files; 300 with task 6's
   `index.ts` files); measure again with the same method when the waves
   finish. It is not
   expected to reach zero, but cross-domain type cycles should run through
   `index.ts` files, where they are visible. Runtime cycles are already
   blocked by `import/no-cycle` (`.oxlintrc.json`), the only runtime-cycle
   guard.

Procedure for one slice, one domain per PR, pure moves only (no behaviour
change, no edits beyond paths, the new `index.ts` and the lint patterns):

1. **Measure.** List the domain's files, its importers outside the domain and
   the symbols they use. That symbol list is the `index.ts`.
2. **Move with the codemod** from a clean tree, `--dry-run` first. If a run
   fails midway, reset with `git reset -q && git checkout -- . && rm -rf <new
   folder>` and run it again. Then fix by hand what it gets wrong or leaves
   alone:
   - it leaves paths that name a historical commit
     (`` `<sha>^:apps/backend/src/core/<old>.ts` `` in test comments and
     `git show <sha>:…` commands in flake records) alone, but only for the
     revision forms listed under "Current state"; grep the diff for `:apps/`
     and revert any other revision spelling it rewrote;
   - it does not rewrite bare file names (`` `http-bridge-provider.ts` ``) in
     source comments, living docs, `AGENTS.md` globs, or file-name lists that
     tests read by path (`agent-provider-boundaries.test.ts`). Grep for the old
     prefix afterwards; leave dated reports and flake records as they are.
3. **Write `index.ts`** with explicit named re-exports only
   (`export { X } from "./x.js"`, never `export *`). Point production
   importers outside the folder at `<domain>/index.js`. White-box tests and
   test support outside the folder may keep deep imports where they use
   internals no other domain needs.
4. **Add the pattern** to both lint overrides.
5. **Validate** with `mise run format:check`, `mise run lint`,
   `mise run typecheck`, `mise run test`, `mise run build:backend` and
   `mise run verify:packaged-backend`. The last two catch a bundled entry point
   or worker that names a moved file. `verify:packaged-backend` reads a
   packaged app under `release/`, so it needs the packaging build first; it is
   not a quick per-slice check. Run backend tests with `NODE_ENV=test` in a
   shell that sets `NODE_ENV=production`
   (`host-model-catalog-refresh.test.ts` fails otherwise).
6. **Merge quickly** and announce it, so open branches rebase promptly.

Done when:

- every domain above is a folder with an explicit `index.ts` and an
  enforcement pattern, and `mise run lint` is clean;
- the `core/` root holds only the shared kernel and `index.ts` (the backend
  composition root);
- the type-level cycle has been re-measured and recorded.

## Assumptions and decisions

Decisions taken while doing tasks 5 and 6 (2026-10-28), task 1's
`index.ts` step (2026-11-03), task 1's `http-bridge` slice (2026-11-06) and
task 1's `web-annotations` slice with the codemod fix from todo 7490
(2026-11-11). The moves in waves 1 to 4 (tasks 1 to 4) were
left open on purpose: they move many files that other work in flight touches.

### Task 1: `web-annotations` as the next slice

- Chosen: one domain, `web-annotations`, moved with the codemod
  (`--prefix web-annotation- --into web-annotations`) against `main` at
  `14df96544`. Of the three wave 1 moves left it is the smallest (29 source,
  27 tests, against 55/53 for `opencode-*` and 39/27 for `control-mcp-*`), no
  open pull request touched it (three were open, none in these files), and
  `opencode` has the unsettled `opencode2/` layout (see task 1).
  `commands-registry-web-annotations.ts` stays at the root: it is a
  `commands-*` file and moves with the `commands` slice.
- Measured before the move: importers outside the folder were 6 production
  files in `apps/backend/src/core/` (`agent-tools.ts`, `commands-context.ts`,
  `commands-registry-terminal.ts`, `commands-registry-web-annotations.ts`,
  `index.ts`, `storage-stores.ts`) using 23 symbols from 12 modules; 2
  co-located tests at the root (`commands-registry-web-annotations.test.ts`,
  `mcp-tool-schema-portability.test.ts`); `scripts/web-annotation-commit-profile.ts`
  (test support); `tests/source-guards/baseline.json` (two keys); and path
  strings in a protocol comment, `docs/architecture/web-page-annotations.md`,
  four to-do files and three flake records. The codemod moved 56 files and
  rewrote 68. No `<revision>:<path>` string named a moved file, so the 7490
  fix had nothing to skip in this slice; it is covered by its fixture test.
- `index.ts` holds exactly the 23 production symbols. All six production
  importers use it except the two exception sites below; co-located tests and
  the profile script keep deep imports (procedure step 3).
- Named exceptions: `store-layout.js` and `tools.js`. Routing all six
  importers through `index.ts` added `import/no-cycle` errors: `index.ts`
  reaches `storage-stores.ts` through `service.ts`, `context.ts` and
  `storage.ts`, and reaches `agent-tools.ts` through `dispatch.ts`,
  `native-agent-service-shared.ts`, `native-agent-provider.ts`,
  `opencode-provider.ts` and `opencode-provider-helpers.ts` (found with a
  throwaway value-import reachability script). Neither leaf module reaches
  its importer. Options were the same as task 6's (exceptions in the pattern,
  disable comments at each site, or breaking the cycle by moving code);
  chosen the exceptions, as task 6 and the `public-api/` step did, because a
  code move is outside this file's "pure moves" rule. `agent-tools.ts` still
  takes the type `WebAnnotationToolHost` from `index.ts` with `import type`,
  which adds no runtime edge. Both modules are still re-exported from
  `index.ts` (the `public-api/` choice: `index.ts` stays the complete list),
  and its header names them and why.
- Hand fixes after the codemod: bare file names in the moved files' own
  comments (`web-annotation-service-store.ts` → `service-store.ts`, and the
  `-threads.ts` shorthand in `context.ts` written out), a comment in
  `apps/web/src/stores/conversationScrollTargetStore.ts`, five short names in
  `docs/architecture/web-page-annotations.md`, five to-do files (0057,
  7543, 0078, 5800, 6140) and `plans/unified/7014-remaining-zod-to-effect-schema.md`,
  and the folder list in `docs/development/linting.md` ("Module
  boundaries"), which also lacked `http-bridge/`. Flake records keep the path
  rewrites the codemod made and their bare names, as in the earlier slices.
- Lint patterns: `**/web-annotations/*` with `!**/web-annotations/index.js`
  and the two exceptions under `apps/backend/src/**`, and the
  `**/backend/src/core/web-annotations/*` form under `tests/unit/**`. No
  backend or `tests/unit` import path has another `web-annotations/` segment
  (the protocol's `@orkestrator/protocol/web-annotations*` modules are single
  segments; `apps/web/src/lib/web-annotations/` is outside both overrides).
  Checked with probe files (deleted): a deep import is reported under both
  overrides; `index.js` is not; the two exceptions are not reported under
  `apps/backend/src/**` and are under `tests/unit/**`; the protocol imports
  are not.
- Validation run here: `bunx oxlint apps/backend tests/unit scripts` (no
  errors), backend typecheck, `mise run guards`, the moved tests plus the
  importers' tests (`bun test --preload ../../tests/setup-node.ts
  ./src/core/web-annotations …`, 415 pass across 30 files) and
  `mise run build:backend`. The full suite and `verify:packaged-backend` run
  in the pipeline's validation stage.

### Task 1: the codemod skips `<revision>:<path>` strings (todo 7490)

- Chosen: 7490's recommended option, a negative look-behind for a revision
  token and a colon (plus any leading directories of the path) before each
  path-string match in `scripts/move-backend-modules.ts`, with a fixture
  case in `tests/unit/move-backend-modules.test.ts`. The test was confirmed to
  fail on the unfixed script (10 lines rewritten) before the fix.
- The revision token is a closed list (SHA, `HEAD` and kin, `main`,
  `master`, `origin/`/`upstream/` and `refs/` names, `vX.Y.Z` tags), not any
  word, so `see:apps/…` or `domain:apps/…` still moves. Cons: another ref
  name (`release-2:apps/…`) is rewritten, which is why procedure step 2 still
  asks for a grep; and a bare word of seven or more hex letters followed by
  `:` before a path (`deadbeef:apps/…`) would be skipped.

### Task 1: `http-bridge` as the procedure proof

- Chosen: the recommended option, one domain (`http-bridge`) moved on its own
  with the codemod (`--prefix http-bridge- --into http-bridge`), against
  `main` at `c1724ab7`. `control-mcp` was not chosen because an open PR
  (#1912) is splitting `control-mcp-tools.ts`; `web-annotations` had another
  build in flight; `opencode` and `keyed-record-format.ts` are left for later
  slices.
- Measured before the move: 20 source files, 20 tests. Importers outside the
  folder: 7 production files in `apps/backend/src/core/`
  (`bridge-session-close.ts`, `host-model-catalog-refresh.ts`,
  `log-policy-service.ts`, `native-agent-provider.ts`,
  `opencode-provider-login.ts`, `opencode-sdk-client.ts` (removed with
  OpenCode 1.x on 2026-11-11),
  `session-held-model.ts`) using six symbols; 10 co-located tests at the
  root, plus one test that lists file names (`agent-provider-boundaries.test.ts`);
  3 `apps/backend/tests` files and `apps/backend/scripts/conditional-reads-baseline.ts`
  (all `HttpBridgeProvider`); 3 `e2e/fixtures` files
  (`HttpBridgeInteractionAdapter`), `scripts/benchmark-slash-command-catalogue.ts`
  (`HttpBridgeCatalogAdapter`), a dynamic import in
  `bridges/claude-bridge/src/routes/session-interactions.test.ts`, and path
  strings in `scripts/efficiency/workloads-projection.ts`,
  `tests/unit/auth-secret-guards.test.ts` and `.oxlintrc.json` (the
  raw-`console` allowlist). The codemod moved 40 files and rewrote 98.
- `index.ts` holds exactly the six production symbols. Importers that use only
  those (the `apps/backend/tests` files and the baseline script, too) go
  through it; co-located tests, the e2e fixtures, the benchmark script and
  the claude-bridge test keep deep imports, because they use internals no
  other domain needs (procedure step 3).
- Hand fixes after the codemod: reverted its rewrite of historical
  `ff4026b4e^:…` paths in four bridge test files and a `git show 0d254a3a^:…`
  command in flake record 0255; renamed bare file names in source comments,
  five `docs/architecture/` files, the root and `bridges/` `AGENTS.md`
  globs, and the file list `agent-provider-boundaries.test.ts` reads by path.
  Dated reports and flake records keep the path rewrites the codemod made,
  as the `design` slice (#979) did, except the `git show` command.
- Lint patterns: `**/http-bridge/*` with `!**/http-bridge/index.js` under
  `apps/backend/src/**`, and the `**/backend/src/core/http-bridge/*` form
  under `tests/unit/**`. No other import path contains an `http-bridge/`
  segment, so no negation is needed. Checked with probe files (deleted): a
  deep import is reported under both overrides, `index.js` is not.

### Task 1: the `index.ts` step for `mcp-management/` and `public-api/` first

- Chosen: the recommended option (2026-11-03, against `main` at
  `b68b6e71`): the two `index.ts` files and lint patterns on their own, with
  no file moves, using the procedure task 6 used for the four newer folders
  (below). The four wave 1 moves and `keyed-record-format.ts` stay open.
- Why: no renames, so no rebase conflicts for open branches; each rewritten
  importer is a one-line (or one-statement) path change.

### Task 1: what each `index.ts` exports

- Chosen: exactly the symbols production code outside each folder imported on
  `b68b6e71`, as explicit named re-exports, with `export type` or inline
  `type` for types. `mcp-management/index.ts` re-exports `McpManagementService`
  and the types `commands-registry-mcp.ts` and `commands-context.ts` use;
  `public-api/index.ts` re-exports what the 18 production importers outside
  the folder use, and 13 of them now import it through `index.ts`.
- Importers that pulled several symbols from one folder now have one import
  statement per folder (`commands-registry-mcp.ts`, `worker-turn-controls.ts`,
  `native-agent-job-tab-reuse.ts`). `commands-context.ts`'s
  `import("…")` type expression points at `mcp-management/index.js` too.
- The exception modules are still re-exported from `public-api/index.ts`, and
  importers outside the cycle (`environment-move.ts`,
  `native-agent-goal-check.ts`, `control-mcp-server.ts`,
  `worker-turn-controls.ts`) import them through it. Options: (a) re-export
  them and route every importer that can through `index.ts`; (b) leave them
  out of `index.ts` and have every importer import them directly. Chosen (a):
  `index.ts` stays the complete list of what the domain offers, and the
  exception list says only who may bypass it. Cons: the same symbol has two
  allowed import paths. (Task 6's `scheduled-jobs/index.ts` already does the
  same for `ScheduledJobCapacityError` from `store.js`.)
- Not routed through `index.ts`: co-located tests and test support (the
  tests-off override exempts them), `apps/backend/tests/**`, and the test-tier
  path strings in `scripts/test-tiers.ts`.

### Task 1: named exceptions where `public-api/index.ts` would close a runtime cycle

- Problem found: `public-api/index.ts` re-exports `registry.js`,
  `actions-sessions.js`, `sessions.js`, `dispatch.js`, `exec-control.js` and
  `actions-session-commands.js`, each of which reaches most of the backend
  (commands, storage, scheduled jobs, control MCP). Six of the 18 production
  importers are inside that reach, so routing them through `index.ts` closes a
  runtime import cycle: `storage-public-operations.ts` (through
  `storage-repositories.ts` and `storage.ts`), `commands-environment.ts`,
  `commands-servers.ts` and `container-replacement.ts` (through
  `actions-projects.ts` and `commands-registry-projects.ts`),
  `control-mcp-caller.ts` (through `scheduled-jobs/executor.ts` and
  `control-mcp-tools.ts`) and `scheduled-jobs/executor.ts` (through
  `actions-schedules.ts`). Found with a throwaway reachability script over the
  same value-edge graph `tests/unit/module-import-cycles.test.ts` built
  (that test was removed on 2026-11-10; `import/no-cycle` enforces the same
  graph).
  `mcp-management/index.ts` reaches neither of its two importers, so it has
  no exceptions.
- Options: (a) name the leaf modules those six files import as exceptions in
  the `apps/backend/src/**` pattern; (b) keep the deep imports with an
  `oxlint-disable-next-line` and a reason at each site; (c) make `registry.js`
  the exception instead, so `index.ts` would not reach the backend; (d) break
  the cycles by moving code.
- Chosen: (a), as task 6 did. The exceptions are `attention-cursor.js`,
  `dispatch.js`, `errors.js`, `exec-control.js`, `operation-ledger.js` and
  `revisions.js`; the `public-api/index.ts` header names them and the files
  that import them directly. The six files keep their imports unchanged,
  except `scheduled-jobs/executor.ts`, whose type-only import of
  `PublicActionHandler` (from `types.js`, not an exception) now comes from
  `index.ts` as `import type`, which adds no runtime edge. The
  `tests/unit/**` patterns stay strict (index only).
- Why: (c) does not work: `actions-sessions.js`, `sessions.js`,
  `dispatch.js`, `exec-control.js` and `actions-session-commands.js` reach the
  same six files without `registry.js`, so it would need most of the surface
  as exceptions. (d) is a non-path edit, outside this file's "pure moves"
  rule. (b) scatters the same list over six files. (a) also leaves
  `commands-environment.ts` and `commands-servers.ts`, which other open
  branches edit, untouched.
- Cons: six `public-api/` files are importable without `index.ts`; a reader
  has to check the lint pattern or the `index.ts` header to see them. They can
  go when `storage` and `commands` get their own folders and the cycle through
  `registry.js` is broken at the composition root.

### Task 1: neither pattern collides with the protocol package

- `@orkestrator/protocol/public-api*` and `@orkestrator/protocol/mcp-management`
  are single path segments, so `**/public-api/*` and `**/mcp-management/*`
  do not match them; no `!@orkestrator/protocol/…` negation is needed. Checked
  with a probe file (deleted): deep imports into both folders are reported
  under `apps/backend/src/**` and `tests/unit/**`, the six exceptions and
  `index.js` are not reported under `apps/backend/src/**`, an exception is
  reported under `tests/unit/**`, and the protocol imports are not reported.

### Task 6: track the four folders here, as part of wave 1's `index.ts` step

- Chosen: the recommended option. The four folders get the same procedure as
  `mcp-management/` and `public-api/` (steps 3 to 5, no moves), recorded in
  this file rather than a new todo.
- Why: one procedure, one file; the work needs no file moves, so it does not
  conflict with the open waves.

### Task 6: what each `index.ts` exports

- Chosen: exactly the symbols production code outside the folder imported on
  `79f3bc97` (step 1 of the procedure), as explicit named re-exports. Types are
  re-exported with `export type` or inline `type`, so type-only importers add
  no runtime edge.
- Not routed through `index.ts`: co-located tests in the `core/` root (the
  tests-off override already exempts them), `e2e/` specs, and the repository
  scripts `scripts/benchmark-change-tracking.ts`,
  `scripts/qualify-preview-worker-upgrade.ts` and
  `apps/backend/scripts/build.ts` (white-box tools, outside both lint
  overrides; `build.ts` names worker entry points by path and must keep doing
  so).
- Importers that pulled several symbols from one folder now have one import
  statement per folder, merged from the old per-file imports.
- `storage.ts`'s type-only import of `ScheduledJobStore` stays on
  `scheduled-jobs/store.js`, one of the exceptions below, so `storage.ts` is
  untouched.

### Task 6: named exceptions where an `index.ts` would close a runtime cycle

- Problem found: routing every importer through `index.ts` added 91
  `import/no-cycle` errors and failed `tests/unit/module-import-cycles.test.ts`
  (since removed; `import/no-cycle` alone guards runtime cycles now).
  The storage layer (`storage-stores.ts`, `storage-nodes.ts`,
  `storage-scheduled-jobs.ts`) imports each domain's store layout, migration or
  store, and each domain's services import storage, so through a barrel
  storage would depend on the whole domain. Likewise `scheduled-jobs/executor.ts`
  imports `control-mcp-tools.ts`, which reaches `control-mcp-coordinator-tools.ts`
  and `agent-tools.ts`, which import `scheduled-jobs/tools.ts`. Each of these
  had to stay a deep import (checked one at a time: routing any one of them
  through `index.ts` brings the cycle back).
- Options: (a) name the six leaf modules as exceptions in the
  `apps/backend/src/**` lint pattern; (b) keep the deep imports with an
  `oxlint-disable-next-line` and a reason at each of the seven sites; (c) break
  the cycles by moving code (for example `coordinatorRoleCapabilities` out of
  `control-mcp-tools.ts`).
- Chosen: (a). The exceptions are `nodes/node-store-format.js`,
  `change-tracking/ledger-schema.js`, `transcript-artifacts/store-layout.js`,
  `scheduled-jobs/layout.js`, `scheduled-jobs/store.js` and
  `scheduled-jobs/tools.js`; each `index.ts` header says which files are
  imported directly and why, and those symbols are not re-exported from
  `index.ts`. The `tests/unit/**` patterns stay strict (index only).
- Why: (c) is a behaviour-neutral but non-path edit, outside this file's "pure
  moves" rule and the narrow scope asked for. (a) keeps the importer files
  unchanged (smaller diff, easier rebase) and lists every exception in one
  reviewable place; (b) would scatter the same list over seven files. The
  exceptions can go when `storage` (wave 3) and `control-mcp` (wave 1) get
  their own folders and the shared pieces are placed.
- Cons: six files are part of their domain's surface without being in
  `index.ts`; a reader has to check the lint pattern or the `index.ts` header
  to see them.

### Task 6: the `change-tracking` pattern skips the protocol package

- The `**/change-tracking/*` pattern would also match
  `@orkestrator/protocol/node/change-tracking/*`, which backend files import
  legitimately. The pattern adds `!@orkestrator/protocol/node/change-tracking/*`.
  The other three folder names do not collide with any other import path
  (checked with a probe file: deep imports into all four folders are reported,
  the exceptions and the protocol path are not).

### Task 6: new domain folders start with an `index.ts`

- Chosen: the recommended option, a line in `docs/development/linting.md`
  ("Module boundaries").
- Why: stops the list of unenforced folders growing while the waves run.

### Task 5: a one-off measurement, method in prose

- Chosen: the recommended option. The baseline and the method are in
  "Current state"; the script used was throwaway, so the method is described
  precisely enough to repeat.
- Measured on the base commit (`79f3bc97`) and again with task 6 applied, so
  the effect of the `index.ts` files is recorded separately from the baseline.
- The 2026-10-14 figure (112 files) could not be reproduced: its method was not
  recorded, and no edge set tried here comes close (static imports only give
  289). It is kept for history but not compared against.

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
  inheritance chains are split. Settled: both chains are split (todos 0009
  and 0010, retired on 2026-10-29), so neither slice moves files that are
  about to be rewritten.

## Related

- [`backend-runtime.md`](../../architecture/backend-runtime.md#rules): the
  runtime state owner from todo 0011 (retired on 2026-10-29), which had to land
  before the `commands` slice.
- [`storage.md`](../../architecture/storage.md#code-layout) and
  [`native-agent-service.md`](../../architecture/native-agent-service.md#collaborators):
  the storage repositories and native agent collaborators (todos 0009 and
  0010).
- [`linting.md`](../../development/linting.md) ("Module boundaries").
- [7800](7800-domain-folders-without-index.md): `index.ts` and lint patterns
  for `permission-rules/`, `opencode2/` and `self-improvement/`.

## Replaces

- `docs/2026-10-14/core-domain-folders.md`
