# Report a bug

The sidebar's bottom bar has a Bug button (right; global, repository and
environment settings are on the left). It opens a sheet in which a coding
agent interviews the user, reads the backend host's logs, and drafts a GitHub
issue for `orkestrator-ai/orkestrator-v2`.
The user approves the draft and Orkestrator files it. This is the desktop and
web counterpart of `orkestrator --fix AGENT`
([public-cli.md](public-cli.md)), and both share their instructions.

## Pieces

| Piece | Where |
| --- | --- |
| Prompt sections, draft parsing, runtime ids, limits | [`packages/protocol/src/bug-report.ts`](../../packages/protocol/src/bug-report.ts) |
| Host facts (versions, logs, backend descriptor; never contents) | [`packages/protocol/src/node/bug-report-facts.ts`](../../packages/protocol/src/node/bug-report-facts.ts) |
| Report records (`bug-reports.json`) | [`storage-bug-reports.ts`](../../apps/backend/src/core/storage-bug-reports.ts) |
| Synthetic runtime `bug-report:<id>` | [`bug-report-runtime.ts`](../../apps/backend/src/core/bug-report-runtime.ts) |
| Create, assign, draft, screenshot, file, discard | [`bug-report-service.ts`](../../apps/backend/src/core/bug-report-service.ts), commands in [`commands-registry-bug-reports.ts`](../../apps/backend/src/core/commands-registry-bug-reports.ts) |
| Sheet | [`BugReportSheet.tsx`](../../apps/web/src/components/bug-report/BugReportSheet.tsx), hosted once per window by `AppShell` (`BugReportSheetHost`) |
| Machine routing | [`open-bug-report.ts`](../../apps/web/src/lib/bug-report/open-bug-report.ts) |
| App context and renderer errors | [`client-context.ts`](../../apps/web/src/lib/bug-report/client-context.ts), [`renderer-errors.ts`](../../apps/web/src/lib/bug-report/renderer-errors.ts) |
| Window capture | `orkestrator:bug-report:capture-window` in [`ipc.ts`](../../apps/desktop/electron/ipc.ts) |

The shared prompt section sends the agent to the
[essential event log](logging.md#the-essential-event-log) first, because it is written
even with **Save Logs to Disk** off, and asks the user to turn saving on and reproduce the
problem only if that log does not explain it. `orkestrator --fix` also mentions the
[diagnostics bundle](logging.md#the-diagnostics-bundle) as something the user can attach.
It never runs it: what goes into a public issue stays the user's decision.

## Lifecycle

1. Opening the sheet reads `get_bug_report`. Without a report it calls
   `create_bug_report` with the client context. That makes a scratch
   directory (`$TMPDIR/orkestrator-bug-report-*`) and a record. Only one
   report is open at a time; leftovers are discarded.
2. The chat is the shared `AgentNativeTab`, unassigned, filtered to Claude,
   Codex and OpenCode. Its first message calls `assign_bug_report_agent`,
   which writes the briefing (`buildBugReportBriefing`) as the scratch
   directory's `AGENTS.md` and `CLAUDE.md`. Every offered agent loads one of
   those from its working directory on every turn. The first prompt also
   carries a pointer to it inside the coordinator context tags, which the
   transcript projection hides, as it does for a coordinator.
3. The agent writes `issue.md` (`# Title`, then the body). The sheet polls
   `get_bug_report` while it is open and shows the parsed draft with
   **File issue** and **Open on GitHub instead**.
4. `file_bug_report` takes the title and body the user saw, not a re-read of
   the file. With a GitHub credential (the host `gh` login, or the stored
   token, as Settings selects) it passes the exact approved body to
   `gh issue create --body-file -` through stdin, outside the agent's write
   boundary. Concurrent requests share one filing operation. A durable attempt
   marker blocks another launch after an uncertain CLI result, including after
   backend restart; the user checks existing issues and records the URL to
   resolve it. Without credentials it returns a prefilled `issues/new` URL.
   A body too long for a URL is retained for manual copying and copied to the
   clipboard when available; the user then pastes the issue URL back
   (`mark_bug_report_filed`).
5. **Done** (`discard_bug_report`) stops the report's bridge and deletes
   Orkestrator's session records, the report record and the scratch
   directory. It never deletes the provider's conversation (invariant 13).
   Only a directory named with the report prefix directly under the
   temporary directory is ever removed.

Closing the sheet only hides it. The report lives in the backend, and the
Bug button shows a dot while one is open and unfiled.

## The runtime

A report has no environment row. Like a coordinator conversation, it is
addressed by a synthetic runtime id that resolves to a local, running, ready
`Environment` whose worktree is the scratch directory
(`bugReportRuntimeEnvironment`). The id is special-cased where the
coordinator's is:

- session trust (`trustedBugReportInput`), where the platform must match the
  report's;
- environment liveness and background-state checks;
- local bridge start, stop and exit, with the bridge port and pid kept on the
  record;
- the startup bridge reaper;
- the activity sweep, where a report is observed but is not an environment
  owner;
- transcript preamble stripping.

A report gets no Agent Tools MCP: it belongs to no project.

Its policy is `interactive-host` with the override in
`BUG_REPORT_EXECUTION_POLICY_OVERRIDE`: provider sandbox and approvals `ask`.
The agent can read the host but write only inside its scratch directory, and
every escalation or non-read-only command needs the user's approval. The
briefing tells it never to file anything; filing is the sheet's button.

## Machines

A report's chat talks to the backend of the machine it reports on. Another
machine's workspace is in the window's own tree, on that machine's node
scope, so the window opens the sheet there (plan item 5003):

- `openBugReport(nodeId)` shows that node if it is not in front
  (`remoteWorkspaceStore.open`) and opens the window's sheet for it
  (`bugReportStore.openSheet(nodeId)`, `sheetNodeId`).
- `BugReportSheetHost` renders the sheet on the node's scope
  (`BugReportSheet scope`): the report is created, captured, filed and
  discarded through that node's client, and its agent session renders inside
  that scope, so it talks to that node.

The Bug button defaults to the machine in front: the node the central
region shows, otherwise the command node. The sheet's machine picker hands
the report over to another machine's sheet.

## Context sent to the agent

Identifiers and categories only:

- app version and channel, Electron version and user agent;
- the selected project and environment ids, environment type and status, and
  the active tab type;
- the last 30 renderer `console.error` lines, each at most 600 characters.

The renderer errors are recorded by `installRendererErrorRecorder` from the
renderer entry, and the briefing tells the agent to redact them.
**Capture window** captures the window, with the sheet stepped aside so it
shows what the user was looking at, into the report's `screenshots/` on the
node it reports on, and attaches it to the next message.
Pasted images use `write_bug_report_attachment` in both the assigned and
unassigned composers. The command resolves the scratch directory from the
stored report ID and writes a generated filename through the confined report
writer. It accepts no root path; `read_local_file` and `write_local_file`
remain restricted to registered local environments.
Screenshots are never uploaded: the filed notice tells the user to drag them
into the issue.

## Changing it

Edit shared instruction text in `bug-report.ts`. `buildFixPrompt` (CLI) and
`buildBugReportBriefing` (desktop) compose the same sections, so a change to
log names, settings labels or redaction rules reaches both.
