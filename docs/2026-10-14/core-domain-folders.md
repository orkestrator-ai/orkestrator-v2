# Backend `core/` domain folders — plan

Status: Active — Wave 1 in progress. Slice 1 (`design`) moved on 2026-10-15;
see the [slice log](#slice-log) for what each slice did and the procedure
lessons. Next slice: `keyed-records`. Follow-up to the module-boundary guardrails added
on branch `architecture-boundaries-01141669b04a-r1` (2026-10-14). The rules
those added are described in
[linting.md § Module boundaries](../development/linting.md#module-boundaries).
The companion plan, [runtime-state-ownership.md](runtime-state-ownership.md),
should land before the `commands` slice below.

## Problem

`apps/backend/src/core/` holds 373 non-test source files in one directory,
with two subfolders (`public-api/`, `mcp-management/`). The domains exist only
as filename prefixes (`design-*`, `opencode-*`, `web-annotation-*`, …), so
nothing shows or enforces what a domain offers to the rest of the backend:

- Any file can import any other file's internals. A domain's real public
  surface is whatever someone happened to import.
- There is still a 112-file type-level import cycle across `core/`. It is
  harmless at runtime, because `import/no-cycle` now blocks runtime cycles,
  but it shows how tangled the domains are.
- Ownership questions ("who may call `design-records.ts`?") have no answer in
  the tree.

## End state

```text
apps/backend/src/core/
  design/
    index.ts            ← the only file other domains import
    service.ts          (was design-service.ts)
    records.ts          (was design-records.ts)
    …
  opencode/
    index.ts
    …
  shell.ts, constants.ts, models.ts, path-safety.ts, …   ← shared kernel
```

- Each domain is a folder, and its `index.ts` re-exports only what other
  domains use today.
- Inside a folder, the domain prefix drops from the file name (`design/service.ts`,
  not `design/design-service.ts`). Tests move with their source file.
- Files no domain owns, such as `shell.ts`, `constants.ts`, `models.ts` and
  `path-safety.ts`, stay at the `core/` root as the shared kernel. Do not
  create a `core/shared/` or `core/utils/` folder: it becomes the next
  `commands-dependencies.ts`.
- A lint rule stops any file outside a domain from importing that domain's
  internals (see [Enforcement](#enforcement)).

## Domain map

These numbers were measured on 2026-10-14 (after the barrel removal) by
grouping files by prefix:

- **Dependent domains**: how many other domains import this one.
- **Runtime importers**: production files outside the domain that import it
  for values.
- **Outside `core/`**: importers in `src/*.ts` or `tests/`, which also need
  their paths rewritten.
- **Source-path refs**: tests or scripts that name a file path as a string.

| Domain | Prefixes | Files | Tests | Dependent domains | Runtime importers | Depends on | Outside `core/` | Source-path refs |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| design | `design-*` | 20 | 11 | 2 | 3 | 0 | 0 | 0 |
| keyed-records | `keyed-record-*` | 7 | 2 | 3 | 3 | 0 | 0 | 0 |
| mcp-management | (folder) | 19 | 18 | 2 | 2 | 1 | 0 | 0 |
| opencode | `opencode-*` | 25 | 19 | 3 | 6 | 1 | 0 | 0 |
| web-annotations | `web-annotation-*` | 24 | 22 | 2 | 4 | 3 | 0 | 0 |
| http-bridge | `http-bridge-*` | 13 | 11 | 2 | 1 | 3 | 0 | 0 |
| control-mcp | `control-mcp-*` | 2 | 1 | 2 | 1 | 2 | 0 | 0 |
| public-api | (folder) | 27 | 5 | 4 | 6 | 6 | 1 | 0 |
| plan-usage | `plan-usage*` | 2 | 2 | 3 | 5 | 3 | 0 | 0 |
| features | `feature-*` | 3 | 3 | 2 | 2 | 7 | 0 | 0 |
| coordinator | `coordinator-*` | 7 | 5 | 5 | 10 | 4 | 0 | 0 |
| agent-accounts | `agent-accounts-*` | 7 | 7 | 4 | 10 | 4 | 0 | 0 |
| worktrees | `worktree-*` | 6 | 4 | 4 | 6 | 3 | 1 | 0 |
| previews | `preview-*` | 7 | 5 | 2 | 2 | 3 | 13 | 0 |
| git | `git-*`, `github*`, `pr-*` | 9 | 7 | 2 | 12 | 3 | 8 | 0 |
| workflows | `workflow-*` | 9 | 7 | 7 | 11 | 4 | 0 | 0 |
| review | `multi-review-*`, `review-*`, `looped-review-*` | 26 | 26 | 6 | 12 | 9 | 1 | 0 |
| build-pipeline | `build-pipeline-*` | 17 | 15 | 6 | 12 | 8 | 2 | 0 |
| native-agent | `native-agent-*` | 25 | 36 | 8 | 20 | 9 | 1 | 0 |
| terminals | `terminal-*`, `transcript-*` | 3 | 3 | 6 | 14 | 2 | 1 | 0 |
| tmux | `tmux*` | 10 | 0 | 4 | 8 | 6 | 8 | 0 |
| recurring | `recurring-*` | 4 | 2 | 13 | 30 | 2 | 3 | 0 |
| containers | `container-*`, `docker-*` | 18 | 4 | 6 | 17 | 8 | 23 | 1 |
| environments | `environment-*` | 11 | 9 | 7 | 23 | 9 | 8 | 0 |
| storage | `storage*` | 19 | 24 | 13 | 22 | 7 | 8 | 1 |
| commands | `commands*` | 51 | 35 | 13 | 25 | 25 | 23 | 11 |
| (shared kernel) | everything else | 46 | 33 | 24 | 125 | — | 36 | 2 |

`pi-*` (one file) can join `opencode`'s neighbours or stay in the kernel; decide
when it is touched. Re-run the measurement before each slice. The tree moves,
and the order below depends on these numbers.

## Order

Move domains that few others depend on first. Each move is cheap and safe, and
together they prove the procedure before the busy domains move.

1. **Wave 1 (leaves).** `design` (no dependencies on other domains, 3 runtime
   importers: `agent-tools.ts`, `commands-registry-design.ts`, `index.ts`),
   then `keyed-records`, `opencode`, `web-annotations`, `http-bridge`,
   `control-mcp`. `mcp-management/` and `public-api/` are already folders.
   They only need an `index.ts` and the lint rule.
2. **Wave 2 (mid-tier).** `plan-usage`, `features`, `coordinator`,
   `agent-accounts`, `worktrees`, `previews`, `git`, `workflows`, `review`,
   `build-pipeline`, `native-agent`.
3. **Wave 3 (hubs).** `terminals`, `tmux`, `recurring`, `containers`,
   `environments`, `storage`. Many files import these, and several are imported
   from outside `core/` (`containers` 23, `previews` 13), so these slices
   touch the most files.
4. **Last: `commands`.** It depends on 25 other domains and owns
   `commands-runtime-state.ts`. Move it only after
   [runtime-state-ownership.md](runtime-state-ownership.md) has replaced that
   module's globals. It has 11 tests that name source paths as strings.

## One slice, step by step

One domain per PR. Keep the PR mechanical: no behaviour change, and no edits
beyond paths, the new `index.ts` and the lint rule.

1. **Measure.** List the domain's files, its importers outside the domain, and
   the symbols they use. That symbol list *is* the `index.ts`.
2. **Move with a codemod, not by hand.** The first slice commits
   `scripts/move-backend-modules.ts`, based on the codemod that moved
   `packages/protocol/src/node/` on 2026-10-14. It takes a mapping of old path
   to new path and does four things:
   - moves the files;
   - rewrites every relative specifier in the moved files, and in every file
     that imports them, by resolving the old target, mapping it, and
     re-relativising (keeping the `.js` suffix);
   - rewrites `mock.module("…")`, `import("…")` and `require("…")` the same way;
   - rewrites `apps/backend/src/core/<file>.ts` path strings in tests,
     `scripts/`, docs and `AGENTS.md`.

   Watch for relative specifiers that leave the package (`../../../…`). They
   gain a level when a file moves one directory deeper; the protocol move hit
   exactly this in `preview-forward.test.ts`.
3. **Write `index.ts`.** Use explicit named re-exports only (`export { X } from
   "./x.js"`, never `export *`), so the public surface is reviewable in one
   file. Point external importers at `./design/index.js`.
4. **Add the domain to the lint rule** (below) in the same PR.
5. **Validate.** Run `mise run format:check`, `mise run lint`,
   `mise run typecheck`, `mise run test`, `mise run build:backend` and
   `mise run verify:packaged-backend`. The last two catch a bundled entry
   point or worker that names a moved file.
6. **Merge quickly.** Do not let a move PR wait for review alongside feature
   work.

### Things a move can break

- `mock.module()` paths and `spyOn(namespace, …)` targets in tests. The
  `commands-dependencies` removal had one namespace spy that needed
  repointing.
- Source files read as text by tests or scripts (for example
  `scripts/efficiency/workloads-transcripts.ts` loads bridge modules by path).
- Worker and bundler entry points in `apps/backend/scripts/build.ts` and
  anything that embeds a function body (`host-test-scheduler` is serialised
  into validation workers).
- Doc links in `docs/` and `AGENTS.md` (16 references to `core/design*.ts`
  alone).

## Enforcement

Each moved domain adds one pattern to a single backend override in
`.oxlintrc.json`:

```json
{
  "files": ["apps/backend/src/**", "tests/**"],
  "rules": {
    "no-restricted-imports": ["error", { "patterns": [
      { "group": ["**/design/*", "!**/design/index.js"],
        "message": "Import the design domain through design/index.js." }
    ] }]
  }
}
```

This was verified against oxlint 1.88 on 2026-10-14: a deep import is
reported, `index.js` is allowed, and files inside the folder importing each
other (`./records.js`) are not affected.

Two caveats:

- Overrides for the same rule replace one another rather than merging (see
  [linting.md](../development/linting.md#module-boundaries)). The backend
  override must therefore repeat the global
  `@orkestrator/protocol/testing/*` pattern.
- Decide whether tests may reach domain internals. Two options:
  - **Allow it.** List `tests/**` and `**/*.test.ts` in the existing tests
    override, which turns the rule off. White-box tests next to their source
    stay simple.
  - **Restrict it.** Only tests inside the domain folder may reach its
    internals.

  Recommendation: allow it for co-located tests (`core/design/*.test.ts`) and
  forbid it for `tests/unit/**`.

## Living with parallel branches

Orkestrator runs many agent branches at once, so every move PR conflicts with
whatever is in flight in that domain.

- Prefer quiet windows, and move a domain while nobody has an open branch in
  it (`git log --since=… -- 'apps/backend/src/core/design-*'`).
- Git's rename detection (`merge-ort`) carries most edits on in-flight branches
  across a pure rename, which is why each slice must stay pure moves and
  imports. If a rebase misses a rename, re-run with
  `-X find-renames=40%`.
- Announce each merged slice so open branches rebase promptly.

## Done when

- Every domain in the map is a folder with an explicit `index.ts`.
- Every domain has an enforcement pattern, and `mise run lint` is clean.
- `core/` root holds only the shared kernel and `index.ts` (the backend
  composition root).
- The type-level cycle across `core/` is re-measured and recorded here. It is
  not expected to reach zero, but cross-domain type cycles should go through
  `index.ts` files, where they are visible.

## Slice log

### 1. `design` (2026-10-15)

- **Measured.** 21 source files (including `test-support.ts`) and 12 tests
  moved to `core/design/`. Production importers outside the folder:
  `agent-tools.ts`, `commands-context.ts` (type only),
  `commands-registry-design.ts` and `index.ts`. `index.ts` exports 4 symbols:
  `DesignService`, `createDesignMcp`, `registerDesignCommandHandlers` and
  `resolveDesignDestination`. The domain map above is stale for `design`: since
  the SQLite migration (#969) `design/coordination.ts` depends on `storage`
  (`storage-stores`, `storage-deletion-fences`, `storage-database`).
- **Codemod.** `bun scripts/move-backend-modules.ts --prefix design- --into design`
  (add `--dry-run` first). It rewrote 47 files. Hand edits on top: the four
  production importers now use `design/index.js`, and bare file names in prose
  (`design-service.ts`) in living docs and two source comments. Historical plan
  docs under `docs/improvements/design-space/plan/` keep their bare names.
- **Tests stay white-box.** Tests outside the folder
  (`commands-registry-design.test.ts`, `mcp-tool-schema-portability.test.ts`),
  the e2e specs and `scripts/benchmark-design.ts` keep deep imports: they use
  `test-support.ts` or internals (`runDesignAction`,
  `resolveDesignChromiumPath`, `planDefaultDesignExportPath`) that no other
  domain needs, so `index.ts` does not export them.
- **Lint rule.** Two overrides, not the single one sketched in
  [Enforcement](#enforcement). The `apps/backend/src/**` override sits *before*
  the tests override, so any `*.test.ts` and test-support file may reach
  internals. A `tests/unit/**` override *after* it restricts deep imports again.
  That one uses `**/backend/src/core/design/*`, because `**/design/*` would also
  catch web imports such as `@/components/design/*`, and it leaves out the
  `@orkestrator/protocol/testing/*` pattern, which tests may use. Each later
  slice adds its pattern to both overrides.

Procedure lessons:

- Re-measure dependencies: the map's `0` for `design` was a day old and wrong.
- Per-file `git mv` failed midway on an `index.lock` held by another process,
  leaving a half-moved tree. The codemod now renames on disk and stages all
  moves with one retried `git add -A`. Start from a clean tree. If a run still
  fails, reset with `git reset -q && git checkout -- . && rm -rf <new folder>`
  and run it again.
- Shorter specifiers let wrapped import lists fit on one line, which fails
  `format:check`. The codemod now runs `oxfmt` on every file it touched.
