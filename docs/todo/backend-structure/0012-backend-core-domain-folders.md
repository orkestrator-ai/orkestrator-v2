# Backend core domain folders

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; tasks 1 and 6 re-checked 2026-11-11 against `main` at `14df96544`, and task 1 again against `963ffa6ab` for the `control-mcp` slice; tasks 1, 2 and 7 re-checked 2026-11-13 against `main` at `17d28238c` for the `keyed-record-format.ts` placement and the `plan-usage` slice; task 2 re-checked 2026-11-14 against `main` at `dc90609bf` for the `features` slice, and 2026-11-16 against `main` at `c1fcc573b` for the `previews` slice; task 1 re-checked 2026-11-16 against `main` at `a0920f1a7` for the `opencode` slice; task 2 re-checked 2026-11-17 against `main` at `0265e7882` for the `worktrees` slice, 2026-11-18 against `main` at `b2c91abb9` for the `git` slice, 2026-11-20 against `main` at `0b778d995` for the `coordinator` slice, 2026-11-20 against `main` at `e102a0dd5` for the `agent-accounts` slice, 2026-11-20 against `main` at `7fd328b8c` for the `workflows` slice, 2026-11-20 against `main` at `05f3db2d8` for the `review` slice, 2026-11-20 against `main` at `11fca66ca` for the `build-pipeline` slice, and 2026-11-20 against `main` at `9a5a84f63` for the `native-agent` slice; task 3 re-checked 2026-11-22 against `main` at `dd1391427` for the `recurring` slice and the codemod's permalink fix, 2026-11-22 against `main` at `81a501415` for the `tmux` slice, and 2026-11-22 against `main` at `3030e84a2` for the `terminals` slice; task 7 re-checked 2026-11-20 against `main` at `9a5a84f63` for `pi-model-catalog-seeding.ts`.

### Tasks

1. **Wave 1 (leaves)**: move `opencode`, `web-annotations`, `http-bridge`, `control-mcp`; give `mcp-management/` and `public-api/` an `index.ts` and lint patterns; place `keyed-record-format.ts`. Status: done: the `index.ts` step for `mcp-management/` and `public-api/` is done (2026-11-03), the `http-bridge` move is done (2026-11-06, the procedure proof), and the `web-annotations` and `control-mcp` moves are done (2026-11-11, one change each; see "Assumptions and decisions"); `keyed-record-format.ts` is placed in the shared kernel at the `core/` root (2026-11-13, see task 7); and the `opencode` move is done (2026-11-16: the root `opencode-*` and `opencode2-*` files moved into `opencode2/`).
2. **Wave 2 (mid-tier)**: eleven domains from `plan-usage` to `native-agent`. Status: done: the `plan-usage` move is done (2026-11-13), the `features` move is done (2026-11-14), the `previews` move is done (2026-11-16), the `worktrees` move is done (2026-11-17), the `git` move is done (2026-11-18), the `coordinator` move is done (2026-11-20), the `agent-accounts` move is done (2026-11-20), the `workflows` move is done (2026-11-20), the `review` move is done (2026-11-20), the `build-pipeline` move is done (2026-11-20) and the `native-agent` move is done (2026-11-20), one change each (see "Assumptions and decisions"). Wave 2 is done; wave 3 is in progress (task 3).
3. **Wave 3 (hubs)**: `terminals`, `tmux`, `recurring`, `containers`, `environments`, `storage`. Status: in progress: the `recurring`, `tmux` and `terminals` moves are done (2026-11-22, one change each; see "Assumptions and decisions"); `containers`, `environments` and `storage` are open, one change each.
4. **Last: `commands`**. Status: open (its prerequisite, 0011, is done).
5. **Record the type-level import cycle**: re-measure and record it here. Status: done for the baseline (2026-10-28, see "Current state"); re-measure when the waves finish.
6. **Folders created since the plan**: `nodes/`, `change-tracking/`, `transcript-artifacts/` and `scheduled-jobs/` exist without an `index.ts` or lint pattern. Status: done (2026-10-28): each has an `index.ts` and both lint patterns, production importers go through it, and `linting.md` asks new domain folders to start with one. Three more folders without one (`permission-rules/`, `opencode2/`, `self-improvement/`) were found on 2026-11-11; to-do 7800 (retired 2026-11-11) gave each an `index.ts` and both lint patterns (see "Current state").
7. **Open questions**: where `keyed-record-format.ts` and `pi-model-catalog-seeding.ts` go, and whether `storage` and `native-agent` move before or after their splits. Status: partly done (the 0009/0010 splits have landed, and `keyed-record-format.ts` stays in the shared kernel, 2026-11-13); `pi-model-catalog-seeding.ts` is open until the model catalogue code is moved (re-checked 2026-11-20 for the `native-agent` slice, which does not touch it: its importers are `host-model-catalog-refresh.ts` and `commands-registry-projects.ts`, not native-agent files).

### 1. Wave 1 (leaves)

**Problem.** `apps/backend/src/core/` is one flat directory whose domains exist only as file-name prefixes, so nothing shows or enforces a domain's public surface. Every backend contributor pays for it when reading or reviewing; the cost grows with every feature.

