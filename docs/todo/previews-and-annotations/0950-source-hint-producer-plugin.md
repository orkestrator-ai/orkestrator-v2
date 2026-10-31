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
   (results under Current state).

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

- Local worktree: the Electron case compiles the documented Babel emitter and
  captures its rendered Save button with trusted input, saves through the real
  renderer, and reads back
  `[verified, not verified]`. The thread shows both rows.
- Container: the same case on a `containerized` environment, opt-in through
  `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1`. The page is served from the
  host, as in the other container annotation cases, because only the page
  identity matters to a capture. The paths are checked in the container's
  `/workspace`.
- `web-annotations-gateway.spec.ts` has a Docker fixture case that adds a symlink
  leaving `/workspace` and confirms it stays unverified, and that the web client
  shows the same list.
- The documented configs have automated integration coverage under Vite 8 with
  `@vitejs/plugin-react` 6 and `@rolldown/plugin-babel`, and Vite 7 with
  `@vitejs/plugin-react` 5. Development transforms emit workspace-relative
  stamps; production builds have none, even with `NODE_ENV=development`.

### Review follow-up validation, 2026-10-31

Tested commits `589a0b2c9` and `f629db0ed` in this worktree on macOS with
Docker Desktop.
Commands below ran through `mise run test:logged` except the formatter and
dependency installs.

- `bun test apps/desktop/tests/source-hint-emitter-doc.test.ts apps/desktop/tests/source-hint-emitter-vite.integration.test.ts --parallel=1`:
  13 passed. Covers nested lowercase helpers, all-caps names, module-level JSX,
  absent filenames, both real Vite configurations, and production exclusion.
- `bun test tests/unit/playwright-spec-loading.test.ts tests/unit/electron-spec-process-ownership.test.ts apps/desktop/tests/browser-preview-source-hints.test.ts --parallel=1`:
  all three owning files passed.
- `ORKESTRATOR_AGENT_TEST_PROFILE=hint-review-docker ORKESTRATOR_AGENT_TEST_DOCKER=1 bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts web-annotations-gateway.spec.ts --grep 'Docker fixture checks source hints' --workers=1`:
  one passed. Existing, missing and escaping-symlink paths returned
  `[true, false, false]`; the web thread showed all three statuses. The
  disposable profile was stopped and reset, including its two containers,
  two volumes and network.
- `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 ORKESTRATOR_AGENT_TEST_RUN_ID=hint-review-electron mise run test:agent:electron`:
  both source-hint cases passed, including the container opt-in. The selected
  button is now real Babel output from `annotation-app/GeneratedSave.tsx:2`;
  the negative ancestor remains deliberately handwritten. The full suite
  finished with 42 passed, three failed, two skipped and one not run. Failures
  were native nickname refresh, terminal input and the annotation pixel test's
  focus assertion. Failure log:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.2imAYu/agent-electron.log.gz`.
- Rerunning the owning Electron file alone reproduced the renderer-control
  focus failure before capture (six passed, one failed, eight not run; log
  `orkestrator-test-run.GCL432/source-hint-electron-owner.log.gz` below the same
  temporary root). Commit `f629db0ed` explicitly returns native keyboard focus
  to the host renderer before focusing a control, preserving every assertion.
  The exact owner command then passed both source-hint cases, but stopped at
  the existing keyboard-to-preview handoff assertion (nine passed, one failed,
  five not run; log `orkestrator-test-run.pQLpum/source-hint-electron-owner.log.gz`).
  The command was
  `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 ORKESTRATOR_AGENT_TEST_RUN_ID=hint-review-electron-owner bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts --workers=1`.
- `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 ORKESTRATOR_AGENT_TEST_RUN_ID=hint-review-electron-pixels bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts --grep 'capture pixels stay on the target' --workers=1`:
  one passed after the focus repair. The control-focus failure reproduced in
  the complete owner, so it is not classified as an aggregate-only flake.
- After the repair, the exact full Electron command above was rerun again:
  38 passed, two failed, two skipped and six not run. Both source-hint cases
  passed again. The remaining failures were the Notes-column geometry test's
  missing panel and the workspace-realm native focus assertion; later annotation
  cases were not run after the geometry failure. Failure log:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.kN4NjU/agent-electron.log.gz`.
  Full-suite artifacts are in `output/agent-testing/hint-review-electron/`;
  the passing pixel case is in `output/agent-testing/hint-review-electron-pixels/`.
- `bun check -p apps/desktop/tsconfig.test.json` and
  `bun check -p e2e/agent-testing/tsconfig.json` passed. Targeted `bunx oxlint`
  on the four changed TypeScript files and `mise run format:check` passed.
  Both frozen installs and `bun test tests/unit/version-drift.test.ts --parallel=1`
  passed after regenerating the lockfiles with the pinned Bun runtime.
- The preparation's failed broad commands were rerun. With
  `ORKESTRATOR_E2E_PORT=14590`, `mise run test:browser` cleared the original
  checkout/port conflict but accumulated unrelated page-load and UI failures
  while the host load average exceeded 70. It was interrupted after 146 passed,
  33 failed and nine interrupted tests; 55 skipped and 853 did not run. Failure
  log: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XtMApK/browser-review-rerun.log.gz`.
- `mise run test:agent:browser:isolated` passed the previously failing graph
  approval case, but failed the capped-file-tree and Cursor draft-attachment
  cases and reached its 15-minute browser timeout. Its profile
  `qa-browser-e2a0af6b-a29` was stopped and reset automatically. Failure log:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.l9IZdm/isolated-browser-review-rerun.log.gz`.

## Needs verification

- These runs were on macOS with Docker Desktop. Linux and Windows hosts were not
  run.
- The desktop captures use a real Babel transform and React render served as
  fixture HTML. Vite's development pipeline is covered separately by the
  integration test; its page has not been captured through Electron.
- Other Babel build integrations (such as webpack or Next.js) have not been
  qualified; the doc gives only the two Vite configurations in full.

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

### Task 1: build tools as desktop dev dependencies

The tests need real Babel and both supported Vite/plugin configurations. These
are dev dependencies of `apps/desktop`; aliases keep Vite 7/plugin-react 5
available alongside Vite 8/plugin-react 6. Nothing ships with them.

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

### Tasks 1 and 3: execute copied configurations and capture emitted output

The review follow-up extracts every JavaScript snippet from the doc instead of
maintaining a second plugin/config copy. Vite versions run in separate child
processes with explicit environments, so tests do not mutate the suite's Babel
environment. The Electron fixture compiles the plugin, renders the button with
React, and commits that source into its disposable origin before creating
either environment. This gives both workspace checks the actual emitted path.

### Task 3: return native keyboard focus before renderer control activation

The owning-file rerun exposed that setting a DOM active element alone did not
return keyboard focus from the native preview. `pressControl` now activates
the host and focuses its renderer first, matching the existing keyboard test's
explicit focus ownership setup. It still asserts DOM focus before Enter; no
assertion, timeout or skip was relaxed.
