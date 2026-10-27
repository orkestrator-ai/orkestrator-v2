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
default-view commit has marked the visible frames live).

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

The repo was formatted in one commit, listed in `.git-blame-ignore-revs`. To
keep `git blame` readable locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub applies that file automatically.
