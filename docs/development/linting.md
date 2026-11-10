# Formatting and linting

Status: Living — formatter, linter and type checker configuration and rationale.

The short rules live in the root `AGENTS.md`. This guide keeps the reasons.

Formatting is [`bun fmt`](https://bun.com/docs/format), built into the pinned
Bun runtime, and linting is [oxlint](https://oxc.rs) (`.oxlintrc.json`). Both
run over the whole repo in well under a second, so there is no turbo task and no
per-package config — always run them from the repo root.

`bun fmt` is configured by the `[fmt]` section of the root `bunfig.toml`,
which applies Prettier's defaults plus `printWidth = 100` and the ignore
patterns below. The repo used to keep an `.oxfmtrc.json`, which `bun fmt` read
in oxfmt-compatible mode; that file was removed on 2026-10-27 and the code
reformatted once in Prettier style (mostly union types that now fit on one
line). Do not reintroduce an `.oxfmtrc.json` or `.prettierrc`: either would
take precedence over `bunfig.toml` and change the output. `bun fmt --doctor`
shows which config it picked up.

Typechecking is [`bun check`](https://bun.com/docs/runtime/check), which reports
the same errors as `tsc` from TypeScript 7 and uses every core. Each package's
`typecheck` script runs `bun check -p <tsconfig>` per project, and `mise run
typecheck` runs those through turbo plus the root `tests/` and `e2e/` projects.
`bun check` never emits, so the `typescript` dev dependency stays only so editors
use the same TypeScript version (`bun -p process.versions.typescript`). A
`package.json` `check` script would shadow the type checker (`bun check` runs
the script), so packages name theirs `typecheck`.

```bash
mise run format         # rewrite files in place
mise run format:check   # verify only; what CI runs
mise run lint           # report; fails on errors, not warnings
mise run lint:fix       # apply the auto-fixable subset
mise run check          # format:check && lint && typecheck
```

The `CI` workflow (`.github/workflows/ci.yml`) runs `format:check` and `lint`
on every pull request, alongside the typecheck and test jobs. The lint step
uses `if: ${{ !cancelled() }}` so a formatting failure does not hide lint
output — one push reports both.

The same job also runs repository-wide test guards that need no build: the
DOM absence scan (`never passes a DOM-producing query result directly to
toBeNull` in `tests/unit/dom-absence-scan.test.ts`), the flaky-test
index check (`tests/unit/flaky-tests-index.test.ts`), and the to-do index and
number-claim checks (`tests/unit/todo-index.test.ts`,
`tests/unit/number-claims.test.ts`), so a PR that breaks one fails within
minutes. All of them also run in `mise run test`, the default tier that
review preparation runs, so a branch hears about them before it reaches CI.
The DOM scan used to be in the slow tier, which no review runs, and seven
offenders merged on 2026-11-05 (todo
[7142](../todo/cross-cutting/7142-red-lint-job-merged-unguarded.md)). A scan
failure is fixed with `bun scripts/rewrite-bounded-dom-assertions.ts`.

The default-tier scan is separate from the subprocess diagnostic canaries,
which remain in the slow tier. Its synchronous source walk skips `node_modules`,
`dist` and `.git` directories and does not follow directory symlinks. This reduces
installed-tree I/O and avoids per-file asynchronous scheduling. The original
aggregate timeout history remains open in flake case
[0043](../tests/flaky-tests/aggregate-validation-runs/0043-root-suite-5000-ms-timeout-cluster.md);
focused passes do not establish that the loaded-host flake is resolved.

## Source guards

`tests/unit/source-guards.test.ts`, in the default tier beside the DOM scan,
refuses new instances of the causes behind most of the flakes fixed on
2026-11-06. It walks the test sources under `tests/`, `apps/`, `bridges/`,
`packages/`, `scripts/` and `e2e/` once (test and spec files plus test-support
modules: files under `tests/` or `testing/` directories and names containing
`test-harness`, `test-support` or `fixture`), with the DOM scan's exclusions. A
cheap text prefilter decides which files oxc-parser parses, and each parsed file
is walked once for all four guards. The guards live in `tests/source-guards/`:

- **`sleep-before-negative-assertion`**: an awaited fixed sleep with a literal
  delay (`Bun.sleep(50)`, `sleep`, `delay`, `wait`, `pause`, a Promise-wrapped
  `setTimeout`, `page.waitForTimeout`, `act` around a sleep, or a local helper
  whose body is one) followed in the same block, before any other await, by a
  negative or exact-count assertion (`.not.*`, `toBe(0)`, `toBe(false)`,
  `toHaveLength(0)`, `toEqual([])`, `toHaveBeenCalledTimes`, `toBeNull`,
  `toBeUndefined`, `toBeFalsy`). Use `installControlledTimeout` or await the
  event (testing guide, "Controlled time").
- **`released-port-rebind`**: a helper that binds port 0, reads the port and
  closes the server before the port is used or returned, and any call to a
  free-port helper by name (`getFreePort`, `reserveFreePort`,
  `reserveLoopbackPorts`, the `get-port` package and the like). Bind port 0 in
  the component itself and read the bound port back, keep the server bound, or
  retry with `retryOnAddressInUse` (`@orkestrator/protocol/testing/ports`).
- **`subprocess-without-budget`**: a `*.test.*` file that starts real processes
  (`Bun.spawn`, Bun shell, `node:child_process`, an imported Git helper) but sets
  no `setDefaultTimeout` and gives no test or hook an explicit timeout, so
  Bun's 5 s default kills real work under load.
- **`small-fake-pid`**: a pid below Linux's `pid_max` (4 194 304, 0 and 1
  included) given to a fake child process: a `*Child*`/`*Process*` constructor,
  a `pid` field in a `*Child*`/`*Process*`/`Fake*` class, or an object with
  child-process members (`kill`, `stdin`, `stdout`, `on`, `exitCode`, …). Use
  `fakePid(n)` from `@orkestrator/protocol/testing/fake-pids`. Pids that are
  only data (process tables, log fields, arguments to injected functions) are
  not flagged.

Some guards read production sources instead of tests (`SourceGuard.productionRoots`;
the walk is `listProductionSources`, which skips test files and test-support
modules). They hold the node-scope boundaries of the unified federation work and
are described in [Transports only through a scope](#transports-only-through-a-scope):
`window-orkestrator-direct`, `direct-transport-import`,
`lib-backend-command-default` and `workspace-command-bound-call`. One more
holds an Electron main rule:

- **`raw-webrequest-listener`**: a `webRequest.on*(...)` call in
  `apps/desktop/electron` whose listener is not wrapped in `answering` or
  `observing` (`apps/desktop/electron/webrequest-listener.ts`), or `null`. A
  listener that throws before calling Electron's callback leaves its request
  unanswered and gives main an uncaught exception (flake 0622); the wrappers
  always answer, with the listener's fail-closed response
  ([renderer-security.md](../architecture/renderer-security.md#webrequest-listeners)).
  The baseline is zero.

Existing offenders are tolerated by a ratchet, not fixed in bulk:
`tests/source-guards/baseline.json` holds a count per guard and file. The test
fails on a file absent from the baseline that has findings and on a file whose
count rises, printing each finding's `file:line` and the guard's advice. It also
fails when an entry is above the file's real count (or names a file that no
longer offends), so a baseline entry only ever goes down. Regenerate it with
`bun tests/source-guards/update-baseline.ts`, whose output is sorted and stable,
after fixing offenders, and never to admit a new one; a rewrite that only moves
an existing offender between files is the one reason an entry may appear. The
whole check takes about two seconds on an idle host.

When you change one guard's findings, regenerate only that guard:
`bun tests/source-guards/update-baseline.ts --guard <id>` (repeatable). It
rescans the named guards and keeps every other guard's committed entries byte
for byte, so it cannot also absorb another guard's new findings elsewhere in
the tree. Check the diff of `baseline.json` touches only that guard's section.

## What is excluded, and why

`bridges/codex-bridge/src/app-server/generated/**` is excluded from both the
formatter and the linter. It is a lockfile: `mise run verify:codex:protocol`
regenerates it and compares byte-for-byte, so reformatting it would fail that
check against a generator this repo does not control. `test-fixtures/**` is excluded from linting because those
files deliberately contain failing and malformed code.

Markdown and `docs/**` are excluded from `bun fmt`. The prose in this repo is
hand-wrapped and several documents are read as much as they are rendered;
reflowing them would produce churn with no reader benefit.

## Severity policy

`correctness` is the only enabled category, and it is an error — a failing lint
is a real defect, not a style opinion. The one exception is `no-unused-vars`,
which is a **warning**: the repo carries ~3,150 pre-existing unused imports and
declarations, and removing them is judgement work rather than a mechanical fix.
Clean them up opportunistically in files you are already touching. Do not
silence the rule, and do not raise it to `error` until the backlog is actually
gone.

The React Compiler rules oxlint 1.79 moved into `correctness` are errors like
the rest of the category: `react/refs`, `react/set-state-in-effect`,
`react/immutability`, `react/preserve-manual-memoization`, `react/globals`,
`react/purity` and `react/use-memo`. They were warnings from the oxlint 1.88
adoption (2026-10-13, 337 findings in 129 files, almost all `apps/web`) until
the backlog reached zero on 2026-10-25 (317 findings in 114 files at the
time), when all seven went back to `error`. The usual fixes:

- Reset state on a prop or key change during render (keep the previous key in
  state and compare), not in an effect.
- Write "latest value" refs in `useLayoutEffect`, or use `useEffectEvent`;
  never read or write `ref.current` during render.
- Read clocks through `useSyncExternalStore` or a `useState` initialiser, not
  `Date.now()` in render.
- In a loader an effect calls, set state only after the request settles; a
  click handler that wants an immediate loading state sets it itself.

Thirteen sites (2026-10-25) keep a disable directive for these rules, each
with its reason above it. Twelve are `react/set-state-in-effect` where the
state change has to happen in the same effect as a side effect (a native
cancel, a flush before unmount, a tab opened in the parent) or must follow a
commit (the design canvas restores its saved view only after the first
default-view commit has marked the visible frames live, and a native tab
starts restoring a reader's place only once a commit shows their part
dropped, `useRestorePlaceAfterHistoryDrop`).

The `jsx-a11y` plugin is not enabled. Its interaction rules reported 58
findings that are real accessibility gaps, but fixing them means adding keyboard
handlers, roles and focus targets to live UI — behaviour changes that belong in
their own reviewed change, not in a lint rollout. Turning the plugin back on is
a deliberate decision with that work attached, not a config tidy-up.

`no-control-regex` is off. Orkestrator strips ANSI escapes and control
characters as a matter of course — terminal output, tmux capture, transcript
sanitising — so a control character in a regex here is the intent rather than
the typo the rule is looking for.

Warnings never fail the build, so `mise run lint` exiting `0` means zero errors,
not zero findings. Read the output.

## Raw `console`

`no-restricted-globals` refuses `console`, used directly or passed as a value, so
new code goes through the [shared logger](../architecture/logging.md). The
migration is finished: every application path is covered, and one permanent
override in `.oxlintrc.json` turns the rule off only for code whose console is its
product or which wraps the console. That is tests, scripts (including a bridge's
`scripts/` and `*.live-probe.ts` files, and the backend's, desktop's and renderer's
`scripts/`), the CLI, `docker/`, the logger itself, the application log writer, the
fatal rejection guard (serialized into workers, so it imports nothing), the
backend's `bounded-console.ts`, the renderer's bug-report recorder, which wraps
`console.error`, and `desktop-startup-marker.ts`, which writes the startup markers
the desktop matches exactly. `tests/unit/raw-console.test.ts` pins that list and
the lint ignore patterns. It scans other sources for the six common console
methods and rejects directives disabling `no-restricted-globals`, including
blanket disables, so lint continues to catch other methods and console aliases.
Adding to the list needs the same case as these.

## Module boundaries

Three rules outside `correctness` are errors because they hold an
architectural line the type checker cannot see. Each was at zero, or had an
explicit allowlist, when it was turned on (2026-10-14), so a finding is always
new.

- **`import/no-cycle`.** No runtime import cycles anywhere. Type-only imports
  are exempt (the rule's `ignoreTypes` default), because they are erased before
  anything runs. A cycle through value imports makes module evaluation order
  load-bearing: a binding read during initialisation can still be in its
  temporal dead zone. Break one by moving the shared piece into a module both
  sides import. Two components that render each other belong in one module.
- **`no-restricted-imports`.** It enforces where code may run:
  - The renderer (`apps/web/src`, `apps/web-public/src`) runs in a browser. It
    may not import `node:*` or `bun:*`, or import values from
    `@orkestrator/protocol/node/*`. Types from those modules are fine.
  - Components reach the backend through the typed clients in `lib/`
    (`lib/backend`, `lib/design-client`, …), never through the raw
    `@/lib/native/backend` command transport.
  - Top-level `packages/protocol/src/*.ts` modules are shared with the
    renderer. Code that needs Node or Bun lives in `src/node/` and is exported
    as `@orkestrator/protocol/node/*`. A top-level module may import only types
    from there. Fixtures and fakes live in `src/testing/`
    (`@orkestrator/protocol/testing/*`), and only tests may import them.
  - Backend domain folders under `apps/backend/src/core/` (`design/`,
    `nodes/`, `change-tracking/`, `transcript-artifacts/`, `scheduled-jobs/`,
    `mcp-management/`, `public-api/`)
    are reached only through their `index.ts`, which re-exports by name (never
    `export *`). A new domain folder starts with an `index.ts` and a pattern in
    both the `apps/backend/src/**` and the `tests/unit/**` overrides. Where
    routing a leaf module through `index.ts` would close a runtime import cycle
    (the storage layer importing a domain's store layout, for example), name
    that file as an exception in the `apps/backend/src/**` pattern and say so
    in the `index.ts` header.

  Test files, harnesses and fixtures are exempt from this rule (see the test
  globs in `.oxlintrc.json`).
- **`import/no-mutable-exports`.** No new `export let`. An exported mutable
  binding is shared state that any importer can observe changing, and it is
  usually paired with a setter that exists only for tests. Prefer state owned
  by an object or closure, with an explicit accessor. The modules that already
  export mutable bindings are listed in the last `.oxlintrc.json` override. That
  list is a burn-down list, so remove a file from it once it no longer needs
  the exemption, and never add one.

The overrides for `no-restricted-imports` replace one another rather than
merging, so the components override repeats the renderer patterns. Keep the two
in step when you edit either.

## Transports only through a scope

Renderer code reaches a backend through a node scope (report §7.6, plan items
2010 and 2012): `useNodeScope()` and `scope.client.invokeRaw`/`listenRaw` in a
component, a scoped store or service that holds its scope, a `NodeScope` or
`NodeClient` parameter in plain code, or a typed client in `lib/backend`
(which runs on the command scope until plan item 3002 gives it a client
parameter). Only `lib/node-scope/**`, which builds the clients, may hold a
transport directly. Three checks hold the line; oxlint's built-in rules cannot
count per file, so two of them are source guards (above) with a shrink-only
baseline:

- **`window-orkestrator-direct`** (source guard). Every read of the host global
  (`window.orkestrator`, also through `globalThis`/`self`, computed or
  destructured) in `apps/web/src` outside `lib/node-scope/**` and `src/test/**`.
  The baseline lists what is left: window-shell calls (clipboard, window,
  process, shell) and desktop-only APIs. Its transport members (`invoke`,
  `listen`, `eventStreamReady`, `eventStreamConnection`, `node`, `nodes`) have
  no baseline at all: `tests/unit/source-guards.test.ts` asserts no renderer
  file reads one.
- **`direct-transport-import`** (source guard). Each value import, re-export
  or `import()` of a transport module in `apps/web/src`, counted per file:
  `@/lib/native/backend` (`invoke`), `@/lib/native/events` (`listen`),
  `@/lib/native/authoritative-events` (`listenAuthoritative`) and
  `@/lib/native/node-transport` (`createNodeTransport`). The guard resolves
  the `@/` alias and relative paths, so `../native/events` counts too.
  Type-only imports reach nothing and are not counted. Exempt: `lib/node-scope/**`
  (the scopes and their clients), `lib/backend/**` (the typed command clients),
  `lib/native/**` (the adapter layer that defines the transports and builds them
  on one another) and `src/test/**`. The 2026-11-07 baseline is 45 imports in
  40 files.
- **Whole-directory bans** (`no-restricted-imports`). Directories with no
  importer at all may not gain one: `components/chat`, `components/native-agent`,
  `components/pane-layout`, `components/projects`, `components/sidebar` and
  `contexts`, besides the federation directories' older and wider ban
  (`lib/federation`, `components/federation`). The override repeats the
  renderer's base patterns, because overrides replace one another. Add a
  directory to it once its last importer is gone; type-only imports stay
  allowed (`allowTypeImports`), as in the guard.

- **Per-node stores have no statics** (plan item 3018, which retired plan item
  3001's `scoped-store-shim` source guard). A per-node store's hook
  (`scopedStoreHook(def)`) carries no `getState`/`setState`/`subscribe`, so
  the types forbid a call that does not name its node, and the hook throws
  outside a `NodeScopeProvider` in development and tests. The store registry
  test (`tests/unit/source-guards.test.ts`, `tests/source-guards/window-stores.ts`)
  fails on a module in `apps/web/src/stores` that is neither a scoped store
  nor a listed window store. The recipe is [node-scopes.md](node-scopes.md).

- **`lib-backend-command-default`** (source guard, plan item 3002). Uses of a
  `lib/backend` named export in an `apps/web/src` production module that
  defines a scoped store, service or slot (`defineScopedStore`,
  `defineScopedService`, `defineScopedSlot`). Every `lib/backend/<x>.ts`
  exports `createXApi(client)`, and its named exports are that factory over
  the window's command scope, so a named export in per-node code reaches the
  command node whichever node the code serves. The guard counts per
  `lib/backend` file and per module (`[file] module`), reads the shim names
  from the `lib/backend` sources, and follows imports through `@/lib/backend`
  and other re-exports. Regenerate with `--guard lib-backend-command-default`.

- **`workspace-command-bound-call`** (source guard, plan item 4007). Uses of
  a command-bound export in a module of a node's workspace: the value-import
  graph from `WorkspaceContent`, `NodeWorkspaceLayout`, `OpenFileDialog` and
  `AgentMailPanel` (static imports, re-exports and `import()`; type-only
  imports are not followed). An in-tree leaf renders these modules under its
  own node scope, so a `lib/backend` named export there, or another module's
  export bound to `commandBackendClient`/`portalBackendClient` (the Claude
  tmux client's shim), sends the leaf's command to the command node. Counted
  per subject and module (`[subject] file`). Not followed: `lib/backend/**`,
  `lib/node-scope/**`, `src/test/**`, test sources and the window-level
  modules in `WORKSPACE_EXEMPT_MODULES`; `WORKSPACE_WINDOW_LEVEL_EXPORTS`
  lists the exports that are the window's wherever they are called
  (`openInBrowser`), each with its reason. The baseline is zero. Fix a
  finding with `useScopeBackend()` or the node's backend passed in
  ([node-scopes.md](node-scopes.md#a-nodes-workspace-in-the-windows-tree));
  regenerate with `--guard workspace-command-bound-call`.

To retire an importer, route it through a scope, then regenerate only this
guard's entries with
`bun tests/source-guards/update-baseline.ts --guard direct-transport-import`
and commit the smaller baseline. A new importer is never admitted to the
baseline.

## Disable directives

Reach for a disable directive only when the rule is wrong about that specific
site, and always with the reason immediately above it. Placement is fiddly:

- `// oxlint-disable-next-line <rule>` must sit above the **reported** line,
  which is not always the line you expect. For `react/no-did-update-set-state`
  it is the `setState` call, not the method declaration.
- `react-hooks/exhaustive-deps` does not honour the next-line form at all.
  Wrap the whole hook in `/* oxlint-disable react-hooks/exhaustive-deps */` and
  `/* oxlint-enable react-hooks/exhaustive-deps */` instead.

Before suppressing an `exhaustive-deps` finding, check whether the dependency is
genuinely missing. Most of them were. The ones that are not share a shape: the
value has a new identity every render (a memo keyed on something coarser, an
object rebuilt per poll), so adding it re-runs the hook far more often than the
author intended — refetching, re-arming a debounce, or resetting a tab the user
is looking at.

## Iterating a collection you are about to mutate

Write `for (const x of Array.from(collection))`, not `for (const x of [...collection])`.

Both materialise a snapshot, and the snapshot is load-bearing wherever the loop
body deletes from the collection it is walking — `destroy`, `retire`,
`untrack`, `respond` and friends all do. Map and Set iterators are live, so
dropping the copy makes the loop skip entries.

`unicorn/no-useless-spread` cannot see that mutation and flags the spread form
as redundant; its suggested fix silently introduces the skip. `Array.from`
is exactly equivalent, says "materialise this" out loud, and is not flagged.

## The formatting baseline commit

The original oxfmt baseline (`0b5cbd4a5`) and the 2026-10-27 bunfig migration
(`c5e244012`) are listed in `.git-blame-ignore-revs`. The migration is an
explicit exception to the mechanical-only policy: it also changed formatter
configuration, documentation and test-fixture config wiring. Inspect it with
`git show c5e244012` when tracing those changes; future reformats should be
separate from configuration and documentation edits. To keep `git blame`
readable locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub applies that file automatically.
