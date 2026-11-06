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
| [Coordinator and Multi Review](coordinator-and-multi-review/0000-index.md) | The Coordinator service and live runner, agent mail, Multi Review, the retired looped review, the review validation worker, change tracking and build-pipeline review fan-out. |
| [Environments, Git and containers](environments-and-containers/0000-index.md) | Environment lifecycle commands (create, move, fork, delete, cleanup), worktrees, submodules, Git and GitHub credentials, Docker containers, the firewall and disk reports. |
| [Design canvas and transcript artifacts](design-canvas-and-artifacts/0000-index.md) | The design canvas service, renderer and browser journeys; transcript artifacts (Mermaid, interactive previews, the content engine) and the agent-test artifact sanitizer. |
| [Service previews, annotations and gateway](previews-annotations-and-gateway/0000-index.md) | Service previews and the preview tunnel, web annotations, the browser gateway journey and the remote gateway proxy. |
| [Web UI components and browser specs](web-ui/0000-index.md) | `apps/web` components and libraries, root component tests, and component browser specs under `e2e/` that no feature group owns. |
| [Electron and desktop](electron-and-desktop/0000-index.md) | The desktop backend process and lifecycle, Electron command-registry and tmux-backend tests, Electron main-window journeys and native focus. |
| [Backend services, CLI and tooling](backend-services-and-tooling/0000-index.md) | The standalone backend, public API, MCP management, tmux and terminal history, storage, agent accounts and skills; the CLI package, toolchain, protocol, install scripts and test-runner scripts. |
| [Aggregate and merge validation runs](aggregate-validation-runs/0000-index.md) | Whole-suite, main-merge and component-browser validation runs whose failures span many owning files, dated resolution sweeps, and host conditions that are environmental rather than flaky. |

## How to use

1. Before a flake sweep, and periodically otherwise, run the stale report and
   close the cases that are already fixed first:
   `mise run flaky:stale` (`--days N`, default 21; `--group <folder>`). It
   lists `open` cases whose newest date is older than N days, with their
   owning test files, whether those still exist, the commits that changed them
   after the last observation, and any commit the case cites that `HEAD`
   already contains. It never edits the registry; a case is closed only by a
   change that records why (see Recording a case).
2. Pick the group that owns the failing test's feature or file. When unsure,
   search every group index at once:
   `rg '<test name or owning file>' docs/tests/flaky-tests/*/0000-index.md`.
3. Read the **Status** column before opening anything else.
4. Open the linked case file only for a matching row. Prefer `open` rows;
   open `resolved` rows only when checking recurrence; open
   `environmental` rows only when the host matches the note.
5. Before recording a failure against a matching row, run the recurrence check
   with the base commit of the run that failed:
   `mise run flaky:recurrence -- <case-id> --base "$(git merge-base HEAD origin/main)" --registry-ref origin/main`
   (after `git fetch`; use the configured base branch in place of `main`).
   `--registry-ref` reads the case as committed on that branch, so a branch
   cut before a resolution still sees it. The check is read-only and prints
   one verdict:
   - **open**: record the failure as a recurrence.
   - **resolved, and the base contains its fix**: a real recurrence. Reopen
     the case (status `open` in the case file and the group table) and record
     it.
   - **resolved, but the base predates fix `<hash>`**: not a recurrence.
     Rebase and rerun; if you note the failure at all, note it as "base
     predates fix `<hash>`" and do not count it as a recurrence.
6. If no row matches, the failure is not a known flake until the isolated
   rerun passes. Then add a new numbered case file to the owning group's
   folder and append its row to the end of that folder's table.

## Recording a case

- Put each case in exactly one group folder. A single aggregate or merge run
  whose failures span several groups goes in
  [Aggregate and merge validation runs](aggregate-validation-runs/0000-index.md);
  a recurrence of a known case updates that case instead.
- Name the file `NNNN-short-slug.md`. Its body carries `- **ID:** NNNN` and
  `- **Status:** <status>` lines that match its index row.
- A new case takes the next number after the highest one in use in any group
  (or one from a range reserved for the branch), and a number is never
  reused. `tests/unit/flaky-tests-index.test.ts` fails on a number used by
  more than one case file, in one group or across groups. The 29 numbers that
  were already shared when the check was added are frozen in its
  `FROZEN_DUPLICATES` list and kept, not renumbered; none of them may gain
  another file. When a reused number is cited in prose, cite the case file
  name too.
- A case numbered 9800 or above also adds its claim,
  `docs/number-claims/flaky-tests/NNNN`, holding `<group>/NNNN-slug.md`. Two
  branches that take the same number then conflict in Git instead of both
  merging ([number-claims](../../number-claims/README.md),
  `tests/unit/number-claims.test.ts`). Count claims as numbers in use.
- Status is one of `open`, `resolved` or `environmental`. Change it in place
  in both the case file and the group table; never move or delete a row.
- Group tables have the columns `ID | Status | Test | File | Symptom | Case`,
  with rows in ID order. Keep **Symptom** to one or two sentences; detail
  belongs in the case file.
- Never add case rows to this file. Add a group only by creating its folder
  and index and linking it here.
- Link to a case in another group with a relative path such as
  `../web-ui/0382-component-browser-parallel-load.md`.
- Every observation (the first failure and each recurrence) records the date,
  the command and worker configuration, and the observing branch's **base
  commit**: `git merge-base HEAD origin/main`, or the merge base with the
  configured base branch. Run the recurrence check first (How to use, step 5);
  a failure on a base that predates the case's fix is written as "base
  predates fix `<hash>`" and is not a recurrence.
- A change that fixes a flake flips its case to `resolved` in the same change,
  in both the case file and the group table, and adds a dated
  `## Resolution (YYYY-MM-DD)` section with:
  - **Root cause:** what raced or starved, in the code.
  - **Fix:** what changed and where.
  - **Reproduced:** `yes — <how>` (the injected delay, held port or
    contention command that made the recorded failure happen before the fix,
    and that it passes under the same condition after), or
    `no — <why>`. A fix proven only by a passing stress run, or by a raised
    timeout, is weaker evidence and says so here.
  - **Stress:** the exact command and its result, for example
    `mise run test:logged -- --name <name> -- bun scripts/test-under-contention.ts -- bun test <file> --rerun-each=20`
    passed 20 of 20.

  Keeping the status flip in the fix's own change is what lets the
  recurrence check find the fix commit on the base branch.
