# 06 — Give each suite the runtime environment it needs

Status: Bridge migration implemented; root partition retained. Depends on:
[01](01-baseline-and-coverage-inventory.md),
[05](05-test-ownership-and-duplicates.md).

## Implementation result

All five bridge `test:bridge` commands now load the node-only setup instead of
registering a DOM and then loading the shared setup. Turbo inputs and static
wiring assertions were updated with the scripts. The full bridge group first
passed in 107.9 seconds and then passed in 95.9 seconds inside the final
aggregate; the reviewed bridge execution was 126.7 seconds. The root suite
remains on its current preload because most of its selected files require DOM
state and a second root partition would add ownership and orchestration
complexity for little demonstrated gain.

## Goal

Avoid loading Happy DOM and renderer mocks for server-only tests. Keep file
isolation and all shared safety setup. Start with bridges, where package-level
entrypoints make the boundary clear; treat root partitioning as a second,
measurement-gated change.

## Existing contracts

- [register-dom.ts](../../../../tests/register-dom.ts) installs Happy DOM and
  preserves native fetch, AbortController, AbortSignal and Response constructors.
- [setup.ts](../../../../tests/setup.ts) installs renderer mocks and bounded
  DOM diagnostics after DOM registration.
- [setup-node.ts](../../../../tests/setup-node.ts) already isolates Git config,
  sets `CODEX_BRIDGE_NO_SERVER`, and installs bounded console diagnostics.
- [monorepo-scripts.test.ts](../../../../tests/unit/monorepo-scripts.test.ts)
  currently requires each bridge to carry all root preloads explicitly. That
  policy test must change with the runtime policy; simply deleting it would
  remove protection against package-cwd configuration loss.

## Tasks

### 1. Audit the effective runtime

- [ ] Inventory each bridge's use of browser globals, native web API snapshots,
  renderer aliases, import-time globals and shared mock exports. Include helper
  imports; a test without the word `window` can still import DOM-only setup.
- [ ] Distinguish native web APIs used by Bun HTTP/SSE tests from browser DOM
  behavior. Native fetch/Response support does not require Happy DOM.
- [ ] Verify package invocation behavior with pinned Bun and the real invocation
  directory. Additional preload flags must not be assumed to replace preloads
  inherited from a configuration file.
- [ ] Inspect any native constructor shim and retain explicit fallback/error
  behavior. The ACP harness already handles an environment without Happy DOM;
  audit other callers rather than assuming they all do.

### 2. Migrate bridge packages one at a time

- [ ] Start with a small bridge package whose audit shows no DOM requirement,
  then migrate the other packages independently.
- [ ] Change its package `test:bridge` command to use the explicit node preload,
  preserving `--parallel`, only-failure output, timing updates and the package's
  working directory.
- [ ] Keep DOM-dependent exceptions explicitly classified. If an exception is
  actually testing native transport, remove the accidental DOM dependency;
  if it needs DOM, retain a correctly configured separate selection.
- [ ] Update Turbo test inputs to include the actual shared setup dependencies,
  including `setup-node.ts`. Keep `cache: false` and worker/timing environment
  variables passed through without changing dependency build hashes.
- [ ] Rewrite the preload wiring test around required effects: correct
  per-runtime preloads, no lost no-server guard, Git isolation and bounded
  diagnostics. Keep a test that package invocations work without root bunfig
  inheritance.
- [ ] Run the lockfile procedure if manifest metadata recorded by Bun changes;
  review rather than hand-edit any generated diff.

### 3. Decide whether root partitioning earns its complexity

- [ ] Use the inventory to classify root files into DOM and non-DOM buckets.
  Base classification on required runtime, not solely directories such as
  `electron`, which may contain mixed helpers or renderer imports.
- [ ] Prototype the non-DOM bucket without changing the ordinary root focused
  invocation. Preferred first approach: a dedicated node-runtime invocation
  directory with minimal Bun configuration and explicit file paths supplied by
  a small root-suite launcher. Proposed configuration paths are new files, not
  an assumption that they already exist.
- [ ] Verify alias resolution, preload order, path ignores and imported source
  behavior under that directory. Resolve file arguments against repository
  root before changing the invocation cwd. Never let bare substring filters
  accidentally expand selection beyond the bucket.
- [ ] Keep the existing root DOM defaults for ordinary focused JSX commands
  unless there is a measured reason to change that user-facing convention.
  Document the node-focused equivalent if this launcher is adopted.
- [ ] Maintain one authoritative selection manifest/function for the launcher
  and inventory guard. Assert the two buckets are disjoint and their union is
  the intended root/support selection, including the external support fixtures.
- [ ] Preserve the root group's total worker reservation. Initially run buckets
  sequentially within that allocation, or explicitly divide workers between
  concurrent buckets; never give each bucket the entire three-worker budget
  while both run together.
- [ ] Use distinct timing-profile files for independently updating processes,
  scoped to the same worktree. Preserve failure aggregation and process-tree
  cleanup across both buckets.
- [ ] Carry changed-file selection into both buckets and verify a zero-test
  affected bucket is allowed while an unexpectedly empty full bucket is visible.

If startup cost, alias complexity or sequential scheduling cancels the measured
benefit, defer the root split and retain only the verified bridge improvement.
Do not relocate hundreds of tests solely to force a runtime boundary.

## Validation matrix

| Path | Required evidence |
| --- | --- |
| Node package invocation | Real package script succeeds without root DOM configuration |
| HTTP/SSE integration | Matching native fetch/abort/Response implementations; aborts settle |
| No-server guard | Importing bridge entrypoints does not bind an accidental production port |
| Diagnostics | Oversized console failures remain bounded; DOM failures retain DOM diagnostics |
| Git configuration | Ambient user config cannot change fixtures |
| DOM bucket | Testing Library binds to a registered document before imports |
| Root selection | Every owned test exactly once, including support files |
| Cancellation/failure | All launched child groups cleaned; failures not hidden by sibling success |

For each bridge, run its focused tests using the package cwd and node preload,
then its real package script through the logged wrapper. Run runner, preload
wiring and diagnostic-bound tests before the aggregate. Compare warm package
duration and memory, not only the count of imported libraries.

## Completion and rollback

- [ ] Every migrated package has the minimal correct environment and unchanged
  behavior coverage.
- [ ] Root partition is either validated with measurable benefit or explicitly
  deferred with the original default intact.
- [ ] The testing guide and inventory reflect actual commands and selection.
- [ ] There are no new unhandled rejections, global mismatches or order flakes.

Revert a bridge's manifest/setup change independently. Revert a root launcher
as one unit with its selection/configuration changes so it cannot silently
leave a bucket uncollected.
