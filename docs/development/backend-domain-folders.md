# Backend domain folders

`apps/backend/src/core/` is split into domain folders. Each folder has an
`index.ts` that re-exports, by name, what the rest of the backend may use, and
a lint pattern makes a deep import into the folder an error. The modules that
belong to no domain stay at the `core/` root. This page says how the folders
are laid out, how to move files into one, how a folder's surface and its
exceptions are chosen, and how the type-level import cycle is measured. The
boundary rules themselves, and every folder's exceptions, are in
[`linting.md`](linting.md) ("Module boundaries").

The folders came from to-do 0012 (retired 2026-11-26), which moved the
`core/` prefix groups one domain per pull request, the last (`commands`) on
2026-11-26. Its slice-by-slice decision record is in
`git show 8950e12e2:docs/todo/backend-structure/0012-backend-core-domain-folders.md`.
The root groups it did not plan for are [to-do 8324](../todo/backend-structure/8324-backend-core-root-groups.md).

## Layout

- One folder per domain (`commands/`, `storage/`, `containers/`,
  `native-agent/`, …), with the file-name prefix dropped:
  `commands-registry-native.ts` is `commands/registry-native.ts`. A
  sub-prefix stays in the file name rather than becoming a subfolder
  (`commands/registry-*.ts`, `build-pipeline/review-*.ts`, `git/github*.ts`).
- `index.ts` re-exports by name, never `export *`, so the surface is
  reviewable in one file. Its header says what the domain owns, what stays
  outside, and why each exception is one.
- Code outside the folder imports `index.ts`. Tests, test support,
  `apps/backend/tests`, `apps/backend/scripts` and repository scripts may keep
  deep imports where they use internals no other domain needs.
- A new domain folder starts with an `index.ts` and a pattern in both
  `.oxlintrc.json` overrides (`apps/backend/src/**`, and `tests/unit/**` in the
  `**/backend/src/core/<domain>/*` form).
- The composition root is `core/index.ts`. Modules shared by several domains
  (`keyed-record-format.ts`, `shell.ts`, `models.ts`, …) and the groups no
  domain owns yet stay at the root.

## Moving files into a domain

`scripts/move-backend-modules.ts`, tested by
`tests/unit/move-backend-modules.test.ts`, does the mechanical part:

```bash
mise exec -- bun scripts/move-backend-modules.ts --prefix <prefix> --into <folder> --dry-run
mise exec -- bun scripts/move-backend-modules.ts --map <moves.json> --dry-run
```

`--prefix` moves every `core/<prefix>*.ts` file, tests included, and drops the
prefix; a `--map` file (old path to new path) handles a group whose names no
single prefix covers, a name that would collide, or a barrel that becomes
`index.ts`. The codemod moves the files, rewrites relative specifiers
(including `import()`, `require()` and `mock.module()`) and path strings in
tracked text files, stages the moves in one `git add` and formats what it
touched. It leaves a path under its old name when it follows a Git revision
and a colon (`git show 0d254a3a^:apps/…`; a 7–40 character hex SHA, `HEAD`,
`main`, an `origin/` name, a `refs/` name or a version tag, with any `^`/`~`
steps) or sits in a commit-pinned GitHub permalink.

Run it from a clean tree, `--dry-run` first. If a run fails midway, reset with
`git reset -q && git checkout -- . && rm -rf <new folder>`. Then fix by hand
what it gets wrong or leaves alone:

- Bare file names (`` `commands-servers.ts` ``) in comments, living docs,
  globs and file-name lists that tests read. Rewrite only the moved names;
  inside the folder name a sibling without the folder, outside it as
  `<folder>/<name>.ts`, and in protocol or bridge comments by the full backend
  path. Leave flake records, plans, dated reports and handoffs as they are.
- Synthetic fixtures whose made-up imports happen to resolve to a moved file
  (`validation-failure-classifier.test.ts`, `storage/writer-guards-raw.test.ts`):
  revert those rewrites.
