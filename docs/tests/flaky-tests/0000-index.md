# Flaky tests

Status: Living — only flake registry index.

This directory is the only flake registry. Do not start a second one. Do not
read every case file. This index only points to the group folders below; it
holds no cases. Each folder's `0000-index.md` tracks that group's cases in a
single table; cases are tracked only there.

A credible flake fails in the normal aggregate or parallel suite and passes
when its owning file is rerun alone. Resolved entries stay in their case files
with full history. Status lives in the group index so a model can skip those
files.

## Groups

| Folder | Covers |
| --- | --- |
| [Agent bridges](agent-bridges/0000-index.md) | Provider bridge packages (Claude, Codex, ACP and Cursor, Pi, OpenCode), their test harnesses, runtime environment wiring and bridge vendoring. |
| [Native agents and transcripts](native-agents-and-transcripts/0000-index.md) | The backend native agent service and observation, agent tools, chat tabs and messages, streaming and paged transcripts, scroll state and plan usage. |
| [Coordinator and Multi Review](coordinator-and-multi-review/0000-index.md) | The Coordinator service and live runner, agent mail, Multi Review, looped review, the review validation worker, change tracking and build-pipeline review fan-out. |
| [Environments, Git and containers](environments-and-containers/0000-index.md) | Environment lifecycle commands (create, move, fork, delete, cleanup), worktrees, submodules, Git and GitHub credentials, Docker containers, the firewall and disk reports. |
| [Design canvas and transcript artifacts](design-canvas-and-artifacts/0000-index.md) | The design canvas service, renderer and browser journeys; transcript artifacts (Mermaid, interactive previews, the content engine) and the agent-test artifact sanitizer. |
| [Service previews, annotations and gateway](previews-annotations-and-gateway/0000-index.md) | Service previews and the preview tunnel, web annotations, the browser gateway journey and the remote gateway proxy. |
| [Web UI components and browser specs](web-ui/0000-index.md) | `apps/web` components and libraries, root component tests, and component browser specs under `e2e/` that no feature group owns. |
| [Electron and desktop](electron-and-desktop/0000-index.md) | The desktop backend process and lifecycle, Electron command-registry and tmux-backend tests, Electron main-window journeys and native focus. |
| [Backend services, CLI and tooling](backend-services-and-tooling/0000-index.md) | The standalone backend, public API, MCP management, tmux and terminal history, storage, agent accounts and skills; the CLI package, toolchain, protocol, install scripts and test-runner scripts. |
| [Aggregate and merge validation runs](aggregate-validation-runs/0000-index.md) | Whole-suite, main-merge and component-browser validation runs whose failures span many owning files, dated resolution sweeps, and host conditions that are environmental rather than flaky. |

## How to use

1. Pick the group that owns the failing test's feature or file. When unsure,
   search every group index at once:
   `rg '<test name or owning file>' docs/tests/flaky-tests/*/0000-index.md`.
2. Read the **Status** column before opening anything else.
3. Open the linked case file only for a matching row. Prefer `open` rows;
   open `resolved` rows only when checking recurrence; open
   `environmental` rows only when the host matches the note.
4. If no row matches, the failure is not a known flake until the isolated
   rerun passes. Then add a new numbered case file to the owning group's
   folder and append its row to the end of that folder's table.

## Recording a case

- Put each case in exactly one group folder. A single aggregate or merge run
  whose failures span several groups goes in
  [Aggregate and merge validation runs](aggregate-validation-runs/0000-index.md);
  a recurrence of a known case updates that case instead.
- Name the file `NNNN-short-slug.md`. Its body carries `- **ID:** NNNN` and
  `- **Status:** <status>` lines that match its index row.
- Status is one of `open`, `resolved` or `environmental`. Change it in place
  in both the case file and the group table; never move or delete a row.
- Group tables have the columns `ID | Status | Test | File | Symptom | Case`,
  with rows in ID order. Keep **Symptom** to one or two sentences; detail
  belongs in the case file.
- Never add case rows to this file. Add a group only by creating its folder
  and index and linking it here.
- Link to a case in another group with a relative path such as
  `../web-ui/0382-component-browser-parallel-load.md`.
