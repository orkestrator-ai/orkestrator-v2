# Three backend domain folders have no `index.ts`

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Give `core/permission-rules/`, `core/self-improvement/` and `core/opencode2/` an `index.ts` and both lint patterns**: production code outside each folder imports its internals directly. Status: open.

### 1. Give the three folders an `index.ts` and both lint patterns

**Problem.** Todo [0012](0012-backend-core-domain-folders.md) gives each
backend domain folder an `index.ts` and a `no-restricted-imports` pattern, so
its public surface is one reviewable file and a deep import is a lint error.
Three folders under `apps/backend/src/core/` have neither, so any backend file
can import their internals: `permission-rules/` (6 source files, 6 tests;
added in #1348 on 2026-10-27), `opencode2/` (36 source, 43 tests; #2009,
2026-11-09) and `self-improvement/` (6, 6; #2092, 2026-11-10). 0012's
"Current state" said on 2026-11-03 that no domain folder was without an
`index.ts`; `permission-rules/` already existed then and was missed.

**Context.** `docs/development/linting.md` ("Module boundaries") asks a new
domain folder to start with an `index.ts`; these three did not. The procedure
is 0012's steps 3 to 5 with no file moves, as used for `nodes/`,
`change-tracking/`, `transcript-artifacts/`, `scheduled-jobs/`,
`mcp-management/` and `public-api/` (0012, "Assumptions and decisions",
tasks 1 and 6). The `apps/backend/src/**` override in `.oxlintrc.json` exempts
co-located tests and test support, and the `tests/unit/**` override uses the
`**/backend/src/core/<folder>/*` form.

**Investigation.** Production importers outside each folder on
`14df96544` (a grep of relative specifiers, tests and test support excluded):

- `permission-rules/`: 11 files: `commands-registry-permission-rules.ts`,
  `http-bridge/interactions.ts`, `native-agent-service.ts`,
  `native-agent-session-operations.ts`,
  `native-agent-transcript-projection.ts`, `opencode-interactions.ts`,
  `opencode2/interactions.ts`, `public-api/actions-permission-rules.ts`,
  `storage-permission-rules.ts`, `storage-stores.ts` and `storage.ts`. The
  three storage files are the storage layer, which is where task 6's and the
  `web-annotations` slice's runtime cycles came from, so expect at least one
  named exception there.
- `self-improvement/`: 4 files: `commands-context.ts`,
  `commands-registry-self-improvement.ts`, `index.ts` and
  `public-api/actions-self-improvement.ts`.
- `opencode2/`: 15 files, including the root `opencode2-*.ts` files
  (`opencode2-container-launch.ts`, `opencode2-container-server.ts`,
  `opencode2-credential-sync.ts`, `opencode2-host-server.ts`) that sit beside
  the folder, `native-agent-provider.ts`, `native-agent-service.ts`,
  `local-server-runtime.ts` and `commands-registry-terminal.ts`.

Not done in the 0012 `web-annotations` slice (2026-11-11) because that change
was scoped to one domain, and `opencode2/` had commits on 2026-11-11
(#2144, #2149).

**Decisions.**

- **One change for all three folders, or one each?**
  - **One change for `permission-rules/` and `self-improvement/`, and
    `opencode2/` on its own or with 0012's `opencode` slice (recommended).**
    - Pros: the two small folders are a low-conflict pair; `opencode2/` is
      under active development and its root `opencode2-*` files belong with
      whatever decides the `opencode` folder layout.
    - Cons: two changes instead of one.
  - **All three in one change.**
    - Pros: one review, and 0012's "no folder without an `index.ts`" holds
      again at once.
    - Cons: the `opencode2/` part conflicts with open OpenCode 2 work.
- **Should the root `opencode2-*.ts` files move into `opencode2/` at the same
  time?**
  - **No, leave them to 0012's `opencode` slice (recommended).**
    - Pros: this to-do stays an `index.ts` step with no renames, like task 6.
    - Cons: four `opencode2-*` files stay at the root for now.
  - **Yes.**
    - Pros: the domain ends up in one folder.
    - Cons: a move, which 0012 does one domain per change with its codemod.

## Related

- [0012](0012-backend-core-domain-folders.md): the domain-folder plan and the
  procedure this follows.
- [`linting.md`](../../development/linting.md) ("Module boundaries").
