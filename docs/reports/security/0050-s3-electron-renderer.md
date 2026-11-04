# S3: Electron renderer

This file combines 3 reports into one batch to build together. CSP, permissions and sandbox for the same windows.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0050](#0050-add-a-content-security-policy-to-the-renderer-and-the-gateway-served-app) | High | M6: CSP on the renderer and gateway HTML, Trusted Types, invoke allowlist |
| [0130](#0130-default-deny-permissions-on-renderer-and-realm-sessions) | Medium | L5: default-deny permissions on renderer and realm sessions |
| [0060](#0060-turn-on-the-os-sandbox-for-windows-that-load-a-preload) | Medium | M7: CommonJS preloads and `sandbox: true` |

## 0050: Add a Content Security Policy to the renderer and the gateway-served app

### Task analysis

#### Tasks

1. **Add the policy to both surfaces**: the Electron renderer and the HTML the gateway serves. Status: open.
2. **Consider Trusted Types**: the report's optional follow-up. Status: open (depends on 1).
3. **Consider an allowlist of renderer-invokable commands**: narrow the generic command bridge in the main process. Status: open.

#### 1. Add the policy to both surfaces

**Problem.** The renderer shows attacker-influenced markdown, Mermaid, SVG and transcripts. One sanitiser bypass would run script that can reach `window.orkestrator.invoke`, and from there the host.

**Context.** The hosted client already has a strict policy (`apps/web-public/vercel.json:17-18`), which is a useful starting list. The toolchain bootstrap windows and the artifact host have their own too (`apps/desktop/electron/toolchain-bootstrap-window.ts:45`, `apps/desktop/electron/artifact-host-shell.ts:258`).

**Investigation.** `apps/web/index.html` has no policy. `serveStatic` (`apps/backend/src/gateway-proxy.ts:700`) sets none, and the Electron window loads the renderer by URL or file with none (`apps/desktop/electron/window.ts:134`, `:137`). The sinks are still `apps/web/src/components/chat/rich/MermaidBlock.tsx:400`, `:405`, `apps/web/src/components/chat/rich/ArtifactPartBodies.tsx:417` and `apps/web/src/components/chat/MentionableInput.tsx:443`. The bridge still forwards any command string (`apps/desktop/electron/ipc.ts:297-306`). With a dev server configured, `serveStatic` proxies instead (`apps/backend/src/gateway-proxy.ts:712-718`), so that path needs no policy of its own. The login page carries an inline `<style>` (`apps/backend/src/gateway-support-extra.ts:271`).

**Decisions.**

- **Where should the policy live?**
  - **A response header from `serveStatic`, and a `<meta>` tag in `apps/web/index.html` for the `file://` load (recommended).**
    - Pros: one policy text can be generated for both; a header also carries `frame-ancestors`, which a `<meta>` tag ignores.
    - Cons: two delivery paths to keep in step; Electron's `file://` load gets no `frame-ancestors`.
  - **Only a `<meta>` tag in `index.html`.**
    - Pros: one line, covers both surfaces.
    - Cons: no `frame-ancestors`, and connection targets that vary per deployment cannot be expressed at build time.
- **How wide should `connect-src` and `frame-src` start?**
  - **Follow the hosted client's `connect-src 'self' https: wss:` and add loopback and the known preview and artifact origins (recommended).**
    - Pros: fits a renderer that connects to remote gateways chosen at run time; script is still confined by `script-src 'self'`.
    - Cons: an injected script that does run could still send data out.
  - **Exact origin lists, as the report suggests.**
    - Pros: the tightest result.
    - Cons: the backend URL and any preview origins are only known at run time, so the policy has to be generated per connection.

#### 2. Consider Trusted Types

**Problem.** Task 1 restricts script sources, but the DOM sinks stay open to any script that runs.

**Context.** The report says to consider this; it is not part of its core fix.

**Investigation.** Three components assign HTML directly (task 1's list). Not checked: whether Mermaid or other dependencies assign to sinks in ways that Trusted Types would refuse.

**Decisions.**

- **Adopt it?**
  - **Decide after task 1, in report-only mode first (recommended).**
    - Pros: shows real violations before anything breaks.
    - Cons: needs a place to receive the reports.
  - **Skip it.**
    - Pros: no work.
    - Cons: the sinks rely on the sanitisers alone once a script is allowed.

#### 3. Consider an allowlist of renderer-invokable commands

**Problem.** `orkestrator:invoke` passes any string to the backend, gated only by the sender check.

**Context.** The report says to consider this. The backend already holds deny-lists for other callers (see [0200](0200-i1-workspace-grant-allowlist.md)).

**Investigation.** `apps/desktop/electron/ipc.ts:297-306`. A renderer legitimately uses a very large part of the command registry, because it is the application's main client.

**Decisions.**

- **Add one?**
  - **No, rely on task 1 (recommended).**
    - Pros: the renderer needs most commands, including terminals, so an allowlist would remove little of what injected script could do.
    - Cons: the bridge stays generic.
  - **Yes, an allowlist in the main process.**
    - Pros: a clear statement of the renderer's surface; refuses new internal commands by default.
    - Cons: a second list to maintain for every command, with little security gain while terminals stay on it.

### Needs verification

Nothing was run for this file.

- Whether `style-src` needs `'unsafe-inline'` here as it does on the hosted client: Mermaid SVG output and the login page's inline `<style>` suggest it does.
- Whether `script-src 'self'` behaves as expected on Electron's `file://` load.
- Whether the renderer's workers and blob URLs fit `worker-src 'self' blob:`.

## 0130: Default-deny permissions on renderer and realm sessions

### Task analysis

#### Tasks

1. **Install a permission policy on renderer and realm partitions**: these keep Electron's default handler, which grants every request. Status: open.

#### 1. Install a permission policy on renderer and realm partitions

**Problem.** A script running in the renderer or a realm view could get camera, microphone, notifications or any other permission without a prompt.

**Context.** Previews and the artifact host deny by default already (`apps/desktop/electron/browser-preview-startup.ts:54-55`, `:122-123`, `apps/desktop/electron/artifact-host-session.ts:432-435`), so the shape to copy exists.

**Investigation.** Those are the only calls to `setPermissionRequestHandler` and `setPermissionCheckHandler`. Renderer and realm partitions are named at `apps/desktop/electron/desktop-window-lifecycle.ts:61-76`, and a window can also use the default session (`useLegacyDefaultSession`). The web app uses `navigator.clipboard.writeText` (`apps/web/src/components/bug-report/BugReportSheet.tsx:260`, `apps/web/src/components/browser/ServiceBrowserTab.tsx:854-871`, `apps/web/src/components/review/ReviewValidationStatus.tsx:231`) and `navigator.clipboard.read` (`apps/web/src/lib/native/web-gateway.ts:90`). A search for `mediaDevices`, `new Notification`, `requestFullscreen` and `geolocation` under `apps/web/src` found nothing.

**Decisions.**

- **What should stay allowed?**
  - **Deny everything except clipboard write, and any permission that a run proves necessary (recommended).**
    - Pros: smallest grant; matches how previews work.
    - Cons: a permission nobody noticed the app using fails silently, so it needs a pass through clipboard, fullscreen and file pickers.
  - **Deny only media, geolocation and notifications.**
    - Pros: lower risk of breaking anything.
    - Cons: a deny-list misses whatever Electron adds next.

### Needs verification

- Which permissions the renderer actually asks for at run time, including from dependencies. Log the handler's requests on one full session before tightening it.
- Whether `navigator.clipboard.read` runs in the Electron path at all: `web-gateway.ts` is the web client's native layer, and desktop has its own IPC (`apps/desktop/electron/ipc.ts:308-311`).

## 0060: Turn on the OS sandbox for windows that load a preload

### Task analysis

#### Tasks

1. **Bundle the preloads as CommonJS**: Chromium's sandbox cannot load the current ESM bundles. Status: open.
2. **Sandbox the two bootstrap windows**: these can switch first, as the report notes. Status: open (depends on 1).
3. **Sandbox the main window and realm views**: the windows that show attacker-influenced content. Status: open (depends on 1).

#### 1. Bundle the preloads as CommonJS

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

#### 2. Sandbox the two bootstrap windows

**Problem.** These windows have no need for an unsandboxed preload, but keep it because of the shared bundle format.

**Context.** The report says they can switch at once, since they use only `ipcRenderer`.

**Investigation.** `apps/desktop/electron/toolchain-bootstrap-window.ts:133` and `:234` set `sandbox: false`. The preload imports `ipcRenderer` and a helper, and its other import is a type.

**Decisions.** None: this is mechanical once task 1 is done, and is the qualification run for the CommonJS bundle.

#### 3. Sandbox the main window and realm views

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

### Constraints and rationale

- Update `AGENTS.md:179-181` and `:1066-1069`, the comments at `apps/desktop/electron/window.ts:117-120` and `apps/desktop/scripts/electron-bundle.ts:32-33`, once this lands.

### Needs verification

- That the main preload works under `sandbox: true` in a packaged build. It cannot be observed from the code; `mise run test:package:security` is the existing packaged check to extend.

## Related

- [Security report, M6](../2-26-10-27-security.md#m6-no-csp-on-the-main-renderer-or-the-gateway-served-app-which-hold-a-generic-command-bridge)
- [0130](#0130-default-deny-permissions-on-renderer-and-realm-sessions): the same renderer's permission handler
- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L5)
- [0050](#0050-add-a-content-security-policy-to-the-renderer-and-the-gateway-served-app): the same renderer's Content Security Policy
- [Security report, M7](../2-26-10-27-security.md#m7-the-os-sandbox-is-disabled-for-every-window-that-loads-the-preload)
