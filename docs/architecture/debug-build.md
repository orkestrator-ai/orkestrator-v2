# Debug button: one-click pipeline environment

Settings → Debug → **Debug button** (per window, off by default) adds a button
to the sidebar's bottom bar, beside Report a bug. It replaces the manual
screenshot-and-retype loop: press it in the environment that shows the
problem, say what is wrong (or what should be done), and one pipeline
environment starts working on it.

## Pieces

| Piece | Where |
| --- | --- |
| Toggle | `DebugButtonSetting` (`apps/web/src/components/settings/`), stored as `debugButtonEnabled` in the window chrome (`uiChromeStore`) |
| Button | `SidebarBottomBar`, shown only while the toggle is on, disabled with no environment selected |
| Capture, then open | `startDebugCapture` (`apps/web/src/lib/debug-build/`), `debugBuildStore` (window store) |
| Window capture | `windowCapture()` in `apps/web/src/lib/native/window.ts`, over the desktop's `orkestrator:bug-report:capture-window` IPC (shared with [Report a bug](bug-report.md)) |
| Dialog | `DebugBuildDialog` / `DebugBuildDialogHost` (`apps/web/src/components/debug-build/`), hosted by `AppShell` |
| Ticket text | `packages/protocol/src/debug-build.ts` (`debugBuildTicket`, `debugTranscriptComment`) |
| Command | `create_debug_build` (pipelines domain), handled by `apps/backend/src/core/features/debug-build.ts` |
| Transcript read | `apps/backend/src/core/features/debug-build-transcript.ts`, through the public CLI's `session.transcript` reader |

## Flow

1. The press captures the window **before** the dialog exists, so the image is
   the page the user was looking at and never the dialog. A client that cannot
   capture itself (a browser tab) opens the dialog without one and says why.
2. The dialog shows the capture with **Attach this screenshot** (ticked; untick
   to leave it out), a required **Problem / objective** and an optional
   **Expected result**.
3. Submit sends one `create_debug_build` request to the node that owns the
   environment: `{ environmentId, problem, expectedResult?, screenshot?,
   requestId }`. The renderer does nothing else; the success toast offers to
   open the new environment but does not switch to it.
4. The backend:
   - reads the source environment, its project and its agent tabs (from the
     persisted pane layout; the tab in front first);
   - writes the ticket: the summary is the user's text, **Context** lists the
     environment's ID, name, project, type, status, branch, worktree, pull
     request, creation and capture times, the screenshot and each tab's
     transcript state, and the **acceptance criteria** are the Expected result
     one line per criterion (or, without one, "the problem or objective is
     resolved");
   - attaches each tab's transcript as a ticket comment (first message plus
     the newest that fit, 60,000 characters per tab and 80,000 in total; tool
     calls by name, status and title only) and the screenshot as a ticket
     image;
   - launches exactly one build pipeline on the saved Build defaults
     (`launchBuildPipeline`), whose environment type is the project's last
     choice, else the source environment's.

Every pipeline stage quotes the ticket's description, criteria and comments
and receives its images, which is how the new environment is pre-loaded.

## Idempotency

`requestId` binds to the request (`debugBuildRequestIdentity`, hashed into the
ticket's `featureBuildRequestHash`). A retry of the same request finds the same
ticket, skips attachments it already has (a ticket that already has comments
is not re-read, so a retry never adds later conversation), and gets the same
pipeline from the supervisor's admission key. The same key with a different
request is refused. The dialog keeps its key across retries of an unchanged
request and mints a new one when the text or screenshot choice changes.

## Not started

Only the one pipeline (and the environment it creates) is started. No agent,
review or other environment is launched by the button, the dialog or the
command.
