# Plan: Tiptap Markdown Viewer/Editor with WYSIWYG ⇄ Raw Toggle

## Goal

When a markdown file (`.md`, `.markdown`, `.mdx` opt-in later) is opened in the file viewer, render it in a rich WYSIWYG editor built on Tiptap instead of plain Monaco. A toggle at the top of the pane switches between:

- **WYSIWYG mode** — Tiptap rendered editing (headings, bold, lists, tables, task lists, code blocks…)
- **Raw mode** — the existing Monaco editor showing the markdown source

Both modes edit the same underlying document, share dirty-state tracking, and save through the existing container/local file save path (including Cmd+S).

## Current state (what we build on)

- `apps/web/src/components/terminal/FileViewerTab.tsx` is the single entry point for viewing/editing files. It already handles: loading content via `backend.readLocalFile` / `backend.readContainerFile`, saving via base64 write commands, dirty tracking through `useFileDirtyStore` (keyed by `tabId`), Cmd+S binding, diff view switching, and image preview.
- `useFileDirtyStore` exposes `setOriginalContent`, `setContent`, `getContent`, `markSaved`, `clearDirty` — the authoritative in-memory copy of unsaved edits, independent of which editor is mounted.
- `@tailwindcss/typography` is already a dependency, so `prose` classes are available for styling rendered content.
- shadcn/ui `tabs.tsx`, `button.tsx`, `tooltip.tsx` exist for the toggle UI.
- No Tiptap packages are installed yet. `react-markdown` exists but is only used for chat message rendering — not reused here.

## Dependencies to add (`apps/web`, via Bun)

```bash
bun add @tiptap/react @tiptap/starter-kit @tiptap/markdown \
        @tiptap/extension-table @tiptap/extension-list
```

- `@tiptap/react` + `@tiptap/starter-kit` — editor core (Tiptap v3).
- `@tiptap/markdown` — the official bidirectional markdown extension: `contentType: 'markdown'` on load, `editor.getMarkdown()` on serialize, `markedOptions: { gfm: true }` for GFM.
- `@tiptap/extension-table` (Table, TableRow, TableCell, TableHeader) and `@tiptap/extension-list` (TaskList, TaskItem) — needed for GFM tables and `- [ ]` task lists, which are common in this project's docs (plans, AGENTS.md).

Pin exact versions compatible with each other (all Tiptap packages must share the same major/minor).

## Architecture

### Source of truth and mode-switch semantics

The markdown **string** stays the canonical document; `useFileDirtyStore` (keyed by `tabId`) remains the authority for unsaved content, exactly as today. The Tiptap document is a projection of it.

