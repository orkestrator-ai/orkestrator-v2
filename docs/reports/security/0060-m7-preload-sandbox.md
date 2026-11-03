# Turn on the OS sandbox for windows that load a preload

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Bundle the preloads as CommonJS**: Chromium's sandbox cannot load the current ESM bundles. Status: open.
2. **Sandbox the two bootstrap windows**: these can switch first, as the report notes. Status: open (depends on 1).
3. **Sandbox the main window and realm views**: the windows that show attacker-influenced content. Status: open (depends on 1).

### 1. Bundle the preloads as CommonJS

**Problem.** Every window with a preload runs `sandbox: false`, so a renderer bug triggered by attacker content runs as the user with no sandbox escape needed.

**Context.** `AGENTS.md:179-181` and `:1066-1069` record this as a consequence of ESM preloads, not as a choice to keep.

**Investigation.** One `Bun.build` call builds the main process and both preloads with `format: "esm"` (`apps/desktop/scripts/electron-bundle.ts:10-11`, `:28-34`). `app.enableSandbox()` is never called. Preload imports are `electron` and local modules (`apps/desktop/electron/preload.ts:1-8`, `apps/desktop/electron/toolchain-bootstrap-preload.ts:1-3`). No Node built-in import showed up in `preload.ts` or `preload-api.ts`, but their imported local modules were not walked.

**Decisions.**

- **How to build them?**
  - **A second `Bun.build` for the two preloads with `format: "cjs"` and `electron` external (recommended).**
    - Pros: the main process stays ESM; the change is contained in `electron-bundle.ts`.
    - Cons: two build configurations; needs `electron-bundle.test.ts` to pin the format.
  - **Make everything CommonJS.**
    - Pros: one configuration.
    - Cons: moves the main process off ESM for no security gain.

### 2. Sandbox the two bootstrap windows

**Problem.** These windows have no need for an unsandboxed preload, but keep it because of the shared bundle format.

**Context.** The report says they can switch at once, since they use only `ipcRenderer`.

**Investigation.** `apps/desktop/electron/toolchain-bootstrap-window.ts:133` and `:234` set `sandbox: false`. The preload imports `ipcRenderer` and a helper, and its other import is a type.

**Decisions.** None: this is mechanical once task 1 is done, and is the qualification run for the CommonJS bundle.

### 3. Sandbox the main window and realm views

**Problem.** These are the surfaces that matter, because they render transcripts and another node's content.

**Context.** Browser preview views and the artifact host are already sandboxed (`apps/desktop/electron/browser-preview-manager.ts:1012`, `apps/desktop/electron/artifact-host-session.ts:46`).

**Investigation.** `apps/desktop/electron/window.ts:120` and `apps/desktop/electron/workspace-views.ts:230` set `sandbox: false`. A sandboxed preload may require only a small set of modules, so anything beyond `electron` has to be bundled in.

**Decisions.**

- **Switch together or apart?**
  - **Switch both in one change (recommended).**
    - Pros: they load the same preload, so one run qualifies both.
    - Cons: a larger blast radius if something the preload uses is missing.
  - **Realm views first.**
    - Pros: they show another node's content, the higher risk.
    - Cons: two passes over one preload.

## Constraints and rationale

- Update `AGENTS.md:179-181` and `:1066-1069`, the comments at `apps/desktop/electron/window.ts:117-120` and `apps/desktop/scripts/electron-bundle.ts:32-33`, once this lands.

## Needs verification

- That the main preload works under `sandbox: true` in a packaged build. It cannot be observed from the code; `mise run test:package:security` is the existing packaged check to extend.

## Related

- [Security report, M7](../2-26-10-27-security.md#m7-the-os-sandbox-is-disabled-for-every-window-that-loads-the-preload)
