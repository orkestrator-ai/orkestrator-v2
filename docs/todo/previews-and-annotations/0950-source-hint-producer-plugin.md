# Source hint emitter and display

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`. First analysed 2026-10-30 at
`cd7bbe3e`, plus the source hint work on branch
`todo-0047-web-annotation-extensions`.

### Tasks

1. **Reference emitter**: give projects a supported way to emit the
   `data-orkestrator-source` convention. Status: done
   ([source-hint-emitter.md](../../development/source-hint-emitter.md)).
2. **Show hints in the thread view**: let the reviewer see the candidate
   locations the agent gets. Status: done.
3. **Live qualification**: a real desktop capture on a page that emits the
   convention, in a local worktree and in a container. Status: done on macOS
   (results under Assumptions and decisions).

### 1. Reference emitter

**Problem.** The desktop capture reads `data-orkestrator-source`, but nothing
shipped that writes it, so no page produced hints unless its owner wrote a
plugin.

**Context.** The convention is `WEB_ANNOTATION_SOURCE_ATTRIBUTES`
(`packages/protocol/src/web-annotations.ts`), documented in
[web-page-annotations.md](../../architecture/web-page-annotations.md#development-source-hints).
Todo [0047](0047-web-annotation-extensions.md) task 4 rules out reading
framework runtime internals. An emitter must run only in development builds.

**Investigation.** The desktop producer is `sourceHintsFor` in
`apps/desktop/electron/browser-preview-anchor-script.ts`. Main rebuilds hints
in `parseSourceHints` (`browser-preview-capture-parse.ts`). The backend check
is `verifySourceHints` in `apps/backend/src/core/web-annotation-service-threads.ts`.
Existing community plugins emit similar attributes with other names and often
absolute paths, which the desktop drops by design. `@vitejs/plugin-react` 6
removed its `babel` option, so on Vite 8 a Babel plugin goes through
`@rolldown/plugin-babel`. A custom SWC plugin is a Rust and WebAssembly project,
so it cannot be a short snippet.

**Decisions.**

- **What to ship?**
  - **Documentation with a short example Babel transform, not a package
    (recommended).**
    - Pros: no new published package or release surface; projects keep
      control of their build.
    - Cons: each project copies and maintains the snippet; SWC-only projects
      get no equivalent.
  - **A published Vite/webpack plugin.**
    - Pros: one line of setup.
    - Cons: a public package to version against framework releases; publishing
      needs the user's approval.
  - **Also accept other plugins' attribute names.**
    - Pros: works with tools projects already use.
    - Cons: their paths are often absolute or tool-relative, and their names
      change between versions.

### 2. Show hints in the thread view

**Problem.** The reviewer could not see which source locations the agent was
given or whether the backend verified them.

**Context.** Hints reach the agent in the brief and in
`get_annotation_evidence`. The thread view renders the capture
(`apps/web/src/components/browser/annotations/AnnotationThread.tsx`).

**Investigation.** The stored capture already carries the hints and their
`verified` flag, so this was renderer work only.

**Decisions.**

- **How to show them?**
  - **A small "Source candidates" list under the capture, with
    "path found in workspace at capture" for verified ones (recommended).**
    - Pros: matches what the agent sees; wording avoids implying the element
      came from the file.
    - Cons: more text in a busy panel.
  - **Do not show them.**
    - Pros: nothing to build.
    - Cons: the reviewer cannot check what the agent was told.

### 3. Live qualification

**Problem.** The producer and the backend check were covered by unit tests
(happy-dom page, real temporary worktree) and one local Electron case, but not
by a desktop capture into a container, or by the thread view.

**Context.** Runs must use a throwaway profile, never the real data directory,
and never bind ports 34121 or 34122.

**Investigation.** `web-annotations-electron.spec.ts` already had a local
capture case on its own disposable profile, and needs no provider turn. Its
helpers take the environment from the stack, so the same case runs against a
container environment created on that profile.

**Decisions.**

- **Where to run it?**
  - **Electron spec on a fixture page that emits the convention, then read the
    stored capture (recommended).**
    - Pros: deterministic; no live agent turn needed.
    - Cons: needs Docker and the worktree's development image for the container
      case.
  - **A manual run in the app.**
    - Pros: quick.
    - Cons: not repeatable.

## Current state

- Local worktree: the Electron case captures the fixture's Save button with
  trusted input, saves through the real renderer, and reads back
  `[verified, not verified]`. The thread shows both rows.
- Container: the same case on a `containerized` environment, opt-in through
  `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1`. The page is served from the
  host, as in the other container annotation cases, because only the page
  identity matters to a capture. The paths are checked in the container's
  `/workspace`.
- `web-annotations-gateway.spec.ts` has a Docker fixture case that adds a symlink
  leaving `/workspace` and confirms it stays unverified, and that the web client
  shows the same list.
- The emitter ran under real Vite 8: `@vitejs/plugin-react` 6 and
  `@rolldown/plugin-babel` with the doc's config, in a scratch monorepo. Chromium
  showed workspace-relative stamps on the elements with no console errors, and a
  production build had none.

## Needs verification

- These runs were on macOS with Docker Desktop. Linux and Windows hosts were not
  run.
- The container and local captures used the fixture's hand-written attributes.
  The Babel output was checked in Chromium and through the capture kit in
  happy-dom, not through a desktop capture of a Vite page.
- The webpack and Next.js setups in the doc were not run. The doc gives Vite's
  config in full and only says other Babel setups add the same plugin entry.

## Related

- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) task 4.
- [web-page-annotations.md](../../architecture/web-page-annotations.md#development-source-hints).
- [source-hint-emitter.md](../../development/source-hint-emitter.md).

## Assumptions and decisions

Recorded 2026-10-31 by the worker on branch
`todo-0950-source-hint-emitter-28027c4bf3b8`, against `main` at `931e5541`.

### Task 1: a documented Babel plugin, with no package

Chose the recommended option. The doc is the only copy of the plugin, and
`apps/desktop/tests/source-hint-emitter-doc.test.ts` runs that exact text through
real Babel, a React render and the capture kit, so it cannot quietly rot.

### Task 1: `@babel/core` as a desktop dev dependency

The test needs real Babel, and the lockfile had none. It is a dev dependency of
`apps/desktop` only, so nothing ships with it.

### Task 1: no SWC example

The to-do said Babel/SWC. A custom SWC plugin needs Rust and WebAssembly, so the
doc says so and points those projects at writing the attribute directly.

### Task 1: paths relative to the workspace, so no root meta is needed

The plugin takes the workspace root and emits workspace-relative paths, which
also suits server rendering with no HTML hook. The `orkestrator-source-root` meta
stays documented for emitters whose paths are project-relative.

### Task 1: host JSX elements only

A component may not forward the attribute, and React's Fragment rejects it. A
lowercase renderer such as React Three Fiber is a documented limit.

### Task 1: two development gates

The doc adds the plugin only under `command === "serve"`, and the plugin also does
nothing unless Babel's env is `development`. Babel treats an unset `NODE_ENV` as
development, so the plugin's check alone could stamp a production build.

### Task 2: list visible under the capture, outside the evidence disclosure

Chose the recommended list. It sits outside "Page evidence (untrusted)" so the
reviewer sees what the agent was told without opening anything. Its heading says
the page declared the hints and that the agent is told to check the code.

### Task 2: "at capture" and "path not confirmed"

"path found in workspace" became "path found in workspace at capture", matching
the brief, because the file may have moved since. Unverified covers a missing
path, one outside the workspace and a check that did not run, so it reads "path
not confirmed" rather than "not found". Neither row is styled as a success.

### Task 3: extend the existing Electron case

Moved the case body into `captureAndReviewSourceHints` and added an opt-in
container variant, which needs no billed turn. The variable keeps it out of
`test:agent:electron` runs on hosts with no image.
