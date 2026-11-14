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
| Ticket text | `packages/protocol/src/debug-build.ts` (`debugBuildTicket`, `debugTranscriptComments`, `allocateDebugTranscriptBudgets`) |
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
   - attaches each tab's transcript as ticket comments, written in the same
     commit as the ticket, so a ticket never exists with only some of them.
     The tabs share one bound of 240,000 characters fairly: every tab that
     fits an equal share is attached whole and only the longest are cut
     (first message plus the newest that fit, with what was left out stated
     and the public session ID that reads the whole conversation). A long
     transcript spans several comments of at most 40,000 characters each.
     Tool calls appear by name, status and title only; the public reader
     already caps one message at 20,000 characters and says so;
   - attaches the screenshot as a ticket image;
   - launches exactly one build pipeline on the saved Build defaults
     (`launchBuildPipeline`), whose environment type is the project's last
     choice, else the source environment's.

Every pipeline stage quotes the ticket's description, criteria and comments
and receives its images, which is how the new environment is pre-loaded.

## Idempotency

`requestId` binds to the request (`debugBuildRequestIdentity`, hashed into the
ticket's `featureBuildRequestHash`); the screenshot is part of the identity by
the SHA-256 of its whole content. A retry of the same request finds the same
ticket (its transcripts were written with it, so it is not re-read and never
gains later conversation), attaches the screenshot if an earlier attempt
stopped before it, and returns the pipeline already linked to the ticket in
any phase, running, failed or complete, instead of launching another. The
oldest linked pipeline is the request's own; a build the user later starts on
the ticket from the board is not returned. Overlapping attempts of one request
share one run; an attempt with the same key and a different request is
refused before it writes anything, whether or not the first is still running.
The dialog keeps its key across retries of an unchanged request and mints a
new one when the text or screenshot choice changes.

The press waits at most 10 seconds for the window capture; a capture that
never answers opens the dialog without a screenshot and says why, so the
button cannot stay disabled.

## Not started

Only the one pipeline (and the environment it creates) is started. No agent,
review or other environment is launched by the button, the dialog or the
command.