- Regular expressions and string-built paths that name a moved file
  (`diff-stats-tracking.test.ts` matches its subject's import line), and paths
  a moved file builds from its own location (`import.meta.dir`,
  `new URL("../../…", import.meta.url)`): one folder deeper needs one more
  `../`.
- Readers of older trees: `scripts/backfill-contract-snapshots.ts` imports a
  published release's registry, so it tries `core/commands/registry.ts` and
  then the pre-move `core/commands-registry.ts`.
- `tests/source-guards/baseline.json` entries come out of order; regenerate
  that guard with `bun tests/source-guards/update-baseline.ts --guard <id>`.
- `scripts/test-tiers.ts`, `.orkestrator-test-scheduler.json` triggers and
  workflow path filters: check the moved tests stay in the same tier
  (`slowTestFiles`) and the globs still match.

Then write `index.ts`, point production importers outside the folder at it,
add the two lint patterns and validate with `mise run format:check`,
`mise run lint`, `mise run typecheck`, `mise run test`,
`mise run contract:check` when command modules moved, and
`mise run build:backend`.

## Choosing the surface and the exceptions

`index.ts` re-exports every symbol that production code outside the folder
uses, each from the module that defines it rather than through another
barrel. A module is left out, and named as an exception in the
`apps/backend/src/**` pattern, when re-exporting it would close a runtime
import cycle:

1. Build the runtime import graph: value imports and re-exports only, as
   `import/no-cycle` sees it (type-only imports add no edge).
2. A module is an exception when a value re-export of it reaches, at runtime,
   a file that would import `index.ts`. Remove those, recompute which files
   import `index.ts`, and repeat until nothing changes.
3. Confirm each exception alone with oxlint: add one value re-export of it to
   `index.ts` and count the `import(no-cycle)` errors.

An exception's types can still be re-exported with `export type`, which adds
no runtime edge (`storage/index.ts` and `commands/index.ts` do), so its
type-only importers still go through `index.ts`. Moving a hub can free another
domain's exceptions: when `commands` moved, its importers stopped reaching the
whole command layer through the old `commands.ts` barrel, and
`coordinator/node-tickets.ts`, `review-actions.ts` and `subork-actions.ts`
stopped closing cycles. Re-check a folder's exceptions when a domain it
depends on moves.

## The type-level import cycle

`import/no-cycle` blocks runtime cycles; type-only imports are exempt by
design, and nothing tracks the type-level cycle. It is measured by hand, and
it is not expected to reach zero: cross-domain type edges should run through
the `index.ts` files, where they are visible.

Method: every non-test `.ts` file under `apps/backend/src/core/` (excluding
`*test-support*`, `*test-helpers*`, `*test-harness*` and `fixtures/`); an edge
for every relative `import … from` and `export … from`, value or type, and
every `import("…")` type expression; Tarjan's strongly connected components;
count the components larger than one file.

| Date | Commit | Files | In cycles | Largest component | Without `import("…")` edges |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026-10-28 | `79f3bc97` | 754 | 308 | 292 | 289 |
| 2026-10-28, with the first four `index.ts` files | `79f3bc97` | 758 | 316 | 300 | 297 |
| 2026-11-26, before `commands` moved | `8950e12e2` | 1394 | 925 | 916 | 913 |
| 2026-11-26, after `commands` moved | (the move) | 1394 | 824 | 815 | 767 |

The largest component grew as the folders arrived: a type import through an
`index.ts` reaches every module that file re-exports, which is the trade the
plan accepted. After the `commands` move, 132 of the 815 files are at the
`core/` root and the rest in 34 folders (`storage/` 65, `native-agent/` 50,
`capabilities/` 46, `public-api/` 44, `build-pipeline/` 40, `coordinator/` 38,
`commands/` 26, …). The other components hold 5, 2 and 2 files.

## Decisions from the last step (2026-11-26)

The `commands` move against `main` at `8950e12e2`, and what retired to-do 0012.

- **What moved.** All 87 `commands*` source files (`secret-sweep-test-support.ts`
  included) and their 85 tests, with a `--map` file: `commands-<name>.ts`
  became `commands/<name>.ts`, and the five-line barrel `commands.ts` became
  `commands/index.ts` with named re-exports. No `commands*` file is left at
  the root. The `registry-*` sub-prefix stays flat in the file names
  (`commands/registry-native.ts`), as earlier slices kept theirs
  (`build-pipeline/review-*.ts`); a `commands/registry/` subfolder would have
  needed its own `index.ts` and lint pattern for files that only
  `registry.ts` assembles. The codemod moved 172 files and rewrote 808.
- **Surface.** `commands/index.ts` re-exports 71 symbols from 16 modules,
  and 162 of the 177 production importers outside the folder import it (58
  of them also import an exception module). It does not re-export
  `createCommandRegistry`: `registry.ts` reaches every domain, and most
  domains import `index.ts` for a leaf, so the composition root, the contract
  scripts and the tests import `commands/registry.ts`. Symbols that the old
  `commands/helpers.ts` barrel re-exported from other modules
  (`getClaudeOAuthAccessToken`, `BackendEmit`, `parseGitDiffSummary`,
  `getWorktreeBaseDir`, `dropLocalGitScanCaches`) are imported from the
  module or domain that defines them.
- **Exceptions.** Nineteen modules, found with the iterative rule above and
  each confirmed alone with oxlint (15 to 1034 `import(no-cycle)` errors when
  re-exported). Other sets were possible: a smallest set of 18 keeps only
  about 30 importers on `index.ts`, and the set that keeps the most importers
  on `index.ts` (72) needs 20. The iterative rule, which the `storage` and
  `containers` slices also used, gives 19 with 64 value importers on
  `index.ts`. `tests/unit/**` has two exceptions, `registry.ts` and
  `testing.ts` (`__testing`).
- **Earlier exceptions re-checked.** Every exception in the
  `apps/backend/src/**` pattern was tried by re-exporting it from its domain's
  `index.ts` and pointing its production importers there. Removed:
  `coordinator/node-tickets.ts`, `review-actions.ts` and `subork-actions.ts`
  (197 to 198 cycle errors before the move, none after), and
  `agent-accounts/store.ts` and `auto-switch-notices.ts` (none before or
  after: the `storage` slice had already made them unnecessary). Kept: every
  other exception still closes cycles, including `public-api/dispatch.ts`
  and `exec-control.ts`, whose importers are the command modules (65 and 41
  errors), and `control-mcp/tools.ts` (38), and `plan-usage/cache.ts`, which
  closes no cycle but is a deliberate leaf that keeps the plan reader's
  credential modules out of the bridge provider's graph.
- **Readers of older trees.** `scripts/backfill-contract-snapshots.ts` lists
  a published release's registry from that release's checkout, and every
  release so far has `core/commands-registry.ts`; it now tries the new path
  first and falls back to the old one, and its test covers both layouts.
- **0012's other tasks.** The type-level cycle was re-measured (the table
  above). `pi-model-catalog-seeding.ts` stays at the root beside
  `pi-catalog-probes.ts` and the `host-model-catalog-*.ts` files, because
  the model catalogue code has no domain folder; `auto-pipeline*.ts` stays at
  the root, as the `build-pipeline` slice decided. The root still holds 289 source files in groups 0012 never
  planned (`graph-*`, `agent-*`, `host-*`, `linear-*`, …), so its "only the
  shared kernel" goal moved to [to-do 8324](../todo/backend-structure/8324-backend-core-root-groups.md),
  and 0012 was retired.
