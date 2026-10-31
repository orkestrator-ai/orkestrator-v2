# Source hint emitter and display

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e`, plus the source hint work on
branch `todo-0047-web-annotation-extensions`.

### Tasks

1. **Reference emitter**: give projects a supported way to emit the
   `data-orkestrator-source` convention. Status: open.
2. **Show hints in the thread view**: let the reviewer see the candidate
   locations the agent gets. Status: open.
3. **Live qualification**: a real desktop capture on a page that emits the
   convention, in a local worktree and in a container. Status: open (depends
   on 1).

### 1. Reference emitter

**Problem.** The desktop capture reads `data-orkestrator-source`, but nothing
ships that writes it, so no page produces hints unless its owner writes a
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
absolute paths, which the desktop drops by design.

**Decisions.**

- **What to ship?**
  - **Documentation with a short example Babel/SWC transform, not a package
    (recommended).**
    - Pros: no new published package or release surface; projects keep
      control of their build.
    - Cons: each project copies and maintains the snippet.
  - **A published Vite/webpack plugin.**
    - Pros: one line of setup.
    - Cons: a public package to version against framework releases; publishing
      needs the user's approval.
  - **Also accept other plugins' attribute names.**
    - Pros: works with tools projects already use.
    - Cons: their paths are often absolute or tool-relative, and their names
      change between versions.

### 2. Show hints in the thread view

**Problem.** The reviewer cannot see which source locations the agent was
given or whether the backend verified them.

**Context.** Hints reach the agent in the brief and in
`get_annotation_evidence`. The thread view renders the capture
(`apps/web/src/components/browser/annotations/AnnotationThread.tsx`) but not
`evidence.sourceHints`.

**Investigation.** The stored capture already carries the hints and their
`verified` flag, so this is renderer work only.

**Decisions.**

- **How to show them?**
  - **A small "Source candidates" list under the capture, with
    "path found in workspace" for verified ones (recommended).**
    - Pros: matches what the agent sees; wording avoids implying the element
      came from the file.
    - Cons: more text in a busy panel.
  - **Do not show them.**
    - Pros: nothing to build.
    - Cons: the reviewer cannot check what the agent was told.

### 3. Live qualification

**Problem.** The producer and the backend check are covered by unit tests
(happy-dom page, real temporary worktree) but not by a real desktop capture.

**Context.** Runs must use a throwaway profile, never the real data
directory, and never bind ports 34121 or 34122.

**Investigation.** Not run.

**Decisions.**

- **Where to run it?**
  - **Electron spec on a fixture page that emits the convention, then read the
    stored capture (recommended).**
    - Pros: deterministic; no live agent turn needed.
    - Cons: needs the Electron scenario suite on a frontmost host.
  - **A manual run in the app.**
    - Pros: quick.
    - Cons: not repeatable.

## Related

- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) task 4.
- [web-page-annotations.md](../../architecture/web-page-annotations.md#development-source-hints).