- **Enter WYSIWYG**: parse current string with `contentType: 'markdown'`.
- **Leave WYSIWYG / save / raw view needs content**: serialize with `editor.getMarkdown()` — but **only if the user actually edited in WYSIWYG mode** (track a `wysiwygDirty` flag from Tiptap's `onUpdate`). This avoids round-trip normalization rewriting a file the user never touched (markdown → ProseMirror → markdown is not byte-identical: list markers, escaping, spacing can change).
- **Enter raw mode**: Monaco shows the store's current string; edits flow through the existing `setContent(tabId, value)` path.
- Cmd+S in either mode serializes (if needed), writes via the existing save handler, and calls `markSaved`.

This keeps the AGENTS.md background-reliability rule satisfied for free: content lives in the Zustand store, not in mounted editor state, so tab switches away/back rehydrate correctly.

### New components

```
apps/web/src/components/markdown/
├── MarkdownEditorTab.tsx     # Container: mode toggle, load/save/dirty wiring
├── TiptapMarkdownEditor.tsx  # Tiptap useEditor + EditorContent, markdown in/out
├── MarkdownToolbar.tsx       # (Phase 2) formatting buttons for WYSIWYG mode
└── tiptap-extensions.ts      # Shared extension list (StarterKit, Markdown, Table*, TaskList/Item)
```

**`MarkdownEditorTab`** props mirror `FileViewerTab`'s (`tabId`, `filePath`, `containerId`, `worktreePath`, `isLocalEnvironment`, `isActive`). Responsibilities:

- Header row: existing file-path header, plus a `Tabs` (or two-button segmented) toggle: **Rendered | Raw**. Default mode: Rendered; persist last-used mode per session (simple module-level or config store setting `markdownViewerDefaultMode` — decide in implementation; start with component state defaulting to Rendered).
- Mode switching logic per the semantics above.
- Raw mode renders the existing Monaco setup (extract Monaco block from `FileViewerTab` into a small shared `MonacoFileEditor` component rather than duplicating options/keybinding code).
- Save handler: reuse `FileViewerTab`'s save logic — extract it into a hook `useFileSave(tabId, filePath, containerId, worktreePath, isLocalEnvironment)` in `apps/web/src/hooks/` so both tabs share the base64-chunked write, toasts, and `markSaved`.

**`TiptapMarkdownEditor`**:

- `useEditor` with extensions from `tiptap-extensions.ts`; content set with `contentType: 'markdown'`, `Markdown.configure({ markedOptions: { gfm: true } })`.
- `onUpdate` → debounced (~300 ms) `getMarkdown()` → `setContent(tabId, md)` so the dirty store stays authoritative even if the component unmounts unexpectedly; also set the `wysiwygDirty` flag.
- Cmd+S: `editorProps.handleKeyDown` (or a small keymap extension) calls the shared save handler.
- Styling: wrap `EditorContent` in `prose prose-invert max-w-none` + overrides to match the app's dark theme (`terminalAppearance.backgroundColor`, border/muted tokens). Code blocks styled with the terminal font from config.

### Integration point

In `FileViewerTab.tsx`:

- Add `isMarkdownFile(filePath)` (extension check alongside the existing `isImageFile`).
- If markdown **and not in diff mode**, render `<MarkdownEditorTab …/>` instead of the Monaco block. Diff view for markdown files keeps the existing `DiffViewerTab` behavior untouched.
- Loading/error states stay in `FileViewerTab` (content is fetched once, then passed down), so the markdown component receives a ready string. Keep the fetch effect as-is.

No backend/Electron changes required — read/write commands already exist for both container and local environments.

## Edge cases & decisions

| Case | Handling |
| --- | --- |
| Round-trip lossiness (HTML blocks, footnotes, exotic syntax Tiptap can't model) | Only reserialize when WYSIWYG was edited. Phase 1: accept normalization on edited docs. If content fails to parse cleanly, fall back to raw mode with a small notice. |
| Unsaved edits when toggling modes | Never discard: serialize/parse through the dirty store on every toggle. |
| Large files | Markdown docs are small in practice; no special handling in phase 1. |
| Tab inactive (`isActive` false) | Same pattern as today: keep mounted, `pointer-events-none opacity-0`. Dirty content survives in the store per AGENTS.md rules. |
| External file changes on disk | Out of scope (matches current Monaco behavior — no watcher). |
| Images/links in markdown | Render links (StarterKit Link); relative images won't resolve inside container envs — render alt text placeholder in phase 1. |

## Testing

Per repo Bun test rules (`tests/setup.ts` / `tests/mocks/*`, no leaky `mock.module`):

1. **Unit — mode toggle & sync** (`MarkdownEditorTab.test.tsx`): open with markdown → starts in Rendered mode; toggle to Raw shows original string unchanged when no WYSIWYG edits; edit in WYSIWYG → toggle → Raw shows serialized output; dirty flag set.
2. **Unit — serialization** (`tiptap-extensions.test.ts`): GFM round-trips for headings, bold/italic, fenced code, tables, task lists.
3. **Unit — file-type routing** (`FileViewerTab` test): `.md` renders markdown tab, `.ts` still renders Monaco, `.md` in diff mode still renders `DiffViewerTab`.
4. **Save path**: Cmd+S from both modes calls the (mocked) backend write with current content and `markSaved`. Mock `@/lib/backend` via the existing shared native mocks in `tests/setup.ts`.
5. Manual check of the inactive-environment path (AGENTS.md rule 4): edit a doc, switch environment, come back, verify unsaved edits and mode survive.
6. `bun run --cwd apps/web typecheck` and `bun run test`.

## Implementation phases

**Phase 1 — Core (this plan's scope)**
1. Add dependencies.
2. Extract `useFileSave` hook and `MonacoFileEditor` from `FileViewerTab` (pure refactor, no behavior change; run existing tests).
3. Build `tiptap-extensions.ts` + `TiptapMarkdownEditor` with markdown in/out and prose styling.
4. Build `MarkdownEditorTab` with the Rendered/Raw toggle and dirty-store wiring.
5. Route markdown files in `FileViewerTab`.
6. Tests + typecheck.

**Phase 2 — Polish (follow-up, not required for MVP)**
- `MarkdownToolbar` (bold/italic/heading/list/table/task buttons) using shadcn buttons + tooltips.
- Persisted per-user default mode in config store; remember mode per tab.
- Slash-command or bubble menu; syntax highlighting inside code blocks (lowlight).
- Resolve relative images for local worktrees via base64 read.

## Estimated footprint

~5 new files, ~2 modified (`FileViewerTab.tsx`, `package.json`), no backend changes. Bundle impact: Tiptap core + extensions (~150–200 KB gzip) — acceptable for an Electron renderer; consider `React.lazy` for the markdown tab if bundle size becomes a concern.