**Context.** The plan moves low-dependency domains first to prove the codemod procedure. Only `design/` is done (#979, `0466ebd0`), with an `index.ts` and patterns in both `.oxlintrc.json` overrides (`apps/backend/src/**` at line 177, pattern at 188; `tests/unit/**` at 216, pattern at 223).

**Investigation.** Nothing has moved since #979, and the root has grown fast: 521 source files and 446 tests (the file says 378 and 299). Wave 1 prefix counts today: `opencode-*` 41 source / 33 tests (was 29/22), `web-annotation-*` 29/25 (28/22), `http-bridge-*` 18/14 (13/11), `control-mcp-*` 20/9 (2/1). `mcp-management/` (29 source, 27 tests) and `public-api/` (42, 20) still have no `index.ts`. The codemod `scripts/move-backend-modules.ts` and its test `tests/unit/move-backend-modules.test.ts` still exist (last touched for Bun 1.4.4 in #1229). `mise run build:backend` and `mise run verify:packaged-backend` exist in `mise.toml`. Re-measured 2026-11-11 on `14df96544`: `opencode-*` 55 source / 53 tests, `control-mcp-*` 39/27, and `web-annotation-*` 29/27 before its move. `core/opencode2/` (36/43, #2009) now sits beside the `opencode-*` files, with four `opencode2-*.ts` files still at the root, so the `opencode` slice also has to decide where those four files go. Re-measured 2026-11-11 on `963ffa6ab`, after OpenCode 1.x was retired: `opencode-*` 7 source / 6 tests and `opencode2-*` 4/3, and `control-mcp-*` 40/29 before its move. Dropping the prefix would give `opencode2-container-server.ts` the name of the existing `opencode2/container-server.ts`, so the `opencode` slice needs a map file and a naming decision, not `--prefix`. Re-measured 2026-11-16 on `a0920f1a7` for that slice: `opencode-*` 7 source / 6 tests and `opencode2-*` 4/3, with 10 production importers outside them (all in `core/`) and no open pull request.

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

**Investigation.** Prefix counts today (source / tests): `coordinator-*` 11/10, `agent-accounts*` 10/10, `preview-*` 8/9, `git-*` 4/2, `github*` 12/6, `pr-*` 3/4, `workflow-*` 11/9, review prefixes (`multi-review-*`, `review-*`, `looped-review-*`) 34/35, `build-pipeline-*` 25/21, `native-agent-*` 39/59. `native-agent-service.ts` (4,276 lines) and `native-agent-transcript-projection.ts` (5,589) were the subject of the size todo 0057 (retired 2026-11-17; the resulting collaborators are listed in [`native-agent-service.md`](../../architecture/native-agent-service.md#collaborators)). Re-measured 2026-11-13 on `17d28238c` for the first slice: `plan-usage*` was 2 source / 3 tests, with 10 production importers outside the domain, and no open pull request touched it (two were open). Re-measured 2026-11-14 on `dc90609bf` for the second slice: `feature-*` was 5 source / 4 tests, with 6 production importers outside the domain (five in `core/` and `apps/backend/scripts/recurring-baseline-workflows.ts`) using four symbols, and neither open pull request touched it. Re-measured 2026-11-16 on `c1fcc573b` for the third slice: `preview-*` was 8 source (7 modules and `preview-test-support.ts`) / 12 tests, with 12 production importers outside the domain (three in `core/` and nine `apps/backend/src/preview-*.ts` and `gateway-*.ts` files) using six symbols, plus the two test-only harness entrypoints (one more symbol and the test support); no pull request was open. Re-measured 2026-11-17 on `0265e7882` for the fourth slice: `worktree-*` was 8 source / 11 tests, with 13 production importers outside the domain (all in `core/`, two of them in `change-tracking/`) using 25 symbols from seven modules, plus five repository scripts and two `apps/backend/tests` files; no pull request was open. Re-measured 2026-11-18 on `b2c91abb9` for the fifth slice: `git-*`, `github*` and `pr-*` were 31 source (two test-support files included) / 28 tests (the table's 11 / 8 was stale), with 47 production importers outside the domain (all in `core/`) using about 100 symbols from 28 modules, plus two `apps/backend/scripts` files, 22 `apps/backend/tests` files and one renderer test; PR #2394 was then open and added merge notices alongside changes to the PR monitor. Re-measured 2026-11-20 on `0b778d995` for the sixth slice: `coordinator-*` was 58 source (one test-support file included) / 62 tests (the table's 7 / 5 was stale), with 42 production importers outside the domain in `apps/backend/src` (all in `core/`, nine of them in `control-mcp/`, `nodes/`, `opencode2/` and `public-api/`) using 106 symbols from 44 modules, plus two `apps/backend/scripts` files, one `apps/backend/tests` file, one `e2e/agent-testing` spec and one claude-bridge live test; no pull request was open. Re-measured 2026-11-20 on `e102a0dd5` for the seventh slice: `agent-accounts*` was 15 source / 23 tests (the table's 7 / 7 was stale), with 40 production importers outside the domain in `apps/backend/src` (all in `core/`, 13 of them in `capabilities/`, `coordinator/`, `git/`, `mcp-management/`, `opencode2/`, `permission-rules/` and `plan-usage/`) using 78 symbols from 12 modules, plus 21 tests in `apps/backend/src`, eight `apps/backend/tests` files and one `e2e/agent-testing` integration test; no open pull request touched the domain. Re-measured 2026-11-20 on `7fd328b8c` for the eighth slice: `workflow-*` was 17 source / 17 tests (the table's 9 / 7 was stale), with 42 production importers outside the domain in `apps/backend/src` (all in `core/`, two of them in `features/`) using 47 symbols from 13 modules, plus 29 tests and five test-support files in `apps/backend/src`, one `apps/backend/tests` file, two `e2e/agent-testing` tests and one string in `packages/protocol/src/graphs/type-validators.ts`; one of the 17 source files (`workflow-tab-actions.ts`) and three of the tests are not workflow machinery (see "Assumptions and decisions"). Re-measured 2026-11-20 on `05f3db2d8` for the ninth slice: the review prefixes were 48 source (seven test-support and fixture files included) / 55 tests (the table's 26 / 26 was stale), plus `workflow-tab-actions.ts` and the last looped-review file, `retired-looped-review-cleanup.ts` with its test (no `looped-review-*` file is left); with those, 50 production importers outside the domain in `apps/backend/src` (all in `core/`, eight of them in `coordinator/`, `public-api/` and `workflows/`) used 105 symbols from 27 modules, plus 29 tests in `apps/backend/src`, four `apps/backend/tests` files, one `apps/backend/scripts` file, three `e2e` files, two repository scripts and one `tests/unit` test; the only open pull request (a release version bump) does not touch the domain. Re-measured 2026-11-20 on `11fca66ca` for the tenth slice: `build-pipeline-*` was 57 source (seven test-support and fixture files included) / 66 tests (the table's 23 / 16 was stale), plus `control-workflow-summary.ts` and its test and the three `pipeline-worker-*` files (`pipeline-worker-identity.ts`, `pipeline-worker-mail-test-support.ts`, `pipeline-worker-mail.test.ts`); with those, 59 production importers outside the domain in `apps/backend/src` (all in `core/`, 23 of them in `review/`, `features/`, `coordinator/`, `control-mcp/`, `public-api/`, `workflows/` and `git/`) used 93 symbols from 27 modules, plus 63 tests and test-support files in `apps/backend/src`, three `apps/backend/tests` files, one `apps/backend/scripts` file, one repository script, one `tests/unit` test and one codex-bridge integration test; `native-agent-*` is now 79 source / 122 tests. Re-measured 2026-11-20 on `9a5a84f63` for the eleventh slice: `native-agent-*` was 79 source (three test-support files and the test-only `native-agent-service-test-collaborators.ts` included) / 122 tests (the table's 30 / 40 and the 39 / 59 above were stale), plus `native-terminal-messages.ts` and its test and `workflow-account-handoff.test.ts`; with those, 51 production importers outside the domain in `apps/backend/src` (50 in `core/`, 27 of them in `build-pipeline/`, `capabilities/`, `change-tracking/`, `coordinator/`, `features/`, `git/`, `http-bridge/`, `mcp-management/`, `opencode2/`, `public-api/`, `review/`, `web-annotations/` and `workflows/`, and `gateway-handlers.ts`) used 69 symbols from 23 modules, plus 76 tests and test-support files in `apps/backend/src`, seven `apps/backend/tests` files, three `apps/backend/scripts` files, six repository scripts, two `tests/unit` tests, one desktop test, one CLI test and two e2e files; no pull request was open.

**Decisions.**

- **Should `native-agent` move before or after 0057's splits?**
  - **After 0057 (recommended; chosen: the move landed 2026-11-20, after 0057's splits).**
    - Pros: moves the files once, under their final names; avoids a rename colliding with a large split diff.
    - Cons: the busiest domain stays flat for as long as 0057 is unscheduled. (0057's splits all landed by 2026-11-17, so this no longer holds `native-agent` back.)
  - **Before 0057.**
    - Pros: the new collaborators are created inside the folder from the start.
    - Cons: every open native-agent branch rebases twice.

### 3. Wave 3 (hubs)

**Problem.** The hub domains are imported by many files, some from outside `core/`, so their slices touch the most files.

**Context.** `terminals`, `tmux`, `recurring`, `containers`, `environments`, `storage`.

**Investigation.** Counts today: `terminal-*` 2/2 and `transcript-*` 1/2, `tmux*` 11/3, `recurring-*` 4/2, `container-*` 23/11 and `docker-*` 7/2, `environment-*` 12/9, `storage*` 36/38. The storage repositories now exist (0009 and 0163 merged) and the over-limit storage files are split (todo 0214, retired on 2026-10-29; see [`storage.md`](../../architecture/storage.md#code-layout)), so the `storage` slice can be done once, and the tmux module state has since moved into the runtime (`runtime.tmux`, see [`backend-runtime.md`](../../architecture/backend-runtime.md)). Re-measured 2026-11-22 on `dd1391427` for the first slice: `recurring-*` was 4 source (`recurring-test-support.ts` included) / 3 tests (the table's 4 / 2 was stale on tests), with 50 production importers outside the domain in `apps/backend/src` (49 in `core/`, 17 of them in `build-pipeline/`, `change-tracking/`, `features/`, `git/`, `http-bridge/`, `native-agent/`, `public-api/`, `workflows/` and `worktrees/`, and `main.ts`) using 20 symbols from three modules, plus 68 tests and test-support files in `apps/backend/src`, 15 `apps/backend/tests` files, four `apps/backend/scripts` files and two repository scripts; no `tests/unit` file imports it. The domain's own runtime dependencies are the protocol's `recurring-work` module and `native-session-invalidation-metrics.ts`, which `recurring-diagnostics.ts` reads. Re-measured 2026-11-22 on `81a501415` for the second slice: `tmux*` was 14 source (the seven-module `export *` barrel `tmux.ts` included) / 14 tests (the table's 14 / 14 held; the 11 / 3 above was stale), with 11 production importers outside the domain in `apps/backend/src` (all at the `core/` root, none in a domain folder) using 17 symbols from six modules, plus eight tests and test-support files in `apps/backend/src`, 27 `apps/backend/tests` files and four `apps/backend/scripts` files; no repository script, `tests/unit` file or renderer file imports it (the renderer's and the protocol's `tmux-*` modules are different files). The tmux module state is in the runtime (`runtime.tmux`, todo 0133, retired), so nothing held this slice back. Re-measured 2026-11-22 on `3030e84a2` for the third slice: `terminal-*` and `transcript-*` were 8 source (`terminal-history-test-support.ts` included) / 14 tests (the table's 8 / 14 held; the 2/2 and 1/2 above were stale): six `terminal-*` source files with 11 tests, and two `transcript-*` source files (`transcript-progress.ts`, `transcript-media-pins.ts`) with three tests. The `terminal-*` files had six production importers outside the domain in `apps/backend/src` (five at the `core/` root and `tmux/session-manager.ts`) using five symbols from two modules (`terminal-runtime.ts`, `terminal-history.ts`), plus seven tests in `apps/backend/src`, four `apps/backend/tests` files, one `apps/backend/scripts` file and one repository script; no `tests/unit` file imports them. Their own dependencies are the root's `commands-context.ts`, `commands-review.ts`, `commands-terminal.ts`, `container-terminal-shell.ts` and `pty.ts` (from `terminal-runtime.ts`), the protocol's `terminal-history`, events and logger modules, and xterm. The two `transcript-*` files had eight production importers outside `native-agent/` (`agent-branch-observation.ts`, `environment-delete.ts`, `commands-registry-transcript-media.ts`, two in `review/` and three in `build-pipeline/`) and one inside it (`native-agent/tool-detail-reads.ts`), using ten symbols, plus three tests and one repository script (`scripts/efficiency/workloads-supervision.ts`); neither is terminal code (see "Assumptions and decisions"). No pull request was open.

**Decisions.**

- **Should `storage` and `tmux` wait for 0214 and 0133?** Both refactors are done (0214 retired 2026-10-29, 0133 retired with #1427), so neither waits any more; `tmux` moved on 2026-11-22.
  - **Yes, sequence each slice after its refactor (recommended; chosen).**
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

**Investigation.** `keyed-record-format.ts` is no longer imported only by `build-pipeline-transcript-*`: `transcript-artifacts/store.ts` imports it too, alongside `build-pipeline-transcript-store.ts` and `build-pipeline-transcript-legacy-manifests.ts`. `pi-model-catalog-seeding.ts` now sits beside `pi-catalog-probes.ts` (from 0066, owned by `runtime.localServers.piCatalog`). The third question is settled: the 0009 and 0010 inheritance splits merged (#1276, #1180), so `storage` and `native-agent` are no longer about to be rewritten by those, though 0214 and 0057 are follow-ups (see tasks 2 and 3). Re-checked 2026-11-13 on `17d28238c`: `keyed-record-format.ts` still has those three production importers in two domains (two `build-pipeline-transcript-*` files and `transcript-artifacts/store.ts`), plus `build-pipeline-transcript-test-fixtures.ts` and `build-pipeline-transcript-store.test.ts`. Settled: it stays in the kernel (the recommended option below).

**Decisions.**

- **Where does `keyed-record-format.ts` go?** Settled 2026-11-13: the kernel.
  - **The shared kernel at the `core/` root (recommended; chosen).**
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
  `control-mcp/coordinator-tools.ts`). See "Assumptions and decisions".
- Done (task 1's `index.ts` step, 2026-11-03): `core/mcp-management/` and
  `core/public-api/` each have an `index.ts` and both lint patterns, and
  production importers outside each folder go through it. Six leaf modules of
  `public-api/` are named exceptions in the `apps/backend/src/**` pattern,
  because `public-api/index.ts` reaches most of the backend through
  `registry.js`: `attention-cursor.js`, `dispatch.js`, `errors.js`,
  `exec-control.js`, `operation-ledger.js` and `revisions.js`.
  `mcp-management/` needs none. That left no domain folder without an
  `index.ts` at the time except `permission-rules/` (2026-10-27), which was
  missed.
- Done (to-do 7800, retired 2026-11-11, against `main` at `963ffa6ab`):
  `core/permission-rules/`, `core/self-improvement/` and `core/opencode2/`
  each have an `index.ts` and both lint patterns, and production importers
  outside each folder go through it (10, 4 and 18 of 20 files; the other two
  are the exception below). The four root
  `opencode2-*.ts` files import `opencode2/index.js` like any other caller.
  One leaf module is a named exception in the `apps/backend/src/**` pattern:
  `opencode2/container-credentials.js`, imported directly by
  `agent-accounts/containers.ts` and `portable-input-status.ts`, because
  `opencode2/index.ts` reaches `agent-accounts/containers.ts` through
  `host-launch.ts`. The `self-improvement/` patterns use `**` rather than `*`
  so they also cover its `insights/` subfolder. See "Assumptions and
  decisions".
- Done (task 1's `http-bridge` slice, 2026-11-06, against `main` at
  `c1724ab7`): the 20 `http-bridge-*` source files and their 20 tests are in
  `core/http-bridge/` without the prefix (`http-bridge/provider.ts`,
  `http-bridge/transport.ts`, …), with an `index.ts` and both lint
  patterns. `index.ts` re-exports the five symbols the seven production
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
- Done (task 1's `control-mcp` slice, 2026-11-11, against `main` at
  `963ffa6ab`): the 40 `control-mcp-*` source files (two test-support files
  included) and their 29 tests are in `core/control-mcp/` without the
  prefix (`control-mcp/server.ts`, `control-mcp/tools.ts`, …), with an
  `index.ts` and both lint patterns. `index.ts` re-exports the nine symbols
  the four production importers outside the folder use (`ControlMcpServer`,
  `controlMcpPortOverride`, `coordinatorRoleCapabilities` and the types
  `ControlMcpEndpointState`, `ControlMcpInfo`, `ControlMcpSettings`,
  `CoordinatorControlConnection`, `CoordinatorControlScope` and
  `CreateControlMcpCredentialInput`). One leaf module is a named exception in
  the `apps/backend/src/**` pattern: `tools.js`, from which
  `commands-servers.ts` and `scheduled-jobs/executor.ts` import
  `coordinatorRoleCapabilities`, because `index.ts` reaches both through
  `server.ts`. See "Assumptions and decisions".
- Done (task 1's `keyed-record-format.ts` placement, 2026-11-13, against
  `main` at `17d28238c`): it stays at the `core/` root as a shared-kernel
  module, because its production importers are in two domains
  (`build-pipeline/transcript-store.ts`,
  `build-pipeline/transcript-legacy-manifests.ts` and
  `transcript-artifacts/store.ts`). No file moved and no import changed; its
  header comment, which still named the keyed record store removed with #969,
  now names its users and says why it is in the kernel. See "Assumptions and
  decisions".
- Done (task 2's `plan-usage` slice, 2026-11-13, against `main` at
  `17d28238c`): the two `plan-usage*` source files and their three tests are
  in `core/plan-usage/` (`plan-usage.ts` → `reader.ts`,
  `plan-usage-cache.ts` → `cache.ts`, and `reader.test.ts`, `cache.test.ts`,
  `agent-test-origin.test.ts`), with an `index.ts` and both lint patterns.
  `index.ts` re-exports the seven symbols the ten production importers
  outside the folder use (`contextUsageWithPlanUsage`, `PlanUsageState`,
  `createPlanUsageReader`, `readAgentAccountPlanUsage` and the types
  `PlanUsageCache`, `PlanUsageRead` and `PlanUsageReader`). One leaf module is
  a named exception in the `apps/backend/src/**` pattern: `cache.js`, which
  `http-bridge/provider.ts` and `http-bridge/progressive.ts` import directly,
  because `cache.ts` is documented as a leaf that keeps the reader's
  credential modules out of the bridge provider's graph. See "Assumptions and
  decisions".
- Done (task 2's `features` slice, 2026-11-14, against `main` at
  `dc90609bf`): the five `feature-*` source files and their four tests are in
  `core/features/` without the prefix (`features/planning.ts`,
  `features/planning-scheduling.ts`, `features/build.ts`,
  `features/build-tasks.ts`, `features/plan-build.ts`), with an `index.ts`
  and both lint patterns. `index.ts` re-exports the four symbols the six
  production importers outside the folder use (`createFeatureBuild`,
  `FeatureBuildTasks`, `startFeaturePlanBuild` and `FeaturePlanningService`),
  and all six import it. No named exceptions were needed: routing them
  through `index.ts` closes no runtime cycle. See "Assumptions and
  decisions".
- Done (task 2's `previews` slice, 2026-11-16, against `main` at
  `c1fcc573b`): the eight `preview-*` source files (test support included)
  and their twelve tests are in `core/previews/` without the prefix
  (`previews/runtime.ts`, `previews/access.ts`, `previews/intent.ts`,
  `previews/readiness.ts`, `previews/listener-ownership.ts`,
  `previews/service-registry.ts`, `previews/target-resolver.ts`,
  `previews/test-support.ts`), with an `index.ts` and both lint patterns.
  `index.ts` re-exports the five symbols the twelve production importers
  outside the folder use (`PreviewRuntime`, `resolvePreviewTargetIntent` and
  the types `AuthenticatedPreviewAccess`,
  `PreviewPublicationPort` and `ResolvedPreviewTarget`), and all of them
  import it; it also re-exports `defaultProbeFamily` for
  `preview-browser-harness.ts`. One module is a named
  exception in the `apps/backend/src/**` pattern: `test-support.js`, which
  the test-only entrypoints `preview-browser-harness.ts` and
  `preview-baseline-harness.ts` import; their names fall outside the
  tests-off override's globs. No runtime cycle needed an exception. See
  "Assumptions and decisions".
- Done (task 1's `opencode` slice, 2026-11-16, against `main` at
  `a0920f1a7`): the seven `opencode-*` and four `opencode2-*` source files
  and their nine tests are in the existing `core/opencode2/` folder without
  the prefix (`opencode2/display-transcript.ts`,
  `opencode2/listener-identity.ts`, `opencode2/listener-recheck.ts`,
  `opencode2/package-cache.ts`, `opencode2/project-config.ts`,
  `opencode2/provider-login-slot.ts`, `opencode2/provider-login.ts`,
  `opencode2/container-launch.ts`, `opencode2/host-database-server.ts`,
  `opencode2/host-server.ts`, and `opencode2-container-server.ts` as
  `opencode2/container-server-lifecycle.ts`, because `container-server.ts`
  was taken). `opencode2/index.ts` re-exports the nine new symbols that
  five of the ten production importers outside the folder use. Three moved
  modules are new named exceptions in the `apps/backend/src/**` pattern and
  are not re-exported, because re-exporting any of them closes a runtime
  cycle for the folder's other importers: `container-server-lifecycle.js`,
  `host-database-server.js` and `provider-login.js`. Wave 1 is done. See
  "Assumptions and decisions".
- Done (task 2's `worktrees` slice, 2026-11-17, against `main` at
  `0265e7882`): the eight `worktree-*` source files and their eleven tests
  are in `core/worktrees/` without the prefix (`worktrees/watcher.ts`,
  `worktrees/watch-plan.ts`, `worktrees/git-paths.ts`,
  `worktrees/locations.ts`, `worktrees/adhoc-reads.ts`,
  `worktrees/removal-reads.ts`, `worktrees/snapshot-digest.ts`,
  `worktrees/tree-snapshots.ts`), with an `index.ts` and both lint
  patterns. `index.ts` re-exports the 24 symbols that twelve of the 13
  production importers outside the folder use, and all twelve import it.
  One module is a named exception in the `apps/backend/src/**` pattern and
  is not re-exported: `removal-reads.js`, which `diff-stats-service.ts`
  imports directly, because it imports `change-tracking/index.js` and
  re-exporting it would close a runtime cycle for `commands-files.ts` and
  `container-git-fetch.ts`. See "Assumptions and decisions".
- Done (task 2's `git` slice, 2026-11-18, against `main` at
  `b2c91abb9`): the 31 `git-*`, `github*` and `pr-*` source files (two
  test-support files included) and their 28 tests are in `core/git/`. Only
  the `git-` prefix was dropped (`git/fsmonitor.ts`,
  `git/noninteractive-env.ts`, `git/blob-read.ts`, …); the `github*` and
  `pr-*` files keep their names (`git/github.ts`,
  `git/github-credentials.ts`, `git/pr-monitor.ts`, …). `index.ts`
  re-exports 86 symbols from 21 modules, and 43 of the 47 production
  importers outside the folder import it. Seven modules are
  named exceptions in the `apps/backend/src/**` pattern and are not
  re-exported, because re-exporting any of them closes a runtime cycle:
  `github-cli-setup.js`, `github-clone-browser.js`,
  `github-ranges-seed-delivery.js`, `pr-auto-merge.js`,
  `pr-auto-merge-resolve-settled.js`, `pr-monitor-runtime.js` and
  `pr-required-checks.js`, each imported directly by its one production
  importer. The integration of #2394 also moved its merge-notice module and
  test into `core/git/`. See "Assumptions and decisions".
- Done (task 2's `coordinator` slice, 2026-11-20, against `main` at
  `0b778d995`): the 58 `coordinator-*` source files (one test-support file
  included) and their 62 tests are in `core/coordinator/` without the prefix
  (`coordinator/service.ts`, `coordinator/runtime.ts`,
  `coordinator/providers.ts`, `coordinator/pr-watches.ts`,
  `coordinator/review-actions.ts`, …), with an `index.ts` and both lint
  patterns. `index.ts` re-exports 80 symbols from 30 modules, and 40 of the
  42 production importers outside the folder import it. Fourteen modules are
  named exceptions in the `apps/backend/src/**` pattern and are not
  re-exported, because re-exporting any of them closes a runtime cycle: the
  command handlers the command registry installs (`fork-worker.js`,
  `goal-actions.js`, `node-tickets.js`, `pipeline-step-actions.js`,
  `review-actions.js`, `subork-actions.js`, `surface-actions.js`,
  `worker-changes.js`, `worker-mail.js`, `worker-turn-actions.js`),
  `mail-attachments.js`, `node-coordinator-mail.js`, `pr.js` and
  `usage-limit-account-routing.js`. The coordinator's MCP tools in
  `control-mcp/` stay there. See "Assumptions and decisions".
- Done (task 2's `agent-accounts` slice, 2026-11-20, against `main` at
  `e102a0dd5`): the 15 `agent-accounts*` source files and their 23 tests are
  in `core/agent-accounts/` without the prefix (`agent-accounts/active.ts`,
  `agent-accounts/auto-switch.ts`, `agent-accounts/containers.ts`,
  `agent-accounts/store.ts`, …), and `agent-accounts.ts` itself is
  `agent-accounts/accounts.ts`. `index.ts` re-exports 43 symbols from five
  modules (`active.ts`, `auto-switch.ts`, `containers.ts`, `login.ts`,
  `usage-sharing.ts`), and 31 of the 40 production importers outside the
  folder import it. Seven modules are named exceptions in the
  `apps/backend/src/**` pattern and are not re-exported, because routing
  them through `index.ts` closes a runtime cycle: `accounts.js`,
  `machines.js`, `session.js` and `runtime.js`, which reach the command
  layer or `plan-usage/reader.ts`, and `store.js`, `homes.js` and
  `auto-switch-notices.js`, whose importers (the storage layer,
  `permission-rules/`, `coordinator/notice-router.ts`, …) the re-exported
  modules reach. See "Assumptions and decisions".
- Done (task 2's `workflows` slice, 2026-11-20, against `main` at
  `7fd328b8c`): 16 of the 17 `workflow-*` source files and 14 of their 17
  tests are in `core/workflows/` without the prefix
  (`workflows/supervisor.ts`, `workflows/poll-gate.ts`,
  `workflows/artifact-turns.ts`, `workflows/transcript-artifacts.ts`,
  `workflows/result-service.ts`, `workflows/result-tools.ts`,
  `workflows/result-contracts.ts`, …), with an `index.ts` and both lint
  patterns. `workflow-tab-actions.ts`, which opens a Multi Review tab, stays
  at the root for the `review` slice, and three tests of root modules stay
  beside them (`workflow-account-handoff.test.ts`,
  `workflow-dispatch-observation.test.ts`,
  `workflow-vocabulary-commands.test.ts`). `index.ts` re-exports 46 symbols
  from twelve modules, and 41 of the 42 production importers outside the
  folder import it. One module is a named exception in the
  `apps/backend/src/**` pattern and is not re-exported:
  `result-final-text.js`, which `review-consolidation-scope.ts` (since the
  `review` slice, `review/consolidation-scope.ts`) imports directly, because
  the result contracts reach that file. See "Assumptions and decisions".
- Done (task 2's `review` slice, 2026-11-20, against `main` at
  `05f3db2d8`): the 48 `multi-review-*` and `review-*` source files (seven
  test-support and fixture files included) and their 55 tests, with
  `workflow-tab-actions.ts` and `retired-looped-review-cleanup.ts` and its
  test, are in `core/review/` (`review/service.ts`, `review/graph-engine.ts`,
  `review/fanout.ts`, `review/package.ts`, `review/validation-service.ts`,
  `review/consolidation-scope.ts`, …). The `multi-review-` and `review-`
  prefixes were dropped, except that `multi-review-prompts.ts` keeps its name
  because `review-prompts.ts` became `review/prompts.ts`;
  `workflow-tab-actions.ts` is `review/tab-actions.ts`, and
  `retired-looped-review-cleanup.ts` keeps its name. `index.ts` re-exports 68
  symbols from 19 modules, and 41 of the 50 production importers outside the
  folder import it. Eight modules are named exceptions in the
  `apps/backend/src/**` pattern and are not re-exported, because routing
  their importers through `index.ts` closes a runtime cycle: `service.js`,
  `graph-engine.js`, `address-findings-dispatch.js`,
  `retired-looped-review-cleanup.js`, `fanout.js` and
  `validation-service.js`, which reach the graph runtime, the workflow result
  contracts and the coordinator's status wakes, and `validation-prompts.js`
  and `consolidation-scope.js`, which `build-pipeline/prompts.ts` imports
  and `multi-review-prompts.ts` reaches. `validation-prompts.js` is also the
  one exception in the `tests/unit/**` pattern. The build pipeline's own
  `build-pipeline-review-*` files (since the `build-pipeline` slice,
  `build-pipeline/review-*.ts`), the review commands and the review stores
  stay outside `review/`. See "Assumptions and decisions".
- Done (task 2's `build-pipeline` slice, 2026-11-20, against `main` at
  `11fca66ca`): the 57 `build-pipeline-*` source files (seven test-support
  and fixture files included) and their 66 tests, with
  `control-workflow-summary.ts` and its test and the three
  `pipeline-worker-*` files, are in `core/build-pipeline/`
  (`build-pipeline/service.ts`, `build-pipeline/provider.ts`,
  `build-pipeline/prompts.ts`, `build-pipeline/review-fanout.ts`,
  `build-pipeline/transcript-store.ts`, …). The `build-pipeline-` prefix was
  dropped; `control-workflow-summary.ts` and the `pipeline-worker-*` files
  keep their names. `index.ts` re-exports 66 symbols from 20 modules, and 37
  of the 59 production importers outside the folder import it. Seven modules
  are named exceptions in the `apps/backend/src/**` pattern and are not
  re-exported, because each reaches, at runtime, a module that imports one
  of the modules re-exported there: `service.js`, `provider.js`,
  `launch.js`, `worker-mail.js`, `transcript-projection.js`,
  `key-information-tools.js` and `control-workflow-summary.js`. Under
  `tests/unit/**`, `handoff.js` and `service-helpers.js` are exceptions for
  the one `tests/unit` importer. The three review exceptions this slice was
  to re-check (`review/fanout.js`, `review/validation-prompts.js`,
  `review/consolidation-scope.js`) all still close a cycle and stay.
  Auto-pipeline (`auto-pipeline*.ts`), the build-pipeline store and the
  build commands stay at the root. Wave 2 has one domain left,
  `native-agent`. See "Assumptions and decisions".
- Done (task 2's `native-agent` slice, 2026-11-20, against `main` at
  `9a5a84f63`): the 79 `native-agent-*` source files (three test-support
  files and the test-only `service-test-collaborators.ts` included) and their
  122 tests, with `native-terminal-messages.ts` and its test and
  `workflow-account-handoff.test.ts`, are in `core/native-agent/`
  (`native-agent/service.ts`, `native-agent/provider.ts`,
  `native-agent/prompt-dispatch.ts`, `native-agent/transcript-projection.ts`,
  `native-agent/goal-service.ts`, …). The `native-agent-` prefix was dropped;
  `native-terminal-messages.ts` is `native-agent/terminal-messages.ts`, and
  `workflow-account-handoff.test.ts` keeps its name. `index.ts` re-exports 27
  symbols from 14 modules, and 26 of the 51 production importers outside the
  folder import it (27 of 52 after rebasing onto `a01039913`, whose
  `rich-interactions/index.ts` imports the session key through it). Nine modules are named exceptions in the
  `apps/backend/src/**` pattern and are not re-exported: eight because each
  reaches, at runtime, a module that imports one of the modules re-exported
  there (`service.js`, `service-shared.js`, `provider.js`, `suborks.js`,
  `goal-check.js`, `goal-verifier.js`, `job-tab-reuse.js`,
  `job-pipeline-resolve.js`), and `service-test-collaborators.js`, test-only
  support that `public-api/test-provider.ts` imports. Under `tests/unit/**`,
  `service-projection-test-support.js` is the one exception. The earlier
  exceptions that name native-agent files (`git/pr-auto-merge-resolve-settled.js`,
  `web-annotations/store-layout.js` and `web-annotations/tools.js`) all still
  close a cycle and stay. The session stores (`storage-native*.ts`), the
  native commands (`commands-registry-native*.ts`) and
  `native-session-invalidation-metrics.ts` stay at the root. Wave 2 is done;
  wave 3 is next. See "Assumptions and decisions".
- Done (task 3's `recurring` slice, 2026-11-22, against `main` at
  `dd1391427`): the four `recurring-*` source files and their three tests
  are in `core/recurring/` without the prefix (`recurring/scheduler.ts`,
  `recurring/work-metrics.ts`, `recurring/diagnostics.ts`,
  `recurring/test-support.ts`, `recurring/scheduler.test.ts`,
  `recurring/work-metrics.test.ts`, `recurring/diagnostics-caches.test.ts`),
  with an `index.ts` and both lint patterns. `index.ts` re-exports 20
  symbols from three modules, and 49 of the 50 production importers outside
  the folder import it. Two modules are named exceptions in the
  `apps/backend/src/**` pattern: `work-metrics.js`, which
  `native-session-invalidation-metrics.ts` imports directly because
  `diagnostics.ts` reads those metrics at runtime (routing it through
  `index.ts` closes a cycle; the module is still re-exported for everyone
  else), and `test-support.js`, which `review/fanout-interleaving-support.ts`
  imports (test support whose name the tests-off override does not match).
  The `tests/unit/**` pattern has no exception. The owners that schedule
  recurring work (`backend-activity-jobs.ts`, `work-admission.ts`,
  `machine-load.ts`, `host-suspend-detector.ts`, …) and
  `native-session-invalidation-metrics.ts` stay at the root. Wave 3 is in
  progress: `terminals`, `tmux`, `containers`, `environments` and `storage`
  are left, one change each. See "Assumptions and decisions".
- Done (task 3's `tmux` slice, 2026-11-22, against `main` at
  `81a501415`): the 14 `tmux*` source files and their 14 tests are in
  `core/tmux/` without the prefix (`tmux/session-manager.ts`,
  `tmux/backend.ts`, `tmux/hooks.ts`, `tmux/poll.ts`, `tmux/runtime.ts`,
  `tmux/commands.ts`, …). The root barrel `tmux.ts`, which re-exported seven
  modules with `export *`, became `tmux/index.ts` with explicit named
  re-exports: 17 symbols from six modules, and all 11 production importers
  outside the folder import it. Neither lint pattern has an exception: no
  runtime cycle results, and no `tests/unit` file imports the domain. The
  eight `apps/backend/tests` files that imported the old barrel now import
  each symbol from its own module. `claude-state-signal.ts` (both container
  doorbells' install), `local-server-reaper.ts`, the command registry file
  that installs the `claude_tmux_*` handlers (`commands-registry-teardown.ts`)
  and the other `commands-*`, `container-*` and `environment-*` callers stay
  at the root.
  Wave 3 is in progress: `terminals`, `containers`, `environments` and
  `storage` are left, one change each. See "Assumptions and decisions".
- Done (task 3's `terminals` slice, 2026-11-22, against `main` at
  `3030e84a2`): the six `terminal-*` source files and their 11 tests are in
  `core/terminals/` without the prefix (`terminals/runtime.ts`,
  `terminals/history.ts`, `terminals/history-scanners.ts`,
  `terminals/parse-scheduler.ts`, `terminals/size-ownership.ts`,
  `terminals/history-test-support.ts`, `terminals/history-part-1.test.ts`,
  …), with an `index.ts` and both lint patterns. `index.ts` re-exports five
  symbols from two modules (`runtime.ts`, `history.ts`), and all six
  production importers outside the folder import it. Neither lint pattern has
  an exception. The two `transcript-*` files the table also listed are not
  terminal code: `transcript-progress.ts` (the supervisors' bounded
  transcript progress samples) and `transcript-media-pins.ts` (saved copies
  of the images transcript messages showed) moved, keeping their names, into
  `core/native-agent/` with their three tests, and `native-agent/index.ts`
  re-exports the ten symbols their eight outside importers use, with no new
  exception. The terminal command files (`commands-terminal*.ts`,
  `commands-registry-terminal.ts`), `pty.ts`, `container-terminal-shell.ts`
  and `setup-terminal-attempt.ts` stay at the root. Wave 3 is in progress:
  `containers`, `environments` and `storage` are left, one change each. See
  "Assumptions and decisions".
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
  and 842, after the `web-annotations` slice on 2026-11-11 it holds 883
  and 925, after OpenCode 1.x's retirement and the `control-mcp` slice
  on 2026-11-11 it holds 803 and 852, after the `plan-usage` slice on
  2026-11-13 it holds 806 and 856, and after the `features` slice on
  2026-11-14 it holds 807 and 867, down from 812 and 871 just before it,
  and after the `previews` slice on 2026-11-16 it holds 813 and 875, down
  from 821 and 887 just before it, and after the `opencode` slice on
  2026-11-16 it holds 811 and 876, down from 822 and 885 just before it,
  and after the `worktrees` slice on 2026-11-17 it holds 803 and 866, down
  from 811 and 877 just before it, and after the `git` slice on 2026-11-18
  it holds 789 and 851, down from 820 and 879 just before it, and after the
  `coordinator` slice on 2026-11-20 it holds 754 and 809, down from 812 and
  871 just before it, and after the `agent-accounts` slice on 2026-11-20 it
  holds 739 and 786, down from 754 and 809 just before it, and after the
  `workflows` slice on 2026-11-20 it holds 726 and 776, down from 742 and
  790 just before it, and after the `review` slice on 2026-11-20 it holds
  679 and 723, down from 729 and 779 just before it, and after the
  `build-pipeline` slice on 2026-11-20 it holds 619 and 655, down from 679
  and 723 just before it, and after the `native-agent` slice on 2026-11-20
  it holds 539 and 531, down from 619 and 655 just before it; 541 and 531
  once rebased onto `a01039913`, which added two root files; and after the
  `recurring` slice on 2026-11-22 it holds 541 and 530, down from 545 and
  533 just before it; and after the `tmux` slice on 2026-11-22 it holds 528
  and 516, down from 542 and 530 just before it; and after the `terminals`
  slice on 2026-11-22 it holds 520 and 502, down from 528 and 516 just
  before it).
- Prefix counts at the root:

  | Domain | Prefixes | Source | Tests |
  | --- | --- | ---: | ---: |
  | opencode | `opencode-*`, `opencode2-*` | done (11 / 9 moved into `opencode2/`, 2026-11-16) | |
  | web-annotations | `web-annotation-*` | done (29 / 27 moved, 2026-11-11) | |
  | http-bridge | `http-bridge-*` | done (20 / 20 moved, 2026-11-06) | |
  | control-mcp | `control-mcp-*` | done (40 / 29 moved, 2026-11-11) | |
  | keyed-records | `keyed-record-*` | done (1 / 0 placed in the kernel, 2026-11-13) | |
  | plan-usage | `plan-usage*` | done (2 / 3 moved, 2026-11-13) | |
  | features | `feature-*` | done (5 / 4 moved, 2026-11-14) | |
  | coordinator | `coordinator-*` | done (58 / 62 moved, 2026-11-20) | |
  | agent-accounts | `agent-accounts*` | done (15 / 23 moved, 2026-11-20) | |
  | worktrees | `worktree-*` | done (8 / 11 moved, 2026-11-17) | |
  | previews | `preview-*` | done (8 / 12 moved, 2026-11-16) | |
  | git | `git-*`, `github*`, `pr-*` | done (31 / 28 moved, 2026-11-18) | |
  | workflows | `workflow-*` | done (16 / 14 moved, 2026-11-20) | |
  | review | `multi-review-*`, `review-*`, `retired-looped-review-cleanup.ts`, `workflow-tab-actions.ts` | done (50 / 56 moved, 2026-11-20) | |
  | build-pipeline | `build-pipeline-*`, `control-workflow-summary.ts`, `pipeline-worker-*` | done (60 / 68 moved, 2026-11-20) | |
  | native-agent | `native-agent-*`, `native-terminal-messages.ts`, `workflow-account-handoff.test.ts` | done (80 / 124 moved, 2026-11-20) | |
  | terminals | `terminal-*`, `transcript-*` | done (6 / 11 moved into `terminals/`, 2 / 3 into `native-agent/`, 2026-11-22) | |
  | tmux | `tmux*` | done (14 / 14 moved, 2026-11-22) | |
  | recurring | `recurring-*` | done (4 / 3 moved, 2026-11-22) | |
  | containers | `container-*`, `docker-*` | 47 | 27 |
  | environments | `environment-*` | 18 | 18 |
  | storage | `storage*` | 85 | 105 |
  | commands | `commands*` | 87 | 85 |
  | (unplaced) | `pi-model-catalog-seeding.ts` | 1 | 1 |
  | (unplaced) | `auto-pipeline*.ts` | 3 | 2 |

  The wave 3, `commands` and unplaced rows were re-counted on 2026-11-20 at
  `9a5a84f63`, after the `native-agent` slice; their earlier figures dated
  from the plan; the `storage` and `commands` rows were re-counted on
  2026-11-22 at `dd1391427`, before the `recurring` slice; and every open
  row was re-counted on 2026-11-22 at `81a501415`, before the `tmux` slice
  (only `commands` changed, from 86 to 87 source files), and again at
  `3030e84a2`, before the `terminals` slice (none changed). These are file
  counts only. Importer and dependency counts go stale within a
  day, so each slice re-measures them (step 1 below).
- `keyed-record-*` is now one file, `keyed-record-format.ts`: the keyed-record
  engine went with #969. Its importers are two `build-pipeline/transcript-*.ts`
  files and `transcript-artifacts/store.ts`, so it stays in the shared kernel
  (2026-11-13).
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
  any `^`/`~` steps; a path after any other `word:` is rewritten. Since
  2026-11-22 it also leaves a path inside a commit-pinned GitHub permalink
  (`github.com/<owner>/<repo>/blob/<sha>/apps/…`, likewise `tree/` and
  `raw/`, and `raw.githubusercontent.com/<owner>/<repo>/<sha>/apps/…`) under
  its old name. It compares the complete GitHub hostname case-insensitively
  and uses the source file's repository-relative path to read the full ref.
  It preserves 7–40 character hex SHAs, explicit `refs/tags/` and tags
  available locally for `origin`. For refs absent from the local checkout,
  it recognises version tags with an optional `v` and prerelease or build
  suffix. Explicit `refs/heads/` and known branches still follow the file.
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

1. **Wave 1 (leaves):** done. (An `index.ts` and both lint patterns for
   `mcp-management/` and `public-api/`; the `http-bridge`,
   `web-annotations`, `control-mcp` and `opencode` moves;
   `keyed-record-format.ts` placed in the shared kernel.)
2. **Wave 2 (mid-tier):** done. (`plan-usage`, `features`, `previews`,
   `worktrees`, `git`, `coordinator`, `agent-accounts`, `workflows`,
   `review`, `build-pipeline` and `native-agent`.)
3. **Wave 3 (hubs), in progress:** `recurring`, `tmux` and `terminals` are
   done (2026-11-22); `containers`, `environments` and `storage` are left,
   one PR each. Many files import these, and `containers` is
   also imported from outside `core/` (as `previews` was), so these slices
   touch the most files.
4. **Last: `commands`.** It depends on most other domains. Its former
   `commands-runtime-state.ts` was deleted by todo 0011;
   the state now lives in `BackendRuntime` (`backend-runtime.ts`,
   `terminals/runtime.ts`, `local-server-runtime.ts`,
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
     and revert any other revision spelling it rewrote. It likewise leaves
     commit-pinned GitHub permalinks alone; grep the diff for `/blob/`,
     `/tree/` and `/raw/` and revert a pinned link it rewrote with another
     revision spelling;
   - it does not rewrite bare file names (`` `http-bridge-provider.ts` ``) in
     source comments, living docs, `AGENTS.md` globs, or file-name lists that
     tests read by path (`agent-provider-boundaries.test.ts`). Grep for the old
     prefix afterwards; leave dated reports and flake records as they are;
   - it does not rewrite paths a moved file builds from its own location
     (`path.join(import.meta.dir, "../../../..")` to reach the repository
     root, `scripts/` or `bridges/`): a file one folder deeper needs one
     more `../`. Grep the moved files for `import.meta.dir` and `__dirname`;
   - it leaves `tests/source-guards/baseline.json` out of order when it
     renames an entry there; regenerate that guard with
     `bun tests/source-guards/update-baseline.ts --guard <id>` (`mise run
     guards` fails otherwise).
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
   (`host-model-catalog-refresh.test.ts` fails otherwise). For focused backend
   runs through `mise run test:logged`, pass `--cwd apps/backend` to `bun test`
   so the preload and test filters resolve in the backend package.
6. **Merge quickly** and announce it, so open branches rebase promptly.

Done when:

- every domain above is a folder with an explicit `index.ts` and an
  enforcement pattern, and `mise run lint` is clean;
- the `core/` root holds only the shared kernel and `index.ts` (the backend
  composition root);
- the type-level cycle has been re-measured and recorded.

## Assumptions and decisions

Decisions taken while doing tasks 5 and 6 (2026-10-28), task 1's
`index.ts` step (2026-11-03), task 1's `http-bridge` slice (2026-11-06),
task 1's `web-annotations` slice with the codemod fix from todo 7490
(2026-11-11), to-do 7800 and task 1's `control-mcp` slice (2026-11-11), and task 1's
`keyed-record-format.ts` placement with task 2's `plan-usage` slice
(2026-11-13), task 2's `features` slice (2026-11-14), task 2's
`previews` slice (2026-11-16), task 1's `opencode` slice (2026-11-16),
task 2's `worktrees` slice (2026-11-17), task 2's `git` slice
(2026-11-18), task 2's `coordinator` slice (2026-11-20), task 2's
`agent-accounts` slice (2026-11-20), task 2's `workflows` slice
(2026-11-20), task 2's `review` slice (2026-11-20), task 2's
`build-pipeline` slice (2026-11-20), task 2's `native-agent` slice
(2026-11-20), task 3's `recurring` slice with the codemod's permalink
fix (2026-11-22), task 3's `tmux` slice (2026-11-22), and task 3's
`terminals` slice (2026-11-22).
The other moves in waves 3 and 4 (tasks 3 and 4) were left open on purpose:
they move many files that other work in flight touches.

### Task 3: `terminals` as the third wave 3 slice

- Chosen: one domain, `terminals`, moved with
  `bun scripts/move-backend-modules.ts --prefix terminal- --into terminals`
  against `main` at `3030e84a2` (run under the pinned Bun, `mise exec --
  bun …`, as in the `tmux` slice). Every file dropped the prefix
  (`terminal-runtime.ts` → `terminals/runtime.ts`,
  `terminal-history-part-1.test.ts` → `terminals/history-part-1.test.ts`);
  no two moved files map to the same name. The two `transcript-*` files
  moved in a second codemod run with `--map`, into `native-agent/` under
  their own names (see membership below); `native-agent/` had no
  `transcript-progress*` or `transcript-media-pins*` file, so nothing
  collided. The folder is `terminals/`, plural, as the domain row names it,
  so its pattern does not catch the renderer's `components/terminal/`.
- Membership. The `terminal-*` files are the backend's terminal sessions:
  the runtime slice (`runtime.terminals`, every live PTY session, its
  bounded output buffer and activity settling), durable terminal history
  and its two helpers (the headless parse budget and the control-sequence
  scanners), size ownership, and the history tests' harness. Edge cases,
  each decided here:
  - `transcript-*` went into `native-agent/`, not `terminals/`. Options:
    (a) `native-agent/` (chosen): `transcript-progress.ts` samples a native
    agent provider's bounded transcript snapshot (`ProviderTranscriptSnapshot`
    on `NativeAgentRuntimeProvider`) for the review and pipeline
    supervisors, and `transcript-media-pins.ts` keeps the saved copies of the
    images a native transcript message showed, which
    `native-agent/tool-detail-reads.ts` already read; neither touches a
    terminal. (b) `terminals/`, as the table's row said: one folder for the
    whole row, but it would make the review and pipeline supervisors, the
    environment deletion and the media command depend on the terminals
    domain for transcript code. (c) Leave both at the root as unplaced:
    no domain grows, but the root keeps two files with no owner and a later
    slice has to decide again. (d) `transcript-progress.ts` into
    `build-pipeline/` (it imports `legacyTranscriptFingerprint` from
    there): three of its six importers are pipeline files, but the other
    three are review and branch observation, and the media pins would still
    need a home. With (a), `native-agent/index.ts` re-exports the ten symbols
    their eight production importers outside the folder use, and
    `bunx oxlint apps/backend/src` reports no `import(no-cycle)` (a probe,
    reverted, that made `native-agent/transcript-media-pins.ts` import
    `backend-runtime.ts` reported 652, so the check sees cycles through that
    `index.ts`). (e) `transcript-artifacts/` for the media pins: it holds
    the transcript artifacts and their media streams, but the pins' one
    production reader inside a domain folder is
    `native-agent/tool-detail-reads.ts`, and their store is keyed by
    conversation and message, so `native-agent/` keeps that read inside one
    folder.
  - Terminal files without the prefix stay at the root:
    `commands-terminal*.ts` and `commands-registry-terminal.ts` (the
    `commands` slice), `container-terminal-shell.ts` (the `containers`
    slice), `pty.ts` (the PTY wrapper the runtime, the environment commands
    and the setup terminal share) and `setup-terminal-attempt.ts`. Options:
    (a) leave them (chosen): the ticket keeps commands and containers files
    at the root, and moving the other two would widen a prefix move into a
    regrouping, as the `recurring` slice also decided; (b) move `pty.ts` and
    `setup-terminal-attempt.ts` in: closer to a complete terminals domain,
    but not `terminal-*` files, and `pty.ts` is also a commands dependency.
  - No `terminal-*` file is really tmux code: the claude-tmux pane terminal
    is already `tmux/interactive.ts`, and `tmux/session-manager.ts` only
    takes the runtime's type, now through `terminals/index.ts`.
  - The protocol's `terminal-history.ts`, `terminal-size-ownership.ts`,
    `terminal-websocket.ts` and `transcript-media-pins.ts`, the renderer's
    `components/terminal/` and `apps/backend/tests/terminal-*` keep their
    names: they are outside `core/`.
- Measured before the move: see task 3's investigation. The codemod moved
  17 files and rewrote 42 for `terminal-`, and moved 5 and rewrote 17 for
  the map. No worker or bundle entry point names a moved file, no
  `<revision>:<path>` string did, and no GitHub permalink did. One
  slow-tier glob named moved tests (`src/core/terminal-history-part-*.test.ts`);
  it is now `src/core/terminals/history-part-*.test.ts`, which matches the
  same four files. The codemod rewrote one `tests/source-guards/baseline.json`
  entry (`terminals/history-part-2.test.ts`), which stays in order. It
  rewrote the "Owner moved" lines of flake records 0213 and 0954, which name
  where the test is now, not a recorded command, so the rewrites stay, as in
  the earlier slices.
- `index.ts` holds five symbols from two modules (`TerminalRuntime`,
  `TerminalRuntimeOptions`, `TerminalOutputBuffer`, `TerminalSessionConfig`
  from `runtime.ts`, and the `TerminalHistory` type from `history.ts`). All
  six production importers in `apps/backend/src` import it
  (`backend-runtime.ts`, `commands-environment.ts`,
  `commands-registry-terminal.ts`, `commands-terminal.ts`,
  `setup-terminal-attempt.ts`, `tmux/session-manager.ts`). Tests, the
  `apps/backend/tests` files, `apps/backend/scripts/terminal-latency.ts` and
  `scripts/benchmark-terminal-history.ts` keep deep imports (procedure step
  3).
- Named exceptions: none, in either override. With every production
  importer routed through `index.ts`, `bunx oxlint apps/backend/src` reports
  no `import(no-cycle)` and no restricted import; a probe file
  deep-importing `terminals/history.js` was reported by the new pattern.
  Options: (a) no exception (chosen): the smallest set is empty;
  (b) keep `backend-runtime.ts` and the command files deep as before: nothing
  requires it. The `apps/backend/src/**` pattern also carries
  `!@orkestrator/protocol/contract/domains/terminals/*`: the protocol has a
  `contract/domains/terminals/` folder, and the backend imports its barrel
  (`@orkestrator/protocol/contract/domains/terminals`), so a future import of
  one of its files would otherwise be reported as a deep import of this
  domain (as the `change-tracking` pattern skips the protocol's
  `node/change-tracking/*`). It is a collision guard, not a deep-import
  exception. The reasons are written in `index.ts`'s header and in
  `docs/development/linting.md`.
- Paths built from a moved file's own location: no moved file uses
  `import.meta.dir`, `import.meta.url` or `__dirname`.
  `terminals/runtime.test.ts`'s import of `tests/helpers/controlled-timeout.js`
  gained one `../`, which the codemod re-relativised.
  `scripts/efficiency/workloads-supervision.ts` loads
  `transcript-progress.ts` by repository path through `loadOptional`; the
  codemod rewrote both strings to `native-agent/transcript-progress.ts`.
  The efficiency harness falls back to `core/transcript-progress.ts` within
  the measured root when it predates the move.
  `apps/backend/scripts/terminal-latency/producer.ts` prints
  `apps/backend/src/core/terminal-history.ts` as fake build output; the
  codemod's rewrite of that string was reverted, because it is benchmark
  load text, not a reference, and changing it would change the producer's
  bytes.
- Hand fixes after the codemod: bare file names in source comments (the
  moved files' own headers, which now name their siblings without a folder;
  `commands-registry-terminal.ts`, `terminal-websocket-server.ts`,
  `apps/backend/tests/commands-terminal-size-ownership.test.ts`,
  `apps/backend/tests/terminal-websocket-size-ownership.test.ts` and
  `e2e/agent-testing/terminal-size-ownership.spec.ts` for size ownership;
  `agent-branch-observation.ts`, `build-pipeline/index.ts`,
  `review/fanout-transcript.ts` and `review/progress.ts` for progress
  samples), living docs (`backend-runtime.md`, `native-transcripts.md`,
  `rich-transcripts.md`, `terminal-latency.md`) and to-do 8312's
  `terminal-parse-scheduler.ts` and `terminal-history.ts` now read
  `terminals/<name>.ts` or `native-agent/<name>.ts`. Left alone: bare names
  in the protocol that mean the protocol's own `terminal-size-ownership.ts`
  and `transcript-media-pins.ts`, the history tests' note that they were
  split from `terminal-history.test.ts`, the data-directory names
  `terminal-history` and `transcript-media-pins`, `test-wait-review.md`'s
  dated table, flake records' prose, and the earlier slices' entries in this
  section. `native-agent/index.ts`'s header names the two new modules.
  `docs/development/linting.md`'s folder list names the new folder and says
  why it has no exception. The area index's 0012 row records `terminals` as
  done.
- Lint patterns: `**/terminals/*` with `!**/terminals/index.js` and
  `!@orkestrator/protocol/contract/domains/terminals/*` under
  `apps/backend/src/**`, and `**/backend/src/core/terminals/*` with
  `!…/index.js` under `tests/unit/**`. The `native-agent` patterns are
  unchanged.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, the slow tier, `verify:packaged-backend`) is
  agent work for the validation stage, so nothing was added to the
  manual-test checklist (7568).

### Task 3: `tmux` as the second wave 3 slice

- Chosen: one domain, `tmux`, moved with
  `bun scripts/move-backend-modules.ts --map <file>` against `main` at
  `81a501415`. A map file was needed because the root barrel `tmux.ts` has
  no `tmux-` prefix to drop; the map sends it to `tmux/index.ts` and every
  `tmux-*` file to `tmux/<name>` without the prefix
  (`tmux-session-manager.ts` → `tmux/session-manager.ts`,
  `tmux-poll-doorbell.test.ts` → `tmux/poll-doorbell.test.ts`). No two moved
  files map to the same name. No backend import path had a `tmux/` segment:
  the protocol's `tmux-prompt` and `tmux-observation` modules, the renderer's
  `claude-tmux-*` files and the contract's `domains/claude-tmux/` folder have
  none, so `**/tmux/*` catches nothing else. The codemod must run under the
  pinned Bun (`mise exec -- bun …`): an older `bun` on `PATH` has no
  `bun fmt` and fails after the rewrites, which the reset in procedure step
  2 undoes.
- Membership: the claude-tmux mode, which is exactly the `tmux*` files
  (sessions and their poll loop, the tmux/`docker exec` backend, hooks and the
  hook doorbell, the per-container state poll, the interactive pane terminal
  and its clipboard clients, transcript reads, the process census, the
  runtime slice and the command handlers). Edge cases, each decided here:
  - `tmux.ts` became `tmux/index.ts`. Options: (a) replace it with the
    folder's `index.ts` (chosen): it already was the domain's barrel, and
    its importers keep one entry point; (b) keep it at the root beside a new
    `index.ts`: a second public surface, and its `export *` is what the
    procedure forbids. The old barrel re-exported every symbol of seven
    modules; `index.ts` names only the 17 that production importers outside
    the folder use. Eight `apps/backend/tests` files and
    `local-server-reaper.test.ts` used other symbols through the barrel and
    now import them from their own modules (procedure step 3); no test
    changed otherwise.
  - `claude-state-signal.ts` stays at the root. Options: (a) leave it
    (chosen): it installs both container doorbells (the Claude state signal
    and the tmux hook doorbell), and its importers include `agent-tools.ts`
    and the container signal installs, not only tmux files; (b) move it in:
    it is not a `tmux*` file, and its container importers would reach into
    the folder.
  - `local-server-reaper.ts` stays at the root. It reaps local servers and
    tmux sessions alike and only reads the session-name helpers, through
    `index.ts`.
  - `tmux/commands.ts` (the `claude_tmux_*` handlers) moved, not left for the
    `commands` slice. Options: (a) move it (chosen): it has the prefix, and
    the handlers and environment teardown are the domain's own;
    (b) leave it with the `commands*` files: its name does not start with
    `commands`, so it would stay unplaced. `commands-registry-teardown.ts`,
    which registers it, stays at the root for the last slice.
  - The renderer's `claude-tmux-*` and `ClaudeTmux*` files, the protocol's
    `tmux-*` modules and `apps/backend/tests/tmux-*` and
    `apps/backend/scripts/tmux-*` keep their names: they are outside `core/`.
- Measured before the move: see task 3's investigation. The codemod moved 28
  files and rewrote 85. No worker or bundle entry point names a moved file,
  no `<revision>:<path>` string did, and no GitHub permalink did. One
  slow-tier glob named the moved tests (`src/core/tmux*.test.ts`); it is now
  `src/core/tmux/*.test.ts`, which matches the same 14 files.
  `tests/source-guards/baseline.json` names only
  `apps/backend/tests/tmux-poll.test.ts`, which did not move.
  The codemod rewrote two flake records' `apps/backend/src/core/tmux.ts:331`
  and `tmux.ts:2013` (stack locations recorded on 2026-08-07 and
  2026-08-15 in the 4,322-line `tmux.ts` that #417 split into the barrel on
  2026-08-16) to `tmux/index.ts`; both were restored, with no current-path
  note, because no current file holds that code under one name. Its rewrite of `tmux-shared.ts` in the cause prose of flake records
  0236, 0245 and 0786 stays, as in the `recurring` slice.
- `index.ts` holds 17 symbols from six modules (`commands.ts`,
  `hook-signal.ts`, `hooks.ts`, `poll.ts`, `runtime.ts`, `shared.ts`). All
  11 production importers in `apps/backend/src` import it, including the
  five that imported modules directly before (`backend-runtime.ts` for
  `TmuxRuntime`, `claude-state-signal.ts`, `commands-review.ts`,
  `environment-move.ts` and `root-changes.ts`); `claude-state-signal.ts`'s two
  imports became one. Tests and test support, the `apps/backend/tests` and
  `apps/backend/scripts` files keep deep imports (procedure step 3).
  `environment-move.test.ts` and `environment-move.recovery.test.ts` spy on
  `cleanupEnvironmentTmux` through the `tmux/commands.js` namespace while
  `environment-move.ts` now imports it through `index.ts`; both files pass,
  so the spy still reaches the caller through the re-export.
- Named exceptions: none, in either override. Checked with `bunx oxlint
  apps/backend/src`: with every production importer routed through
  `index.ts` it reports no `import(no-cycle)` and no restricted import. A
  probe (reverted) that made `tmux/shared.ts` import `backend-runtime.ts`
  reported 122 `import(no-cycle)` errors, so the check does see cycles
  through this `index.ts`; a probe file deep-importing `tmux/backend.js` was
  reported by the new pattern. Options: (a) route every importer through
  `index.ts` with no exception (chosen): the smallest set is empty;
  (b) keep the five direct importers deep as exceptions, as they were before
  the move: nothing requires it. The reason is written in `index.ts`'s
  header and in `docs/development/linting.md`.
- Paths built from a moved file's own location: no moved file uses
  `import.meta.dir`, `import.meta.url` or `__dirname`.
  `apps/backend/scripts/tmux-exec-count.ts` loads the session manager and
  backend from a `--src` directory (`core/tmux-session-manager.ts`, which
  the codemod rewrote to `core/tmux/session-manager.ts`). Its documented use
  is measuring another checkout's sources for before numbers, which are
  pre-move sources, so it now takes `core/tmux/<name>.ts` and falls back to
  `core/tmux-<name>.ts` when that is absent. Options: (a) the fallback
  (chosen): both layouts load, checked against this tree and a `git archive`
  of `81a501415`; (b) the codemod's rewrite alone: a pure path change, but
  `--src` on any pre-move checkout would fail with a missing module.
- Hand fixes after the codemod: bare `tmux-*.ts` file names in source
  comments (`claude-state-signal.ts`, `commands-context.ts`,
  `container-worktree-signal.ts`, four moved files, which now name their
  sibling `hook-signal.ts` without a folder,
  `apps/backend/tests/tmux-transcript-reopen-docker.test.ts` and the
  protocol's `contract/domains/claude-tmux/commands.ts`), living docs under
  `docs/architecture/` (`agent-engines.md`, `backend-runtime.md`,
  `change-tracking.md`, `container-lifecycle.md`, `environment-deletion.md`,
  `environment-isolation.md`, `platform-inconsistencies.md`,
  `recurring-work.md`) and to-dos 0030, 0048 and 5120 now read
  `tmux/<name>.ts`. Where the codemod turned `core/tmux.ts` into
  `core/tmux/index.ts` in prose that means the whole mode (`AGENTS.md`'s
  backend key-files table, `agent-engines.md`, `upgrade-agents.md`), and
  where `platform-inconsistencies.md` named `core/tmux-*.ts`, the text now
  names the folder, `apps/backend/src/core/tmux/`. Left alone: recurring-work
  kinds and capability names that look like file names (`tmux-poll`,
  `tmux-interactive-capture`, `tmux-hook-signal=1`), the test harness's note
  that it was split out of `tmux-backend.test.ts`, flake-record commands,
  dated plan logs under `plans/`, and the earlier slices' entries in this
  section. `docs/development/linting.md`'s folder list names the new folder
  and says why it has no exception. The area index's 0012 row records
  `tmux` as done.
- Lint patterns: `**/tmux/*` with `!**/tmux/index.js` under
  `apps/backend/src/**`, and `**/backend/src/core/tmux/*` with `!…/index.js`
  under `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, the slow tier, `verify:packaged-backend`) is
  agent work for the validation stage, so nothing was added to the
  manual-test checklist (7568).

### Task 3: the codemod skips commit-pinned GitHub permalinks

- Chosen: identify the exact GitHub hostname and separate the full ref from
  the moved file's repository-relative path. Explicit tags and SHAs protect
  historical paths even in shallow checkouts. Local tags and heads are
  associated with `origin`, and remote-tracking heads with their configured
  remote. Unresolved version tags use the version-spelling fallback.
- Why: the `native-agent` slice restored a link pinned to a commit after the
  codemod moved its historical path. Review of the initial look-behind found
  that it also rewrote some release tags, misread a tag-shaped branch prefix
  and treated hostnames inconsistently.
- Options: (a) use repository-relative paths and locally available refs
  (chosen). This handles slashed refs and works offline; an arbitrary
  unqualified tag outside the local refs needs an explicit `refs/tags/`
  link to be recognised. (b) Use version syntax alone. This works offline
  and requires no ref lookup, but cannot recognise named tags or known
  version-shaped branches.
- Tests: `tests/unit/move-backend-modules.test.ts` checks full and abbreviated
  SHAs, blob, tree and raw links, bare and explicit tags, mixed-case
  hostnames and non-GitHub lookalikes, shorthand and explicit slashed
  branches, scoped local refs, and relative imports beside a pinned URL.

### Task 3: `recurring` as the first wave 3 slice

- Chosen: one domain, `recurring`, moved with
  `bun scripts/move-backend-modules.ts --prefix recurring- --into recurring`
  against `main` at `dd1391427`, after the codemod fix above (a separate
  commit). It goes first because it is the smallest wave 3 domain. Every
  file dropped the prefix (`recurring-scheduler.ts` →
  `recurring/scheduler.ts`, `recurring-diagnostics-caches.test.ts` →
  `recurring/diagnostics-caches.test.ts`); no two moved files map to the
  same name. No backend import path had a `recurring/` segment, and the
  protocol's `@orkestrator/protocol/recurring-work` has none, so
  `**/recurring/*` catches nothing else.
  - Left at the root: the owners that schedule or measure recurring work
    (`backend-activity-jobs.ts`, `work-admission.ts`, `machine-load.ts`,
    `host-suspend-detector.ts`, `system-usage.ts`, `health-summary.ts`) and
    `native-session-invalidation-metrics.ts`. They are not `recurring-*`
    files, and moving them would widen a pure prefix move into a
    regrouping.
  - The `apps/backend/scripts/recurring-baseline*.ts` scripts and
    `apps/backend/tests/recurring-baseline.test.ts` keep their names: they
    are outside `core/`.
- Measured before the move: see task 3's investigation. The codemod moved 7
  files and rewrote 146. No worker or bundle entry point names a moved file,
  no `<revision>:<path>` string did, and no GitHub permalink did. No
  slow-tier glob in `scripts/test-tiers.ts` names a moved test (the one
  `recurring` entry is `tests/recurring-baseline.test.ts`, which did not
  move), so the tier lists are unchanged. The one flake record the codemod
  touched (1318) names `recurring/diagnostics.ts` in its hypothesis prose,
  not in a recorded command, so the rewrite stays, as in the earlier
  slices.
- `index.ts` holds 20 symbols from three modules (`diagnostics.ts`,
  `scheduler.ts`, `work-metrics.ts`): every symbol production importers
  outside the folder use, other than the exception's
  `recurringMetricsEnabled`. 49 of the 50 production importers in
  `apps/backend/src` import it, including the type-only
  `import("…/scheduler.js")` expressions in `core/index.ts` and
  `native-agent/service-shared.ts`; each importer's separate imports from
  the three modules became one import (all-type imports stay
  `import type`). Tests and test support, the `apps/backend/tests` and
  `apps/backend/scripts` files and the repository scripts keep deep imports
  (procedure step 3).
- Named exceptions: two, under `apps/backend/src/**` only.
  `work-metrics.js` for `native-session-invalidation-metrics.ts`:
  `diagnostics.ts` imports that module at runtime for the invalidation
  snapshot, so routing its `recurringMetricsEnabled` import through
  `index.ts` closes a runtime cycle. Checked with a probe (reverted): with
  the import pointed at `index.js` and `recurringMetricsEnabled`
  re-exported, `bunx oxlint` reports `import(no-cycle)` in `index.ts`,
  `diagnostics.ts`, `scheduler.ts` and the importer; with the exception it
  reports none. Options: (a) name the importer's deep import as the
  exception and keep `work-metrics.ts` re-exported (chosen, as
  `plan-usage/cache.js`): one file imports deep; (b) leave `diagnostics.ts`
  and `scheduler.ts` (which reaches it) out of `index.ts`: 20 importers of
  the registry and the scheduler would import deep instead; (c) move the invalidation metrics read out of
  `diagnostics.ts`, which is not a pure move. `test-support.js` for
  `review/fanout-interleaving-support.ts`, test support whose name the
  tests-off override's `*test-support*` glob does not match, as the
  `previews` slice named `previews/test-support.js` for its harnesses.
  Options there: (a) a named exception (chosen): no file changes name;
  (b) rename the review file to match the glob, which is outside this
  slice's pure move of `recurring-*` files; (c) re-export the test helpers
  from `index.ts`, which would put test-only code on the production
  surface. `tests/unit/**` has no exception: no `tests/unit` file imports
  the domain. The reasons are written in `index.ts`'s header and in
  `docs/development/linting.md`.
- Paths built from a moved file's own location: no moved file uses
  `import.meta.dir`, `import.meta.url` or `__dirname`.
  `scripts/benchmark-local-diff-scan.ts` loads the metrics through
  `path.join(core, "recurring-work-metrics.ts")`, a bare file name the
  codemod does not rewrite; it now names `recurring/work-metrics.ts`.
- Hand fixes after the codemod: the bare `recurring-diagnostics.ts` and
  `recurring-diagnostics-caches.test.ts` names in
  `docs/architecture/recurring-work.md`, to-do 0048 and the protocol's
  system contract schema comment now read `recurring/diagnostics.ts` and
  `recurring/diagnostics-caches.test.ts`. `docs/development/linting.md`'s
  folder list and exception examples name the new folder. The area index's
  0012 row records wave 3 as in progress.
- Lint patterns: `**/recurring/*` with `!**/recurring/index.js`,
  `!**/recurring/test-support.js` and `!**/recurring/work-metrics.js` under
  `apps/backend/src/**`, and `**/backend/src/core/recurring/*` with
  `!…/index.js` under `tests/unit/**`. Before the `test-support.js`
  exception was added, `mise run lint` reported exactly one finding, the
  review support file's import; with it, lint is clean.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for the
  validation stage, so nothing was added to the manual-test checklist (7568).

### Task 2: `native-agent` as the eleventh wave 2 slice

- Chosen: one domain, `native-agent`, moved with
  `bun scripts/move-backend-modules.ts --map <file>` against `main` at
  `9a5a84f63`. A map file was needed because the slice takes three files
  outside the prefix. Every `native-agent-*` file dropped the prefix
  (`native-agent-service.ts` → `native-agent/service.ts`,
  `native-agent-service-dispatch.test.ts` →
  `native-agent/service-dispatch.test.ts`); `native-terminal-messages.ts`
  and its test became `native-agent/terminal-messages.ts` and
  `terminal-messages.test.ts`, and `workflow-account-handoff.test.ts` keeps
  its name. No two moved files map to the same name. No backend import path
  had a `native-agent/` segment, so `**/native-agent/*` catches nothing else:
  the protocol's `@orkestrator/protocol/native-agent*` modules have no
  segment after the name, and the renderer's `components/native-agent/` is
  outside the `apps/backend/src/**` override and does not match
  `**/backend/src/core/native-agent/*`.
- Membership: Native Mode's session layer: `NativeAgentService` and every
  collaborator 0057 split it into (all of them, listed in
  [`native-agent-service.md`](../../architecture/native-agent-service.md#collaborators),
  carry the `native-agent-` prefix, so none needed a separate decision), the
  provider and its registry, prompt dispatch and the prompt queue, session
  operations and controls, observation and activity reads, turn recovery,
  mail injection, goals, suborks, handoffs, catalogues, session titles, the
  execution policy, and the transcript projection with its read models and
  display tails. Edge cases, each decided here:
  - `native-terminal-messages.ts` (with its test) moved. It builds the
    terminal rows the projection adds to a failed session's transcript, and
    every production importer is a native-agent file
    (`native-agent-full-projection.ts`, `native-agent-prompt-dispatch.ts`,
    `native-agent-progressive-session-state.ts`). Options: (a) native-agent
    (chosen): its subject and importers are the projection's; (b) leave it at
    the root as kernel: it is not shared by two domains, and its only other
    reader is a test (`http-bridge/usage-limit-signal.test.ts`).
  - `native-session-invalidation-metrics.ts` stays at the root. Options:
    (a) leave it (chosen): its production importers are the storage layer
    (`storage-changes.ts`), the recurring diagnostics and the composition
    root as well as `native-agent-progressive-discovery.ts`, so it is a
    shared metrics primitive; (b) move it in: `storage-changes.ts` would
    then need it as a named exception or close a cycle through `index.ts`.
  - `workflow-account-handoff.test.ts` moved, as the `workflows` slice
    planned: it tests `native-agent-provider.ts` (the HTTP provider's
    dispatch boundary). It keeps its name, which says which scenario it
    covers. Options: (a) native-agent (chosen); (b) leave it at the root: no
    root module is its subject any more.
  - `native-agent-job-pipeline-resolve.ts` and `native-agent-job-tab-reuse.ts`
    moved. They decide which open native tab a job (a Resolve, an auto-merge
    follow-up) resends to, and read the build pipeline record for the Resolve
    case. Options: (a) native-agent (chosen): the prefix and the subject (the
    native tab a job reuses) agree, and the `build-pipeline` slice left
    `native-agent-job-pipeline-resolve.ts` to this one; (b) `build-pipeline/`:
    only one of the two reads the pipeline, and both are native tab logic.
  - `native-agent-opencode-server.ts`, `native-agent-change-tracking.ts` and
    `native-agent-execution-policy.ts` moved. Each adapts another domain
    (OpenCode 2's server, change tracking, the environment's execution
    policy) to `NativeAgentServiceOptions` or the service's hooks, and
    imports `service-shared.ts`. Options: (a) native-agent (chosen): they are
    the service's wiring, not the other domain's code; (b) `opencode2/`,
    `change-tracking/` and the kernel: each would then import native-agent
    internals.
  - Every `native-agent-*` test moved, including those that drive the
    command registry (`native-agent-service-commands.test.ts`,
    `native-agent-service-coordinator-subork.test.ts`): what each checks is
    native-agent behaviour, and tests may reach the registry because they are
    exempt from the domain patterns.
  - Left at the root: the session stores (`storage-native.ts`,
    `storage-native-deliveries.ts`, `storage-shared-native-sessions.ts` and
    their `storage-native-*.test.ts` tests) for the `storage` slice in wave
    3, and the native commands (`commands-registry-native.ts` and its
    `commands-registry-native-*.test.ts` tests), last by plan.
  - `pi-model-catalog-seeding.ts` is not touched (task 7): its importers are
    `host-model-catalog-refresh.ts` and `commands-registry-projects.ts`, and
    it sits with `pi-catalog-probes.ts`, which `runtime.localServers.piCatalog`
    owns; no native-agent file imports either.
- Measured before the move: see task 2's investigation. The codemod moved
  204 files and rewrote 384, including `tests/source-guards/baseline.json`
  (its entries stayed in order: `mise run guards` passes),
  `scripts/test-tiers.ts`, `scripts/efficiency/workloads-*.ts`, flake
  records and to-dos 0001, 0002, 0004 and 0005. One slow-tier glob named a
  moved test (`native-agent-service-progressive.test.ts`); it is now
  `src/core/native-agent/service-progressive.test.ts`. No worker or bundle
  entry point names a moved file, and no `<revision>:<path>` string did.
  One GitHub permalink pinned to a commit
  (`…/blob/f2d21713…/apps/backend/src/core/native-agent-service.ts` in
  `plans/credentials/credentials.md`) was rewritten, because the codemod
  does not read `/blob/<sha>/` as a revision; it was restored, since at that
  commit the file had its old name. In flake case files the codemod's edits
  were undone and a "Current path(s) for the relocated file(s)" note added
  under the title, so recorded commands stay as they ran (the
  `build-pipeline` slice's convention); the group index rows name the new
  paths.
- `index.ts` holds 27 symbols from 14 modules: every symbol production
  importers outside the folder use, other than the exceptions'. 26 of the 51
  production importers import it (and, after rebasing onto `a01039913`,
  `rich-interactions/index.ts`, which #2511 added with a deep import of
  `native-agent-session-key.js`); each importer's separate imports from
  re-exported modules became one import (`storage.ts`'s all-type import
  stays `import type`). Tests and test support outside the folder, the
  `apps/backend/tests` and `apps/backend/scripts` files, the repository
  scripts, the desktop, CLI and e2e tests keep deep imports (procedure
  step 3). Of the two `tests/unit` importers, `qa-remote-goal-hold.test.ts`
  imports `nativeAgentSessionStorageKey` through `index.js` (it took it from
  `native-agent-service-shared.ts`, which re-exports it from the session key
  module), and `native-agent-deferred-normalization.test.ts` imports
  `service-projection-test-support.js`, the one `tests/unit/**` exception;
  both specifiers had no `.js` extension and now do, so the patterns match
  them.
- Named exceptions: nine modules. Eight are the smallest set that closes no
  cycle. Method: a graph of the runtime import edges in `apps/backend/src`
  (type-only imports and `export type` re-exports skipped, as
  `import/no-cycle` does); a module re-exported from `index.ts` conflicts
  with another when it reaches, at runtime, an importer of the other. An
  exhaustive search over all 2^23 subsets of the imported modules found one
  minimum, eight exceptions: `service.ts`, `service-shared.ts`,
  `suborks.ts`, `provider.ts`, `goal-check.ts`, `goal-verifier.ts`,
  `job-tab-reuse.ts` and `job-pipeline-resolve.ts`. Each reaches the storage
  layer (`storage-native.ts`, `storage-stores.ts`), the HTTP bridge provider
  and prompt body, OpenCode 2's coordinator and transcript snapshot, the
  graph run launch and the workflow transcript artifacts, which import
  re-exported modules (session controls, display tails, retired parameters,
  inline files, the execution policy, the projection artifacts); the last
  three also reach the public API's session goal actions, which import
  `goal-service.ts`. The ninth, `service-test-collaborators.ts`, is test-only
  support that `public-api/test-provider.ts` imports (a harness whose name
  the tests-off override does not match), kept out of the surface as the
  `previews` slice kept `previews/test-support.ts`. Options: (a) leave the
  eight reaching modules out (chosen): the domain's main class,
  `NativeAgentService`, and the provider are imported deep, as the review
  and build-pipeline slices did with their services; (b) re-export the
  service modules and make their importers' leaves exceptions: no smaller
  set exists, and `service-shared.ts` alone conflicts with every leaf the
  storage layer imports; (c) break the edges from the storage layer and the
  HTTP bridge provider, which is not a pure move. The reasons are written in
  `index.ts`'s header and in `docs/development/linting.md`. Checked with
  probes: re-exporting one symbol of `service-shared.ts`, `goal-verifier.ts`
  or `job-pipeline-resolve.ts` makes `bunx oxlint apps/backend/src` report
  114, 119 and 583 `import(no-cycle)` errors; with the chosen set it reports
  none.
- Earlier exceptions that name native-agent files, re-checked now that those
  files are in `native-agent/`. None can be dropped: re-exporting
  `git/pr-auto-merge-resolve-settled.ts` (which imports
  `native-agent/service-shared.ts`) from `git/index.ts` and routing the
  composition root through it reports 681 `import(no-cycle)` errors;
  re-exporting `web-annotations/store-layout.ts` or `web-annotations/tools.ts`
  (whose reason is that `web-annotations/index.ts` reaches `agent-tools.ts`
  through `native-agent/service-shared.ts` and `native-agent/provider.ts`)
  and routing `storage-stores.ts` or `agent-tools.ts` through it reports 115
  and 30. `workflow-account-handoff.test.ts`, which the `workflows` slice
  left at the root for this one, moved (above).
- Paths built from a moved file's own location: no moved file uses
  `import.meta.dir`, `import.meta.url` or `__dirname`. Three repository
  scripts load moved modules through
  `path.join(core, "native-agent-<name>.ts")`, a bare file name the codemod
  does not rewrite (`scripts/benchmark-delete-store-work.ts`,
  `scripts/benchmark-store-writes.ts`,
  `scripts/benchmark-transcript-changed-read.ts`); they now name
  `native-agent/<name>.ts`. `agent-provider-boundaries.test.ts` read
  `native-agent-provider.ts` by name and listed the shared service files with
  `readdir(import.meta.dir)` and `/^native-agent-service-.*\.ts$/`; it now
  reads `native-agent/provider.ts` and lists `native-agent/service-*.ts`,
  and its "no OpenCode import" checks match `../opencode` instead of
  `./opencode`, since both the shared service files and (since the
  `build-pipeline` slice, which left that check matching nothing)
  `build-pipeline/provider.ts` sit one folder down.
- Hand fixes after the codemod: bare `native-agent-*` and
  `native-terminal-messages.ts` file names in source comments (the moved
  files, which now name their siblings without a folder, and
  `agent-handoffs.ts`, `auto-pipeline.test.ts`, `build-pipeline/provider.ts`,
  `git/index.ts`, `git/pr-auto-merge.ts`,
  `git/pr-auto-merge-resolve-settled.ts`, `review/reviewer-transcript.ts`,
  `storage-agent-settings.ts`, `transcript-artifacts/ledger.ts`,
  `workflows/transcript-artifacts.ts`, two renderer tests, two e2e files,
  `scripts/efficiency/counters.ts` and `workloads-projection.ts`, and the
  protocol's `agent-settings.ts` and its test, `tab-initial-prompt.ts` and
  three contract files), `AGENTS.md`'s area table (`native-agent/goal*`,
  `native-agent/subork*`) and its Claude bridge notes,
  `bridges/claude-bridge/AGENTS.md`, living docs under `docs/architecture/`
  and `docs/development/` and to-dos (0001, 0002, 0004, 0005, 0027, 0048,
  1010, 4700, 4900, 6020, 7100, 7543) now read
  `native-agent/<name>.ts`. Left alone: the protocol's own
  `native-agent-*.ts` files and the mentions of them, the renderer's
  `native-agent-fork.ts` and `native-agent-resume-requests.ts`, the
  `validation-failure-classifier.test.ts` fixtures (made-up paths),
  `native-agent-service.md`'s note of the file names 0057 split, dated
  reports (`docs/handoff/`), flake-record prose, dated plan logs under
  `plans/`, and the earlier slices' entries in this section.
  `docs/development/linting.md`'s folder list and exception examples name the
  new folder, and it now also lists every `tests/unit/**` exception (the
  review slice's `validation-prompts.ts`, the build-pipeline slice's
  `handoff.ts` and `service-helpers.ts`, which that slice recorded only here,
  and this slice's test support). The area index's 0012 row records wave 2
  as done. Store names (`native-agent-sessions`,
  `native-agent-display-tail-records`) and `git show <revision>:` paths keep
  their names.
- Lint patterns: `**/native-agent/*` with `!**/native-agent/index.js` and
  the nine exceptions under `apps/backend/src/**`, and
  `**/backend/src/core/native-agent/*` with `!…/index.js` and
  `!…/service-projection-test-support.js` under `tests/unit/**`. Checked
  with probe files (deleted): a deep import of `catalog-cache.js` is
  reported under the backend override, `index.js` under neither,
  `service.js` only under `tests/unit/**`, and
  `service-projection-test-support.js` under neither.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for the
  validation stage, so nothing was added to the manual-test checklist (7568).

### Task 2: `build-pipeline` as the tenth wave 2 slice

- Chosen: one domain, `build-pipeline`, moved with
  `bun scripts/move-backend-modules.ts --map <file>` against `main` at
  `11fca66ca`. A map file was needed because the slice takes five files
  outside the prefix. Every `build-pipeline-*` file dropped the prefix
  (`build-pipeline-service.ts` → `build-pipeline/service.ts`,
  `build-pipeline-review-fanout.ts` → `build-pipeline/review-fanout.ts`);
  `control-workflow-summary.ts` and the `pipeline-worker-*` files keep their
  names. Dropping `pipeline-` would have made `pipeline-worker-mail.test.ts`
  collide with `build-pipeline-worker-mail.test.ts` (both
  `worker-mail.test.ts`), and the kept names say what each file is about.
  No backend import path had a `build-pipeline/` segment, so
  `**/build-pipeline/*` catches nothing else:
  `@orkestrator/protocol/build-pipeline` has no segment after it, and the
  renderer's `components/build-pipeline/` is outside the
  `apps/backend/src/**` override and does not match
  `**/backend/src/core/build-pipeline/*`.
- Membership: the build pipeline: its service and collaborators, stage
  provider and prompt dispatch, stages and prompts, launch, scheduling,
  restarts and rewinds, the review stage (`review-*.ts`,
  `reviewer-rerun.ts`), validation, key information and reports, the Kanban
  ticket lifecycle, the transcript store and its migration, and worker mail.
  Edge cases, each decided here:
  - `control-workflow-summary.ts` (with its test) moved. It summarizes a
    build pipeline's workers for a coordinator (its header: "A build
    pipeline's workers, each with the mailbox address a coordinator sends to
    …"), and the `workflows` slice assigned it to this group. Options:
    (a) build-pipeline (chosen): its subject is the pipeline snapshot;
    (b) `control-mcp/`, where two of its three importers are: the public
    review actions import it too, and it reads no MCP state.
  - `pipeline-worker-identity.ts`, `pipeline-worker-mail-test-support.ts`
    and `pipeline-worker-mail.test.ts` moved. They are about build pipeline
    workers (which pipeline worker a turn credential belongs to, and the
    workers' mailboxes end to end). Options: (a) build-pipeline (chosen);
    (b) leave them for an agent-mail slice: no such slice is planned, and
    the identity module reads the pipeline record.
    `agent-tools-pipeline-worker-mail.test.ts` stays beside
    `agent-tools.ts`, the module it tests.
  - Auto-pipeline (`auto-pipeline.ts`, `auto-pipeline-transcript.ts`,
    `auto-pipeline-wiring.ts`, their two tests and
    `agent-tools-auto-pipeline.ts`) stays at the root, and is added to the
    prefix table as unplaced. It promotes a prompt session's Build into a
    pipeline, with its own drafts store (`storage-drafts.ts`) and command
    domain, and is not a `build-pipeline-*` file. Options: (a) leave it
    (chosen): the ticket names the `build-pipeline-*` files, and the
    promotion feature is a separate subject; (b) move it in: it calls the
    completed-build and launch modules, but so do the feature builds, which
    have their own folder.
  - Every `build-pipeline-*` test moved, including those that drive the
    command registry (`coordinator-ticket.test.ts`, `detail-read.test.ts`,
    `service-restart-in.test.ts`): what each checks is build pipeline
    behaviour, and tests may reach the registry because they are exempt from
    the domain patterns.
  - Left at the root or in their folders: `storage-build-pipelines.ts`, its
    tests and `storage-test-support-build-pipeline.test.ts` (storage),
    `commands-registry-build.ts` (commands, last by plan),
    `native-agent-job-pipeline-resolve.ts` (native-agent), and
    `coordinator/build-pipeline-status.ts`, already in its folder.
- Measured before the move: see task 2's investigation. The codemod moved
  128 files and rewrote 276, including `tests/source-guards/baseline.json`
  (its entries stayed in order: `mise run guards` passes),
  `scripts/efficiency/workloads-supervision.ts`, flake records and to-do
  0048. No moved test is in the slow tier (`scripts/test-tiers.ts` names
  none), no worker or bundle entry point names a moved file, and no
  `<revision>:<path>` string did.
- `index.ts` holds 66 symbols from 20 modules: every symbol production
  importers outside the folder use, other than the exceptions'. Modules
  whose importers use only types are re-exported with `export type`, so they
  add no runtime edge (`code-rewind.ts`, `completed-build.ts`, `context.ts`,
  `key-information.ts`). 37 of the 59 production importers import it; each
  importer's separate imports from re-exported modules became one import
  (all-type imports stay `import type`). Tests and test support outside the
  folder, the `apps/backend/tests` files, `apps/backend/scripts`, the
  repository script and the codex-bridge test keep deep imports (procedure
  step 3). The one `tests/unit` importer,
  `user-prompt-display-contract.test.ts`, imports
  `addressFindingsReportPrompt` through `index.js`, and `withUnattendedPolicy`
  and the review handoff helpers deep from `service-helpers.js` and
  `handoff.js`, the `tests/unit/**` exceptions: no production importer
  outside the folder uses those symbols, so they are not in `index.ts`. Its
  specifiers had no `.js` extension and now do, so the patterns match them.
- Named exceptions: seven modules, the smallest set. Method: a graph of the
  runtime import edges in `apps/backend/src` (type-only imports and
  `export type` re-exports skipped, as `import/no-cycle` does); a set of
  re-exported modules is valid when `index.ts` cannot reach itself once the
  importers of those modules are routed through it. Only seven of the 27
  imported modules reach, at runtime, any importer of the domain:
  `service.ts`, `provider.ts`, `launch.ts`, `worker-mail.ts`,
  `transcript-projection.ts`, `key-information-tools.ts` and
  `control-workflow-summary.ts`. Every one of them reaches
  `review/prompts.ts`, `review/multi-review-prompts.ts` and
  `transcript-progress.ts`, which import `prompts.ts` and
  `service-helpers.ts`, and most reach the storage layer, which imports the
  transcript store and the ticket holds. So keeping any of the seven in
  `index.ts` costs at least those two leaves, and re-exporting all seven
  costs 13 leaves; a greedy pass and 3,000 randomised passes found nothing
  smaller than seven. Options: (a) leave the seven reaching modules out
  (chosen): the domain's main class, `BuildPipelineService`, and the stage
  provider are imported deep, as the review slice did with
  `MultiReviewService`; (b) re-export the reaching modules and make the
  leaves exceptions: 13 exceptions, among them `prompts.ts`,
  `service-helpers.ts`, `ticket-hold.ts` and the transcript store;
  (c) break the edges from the review prompts and the storage layer, which
  is not a pure move. The reasons are written in `index.ts`'s header and in
  `docs/development/linting.md`. Checked with a probe: re-exporting even the
  smallest of them, `workflowSummary`, makes `bunx oxlint` report ten
  `import(no-cycle)` errors; with the chosen set it reports none.
- The review slice's exceptions that name build-pipeline files, re-checked
  now that those files are in `build-pipeline/`. None can be dropped:
  re-exporting `consolidation-scope.ts` or `validation-prompts.ts` from
  `review/index.ts` and routing `build-pipeline/prompts.ts`,
  `review-fanout.ts` and `prompt-dispatch.ts` through it makes `bunx oxlint`
  report 14 `import(no-cycle)` errors each (`build-pipeline/prompts.ts` →
  `review/index.ts` → `multi-review-prompts.ts` → `build-pipeline/index.ts`
  → `prompts.ts`), and doing the same for the `review/fanout.ts` imports of
  `build-pipeline/review-fanout.ts` reports 97. `review/index.ts`'s header
  names the new paths.
- Paths built from a moved file's own location: no moved file climbs to the
  repository root through `import.meta.dir`, but `service-recovery.test.ts`
  spawned its sibling through
  `path.join(import.meta.dirname, "build-pipeline-held-dispatch-test-support.ts")`,
  a bare file name the codemod does not rewrite; it now names
  `held-dispatch-test-support.ts`. `agent-provider-boundaries.test.ts` read
  `build-pipeline-provider.ts` by name; it now reads
  `build-pipeline/provider.ts`.
- Hand fixes after the codemod: bare `build-pipeline-*`,
  `control-workflow-summary.ts`, `pipeline-worker-identity.ts` and
  `pipeline-worker-mail.test.ts` file names in source comments (the moved
  files, which now name their siblings without a folder, and
  `agent-tools.ts`, `agent-tools-messaging.ts`,
  `control-mcp/pipeline-workers.test.ts`,
  `coordinator/build-pipeline-status.ts`,
  `environment-delete-tickets.test.ts`, `graph-agent-builtins.ts`,
  `graph-run-transcripts.ts`, `graph-system-ticket.ts` and its test,
  `kanban-merge-closure.ts`, `nodes/node-ticket-sync-lifecycle.test.ts`,
  `opencode2/turn-connections.ts`, `review/index.ts`,
  `storage-agent-settings.ts`, `storage-build-pipelines.ts`,
  `storage-kanban.ts`, `storage-kanban-board.ts`, `storage-shared-core.ts`,
  `workflows/result-service.ts`, `workspace-code-rewind.ts`,
  `apps/backend/tests/pr-monitor-closed-ticket.test.ts`,
  `e2e/agent-testing/cold-restart-live.spec.ts`,
  `scripts/efficiency/workloads-supervision.ts`, and the protocol's
  `agent-settings.ts`, `contract/domains/agent-servers/commands.ts`,
  `graphs/builtins/build-pipeline.ts`, `graphs/prompt-built-ins.ts` and
  `graphs/run-model.ts`), living docs (`agent-engines.md`,
  `agent-messaging.md`, `build-pipeline-view.md`, `coordinator.md`,
  `git-scan-caches.md`, `native-transcripts.md`, `recurring-work.md`,
  `review-preparation.md`, `tickets.md`, `agent-testing.md`,
  `effect-usage.md`) and to-dos (0001, 0025, 0027, 0048, 1010, 1090, 4740,
  and this file's "Current state" and "Open questions") now read
  `build-pipeline/<name>.ts`. Three mentions in the protocol's own
  `build-pipeline.ts` were left alone, because the protocol has files of the
  same names (`build-pipeline-key-information.ts`,
  `build-pipeline-address-findings-report.ts`,
  `build-pipeline-stage-instructions.ts`), as were the protocol's and the
  renderer's own `build-pipeline-*` files, dated reports (`docs/handoff/`,
  `docs/reports/`), flake-record prose, dated plan logs under `plans/`, and
  the earlier slices' entries in this section. `docs/development/linting.md`'s
  folder list and exception examples name the new folder, and the area
  index's 0012 row lists `build-pipeline` as done. Store names
  (`storage-build-pipelines.ts`, the `build-pipeline-transcripts` directory)
  and `git show <revision>:` paths keep their names.
- Lint patterns: `**/build-pipeline/*` with `!**/build-pipeline/index.js`
  and the seven exceptions under `apps/backend/src/**`, and
  `**/backend/src/core/build-pipeline/*` with `!…/index.js`,
  `!…/handoff.js` and `!…/service-helpers.js` under `tests/unit/**`.
  Checked with probe files (deleted): a deep import of `prompts.js` is
  reported under both overrides, `index.js` under neither, `service.js` only
  under `tests/unit/**`, and `service-helpers.js` only under
  `apps/backend/src/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for the
  validation stage, so nothing was added to the manual-test checklist (7568).

### Task 2: `review` as the ninth wave 2 slice

- Chosen: one domain, `review` (the `multi-review-*` and `review-*` prefix
  groups, `workflow-tab-actions.ts` and `retired-looped-review-cleanup.ts`),
  moved with `bun scripts/move-backend-modules.ts --map <file>` against
  `main` at `05f3db2d8`. A map file was needed for two prefixes, two odd
  files and one name collision. Every moved file dropped its prefix
  (`multi-review-service.ts` → `review/service.ts`, `review-fanout.ts` →
  `review/fanout.ts`) except three: `multi-review-prompts.ts` and its test
  keep their names, because `review-prompts.ts` became `review/prompts.ts`;
  `retired-looped-review-cleanup.ts` and its test keep theirs, because there
  is no prefix to drop; and `workflow-tab-actions.ts` is
  `review/tab-actions.ts`. Options for the collision: (a) keep
  `multi-review-prompts.ts` (chosen): the name says which prompts it holds
  (the Multi Review reviewer, consolidation and preparation prompts), while
  `prompts.ts` holds the shared preparation and result schemas; (b) rename
  `review-prompts.ts` instead (`shared-prompts.ts`): less obvious for its
  build-pipeline importers; (c) a subfolder `review/multi-review/`: splits one
  domain into two lint surfaces for one file. No other name collides, and no
  backend import path had a `review/` segment, so `**/review/*` catches
  nothing else (the renderer's `components/review/` is outside the
  `apps/backend/src/**` override).
- Membership: everything named for Multi Review or for the review machinery
  it shares with the build pipeline's review stage: the service, graph engine
  and projection, steps, prompts, scheduling, progress, refusals, worker mail,
  transcripts and auto-PR; the Fix (Address Findings) dispatch; the reviewer
  fan-out (`fanout*.ts`, `efficiency.ts`, `provisional-findings.ts`), whose
  runner both owners use; the review package, sealed diff and evidence
  permits; consolidation; review validation; and the worktree probe and
  fingerprint. Edge cases, each decided here:
  - `review/fanout.ts` and the other shared modules belong to `review`, not
    `build-pipeline`: their headers describe them as shared by Multi Review
    and the build pipeline, and the build pipeline's own review stage
    (`build-pipeline-review-*.ts`) stays with its prefix group and imports
    them. Options: (a) review (chosen): the prefix and the subject agree;
    (b) leave the shared modules at the root as kernel: they are a domain,
    not shared primitives.
  - `multi-review-native-address-findings.ts` maps `NativeAgentService`
    onto Multi Review's options with a type-only import; its subject is
    Multi Review, so it moved (`review/native-address-findings.ts`).
  - `multi-review-button-launch.test.ts` drives `launch_multi_review`
    through the command registry. It moved with the prefix group: what it
    checks is the Multi Review launch, and it may reach the registry because
    tests are exempt from the domain patterns. Option (b), leave it beside
    the command layer like `workflow-vocabulary-commands.test.ts`, was
    rejected because no `commands-*` module is its subject.
  - `retired-looped-review-cleanup.ts` (the startup cleanup of retired
    looped reviews, imported only by `core/index.ts`) is the last
    looped-review file, so it moved: the ticket names `looped-review-*`, and
    no other domain owns it. Option (b), the kernel, would leave a
    one-feature file at the root.
  - Left at the root: `build-pipeline-review-*.ts` (build-pipeline),
    `commands-review.ts` and `commands-registry-reviews.ts` (commands, last
    by plan), `storage-reviews.ts` and `storage-multi-review.test.ts`
    (storage), and `coordinator/review-actions.ts` and
    `control-mcp/review-actions.ts`, already in their folders.
- Measured before the move: see task 2's investigation. The codemod moved
  106 files and rewrote 207, including `tests/source-guards/baseline.json`,
  `tests/unit/test-tiers.test.ts`, the e2e Multi Review fixtures, flake
  records and to-dos 0025, 0027 and 7568. Two slow-tier globs in
  `scripts/test-tiers.ts` named moved tests
  (`multi-review-service-part-*.test.ts`, `review-validation-worker.*.test.ts`);
  they are now `src/core/review/service-part-*.test.ts` and
  `src/core/review/validation-worker.*.test.ts`. No worker or bundle entry
  point names a moved file, and no `<revision>:<path>` string did.
- `index.ts` holds 68 symbols from 19 modules: every symbol production
  importers outside the folder use, other than the exceptions'. 41 of the 50
  production importers import it; each importer's separate imports from
  moved modules became one import (all-type imports stay `import type`).
  `apps/backend/scripts/recurring-baseline-workflows.ts` takes
  `parseReviewPackageReference` from it too. Tests and test support outside
  the folder, the `apps/backend/tests` files, the e2e files and the
  repository scripts keep deep imports (procedure step 3); the one
  `tests/unit` importer, `user-prompt-display-contract.test.ts`, imports
  `index.js` and the `validation-prompts.js` exception.
- Named exceptions: eight modules, the smallest set found. Method: a graph of
  the runtime import edges in `apps/backend/src` (type-only imports skipped,
  as `import/no-cycle` does); a set of re-exported modules is valid when no
  runtime importer of any of them is reachable from them. A greedy pass
  ordered by importer count and 1,800 randomised greedy passes found no
  valid set with fewer than eight exceptions. The exceptions:
  `service.ts`, `address-findings-dispatch.ts`,
  `retired-looped-review-cleanup.ts` (only the composition root imports
  them), `graph-engine.ts` (the composition root and `graph-agent-host.ts`),
  `fanout.ts` (`build-pipeline-review-fanout.ts`) and
  `validation-service.ts` (the review commands, the build pipeline
  supervisor, graph validation and environment teardown) reach the graph
  runtime, the workflow result contracts and the coordinator's status wakes,
  which import modules `index.ts` re-exports; `validation-prompts.ts` and
  `consolidation-scope.ts` are leaves, but `build-pipeline-prompts.ts`
  imports both and `multi-review-prompts.ts`, re-exported, imports
  `build-pipeline-prompts.ts`. Options: (a) leave the heavy modules out of
  `index.ts` (chosen): eight exceptions, and the domain's main class,
  `MultiReviewService`, is imported deep by its one runtime importer, the
  composition root, as the coordinator slice did with its command handlers;
  (b) re-export the heavy modules and make the leaves exceptions: at least
  twelve exceptions (`progress.ts`, `efficiency.ts`, `prompts.ts`,
  `package.ts`, …), with far more importers going deep; (c) break the
  `multi-review-prompts.ts` → `build-pipeline-prompts.ts` edge to save two
  exceptions, which is not a pure move. The reasons are written in
  `index.ts`'s header and in `docs/development/linting.md`. Checked with a
  probe: re-exporting `validation-prompts.ts` and routing
  `build-pipeline-prompts.ts` through `index.ts` makes `bunx oxlint` report
  `import(no-cycle)`; with the chosen set it reports no errors.
- Paths built from a moved file's own location: four moved tests and test
  support (`evaluation-drivers.test.ts`, `validation-worker-test-support.ts`,
  `validation-worker.queue.test.ts`, `validation-worker.policy.test.ts`)
  reach the repository root, `scripts/` or `bridges/` through
  `import.meta.dir` and `../../../..`; one more `../` fixed them (13
  failures before). `tests/source-guards/baseline.json` was regenerated for
  `sleep-before-negative-assertion`, whose renamed entry was out of order.
  Both are now steps of the procedure (step 2).
- `workflows/result-final-text.js` re-checked: its importer is now
  `review/consolidation-scope.ts`, which `workflows/result-contracts.ts`
  still imports, so it stays a `workflows` exception; `workflows/index.ts`'s
  header names the new path.
- Hand fixes after the codemod: bare `multi-review-*`, `review-*` and
  `workflow-tab-actions.ts` file names in source comments (the moved files,
  `agent-test-fanout-stats.ts`, `build-pipeline-review-fanout.ts`,
  `build-pipeline-session-usage.ts`, `graph-artifacts.ts`,
  `graph-node-agent-interleaving.test.ts`, `graph-run-efficiency.bench.test.ts`,
  `transcript-progress.ts`, `workflows/index.ts`,
  `workflows/transcript-artifacts.test.ts`, the protocol's
  `multi-review.ts`, `graphs/builtins/multi-review.ts`,
  `graphs/prompt-built-ins.ts` and `workflow-results.ts`, and
  `e2e/fixture/MultiReviewFlowFixture.tsx`), living docs (`agent-engines.md`,
  `build-pipeline-view.md`, `coordinator.md`, `cursor-diagnostics.md`,
  `environment-isolation.md`, `git-scan-caches.md`, `graphs.md`,
  `recurring-work.md`, `review-preparation.md`,
  `coordinator-live-conformance.md`) and to-dos (0025, 0027, 0030, 0048,
  1010, 4740, this file's "Current state") now read `review/<name>.ts`.
  Mentions of the protocol's own `review-fanout.ts`, the web's
  `multi-review-steps.ts` and `scripts/multi-review-evaluation.ts` were left
  alone, as were the "split from the former `multi-review-service.test.ts`"
  comments, dated reports (`docs/handoff/`), flake-record prose and dated
  plan logs under `plans/`. `docs/development/linting.md`'s folder list and
  exception examples name the new folder, and the area index's 0012 row lists
  `review` as done. Store names (`storage-reviews.ts`, the `multi-review`
  store) and `git show <revision>:` paths keep their names.
- Lint patterns: `**/review/*` with `!**/review/index.js` and the eight
  exceptions under `apps/backend/src/**`, and
  `**/backend/src/core/review/*` with `!…/index.js` and
  `!…/validation-prompts.js` under `tests/unit/**`. Checked with probe files
  (deleted): a deep import of `progress.js` is reported under both
  overrides, `index.js` under neither, `service.js` only under
  `tests/unit/**`, and `validation-prompts.js` under neither.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for the
  validation stage, so nothing was added to the manual-test checklist (7568).

### Task 2: `workflows` as the eighth wave 2 slice

- Chosen: one domain, `workflows` (the `workflow-*` prefix group less four
  files, see membership), moved with `bun scripts/move-backend-modules.ts
  --map <file>` against `main` at `7fd328b8c`. A map file was needed because
  `--prefix workflow- --into workflows` would also have taken the four files
  that stay. Every moved file dropped the prefix
  (`workflow-result-service.ts` → `workflows/result-service.ts`). No name
  collides (`core/workflows/` did not exist, and no backend import path had a
  `workflows/` segment, so `**/workflows/*` catches nothing else). No
  ordering rule blocked it, and the recent workflow-result changes (#2475,
  #2431) are already on `main`, so they moved unchanged.
- Membership: the workflow machinery the backend-owned workflows (build
  pipelines, Multi Review, graph runs, feature planning, goals, suborks)
  share: keyed supervision (`supervisor.ts`), poll deadlines
  (`poll-gate.ts`), transcript-artifact authority for dispatched turns
  (`artifact-turns.ts`, `transcript-artifacts.ts`) and every
  `workflow-result-*` module (service, tools, contracts, registry,
  validators, graph output and template, JSON and final-text checks,
  missing-result prompts, rollout and metrics), with the 14 tests of those
  modules, the conformance and provenance tests included. Left out:
  `workflow-tab-actions.ts`, whose one export is `openMultiReviewTab` and
  whose importers are `commands-registry-controller-workflows.ts` and
  `coordinator/review-actions.ts`; it belongs to the `review` slice and is
  added to that row of the prefix table. Three tests stay at the root beside
  the modules they test: `workflow-account-handoff.test.ts`
  (`native-agent-provider.ts`), `workflow-dispatch-observation.test.ts`
  (`agent-provider-contract.ts`) and `workflow-vocabulary-commands.test.ts`
  (the command registry); they move with the `native-agent` and `commands`
  slices or stay in the kernel with their subject. Options: (a) the machinery
  only (chosen): a pure move that keeps review and build-pipeline files out,
  as the ticket asks; (b) every `workflow-*` file: simpler to state, but puts
  a Multi Review tab operation in this domain and tests in a folder none of
  their subjects is in; (c) also take `control-workflow-summary.ts`,
  `commands-registry-workflow-results.ts` and
  `storage-workflow-vocabulary-upgrade.ts`: they belong to the
  build-pipeline, `commands` and `storage` groups, and `commands` moves last
  by plan.
- Measured before the move: see task 2's investigation. The codemod moved 30
  files and rewrote 106, including `tests/source-guards/baseline.json`, the
  `existing` module string in `packages/protocol/src/graphs/type-validators.ts`
  and to-do 0048. No moved test is in the slow tier
  (`scripts/test-tiers.ts` names none), no worker or bundle entry point names
  a moved file, and no `<revision>:<path>` string did.
- `index.ts` holds 46 symbols from twelve modules: every symbol production
  importers outside the folder use, other than the exception's.
  `result-metrics.ts` and `result-graph-template.ts` have no production
  importer outside the folder and are not re-exported. 41 of the 42
  production importers import it; each importer's separate imports from moved
  modules became one import (all-type imports stay `import type`, so
  `agent-branch-types.ts`, which the result service reaches, adds no runtime
  edge). The two type expressions in `commands-context.ts` now name
  `workflows/index.js`. Tests and test support outside the folder, the
  `apps/backend/tests` file and the e2e tests keep deep imports (procedure
  step 3).
- Named exception: `result-final-text.ts`, the smallest set. Found with a
  graph of the runtime import edges (type-only imports skipped, as
  `import/no-cycle` does): only two importers are reachable from the moved
  modules, `agent-branch-types.ts` (type-only imports) and
  `review-consolidation-scope.ts`, which `result-contracts.ts` imports and
  which imports `inspectFinalText`. Routing that file through `index.ts`
  would close a cycle, so its one module stays out of `index.ts`. Options:
  (a) the one exception (chosen); (b) re-export `inspectFinalText` anyway:
  harmless, but no importer could use it; (c) move the final-text check into
  the review code or the contracts, which is not a pure move. The reason is
  written in `index.ts`'s header. With it `bunx oxlint .` reports no errors.
- Hand fixes after the codemod: bare `workflow-*` file names in source
  comments (`build-pipeline-context.ts`, `build-pipeline-review-fanout.ts`,
  `build-pipeline-service.ts`, `features/planning.ts`, `index.ts`,
  `multi-review-service.ts`, `review-consolidation-provenance.ts`,
  `review-fanout.ts`, `workflows/result-registry.ts`,
  `workflows/result-provenance.test.ts`), living docs (`agent-engines.md`,
  `graphs.md`, `recurring-work.md`, `rich-transcripts.md`,
  `transcript-artifacts-runtime.md`) and to-dos (0027, 0048, this file's
  "Current state") now read `workflows/<name>.ts`.
  `docs/development/linting.md`'s folder list and exception examples name the
  new folder, and the area index's 0012 row now lists `agent-accounts` (missed
  by that slice) and `workflows` as done. The `workflow-results` and
  `workflow-result-tools` store names, the claude-bridge's
  `claude-workflow-result-tools.ts`, `git show <revision>:` paths and dated
  plan logs under `plans/` keep their names.
- Lint patterns: `**/workflows/*` with `!**/workflows/index.js` and
  `!**/workflows/result-final-text.js` under `apps/backend/src/**`, and the
  `**/backend/src/core/workflows/*` form under `tests/unit/**`. Checked with
  probe files (deleted): a deep import of `poll-gate.js` is reported under
  both overrides, `index.js` under neither, and `result-final-text.js` only
  under `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for the
  validation stage, so nothing was added to the manual-test checklist (7568).

### Task 2: `agent-accounts` as the seventh wave 2 slice

- Chosen: one domain, `agent-accounts` (the `agent-accounts*` prefix
  group), moved with `bun scripts/move-backend-modules.ts --map <file>`
  against `main` at `e102a0dd5`. A map file was needed because
  `--prefix agent-accounts-` does not match `agent-accounts.ts` and its test,
  whose name is the bare prefix; they became `agent-accounts/accounts.ts` and
  `agent-accounts/accounts.test.ts`. Every other file dropped the prefix
  (`agent-accounts-auto-switch.ts` → `agent-accounts/auto-switch.ts`). No
  name collides (`core/agent-accounts/` did not exist). No ordering rule
  blocked it, and no open pull request touched the domain. Options for the
  bare file's name: (a) `accounts.ts` (chosen): it holds the account
  operations (list, switch, rename, remove, sign in, read usage) and keeps
  the old name's meaning; (b) `service.ts`, as `coordinator/service.ts`:
  the file is a set of functions over `CommandContext`, not a service class;
  (c) `operations.ts`: accurate but a new word for readers who know the old
  name.
- Membership: every root `agent-accounts*` file. That is the account
  operations, the registry store, account homes, the active account, sign-in,
  the container side, automatic switching (including the fixes of #2350,
  #2362 and #2385, moved unchanged) and its notices, the last, shared and
  shared-out usage readings, other machines' accounts, session accounts,
  promotion and the runtime state. All 23 tests moved too, including the
  five automatic-switching scenario tests (`auto-switch-flap.test.ts`,
  `auto-switch-five-hour.test.ts`, …). Options: (a) the prefix group only
  (chosen): a pure move under the rule the earlier slices used; (b) also take
  `agent-usage-limits.ts`: it reads which agent tabs stopped on a usage
  limit from the session store and the plan-usage cache, and its importers
  are mostly `native-agent-*`, `storage-native.ts` and `http-bridge/`, so it
  belongs with the sessions rather than the accounts; (c) also take
  `claude-host-login-refresh*.ts` and `codex-host-login-refresh.ts`: the
  composition root owns them for the login keeper, beside
  `container-claude-login-keeper.ts` and `container-login-file-watcher.ts`,
  which belong to the `containers` prefix group; (d) also take
  `commands-registry-accounts.ts` and `storage-agent-accounts.ts`: those
  belong to the `commands` and `storage` groups, and `commands` moves last
  by plan.
- Measured before the move: see task 2's investigation. The codemod moved
  38 files and rewrote 122, including `scripts/test-tiers.ts` (two slow-tier
  tests: `containers.test.ts` and `accounts.test.ts`),
  `tests/source-guards/baseline.json`, `docs/architecture/agent-accounts.md`,
  an `e2e/agent-testing` integration test and the path columns of flake
  records. No worker or bundle entry point names a moved file, and no
  `<revision>:<path>` string did.
- `index.ts` holds 43 symbols from five modules (`active.ts`,
  `auto-switch.ts`, `containers.ts`, `login.ts`, `usage-sharing.ts`): the
  production symbols other than those of the seven exception modules.
  `last-usage.ts`, `promotion.ts` and `shared-usage.ts` have no production
  importer outside the folder and are not re-exported. 31 of the 40
  production importers import it; each importer's separate imports from
  re-exported modules became one import. The type expression
  `import("./agent-accounts/auto-switch.js").AgentAccountAutoSwitcher` in
  `commands-context.ts` now names `agent-accounts/index.js`. Tests outside the
  folder, the `apps/backend/tests` files and the e2e integration test keep
  deep imports (procedure step 3).
- Named exceptions: seven modules, the smallest set found that leaves no
  runtime cycle and, among those, the one with the fewest importers left on
  deep imports. Found with a graph of the runtime import edges (type-only
  imports skipped, as `import/no-cycle` does): every subset of the 15 modules
  was tried, and a subset is valid when no re-exported module reaches a file
  that would import `index.ts`. Two sets of five or six modules are also
  valid, but they keep `active.ts` and `containers.ts`, the two modules with
  the most importers, out of `index.ts` and leave 31 importers on deep
  imports instead of 9. The chosen seven: `accounts.ts`, `machines.ts` and
  `session.ts` reach the command layer (`commands-servers.ts`,
  `host-model-catalog-refresh.ts`, `commands-environment.ts`), and
  `runtime.ts` reaches `plan-usage/reader.ts`, all of which import
  `index.ts`; `store.ts`, `homes.ts` and `auto-switch-notices.ts` are
  imported by the storage layer, `permission-rules/external-rules.ts`,
  `coordinator/notice-router.ts` and other files the re-exported modules
  reach, so those importers cannot import `index.ts`. Confirmed with oxlint
  probes: re-exporting `accounts.ts` gave 89 `no-cycle` errors and
  `runtime.ts` 4; routing `storage-agent-accounts.ts`,
  `permission-rules/external-rules.ts` and `coordinator/notice-router.ts`
  through `index.ts` gave 15, 20 and 25. Options: (a) the seven (chosen);
  (b) five (`active.ts`, `auto-switch-notices.ts`, `containers.ts`,
  `homes.ts`, `store.ts`): fewer exceptions but 31 deep importers; (c) break
  the cycles by moving code, which is not a pure move. The reasons are
  written in `index.ts`'s header. Cons: seven deep imports are allowed from
  anywhere in `apps/backend/src`; the `tests/unit/**` pattern stays strict.
  With them `bunx oxlint .` reports no errors.
- Hand fixes after the codemod: bare `agent-accounts*` file names in source
  comments (`commands-context.ts`, `commands-registry-accounts.ts`,
  `git/index.ts`, `opencode2/index.ts`, `opencode2/credentials.ts`,
  `capabilities/scoped-delivery.ts`, `apps/backend/tests/container-benchmarks.test.ts`,
  `apps/backend/tests/commands-registry-docker.test.ts`),
  living docs (`agent-accounts.md`, `agent-capabilities-management.md`,
  `backend-runtime.md`, `coordinator.md`,
  `coordinator-timers-and-accounts-decisions.md`) and to-dos (7543, 8314,
  0039, and this file's "Current state") now read
  `agent-accounts/<name>.ts`. `docs/development/linting.md`'s folder list
  and exception examples name the new folder. Flake case files preserve the
  paths used at the recorded revisions and list the current equivalents.
  Flake indexes use the current paths. Earlier slices' records keep the names
  they measured, as do dated plan logs under `plans/`.
  `@orkestrator/protocol`'s own `agent-accounts.ts` and
  `agent-account-*.ts` modules, the renderer's `lib/backend/agent-accounts.ts`
  and the `agent-accounts` data directory are other things with the same
  names and are untouched.
- Lint patterns: `**/agent-accounts/*` with `!**/agent-accounts/index.js`
  and the seven exceptions under `apps/backend/src/**`, and the
  `**/backend/src/core/agent-accounts/*` form under `tests/unit/**`. No
  backend import path had an `agent-accounts/` segment before the move
  (`@orkestrator/protocol/agent-accounts` has none after it). Checked with
  probe files (deleted): a deep import of `active.js` is reported under both
  overrides, `index.js` under neither, and `accounts.js` only under
  `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for
  the validation stage, so nothing was added to the manual-test checklist
  (7568).

### Task 2: `coordinator` as the sixth wave 2 slice

- Chosen: one domain, `coordinator` (the `coordinator-*` prefix group),
  moved with `bun scripts/move-backend-modules.ts --prefix coordinator-
  --into coordinator` against `main` at `0b778d995`. No map file was
  needed: no dropped-prefix name collides (`core/coordinator/` did not
  exist, and `control-mcp/coordinator-environment-scope.ts` and
  `control-mcp/coordinator-worker-turns.ts` live in another folder). Every
  file dropped the prefix (`coordinator-service.ts` → `coordinator/service.ts`,
  `coordinator-pr.ts` → `coordinator/pr.ts`,
  `coordinator-node-coordinator-mail.ts` →
  `coordinator/node-coordinator-mail.ts`). No ordering rule blocked it, and
  no pull request was open.
- Membership: every root `coordinator-*` file. That is the coordinator
  service and runtime, provider qualification, status wakes, PR status, PR
  watches and the worker PR launch, delegation, worker turns, mail, changes
  and outcomes, account-switch and usage-limit routing, node and remote
  coordination, the review, surface, pipeline-step, goal, graph and subork
  actions, mail attachments and workflow retention. All 62 `coordinator-*`
  tests moved too, including the scenario tests that drive the coordinator
  through the command registry and the control MCP server
  (`account-switch-grant.test.ts`, `worker-turns.test.ts`,
  `timers-and-accounts.test.ts`, …). Options: (a) the prefix group only
  (chosen): a pure move under the rule the earlier slices used, and the
  tests stay beside the domain whose behaviour they check; (b) also take
  `commands-registry-coordinator*`, `storage-coordinator*`,
  `graph-run-coordinator-status.ts` and `control-mcp/coordinator-*`: those
  belong to the `commands`, `storage` and `graph` prefix groups and to
  `control-mcp/`, which the ticket kept where it is, and `commands` moves
  last by plan; (c) leave the scenario tests at the root: they would sit
  apart from the domain they test, and the root would keep
  `coordinator-*` names.
- Measured before the move: see task 2's investigation. The codemod moved
  120 files and rewrote 259, including `scripts/test-tiers.ts` (four
  slow-tier tests: `fork-worker`, `service`, `status-wakes`,
  `surface-actions`), `tests/source-guards/baseline.json`, the
  `.oxlintrc.json` override that lists `service.ts`, the path filter of
  `.github/workflows/claude-apparmor-qualification.yml`, `AGENTS.md`, an
  `e2e/agent-testing` spec and a claude-bridge live test. No worker or bundle
  entry point names a moved file, and no `<revision>:<path>` string did.
- `index.ts` holds 80 symbols from 30 modules: the production symbols other
  than those of the fourteen exception modules. 40 of the 42 production
  importers import it (`commands-registry.ts` and `nodes/node-coordination.ts`
  use exception modules only); each importer's separate imports from moved
  modules became one import (`commands-registry-coordinator.ts`'s fifteen
  became one plus the exception imports). The type expression
  `import("./coordinator/node-reconnect-wakes.js").CoordinatorNodeAttempt` in
  `commands-registry-coordinator-nodes.ts` now names `coordinator/index.js`.
  Tests outside the folder, `apps/backend/tests/seed-coordinator-workflows.test.ts`,
  the e2e spec and the two `apps/backend/scripts` files
  (`coordinator-sweep-bench.ts`, `seed-coordinator-workflows.ts`) keep deep
  imports (procedure step 3).
- Named exceptions: fourteen modules. Found with a graph of the runtime
  import edges (type-only imports skipped, as `import/no-cycle` does): a
  module closes a cycle when it reaches a file that imports `index.ts`.
  Ten are the command handlers the command registry installs, which reach
  the command layer (`commands-servers.ts`, the `control-mcp/` tools):
  `fork-worker.ts`, `goal-actions.ts`, `node-tickets.ts`,
  `pipeline-step-actions.ts`, `review-actions.ts`, `subork-actions.ts`,
  `surface-actions.ts`, `worker-changes.ts`, `worker-mail.ts` and
  `worker-turn-actions.ts`. The others: `mail-attachments.ts` and
  `node-coordinator-mail.ts` reach `storage-config.ts` and
  `storage-coordinators.ts`, `pr.ts` reaches `worker-action-receipts.ts`, and
  `usage-limit-account-routing.ts` reaches `commands-servers.ts`. Two were
  confirmed with oxlint by re-exporting them: `pr.ts` gave 3 `no-cycle`
  errors and `usage-limit-account-routing.ts` 286. Options: (a) leave all
  fourteen out of `index.ts` and name them as exceptions (chosen), as the
  `opencode`, `worktrees` and `git` slices did; (b) re-export them and give
  the widely used modules (`service.ts`, `runtime.ts`, `providers.ts`)
  exceptions instead: most of the backend would then keep deep imports;
  (c) break the cycles by moving code, which is not a pure move. Their
  importers are the four command-registry files, the composition root
  `core/index.ts` and, for one type, `nodes/node-coordination.ts`; the
  reasons are written in `index.ts`'s header. Cons: fourteen deep imports
  are allowed from anywhere in `apps/backend/src`; the `tests/unit/**`
  pattern stays strict. With them `bunx oxlint .` reports no errors.
- Hand fixes after the codemod: bare `coordinator-*` file names in source
  comments, living docs, plans, to-dos, `AGENTS.md` and `docs/README.md`
  now read `coordinator/<name>.ts`; comments inside `coordinator/` that
  name a sibling use its new bare name. One test named its sibling test
  support by file name (`MODEL_SOURCE` in
  `mail-attachments-docker-read-live.test.ts`), which the codemod does not
  rewrite; it now names `mail-attachments-container-model-test-support.ts`.
  `docs/development/linting.md`'s folder list and exception examples name
  the new folder. Flake records keep the codemod's path rewrites and their
  bare names, and the `git` record below keeps the names it measured, as in
  the earlier slices. `@orkestrator/protocol`'s own `coordinator-*.ts`
  modules and `contract/domains/coordinator/` are other things with the
  same names and are untouched, as are runtime identifiers that happen to
  match a file name (the `coordinator-runtime` data directory, the
  `coordinator-usage-limit-notices` store, `coordinator-pr:` request ids).
- Lint patterns: `**/coordinator/*` with `!**/coordinator/index.js`, the
  fourteen exceptions and `!@orkestrator/protocol/contract/domains/coordinator/*`
  under `apps/backend/src/**`, and the `**/backend/src/core/coordinator/*`
  form under `tests/unit/**`. No backend or `tests/unit` import path had a
  `coordinator/` segment before the move. Checked with probe files
  (deleted): a deep import of `service.js` is reported under both
  overrides, `index.js` under neither, and `pr.js` only under
  `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `verify:packaged-backend`) is agent work for
  the validation stage, so nothing was added to the manual-test checklist
  (7568).

### Task 2: `git` as the fifth wave 2 slice

- Chosen: one domain, `git` (the `git-*`, `github*` and `pr-*` prefix
  groups), moved with the codemod and a map file against `main` at
  `b2c91abb9`. The ticket named it and offered `agent-accounts` only if an
  ordering rule blocked it. None does: the only ordering rule in wave 2 is
  that `native-agent` waits for 0057. The feature branch merged #2394 from
  `main`, keeping the monitor and merge-notice code and tests under `core/git/`.
  The merge-notice module is internal to the Git domain, so it needs no public
  export or lint exception. The ticket also kept coordinator tool, CLI and graph
  template names out of scope (to-do 4740 runs in parallel): the slice
  changes only import specifiers and path comments in those files, never a
  name.
- File names: a map file, not `--prefix`, because the domain has three
  prefixes. Only `git-` was dropped, because it repeats the folder name:
  `git-fsmonitor.ts` → `git/fsmonitor.ts`, `git-noninteractive-env.ts` →
  `git/noninteractive-env.ts`, `git-checkout-template-test-support.ts` →
  `git/checkout-template-test-support.ts`, `git-remote-callers.test.ts` →
  `git/remote-callers.test.ts`, and so on for all eighteen `git-*` files.
  The `github*` and `pr-*` files keep their names (`git/github.ts`,
  `git/pr-monitor.ts`). Options: (a) keep those two prefixes (chosen):
  `github.ts` has no name left once its prefix goes, `pr-monitor.ts` would
  become an unhelpful `monitor.ts`, and every bare name in docs and
  comments stays a correct file name; (b) subfolders `git/github/` and
  `git/pr/` with the prefixes dropped: shorter names, but nested domains
  need `**` lint patterns (as `self-improvement/` has) and a second
  `index.ts` decision, which is more than a pure move; (c) drop every
  prefix: impossible for `github.ts` and ambiguous for the rest.
  `project-git-*`, `local-git-scan-caches.ts`, `container-git-fetch*`,
  `container-github-credential.ts`, `coordinator-pr-*`,
  `commands-pr-monitor*`, `commands-registry-git*`/`-github*`,
  `graph-system-pull-request.ts` and `storage-watched-pull-requests.ts`
  belong to other prefix groups and stay where they are.
- Measured before the move: 47 production importers outside the folder,
  all in `core/` (three in `change-tracking/`, one each in `nodes/`,
  `public-api/` and `worktrees/`), using about 100 symbols from 28 modules;
  tests and test support outside the folder in `core/`, 22
  `apps/backend/tests` files, `apps/web/src/types/github.test.ts`, and two
  `apps/backend/scripts` files (`github-ranges-seed.ts`,
  `recurring-baseline-harness.ts`). Path strings in
  `.github/workflows/container-live-qualification.yml` (its path filter
  names the two ranges-seed modules), architecture and development docs,
  one unified plan, one to-do and 13 flake files. Three tests spy on a
  moved module's namespace (`import * as remoteGit` in
  `coordinator-service.test.ts` and `diff-stats-tracking.test.ts`,
  `import * as credentials` in `bug-report-service.test.ts`); they keep the
  deep import, and the spy still reaches production code that now imports
  the symbol through `index.ts`, because a re-export is a live binding (all
  three files pass). No worker or bundle entry point names a moved file,
  `scripts/test-tiers.ts` names none (the two `*.integration.test.ts`
  files stay in the slow tier through its pattern), and no
  `<revision>:<path>` string named a moved file. The codemod moved 59 files
  and rewrote 164.
- `index.ts` holds 86 symbols from 21 modules: the production symbols
  other than those of the seven exception modules, plus four
  `github-credentials.ts` names that only `commands-helpers.ts` passes on. 43 production importers use it; their
  separate imports from moved modules were merged into one import each
  (`commands-files.ts`'s six became one).
  `commands-helpers.ts` had `export * from "./github-credentials.js"`, which
  `commands.ts` passes on through its own `export *`; it now re-exports the
  same eleven names explicitly from `git/index.js`, so the command layer's
  surface is unchanged. Ten `core/` tests outside the folder use only
  `index.ts` symbols, so they import `index.js` too; the others (test
  support, the namespace spies, `linear-merged-label.test.ts` on
  `pr-monitor-runtime.js`, `coordinator-goals.test.ts` and
  `index-pr-monitor.test.ts`'s `PrMonitorServiceOptions` type) keep deep
  imports, as do the `apps/backend/tests` white-box tests, the renderer
  test and the two scripts (procedure step 3).
- Named exceptions: seven modules. With each re-exported, `import/no-cycle`
  reported runtime cycles (3 to 632 each, re-checked one at a time):
  `github-cli-setup.ts` reaches `agent-accounts-login.ts` and
  `host-tools.ts`, `github-clone-browser.ts` reaches
  `commands-error-text.ts`, `github-ranges-seed-delivery.ts` reaches
  `egress-gateway.ts`, `pr-auto-merge.ts` reaches
  `project-home-environment.ts` and `action-default-selection.ts`,
  `pr-auto-merge-resolve-settled.ts` reaches the native agent service and
  `public-api/`, `pr-monitor-runtime.ts` reaches `commands-pr-monitor.ts`,
  and `pr-required-checks.ts` reaches `commands-review.ts`; each path leads
  back to a file that imports `git/index.js`. Options: (a) leave all seven
  out of `index.ts` and name them as exceptions (chosen), as the `opencode`
  and `worktrees` slices did; (b) keep them in `index.ts` and give the
  light modules (`fsmonitor.ts`, `noninteractive-env.ts`,
  `github-credentials.ts`, …) exceptions instead: those are imported by
  dozens of files, so most of the backend would keep deep imports; (c)
  break the cycles by moving code, which is not a pure move. Each exception
  has a single production importer (`commands-registry-tools.ts`,
  `commands-registry-projects.ts`, `agent-accounts-containers.ts`, the
  composition root `core/index.ts` for both auto-merge modules,
  `backend-runtime.ts`, `commands-pr-monitor.ts`), and the reasons are
  written in `index.ts`'s header. Cons: seven deep imports are allowed
  from anywhere in `apps/backend/src`; the `tests/unit/**` pattern stays
  strict. With them `bunx oxlint .` reports no errors.
- Hand fixes after the codemod: the bare `git-*` names (which changed) in
  `local-git-scan-caches.ts`, `backend-runtime.md`, `git-scan-caches.md`,
  `local-start-git-remote-failures.md` and `recurring-work.md`; and,
  because these docs and comments name `core/` modules by folder-relative
  path, the bare `github*` and `pr-*` names in `AGENTS.md` (the GitHub
  ranges seed under "Network Isolation"), the architecture docs and the
  comments of seven root `core/` files now read `git/<name>.ts`; plus the
  folder list and exception examples in `docs/development/linting.md`.
  Comments inside `git/` that name a sibling keep the bare name. Flake
  records and the dated `worktree-watcher-validation.md` report keep the
  codemod's path rewrites and their bare names, as in the earlier slices.
  `@orkestrator/protocol`'s own `github-*`, `git-*` and `pr-*` modules and
  `contract/domains/git/` are other things with the same names and are
  untouched.
- Lint patterns: `**/git/*` with `!**/git/index.js`, the seven exceptions
  and `!@orkestrator/protocol/contract/domains/git/*` under
  `apps/backend/src/**` (no backend file imports that protocol path today;
  the exclusion stops the pattern catching it later, as the
  `change-tracking` pattern does for its protocol namesake), and the
  `**/backend/src/core/git/*` form under `tests/unit/**`. No backend or
  `tests/unit` import path had a `git/` segment before the move. Checked
  with probe files (deleted): a deep import of `noninteractive-env.js` is
  reported under both overrides, `index.js` is not reported under either,
  and `pr-monitor-runtime.js` is reported only under `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `build:backend` and `verify:packaged-backend`)
  is agent work for the validation stage, so nothing was added to the
  manual-test checklist (7568).

### Task 2: `worktrees` as the fourth wave 2 slice

- Chosen: one domain, `worktrees`, moved with the codemod
  (`--prefix worktree- --into worktrees`) against `main` at `0265e7882`.
  The ticket named it and offered `git` or `agent-accounts` only if an
  ordering rule blocked it. None does: the only ordering rule in wave 2 is
  that `native-agent` waits for 0057, the domain's importers include none of
  the files the ticket excluded (native-agent, workflows, review,
  build-pipeline and coordinator code, which other changes in this wave
  edit), and no pull request was open.
- File names: `--prefix` works (every file starts with `worktree-`, and no
  stripped name collides): `worktree-watcher.ts` → `watcher.ts`,
  `worktree-watch-plan.ts` → `watch-plan.ts`, `worktree-git-paths.ts` →
  `git-paths.ts`, `worktree-locations.ts` → `locations.ts`,
  `worktree-adhoc-reads.ts` → `adhoc-reads.ts`,
  `worktree-removal-reads.ts` → `removal-reads.ts`,
  `worktree-snapshot-digest.ts` → `snapshot-digest.ts`,
  `worktree-tree-snapshots.ts` → `tree-snapshots.ts`, and the eleven tests to
  match (`worktree-snapshots-git.test.ts` → `snapshots-git.test.ts`,
  `worktree-watcher-enospc.integration.test.ts` →
  `watcher-enospc.integration.test.ts`, …). The folder is `worktrees/` (the
  plan's domain name). `change-tracking/worktree-owner.ts`, the
  `container-worktree-*` files and `commands-local-worktree.ts` belong to
  other domains and stay where they are; so do
  `apps/backend/tests/worktree-watcher*.test.ts` and
  `scripts/worktree-watcher-live.ts`, which are not in `core/`.
- Measured before the move: 13 production importers outside the folder,
  all in `core/` (`change-tracking/shared-physical-work.ts`,
  `change-tracking/worktree-owner.ts`, `commands-environment.ts`,
  `commands-files.ts`, `commands-registry-disk-usage.ts`,
  `commands-registry-environments.ts`, `container-git-fetch.ts`,
  `container-worktree-signal.ts`, `diff-stats-service.ts`,
  `diff-stats-tracking.ts`, `environment-cleanup-reconciler.ts`,
  `environment-move.ts` and `readable-host-roots.ts`) using 25 symbols from
  seven modules; three tests outside the folder in `core/` and two in
  `apps/backend/tests/`; five repository scripts
  (`benchmark-burst-watch.ts`, `benchmark-change-tracking.ts`,
  `benchmark-worktree-watch.ts`, `worktree-watcher-live.ts` and
  `efficiency/workloads-supervision.ts`, which loads `tree-snapshots.ts` by
  path); path strings in `scripts/test-tiers.ts` (the slow-tier entry for
  `snapshots-git.test.ts`) and `tests/source-guards/baseline.json`; and path
  strings in two development reports, two to-do files and 24 flake files
  (two group indexes included). No `mock.module()` or `spyOn` targeted the
  files, no worker or bundle entry point names them, and no
  `<revision>:<path>` string named a moved file. The codemod moved 19 files
  and rewrote 70 (the moved files included).
- `index.ts` holds the 24 production symbols other than
  `WorktreeRemovalReads`. Twelve production importers use it;
  `diff-stats-service.ts`'s four imports from it became one. The three
  `core/` tests outside the folder use only `index.ts` symbols, so they
  import `index.js` too. The two `apps/backend/tests` files are white-box
  tests of the watcher (`classifyWorktreeChange`, `WATCH_PLAN_MAX_*`, …) and
  keep their deep imports (procedure step 3).
- Named exception: `removal-reads.js`. With `WorktreeRemovalReads`
  re-exported, `import/no-cycle` reported a runtime cycle: `removal-reads.ts`
  imports `change-tracking/index.js`, change tracking reaches
  `commands-files.ts` and `container-git-fetch.ts`, and both import
  `worktrees/index.js`. Options: (a) leave it out of `index.ts` and name it
  as an exception, as the `opencode` slice did for three modules; (b) move
  `PhysicalKeyResolver` out of change tracking, which is not a pure move;
  (c) keep `commands-files.ts` and `container-git-fetch.ts` on deep
  `adhoc-reads.js` imports, which needs an exception for the same cycle and
  leaves the cycle-closing re-export in place for any later importer.
  Chosen (a): one exception, no code change, and the reason is written in
  `index.ts`'s header. Cons: one more deep import is allowed from anywhere
  in `apps/backend/src`; the `tests/unit/**` pattern stays strict. With that
  one exception `bunx oxlint .` reports no errors.
- Scripts keep their deep imports. They sit outside `apps/backend/src/**`,
  so no lint pattern covers them; `workloads-supervision.ts` loads the module
  by file path, and the others use watcher internals that are not part of
  the domain's surface (`worktreeWatchPlanIo`, `WATCH_SETTLE_MS`).
- Hand fixes after the codemod: the bare names in the comments of
  `watcher.ts`, `snapshots.test.ts` and `tree-cache.test.ts`, in
  `docs/architecture/git-scan-caches.md` and `recurring-work.md`, to-dos
  7551 and 7560, and the folder list and cycle example in
  `docs/development/linting.md`. Flake records and the dated
  `worktree-watcher-validation.md` and `test-wait-review.md` reports keep
  the codemod's path rewrites and their bare names, as in the earlier
  slices; so do the historical mentions in to-dos 0030 (the #1149 crash)
  and 0048 (a struck-through done item).
  `@orkestrator/protocol/worktree-snapshots` and the `worktree-snapshots`
  cache name are other things with the same name and are untouched.
- Lint patterns: `**/worktrees/*` with `!**/worktrees/index.js` and
  `!**/worktrees/removal-reads.js` under `apps/backend/src/**`, and the
  `**/backend/src/core/worktrees/*` form under `tests/unit/**`. No backend
  or `tests/unit` import path had a `worktrees/` segment before the move.
  Checked with probe files (deleted): a deep import of `watcher.js` is
  reported under both overrides, `index.js` is not reported under either,
  and `removal-reads.js` is reported only under `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `build:backend` and `verify:packaged-backend`) is
  agent work for the validation stage, so nothing was added to the
  manual-test checklist (7568).

### Task 1: `opencode` as the last wave 1 slice

- Chosen: one domain, `opencode`, the only wave 1 move left and so the
  highest-ranked open domain, against `main` at `a0920f1a7`. No pull request
  was open. The ticket asked for the next domain the to-do ranks highest.
- Folder: the existing `opencode2/`, not a new `opencode/`. Options: (a) move
  the root files into `opencode2/`; (b) a new `opencode/` folder beside it;
  (c) rename `opencode2/` to `opencode/` and move everything there. Chosen
  (a): OpenCode 2 is the only OpenCode line since 1.x was retired, the root
  files already imported `opencode2/index.js`, and a second folder would
  split one provider across two surfaces. (c) would rename 100 more files and
  every importer for a name only. Cons: `display-transcript.ts` normalizes
  stored 1.x transcripts but now sits in the `opencode2/` folder; its header
  says so.
- File names: a `--map` file, because `opencode2-container-server.ts` would
  otherwise take the name of the existing `opencode2/container-server.ts`
  (the pure start script it drives). It became
  `container-server-lifecycle.ts` (it starts, stops, ensures, peeks and
  reports the in-container server). The others drop the `opencode-` or
  `opencode2-` prefix (`opencode-provider-login.ts` → `provider-login.ts`,
  `opencode2-host-server.ts` → `host-server.ts`, …), with their nine tests to
  match. The codemod moved 20 files and rewrote 44.
- Measured before the move: 10 production importers outside the eleven
  files, all in `core/` (`build-pipeline-transcript-projection.ts`,
  `commands-registry-accounts.ts`, `commands-registry-projects.ts`,
  `commands-registry-servers.ts`, `container-bridge-credential.ts`,
  `host-model-catalog-refresh.ts`, `index.ts`, `local-server-runtime.ts`,
  `multi-review-reviewer-transcript.ts`, `native-agent-handoffs.ts`); four
  co-located tests at the root, four `apps/backend/tests` files, two
  `opencode2/*.live.test.ts` files, `e2e/OpenCodePipelineTranscript.spec.ts`
  and `tests/unit/lib/opencode-pipeline-transcript.test.ts`; path strings in `scripts/test-tiers.ts`,
  `tests/unit/runtime-env-wiring.test.ts`, `docker/AGENTS.md` and one
  architecture doc. No `mock.module()` or `spyOn` targeted the files, no
  worker or bundle entry point names them, and no `<revision>:<path>` string
  named a moved file (the `git show 5f4e27b1c:…` paths name files removed
  with 1.x).
- Inside the folder: the moved files imported `opencode2/index.js`; the
  codemod turned that into `./index.js`, and each now imports the module that
  defines the symbol instead, so the folder does not import its own barrel.
- `index.ts` gains nine symbols from three moved modules:
  `normalizeOpenCodeDisplayEntries` and `normalizeOpenCodeDisplayEntry`; the
  listener identity's `judgeOpenCodeListener`, `listOpenCodeListenersScript`,
  `openCodeListenerRecord`, `parseOpenCodeListeners` and the types
  `OpenCodeListenerJudgement` and `OpenCodeServerKind`; and
  `OpenCodeProviderLoginSlot`. Five of the ten importers use it (the other
  five import the exceptions below), and
  `tests/unit/lib/opencode-pipeline-transcript.test.ts` too (the
  `tests/unit/**` pattern allows only `index.js`).
- Named exceptions: `container-server-lifecycle.js`,
  `host-database-server.js` and `provider-login.js`, not re-exported. With
  every importer on `index.ts`, `import/no-cycle` reported dozens of errors:
  these modules reach `commands-servers.ts`, `local-server-runtime.ts` and
  the container lifecycle modules, which themselves import
  `opencode2/index.js`. Re-exporting any one of them from `index.ts`, with no
  importer changed, reported 70 to 80 cycles (`host-server.js` too, which no
  outside file imports); the light modules (`project-config.js`) reported
  none. Options: (a) leave them out of `index.ts` and name them as
  exceptions; (b) re-export them and turn the folder's other importers into
  exceptions; (c) break the cycles by moving code. Chosen (a): (b) would
  need most of the folder's existing importers as exceptions, and (c)
  is outside the "pure moves" rule. This differs from the `public-api/` and
  `web-annotations/` exceptions, which stay re-exported, because there the
  cycle was closed only by the excepted importers. Cons: three modules are
  part of the surface without being in `index.ts`; its header and
  `linting.md` ("Module boundaries") name them.
- Hand fixes after the codemod: one test read the repository root through
  `import.meta.dir` (`container-launch.test.ts`, one more `..`); the
  file-name list `agent-provider-boundaries.test.ts` reads by path drops
  `opencode-display-transcript.ts`, which its `opencode2/` scan now covers;
  bare names in source comments in and outside the folder, the root
  `AGENTS.md` OpenCode row (its `opencode2-*.ts` glob no longer names any
  root file), seven architecture docs, to-do 7545 (since retired), the `opencode2/index.ts`
  header and `linting.md`. Flake records keep the codemod's path rewrites, as
  in the earlier slices. `apps/backend/tests/opencode2-container-server.test.ts`
  and the `opencode2/opencode2-*.live.test.ts` files keep their names: they
  are not prefix files at the `core/` root.
- Lint patterns: the `opencode2/` patterns already existed (to-do 7800); the
  `apps/backend/src/**` one gains the three exceptions, and the
  `tests/unit/**` one is unchanged. Checked with probe files (deleted): deep
  imports of `host-server.js` and `listener-identity.js` are reported under
  `apps/backend/src/**`, the three exceptions and `index.js` are not, and a
  deep import of `provider-login.js` is reported under `tests/unit/**`.
- Two test fixes outside the pure move, in a separate commit, for failures
  already on `main` at `a0920f1a7`: `tests/unit/runtime-env-wiring.test.ts`
  still read the plain state file that #2319 stopped
  `orkestrator-state-signal.sh` writing (it now checks the snapshot), and
  the backend test typecheck failed on `multi-review-auto-pr.test.ts` from
  #2334 (its fake invoker's result now casts to the generic `T`). Both
  failed the same way on the base commit; neither is a flake.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `build:backend`, `verify:packaged-backend` and the
  OpenCode live tests) is agent work for the validation stage, so nothing was
  added to the manual-test checklist (7568).

### Task 2: `previews` as the third wave 2 slice

- Chosen: one domain, `previews`, moved with the codemod
  (`--prefix preview- --into previews`) against `main` at `c1fcc573b`. No
  pull request was open. The ticket asked to avoid native-agent transcript
  projection, build-pipeline and container files. Of the wave 2 domains
  left, `workflows` is imported mostly by `build-pipeline-*`,
  `multi-review-*` and `native-agent-*` files, `worktrees` had just been
  changed by #2305 and is imported by `container-*` and `change-tracking/`
  files, and `coordinator` and `agent-accounts` are larger and reached by
  other domains' named exceptions. `previews` is self-contained (its
  `core/` importers are the composition root, `commands-context.ts` and
  `commands-registry-previews.ts`; the rest are the gateway and the
  `apps/backend/src/preview-*.ts` transport files) and touches none of the
  files the ticket excluded. `commands-registry-previews.ts` stays at the
  root (a `commands-*` file), and the `transcript-artifacts/preview-*.ts`
  files are another domain's and are untouched.
- File names: `--prefix` works (every file starts with `preview-`):
  `preview-runtime.ts` → `runtime.ts`, `preview-access.ts` → `access.ts`,
  `preview-intent.ts` → `intent.ts`, `preview-readiness.ts` →
  `readiness.ts`, `preview-listener-ownership.ts` → `listener-ownership.ts`,
  `preview-service-registry.ts` → `service-registry.ts`,
  `preview-target-resolver.ts` → `target-resolver.ts`,
  `preview-test-support.ts` → `test-support.ts`, and the twelve tests to
  match (`preview-docker.test.ts` → `docker.test.ts`, …). The folder is
  `previews/` (the plan's domain name and the protocol contract domain's
  name).
- Measured before the move: 12 production importers outside the folder
  (`index.ts`, `commands-context.ts` and `commands-registry-previews.ts` in
  `core/`, and `gateway-context.ts`, `gateway-handlers.ts`,
  `gateway-support-core.ts`, `preview-http-proxy.ts`,
  `preview-publication.ts`, `preview-tunnel-mux-server.ts`,
  `preview-tunnel-server.ts`, `preview-upstream-pool.ts` and
  `preview-upstream.ts` in `apps/backend/src/`) using six symbols from four
  modules, all but two of the twelve type-only; two test-only entrypoints
  (`preview-browser-harness.ts`, `preview-baseline-harness.ts`); tests
  outside the folder (three in `core/`, seven in `apps/backend/src/`,
  `apps/backend/tests/gateway-preview.test.ts` and three
  `apps/desktop/tests` files, all but one importing only the test
  support); path strings in `mise.toml` (`test:preview:docker`),
  `tests/unit/mise-tasks.test.ts`, `scripts/test-tiers.ts` (the slow-tier
  entry for `local-discovery.test.ts`) and `tests/source-guards/baseline.json`;
  and path strings in one architecture doc, one development report, three
  to-do files and fourteen flake files. No `mock.module()` or `spyOn`
  targeted the files, no worker or bundle entry point names them, and no
  `<revision>:<path>` string named a moved file. The codemod moved 20 files
  and reported 71 rewrites (the moved files included).
- `index.ts` holds the six production symbols plus `defaultProbeFamily`,
  which `preview-browser-harness.ts` hands to the test support in place of
  its stubbed probe. All twelve production importers use it;
  `commands-registry-previews.ts`, `preview-http-proxy.ts`,
  `preview-publication.ts`, both tunnel servers and `preview-upstream-pool.ts`
  had their several imports merged into one. `preview-upstream-pool.test.ts`
  uses only `index.ts` symbols, so it imports `index.js` too; tests that use
  the test support keep their deep import (procedure step 3).
- Named exception: `test-support.js`. The two harness entrypoints are
  test-only, but their names (`*-harness.ts`) do not match the tests-off
  override's `*test-harness*` glob, so the `apps/backend/src/**` pattern
  reported their `createPreviewHarness` imports. Options: (a) an exception
  for `test-support.js` in that pattern; (b) re-export `createPreviewHarness`
  from `index.ts`; (c) add the two harness files to the tests-off override.
  Chosen (a): it keeps test support out of the domain's surface, and (c)
  would also drop the protocol `testing/*` rule for those files. Cons: a
  production file could import `test-support.js` without a lint error, but
  the name makes that plain in review; the `tests/unit/**` pattern stays
  strict. `defaultProbeFamily` went into `index.ts` rather than a second
  exception because it is a plain function of the domain's surface (the
  runtime's own default). No runtime cycle needed an exception:
  `bunx oxlint` (`import/no-cycle`) is clean with every importer on
  `index.ts`.
- Hand fixes after the codemod: the bare names in `constants.ts`'s comment,
  `target-resolver.ts`'s own comment, `docs/architecture/browser-previews.md`,
  `docs/architecture/future-windows-support.md`, to-do 0046, and the folder
  list in `docs/development/linting.md` (which now also names test support
  as a kind of exception). Flake records and the dated
  `worktree-watcher-validation.md` report keep the codemod's path rewrites,
  as in the earlier slices. The done plan record `plans/unified/7004` keeps
  the old name. `@orkestrator/protocol/preview-access` and the protocol's
  own `preview-access.ts` (cited by `preview-tunnel-mux.ts`) are other
  modules with the same name and are untouched.
- One test fix outside the pure move, in a separate commit:
  `previews/local-discovery.test.ts` failed alone (2 of 19) because a
  comment added to its single-quoted fixture script on 2026-11-15 contained
  an apostrophe. The comment is reworded, behaviour is unchanged, and flake
  record 1145 has the details. It is in the slow tier, so the default suite
  had not caught it.
- Lint patterns: `**/previews/*` with `!**/previews/index.js` and
  `!**/previews/test-support.js` under `apps/backend/src/**`, and the
  `**/backend/src/core/previews/*` form under `tests/unit/**`. No backend
  or `tests/unit` import path has another `previews/` segment
  (`@orkestrator/protocol/contract/domains/previews` ends in it, so it does
  not match). Checked with probe files (deleted): a deep import of
  `runtime.js` is reported under both overrides, `index.js` is not reported
  under either, and `test-support.js` is reported only under
  `tests/unit/**`.
- No manual checking is left: the move changes no behaviour, and what
  remains (`mise run test`, `build:backend`, `verify:packaged-backend` and
  the preview scenario suites) is agent work for the validation stage, so
  nothing was added to the manual-test checklist (7568).

### Task 2: `features` as the second wave 2 slice

- Chosen: one domain, `features`, moved with the codemod
  (`--prefix feature- --into features`) against `main` at `dc90609bf`. It is
  the next wave 2 domain in the plan's order and the smallest left, neither
  open pull request touched it, and the ticket excluded the domains other
  builds in the same wave edit (`opencode`, `native-agent`, `coordinator`,
  `build-pipeline`, `review`). The ticket also offered `agent-accounts` and
  `worktrees`; `agent-accounts` has many more importers and is reached by
  `opencode2/`'s named exception, so it is a larger slice than this one.
- File names: `--prefix` works here (every file starts with `feature-`), so
  no map file: `feature-planning.ts` → `planning.ts`,
  `feature-planning-scheduling.ts` → `planning-scheduling.ts`,
  `feature-build.ts` → `build.ts`, `feature-build-tasks.ts` →
  `build-tasks.ts`, `feature-plan-build.ts` → `plan-build.ts`, and their four
  tests to match. The folder is `features/` (the plan's domain name), not
  `feature/`.
- Measured before the move: 6 production importers outside the folder
  (`backend-runtime.ts`, `commands-context.ts`, `commands-registry-build.ts`,
  `commands-validation.ts`, `index.ts` and
  `apps/backend/scripts/recurring-baseline-workflows.ts`) using four symbols
  from four modules; two tests outside the folder
  (`build-pipeline-delivery.test.ts` and `apps/backend/tests/recurring-baseline.test.ts`);
  and path strings in three flake records. No `mock.module()` or `spyOn`
  targeted the files, no worker or bundle entry point names them, and no
  `<revision>:<path>` string named a moved file. The codemod moved 9 files
  and rewrote 20.
- `index.ts` holds exactly the four production symbols. All six production
  importers use it (`commands-context.ts` and `commands-validation.ts`
  type-only), and `commands-registry-build.ts`'s two imports became one. The
  two tests outside the folder use only those symbols, so they import
  `index.js` too rather than keeping the codemod's deep paths.
  `recurring-baseline-workflows.ts` sits outside `apps/backend/src/**`, so no
  lint pattern covers it; it imports `index.js` anyway.
- No named exception: `mise run lint` (`import/no-cycle`) stays clean with
  every importer on `index.ts`, and no moved file documents itself as a leaf
  kept off a larger graph.
- Hand fixes after the codemod: the bare names in
  `docs/architecture/agent-engines.md`, `backend-runtime.md`,
  `build-pipeline-view.md`, `recurring-work.md` and
  `version-compatibility.md`, to-dos 0031 and 0048, the comment in
  `apps/web/src/lib/feature-plan-build-compat.ts`, and the folder list in
  `docs/development/linting.md`. The three flake records (0189, 0213, 1254)
  keep the codemod's path rewrite, as in the earlier slices. The done plan
  records `plans/unified/7008` and `7009` keep the old names: they describe
  work at that time. `@orkestrator/protocol/feature-planning` and
  `@orkestrator/protocol/feature-build` are other modules with the same names
  and are untouched; the `feature-planning` recurring-work domain and tick
  names are identifiers, not paths, and are unchanged.
- Lint patterns: `**/features/*` with `!**/features/index.js` under
  `apps/backend/src/**`, and the `**/backend/src/core/features/*` form under
  `tests/unit/**`. No backend or protocol module path ends in `features/<x>`,
  so neither pattern catches anything else. Checked with probe files
  (deleted): a deep import of `features/planning.js` is reported under both
  overrides, and `features/index.js` is not.

### Task 2: `plan-usage` as the first wave 2 slice

- Chosen: one domain, `plan-usage`, moved with the codemod against `main` at
  `17d28238c`, in the same change as the `keyed-record-format.ts` placement
  (both requested together; the placement changes one comment). It is the
  first wave 2 domain in the plan's order and the smallest, no open pull
  request touched it (two were open), and the ticket excluded the domains
  other running builds own (`opencode`, containers, native-agent,
  transcripts, coordinator, multi-review, storage, public-api, nodes, mcp,
  host maintenance), so `opencode` stays open in wave 1.
- File names: a `--map` file rather than `--prefix`, because
  `plan-usage.ts` has no `plan-usage-` prefix to drop. It became
  `reader.ts` (its header: "plan-quota reads … without starting an agent";
  it exports `createPlanUsageReader`) and its test `reader.test.ts`;
  `plan-usage-cache.ts` became `cache.ts`, and
  `plan-usage-agent-test-origin.test.ts` became `agent-test-origin.test.ts`.
  Options were `reader.ts` or `index.ts`-as-implementation; `index.ts` stays
  the re-export-only surface, as in every other folder.
- Measured before the move: 10 production importers outside the folder
  (`agent-accounts-runtime.ts`, `agent-accounts.ts`, `agent-usage-limits.ts`,
  `commands-registry-types.ts`, `feature-planning.ts`,
  `native-agent-service-shared.ts`, `retired-looped-review-cleanup.ts`, and
  `http-bridge/progressive.ts`, `provider.ts` and `transport.ts`) using
  seven symbols from two modules; four co-located tests outside the folder
  (`agent-accounts.test.ts`, `agent-usage-limits.test.ts`,
  `backend-runtime.test.ts`, `http-bridge/provider.test.ts`); and path
  strings in one flake record and one to-do file. No `mock.module()` or
  `spyOn` targeted the files, no worker or bundle entry point names them, and
  no `<revision>:<path>` string named a moved file. The codemod moved 5 files
  and rewrote 21.
- `index.ts` holds exactly the seven production symbols. Eight production
  importers use it, six of them type-only; `agent-accounts-runtime.ts`
  (its two imports merged into one) and `agent-accounts.ts` import values
  through it, and both already reached `reader.ts`. Co-located tests outside
  the folder keep deep imports (procedure step 3).
- Named exception: `cache.js`. Routing all ten importers through `index.ts`
  closed no runtime cycle (`oxlint` clean), but `cache.ts`'s header says it is
  "deliberately a leaf module" so that provider read paths do not pull in the
  reader's credential machinery (the Keychain, config and container command
  modules). With `http-bridge/provider.ts` importing `index.js`, its value
  import graph grew from 49 to 194 modules and reached `reader.ts`,
  `commands-files.ts`, `commands-validation.ts` and `cursor-sdk-bridge.ts`
  (measured with a throwaway value-import reachability script). Options:
  (a) an exception for `cache.js` in the `apps/backend/src/**` pattern;
  (b) route the bridge files through `index.ts` and accept the larger graph;
  (c) a second barrel for the cache. Chosen (a), the same mechanism as the
  cycle exceptions: it keeps the leaf property the module documents, and a
  barrel per leaf would split the domain's surface. Cons: a second allowed
  import path for the cache's three symbols. `http-bridge/transport.ts` imports
  only the type `PlanUsageState`, so it goes through `index.ts`. The
  `index.ts` header and `linting.md` ("Module boundaries") name the exception.
- Hand fixes after the codemod: the bare name `plan-usage.ts` in
  `cache.ts`'s own header (now `reader.ts`), a comment in
  `commands-servers-agent-test-origin.test.ts`, short names in
  `docs/architecture/agent-accounts.md` and `backend-runtime.md`, to-dos 0003
  and 1000, and the folder list in `docs/development/linting.md`. The flake
  record (0175) keeps the codemod's path rewrite, as in the earlier slices.
  The four `bridges/cursor-bridge` `plan-usage.js` imports and
  `@orkestrator/protocol/plan-usage` are other modules with the same name and
  are untouched.
- Lint patterns: `**/plan-usage/*` with `!**/plan-usage/index.js` and
  `!**/plan-usage/cache.js` under `apps/backend/src/**`, and the
  `**/backend/src/core/plan-usage/*` form under `tests/unit/**`.
  `@orkestrator/protocol/plan-usage` and
  `@orkestrator/protocol/node/cursor-plan-usage` end in a single segment, so
  neither matches. Checked with probe files (deleted): deep imports of
  `cache.js` and `reader.js` are reported under `tests/unit/**`, `reader.js`
  is reported under `apps/backend/src/**` and `cache.js` is not, `index.js`
  is not reported under either, and the two protocol imports are not.

### Task 1: `keyed-record-format.ts` stays in the shared kernel

- Chosen: task 7's recommended option. Its three production importers are in
  two domains (the build pipeline's transcript store and legacy manifest
  import, and `transcript-artifacts/store.ts`), and what it offers is generic
  (a record header format plus `syncDirectory`, `writeExclusivePrivateFile`,
  `readBoundedFile` and `sha256Hex`), so it is kernel code by this file's own
  rule. The other option, `build-pipeline/` exported from its `index.ts`,
  would make `transcript-artifacts/` depend on `build-pipeline/` for a file
  helper, and `build-pipeline` has not moved yet.
- Done in this change: no move and no import rewrite (nothing to update). The
  header comment, which said the format is "shared by the keyed record store
  and the record manifest" (the store went with #969), now names its users and
  says why it is in the kernel. The table row and "Open questions" record the
  placement.

### Task 1: `control-mcp` as the next slice

- Chosen: one domain, `control-mcp`, moved with the codemod
  (`--prefix control-mcp- --into control-mcp`) against `main` at
  `963ffa6ab`, in the same change as to-do 7800 (a separate commit before
  it). It is the last wave 1 move with no open question: no open pull request
  touched it (three were open, none in backend code), and #1912, which kept
  it out of the `http-bridge` slice, has merged. `opencode` is now smaller
  (7/6 plus four `opencode2-*` files) but still needs the `opencode2/`
  layout decision and a map file (see task 1, "Investigation"), so it stays
  open for its own change. `commands-registry-control.ts` and
  `control-shared-actions.ts` stay at the root: neither has the prefix.
- Measured before the move: importers outside the folder were 4 production
  files in `apps/backend/src/core/` (`index.ts`, `commands-context.ts`,
  `commands-servers.ts`, `scheduled-jobs/executor.ts`) using nine symbols
  from three modules; 21 co-located tests and one test-support file
  (`multi-review-graph-surfaces-test-support.ts`) in `apps/backend/src/`,
  one `apps/backend/tests` integration test, `tests/source-guards/baseline.json`
  and the raw-`console` allowlist in `.oxlintrc.json` (one path each), and
  path strings in three architecture docs, one development doc, five to-do
  files and seventeen flake files (four group indexes and thirteen records).
  The codemod moved 69 files and rewrote 118. No
  `<revision>:<path>` string named a moved file.
- `index.ts` holds exactly the nine production symbols. `index.ts` (the
  composition root) and `commands-context.ts` (type-only, including its
  `import("…")` type expression) import it; co-located tests, test support
  and `apps/backend/tests` keep deep imports (procedure step 3).
- Named exception: `tools.js`. Routing `commands-servers.ts` and
  `scheduled-jobs/executor.ts` through `index.ts` added `import/no-cycle`
  errors across the command registry (`commands-registry-projects.ts`,
  `commands-helpers.ts`, `commands-servers.ts`), `public-api/`
  (`actions-projects.ts`, `actions-schedules.ts`, `index.ts`) and
  `scheduled-jobs/index.ts`: `index.ts` re-exports `server.ts`, which reaches
  both importers. With those two value imports kept on `tools.js` the lint
  run is clean, so `tools.js` reaches neither. Chosen as in task 6 and the earlier
  slices: an exception in the `apps/backend/src/**` pattern and a note in
  the `index.ts` header, since breaking the cycle is a code move.
  `scheduled-jobs/executor.ts` takes the type `CoordinatorControlScope` from
  `index.ts` with `import type`, which adds no runtime edge. The task 6
  exception `scheduled-jobs/tools.js` (imported by
  `control-mcp/coordinator-tools.ts`) is unchanged.
- Hand fixes after the codemod: bare file names in the moved files' own
  comments (written as the short name, `tools.ts`), source comments in
  `commands-registry-nodes.ts`, `control-shared-actions.ts`,
  `nodes/node-action-requests.ts`, `public-api/index.ts` and
  `scheduled-jobs/index.ts`, the root `AGENTS.md` suborks row, eleven
  architecture and development docs, twelve to-do files (the manual-test
  checklist and the `mcp` folder index included), four `plans/unified/` files,
  and the folder list in `docs/development/linting.md`. Flake records keep
  the path rewrites the codemod made and their bare names, as in the
  earlier slices; to-do 7543 is not touched (another build owns it, and it
  names no moved file).
- Lint patterns: `**/control-mcp/*` with `!**/control-mcp/index.js` and
  `!**/control-mcp/tools.js` under `apps/backend/src/**`, and the
  `**/backend/src/core/control-mcp/*` form under `tests/unit/**`. The only
  other import path with `control-mcp` is `@orkestrator/protocol/control-mcp`,
  a single segment. Checked with probe files (deleted): a deep import is
  reported under both overrides, `index.js` is not, `tools.js` is not
  reported under `apps/backend/src/**` and is under `tests/unit/**`, and the
  protocol import is not.
- Validation run here: `bunx oxlint apps/backend tests/unit scripts` (no
  errors), backend typecheck, the backend build (`bun run --cwd apps/backend
  build`, fresh bundle), the moved tests, `scheduled-jobs/` and every test
  that imports the folder (774 pass across 56 files), and the root unit tests
  that name backend paths, the codemod or the to-do registers (37 files).
  `mise run guards` fails only on a finding in
  `apps/web/src/components/review/ToPipelineButton.test.tsx`, which is
  already on `main` (#2173) and outside this change. The full suite and
  `verify:packaged-backend` run in the pipeline's validation stage.

### To-do 7800: `index.ts` for `permission-rules/`, `self-improvement/` and `opencode2/`

- Chosen: all three folders in one change (against `main` at `963ffa6ab`),
  by the procedure's steps 3 to 5 with no file moves. 7800 recommended doing
  `opencode2/` on its own or with the `opencode` slice because OpenCode 2
  work was in flight; the ticket asked for all three, no open pull request
  touched `opencode2/`, and each rewrite is a one-statement path change that
  rebases easily. The four root `opencode2-*.ts` files stay where they are
  (7800's recommendation) and go through `opencode2/index.js`.
- Measured: production importers outside each folder were 10 files for
  `permission-rules/` (9 symbols from 5 modules), 4 for `self-improvement/`
  (3 symbols; one is an `import("…")` type expression in
  `commands-context.ts`) and 20 for `opencode2/` (49 symbols from 15
  modules). Each `index.ts` holds exactly those symbols, as named re-exports.
- Named exception: `opencode2/container-credentials.js`. Routing
  `agent-accounts-containers.ts` and `portable-input-status.ts` through
  `opencode2/index.ts` added four `import/no-cycle` errors, because
  `index.ts` reaches `agent-accounts-containers.ts` through `host-launch.ts`
  (`pushedLoginHostFile`), and `agent-accounts-containers.ts` imports
  `portable-input-status.ts`. Chosen as for the earlier slices: an exception
  in the `apps/backend/src/**` pattern and a note in the `index.ts` header,
  since breaking the cycle is a code move. `permission-rules/` and
  `self-improvement/` need none, the storage layer included: neither
  `index.ts` reaches storage.
- `self-improvement/` has an `insights/` subfolder, and a `*` pattern does
  not match below the first level (a probe import of
  `self-improvement/insights/prepare.js` was not reported), so both of its
  patterns use `**`. The other two folders have no subfolders.
- Not routed through `index.ts`: co-located tests, `apps/backend/tests/**`,
  `e2e/` and `bridges/` tests and fixtures, and
  `apps/backend/scripts/self-improvement-scan-stall.ts` (a white-box
  measurement script outside both lint overrides).
- Lint checked with probe files (deleted): deep imports into all three
  folders are reported under both overrides, `index.js` is not, the
  `container-credentials.js` exception is not reported under
  `apps/backend/src/**` and is under `tests/unit/**`, and
  `@orkestrator/protocol/permission-rules` and
  `@orkestrator/protocol/self-improvement` (single segments) are not.
- 7800 had one task, so it is retired; its row is gone from the folder
  index, the counts are updated, and `linting.md` ("Module boundaries") lists
  the three folders.

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

- Where `keyed-record-format.ts` goes. Settled 2026-11-13: the shared kernel
  at the `core/` root, because `transcript-artifacts/store.ts` imports it as
  well as two `build-pipeline/transcript-*.ts` files (task 7).
- Where `pi-model-catalog-seeding.ts` belongs: next to the native-agent model
  catalogue code, or the kernel. Decide when it is touched. The `native-agent`
  slice (2026-11-20) did not touch it: its importers are
  `host-model-catalog-refresh.ts` and `commands-registry-projects.ts`, and
  the catalogue code beside it (`pi-catalog-probes.ts`, owned by
  `runtime.localServers.piCatalog`) is not a native-agent file.
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
- To-do 7800 (retired 2026-11-11; read it with
  `git show 963ffa6ab:docs/todo/backend-structure/7800-domain-folders-without-index.md`):
  `index.ts` and lint patterns for `permission-rules/`, `opencode2/` and
  `self-improvement/`.

## Replaces

- `docs/2026-10-14/core-domain-folders.md`
