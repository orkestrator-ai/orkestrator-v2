---
id: 5003
title: "Settings, bug report, shortcuts and dialogs by direct calls"
phase: 5
plan: "§9 and §12 Phase 5.3"
status: done
depends_on: [4001, 3017]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 5003 · Settings, bug report, shortcuts and dialogs by direct calls

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features), [Appendix C](../../docs/reports/unified-federation.md#appendix-c-the-realm-protocol-and-what-replaces-it)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [3017](3017-window-stores-node-qualified.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The `settings`, `bugReport` and `shortcut` messages disappear for in-tree nodes. Bug reports and node dialogs run against an explicit scope.

## Work

- [x] `settings` {section} → `requestGlobalSettings(section)`.
- [x] `bugReport` {nodeId} → `BugReportSheet scope={scope(nodeId)}`. The report is created and uploaded through that node's client.
- [x] `shortcut` {id} → one key router. Shortcuts typed inside an in-tree workspace reach the window handler directly. Update `app-shortcuts.ts` and `settings-navigation.ts`, and delete their realm branches for in-tree nodes.
- [x] Node dialogs open under the node's scope, with hydration checks: Add Project, New Environment, Repository Settings, Delete Project, environment Settings and Rebuild.

## Tests

- [x] A bug report for a leaf reaches the leaf's backend; every shortcut in `KeyboardShortcuts.spec.ts` works with a leaf shown; each dialog acts on the right node.

## Done when

- [x] None of the three messages is used for in-tree nodes.

## Notes

- **API (2026-11-07).**
  - `settings`: an in-tree node runs in the window's document, so `requestGlobalSettings(section)` dispatches the window's own event directly (the 4001 deviation already made the imperative callers read the page). Only a realm document still posts `settings`; `settings-navigation.ts` documents that its realm branch is a realm document's, deleted with realms (6002). Nothing was left to delete for in-tree nodes.
  - `bugReport`: `stores/bugReportStore.ts` gains `sheetNodeId` (`null`: this document's own backend) and `openSheet(nodeId?)`. `openBugReport(nodeId)` for an in-tree node shows it if it is not in front (`remote.open(target, selection)` without `bugReport`) and opens the window's sheet on it. `components/bug-report/BugReportSheet.tsx`: `BugReportSheet({ scope? })` runs every call through `backendForScope(scope)` (create, read, assign, screenshot save, file, mark filed, discard, reveal), polls on the scope's coordinator, writes the capture into the scope's compose draft, renders the agent session inside `NodeScopeProvider scope`, names the scope's node in the context and picker, and only the document's own sheet drives the bottom bar's dot. `BugReportSheetHost` (the window's `AppShell`) renders the own sheet plus the in-tree node's, and closes a request for a node that has no scope and is not in-tree. `WorkspaceRealmHost`'s in-tree toast (4001's deferral (4)) is replaced: a leftover `bugReport` flag opens the sheet on the node's scope (4005 asserts this in `2efbd3851`).
  - `shortcut`: `lib/app-shortcuts.ts` is the one key router for every node in the window's tree. New `onAppShortcut(id, handler, { workspace? })` and `setShownAppShortcutWorkspace(resolve)`: a workspace-owned shortcut (⌘T new agent tab) runs only the handlers of the workspace on show; window and document shortcuts are unchanged. `AppShell` (window, not a realm) registers `() => shownNodeScope(windowScope)`; `useActionBarController` tags its ⌘T with its scope. Before this, ⌘T with a leaf in the tree also opened a tab in the hidden command workspace (both are mounted). With a realm's node shown, the window's hidden workspaces no longer take ⌘T typed in the window's chrome.
  - Node dialogs: `AppDialogHost` (3017) already renders Repository Settings, Delete Project, environment Settings and Rebuild in the request's node scope; its project dialogs now wait for the node's first project list (`hasLoaded && !isLoading`) before treating a missing project as gone, so a dialog for a node opened a moment ago is not dropped (the hydration check replacing realm readiness). Environment Settings and Rebuild already wait for the environment to appear. Add Project and New Environment for an in-tree node are `WorkspaceRealmHost`'s, which 4005 moved onto the window's request with `dialogHydrated` gating on the node's stores (4005's Notes); routing `select` was 4005's. That they open on the leaf once its stores hydrate is asserted by 4005's `InTreeWorkspace.direct.test.tsx` ("select: Add Project and New Environment open in the node's workspace once its stores have hydrated"); this item's tests cover the other four.
- **Decision: a scoped sheet beside the window's own, not one sheet that switches (2026-11-07).** Options: (a) one `BugReportSheet` whose scope follows `sheetNodeId`; (b) the window's own sheet always mounted plus one for the in-tree node. Chosen (b): the own sheet keeps the bottom bar's draft dot current from mount (it reads the command node's report), and a leaf's sheet mounting and unmounting cannot reset it or the own sheet's in-flight state.
- **Decision: workspace shortcuts keyed by scope object, resolved at request time (2026-11-07).** The command scope's id may move from provisional to proven (2011), so handlers are tagged with the `NodeScope` itself and the window resolves the shown scope when a key arrives, not when a handler registers. Without a resolver (a realm document, fixtures) every handler runs, as before.
- **"Every shortcut in `KeyboardShortcuts.spec.ts` works with a leaf shown".** Covered without a live stack: the spec's fixture gained an in-tree window (`/keyboard-shortcuts?in-tree`: a leaf workspace in the window's document beside the hidden command workspace, no realm frame), and a new spec case presses ⌘K, ⌘, ⌘⇧D, ⌘T and ⌘⇧/ (Meta and Control) from the leaf's composer: the window's handlers take them, ⌘T reaches only the shown workspace, the dialog returns focus to the leaf composer. Run: `ORKESTRATOR_E2E_PORT=1497 bunx playwright test --config e2e/playwright.config.ts KeyboardShortcuts.spec.ts`, 34 pass on mobile and desktop Chromium. A live in-tree leaf run of the whole spec belongs to 4006's live qualification.
- **Effect.** Not used: a zustand field, React components and a resolver function; the report's lifetime is the backend's and the poll's is the read coordinator's.
- **Visible change (behind the setting).** Rendered in headless Chromium (`output/visual-previews/5002-harness`, `output/agent-testing/5002/shoot.ts`): before, Report a bug for an in-tree leaf showed a toast `output/visual-previews/5003-bug-report-leaf-before.png`, `5003-bug-report-leaf-before-narrow.png`; after, the window's sheet on the leaf `5003-bug-report-leaf-after.png`, `5003-bug-report-leaf-after-narrow.png` (the harness has no portal view, so it names the leaf "another machine"; with the portal it shows the leaf's name). Dialogs look unchanged (no screenshot): only when they open changed.
- **Files outside the item's set touched (minimal):** `components/layout/useActionBarController.ts` (tags ⌘T with its scope), `components/federation/WorkspaceRealmHost.tsx` (the toast hunk only), `e2e/fixture/KeyboardShortcutsFixture.tsx`, `docs/development/node-scopes.md` (one table row for 5002 and 5003).
- Aggregate suite left to review preparation.
- **Since the realm deletion (2026-11-07, orchestrator, completeness check).** The realm-document branches these Notes describe as remaining (`settings` posted by a realm document, the resolver-less realm document, `WorkspaceRealmHost`'s toast hunk) went with 6002 (`4312188ab`); no box here depended on them, so none is superseded. Test counts, counted in source at HEAD (not a new run): `e2e/KeyboardShortcuts.spec.ts` has 31 cases per project, 62 over its two projects (mobile and desktop Chromium); the "34 pass" above was 5003's own run, 4006 recorded 64 at `72ae46d49` including the realm-frame case 6002 deleted. `InTreeWorkspace.cross-node.test.tsx` has 1 case now ("Settings, Report a bug and every app shortcut are direct calls from an in-tree node"); the "2" in the Work log counted the loopback-observer case 6002 removed with the loopback.

## Work log

- 2026-11-07 (claude-worker): bug report sheet on the in-tree node's scope and `openBugReport` direct for it; one key router with workspace-owned shortcuts for the shown workspace; settings documented as direct; `AppDialogHost` project dialogs wait for the node's projects. Tests: `BugReportSheet.test.tsx` +2 (a leaf's report is created, captured, filed and its session hosted on the leaf's client with no command-node create/save/file; an unresolvable node's request closes), `open-bug-report.test.ts` +2, `app-shortcuts.test.ts` +2 (all five shortcuts from an in-tree composer; ⌘T to the shown workspace only; no resolver runs all), `AppDialogHost.test.tsx` +3 (a project dialog for a node still reading its projects waits, then deletes on that node only; a missing project after load drops; Settings and Rebuild on the named node), `InTreeWorkspace.cross-node.test.tsx` 2 (no `panel`, `panelDismissed`, `titleBar`, `settings`, `bugReport` or `shortcut` crosses an in-tree loopback while settings, keys and a bug report are used), e2e `KeyboardShortcuts.spec.ts` 34 pass (2 new). Focused web run 1321 pass, 10 skip, 0 fail (`--parallel=2`). Note: `AppDialogHost.test.tsx` then `AppShell.test.tsx` in one process without `--parallel` fails 6 AppShell mobile-title tests; this happens with the pre-5003 `AppDialogHost.test.tsx` too (mock leakage), so it is not from this item. Web and e2e typecheck clean; fmt and oxlint clean on touched files. Commits 074bd2719, 64a6216a9 and the docs commit.
- 2026-11-07 (orchestrator, completeness check): corrected stale Notes (realm-document branches gone with 6002; current test counts of `KeyboardShortcuts.spec.ts` and `InTreeWorkspace.cross-node.test.tsx`). No box changed: none depended on the realm path.
