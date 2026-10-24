# Backend core domain folders

Checked against `main` at `2459b05c` (2026-10-15).

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
  one `git add`, and runs `oxfmt` on what it touched. It does not rewrite bare
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
