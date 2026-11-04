# Heavy chat code is in the startup closure

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Baseline the startup closure**: repeat the throwaway build measurement on current `main`. Status: done (2026-11-04; 94 chunks, 4.23 MB, 1.28 MB gzip at `96ee1eb3e`).
2. **Lazy-load mail markdown**: stop always-loaded modules pulling in `MessageMarkdown`. Status: done (2026-11-04; the eager path was `AgentMailConversationView`, not `MailTile`).
3. **Lazy-load the find and search module**: move `native-message-search` out of the closure. Status: done (2026-11-04; making `AgentNativeTab` properly lazy was enough).
4. **Stop re-exporting `terminalPortalStore`**: keep xterm out of everything that imports `@/stores`. Status: done (2026-11-04; the re-export is gone, and xterm's runtime left the store too).
5. **Consider `manualChunks`**: only if tasks 2 to 4 leave a reason. Status: done (2026-11-04; not needed, 2.55 MB and 0.80 MB gzip without it).

### 1. Baseline the startup closure

**Problem.** The report's 3.76 MB across 76 chunks was measured once, at an older commit.

**Context.** 1202 task 3 recommends this finding after the local renderer fixes; its con is that it needs a build-size check per step.

**Investigation.** Not run; this file read code only.

**Decisions.** None: the same throwaway production build, before and after each step.

### 2. Lazy-load mail markdown

**Problem.** The always-mounted mail panel pulls in the markdown renderer, which defeats the lazy agent tab.

**Context.** `LazyAgentNativeTab` is lazy (`apps/web/src/components/pane-layout/PaneLeafContainer.tsx:28`).

**Investigation.** `apps/web/src/components/layout/AppShell.tsx:41` imports `AgentMailPanel` eagerly, and `apps/web/src/components/chat/MailTile.tsx:41` imports `MessageMarkdown` eagerly. `App.tsx:38` also imports `ArtifactLiveHost` eagerly; I did not trace its whole import graph.

**Decisions.**

- **Lazy at which level?**
  - **Lazy-load `MessageMarkdown` inside `MailTile`, with plain text as the fallback (recommended).**
    - Pros: the panel still opens at once; only tiles with a body wait.
    - Cons: a brief fallback the first time mail is shown.
  - **Lazy-load the whole `AgentMailPanel`.**
    - Pros: removes more from the closure.
    - Cons: the panel is mounted at both `AppShell.tsx:261` and `:307`, so a lazy boundary needs care around its open state and its buttons.

### 3. Lazy-load the find and search module

**Problem.** The report sized `native-message-search` at 529 KB in the closure.

**Context.** Its importers are `NativeChatShell`, `ClaudeTmuxChatTab`, `MultiReviewReviewerTab`, `PipelineSessionTranscript` and `GraphActivationTranscript`.

**Investigation.** `ClaudeTmuxChatTab` is itself lazy (`PaneLeafContainer.tsx:31`), and `NativeChatShell.tsx:23` uses it only for `getSearchText` (`:557`). What keeps the module in the startup closure is not visible by reading alone, so task 1's build output has to name it.

**Decisions.** None: load the module when find first opens; the build output decides which importer to change.

### 4. Stop re-exporting `terminalPortalStore`

**Problem.** `apps/web/src/stores/index.ts:15-16` re-exports a store that imports xterm (`apps/web/src/stores/terminalPortalStore.ts:2-4`), so importing anything from the barrel can bring in xterm.

**Context.** About 100 files import from `@/stores`. Three import the store by its own path already.

**Investigation.** `PaneLeafContainer`, `PersistentTerminal` and `TerminalPortalHost` import `@/stores/terminalPortalStore` directly.

**Decisions.** None: remove the re-export and move any barrel user to the direct import.

### 5. Consider `manualChunks`

**Problem.** Vite's default chunking may still group modules poorly.

**Context.** The report offers this as optional.

**Investigation.** `apps/web/vite.config.ts` still has no `build` options.

**Decisions.**

- **Add chunk rules?**
  - **Not unless the build after tasks 2 to 4 shows a specific bad grouping (recommended).**
    - Pros: no manual map to maintain.
    - Cons: a possible saving is left until it is shown.
  - **Add `manualChunks` now.**
    - Pros: predictable vendor chunks.
    - Cons: an easy way to pull lazy code back into a shared chunk.

## Needs verification

- Nothing left here. The measurements and what held each module in the closure are in [1202 task 3](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md#3-renderer-re-renders-and-refetches).

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
