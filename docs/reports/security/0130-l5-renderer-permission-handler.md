# Default-deny permissions on renderer and realm sessions

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Install a permission policy on renderer and realm partitions**: these keep Electron's default handler, which grants every request. Status: open.

### 1. Install a permission policy on renderer and realm partitions

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

## Needs verification

- Which permissions the renderer actually asks for at run time, including from dependencies. Log the handler's requests on one full session before tightening it.
- Whether `navigator.clipboard.read` runs in the Electron path at all: `web-gateway.ts` is the web client's native layer, and desktop has its own IPC (`apps/desktop/electron/ipc.ts:308-311`).

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L5)
- [0050](0050-m6-renderer-csp.md): the same renderer's Content Security Policy
