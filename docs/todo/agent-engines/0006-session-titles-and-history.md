# Session titles and history

Checked against `main` at `2459b05c` (2026-10-15).

Every session should have a sensible title that the backend owns. Fork, rewind
and branch navigation should be offered wherever the vendor supports them,
through the shared session-action bus. The history actions and the backend
title fallback are in place. Title generation still runs inside two bridges,
and three Codex and Cursor history semantics (external rewinds, archive,
archived agents) are not adopted.

## Current state

- Protocol (`packages/protocol/src/native-agent.ts`): `actions.rewindMessages`
  and `actions.branches`, the `rewind-messages` and `switch-branch` session
  actions, and `parentId` / `branchLabel` on resume entries.
- Rewind and branches per provider:
  - Codex: `rewind-messages` through `thread/revert`
    (`bridges/codex-bridge/src/engine/app-server-engine.ts`).
  - Cursor: checkpoint revert to a run's `startCheckpointRef`
    (`bridges/cursor-bridge/src/agent-session.ts`). The resume list pages with
    `nextCursor`, and replay keeps tool failures.
  - Pi: `navigateSessionHistory` → `navigateTree`. Fork uses
    `runtime.fork(entryId, { position: "before" })` and hands the selected
    message back as a composer draft (`bridges/pi-bridge/src/agent-session.ts`).
  - Claude: fork at a message with `forkSession(upToMessageId)`
    (`session-manager-persistence.ts`). Only `rewindFiles` is offered, not
    message rewind.
  - OpenCode: undo/redo through `session.revert` / `unrevert`.
  - Grok: no rewind or fork on ACP v1.
- Titles:
  - The backend projection title (`native-agent-transcript-projection.ts`) uses
    the provider's title, then the first user message cut to 80 characters
    (Claude's placeholder titles count as absent). It pushes the result back
    through `setSessionTitle`. A failed push is ignored and the projection keeps
    its title.
  - Setters: Codex `thread/name/set`, OpenCode `session.update`
    (`opencode-capabilities.ts`), Pi `setSessionName`, Claude through the
    bridge's `/session/:id/rename` route. Cursor and Grok have none, so the
    backend title is authoritative there.
  - Generation still happens in two bridges:
    - Codex: the hermetic `codex exec` runner in
      `bridges/codex-bridge/src/session-titles.ts`;
    - Claude: `generateTitleViaCli` (`claude --print --safe-mode` with tools,
      MCP, slash commands, settings and session persistence all off) in
      `session-manager-core.ts`, called from `generateAndSetSessionTitle`.
- Codex `thread/reverted`, `thread/archived` and `thread/unarchived` are on the
  ignore list in `bridges/codex-bridge/src/app-server/event-reducer.ts`.
  Nothing calls `thread/archive`.
- Cursor never reads `SDKAgentInfo.archived`. Claude never calls
  `getSubagentMessages()`.

## Outstanding work

### Code

1. **Backend-owned title generation.** Add a platform-neutral title service in
   `apps/backend/src/core/` (it does not exist yet), keyed by whichever
   credentials the environment already has. It has three strategies:
   - the hermetic `codex exec` runner moved out of `session-titles.ts`;
   - Claude `--print --safe-mode`, from `generateTitleViaCli`;
   - the first-message fallback the projection already applies.

   Then delete `session-titles.ts` and `generateTitleViaCli`, and drop Claude's
   title subprocess. Done when no bridge generates a title and every platform
   gets one from the backend.
2. **External Codex rewinds.** Adopt `thread/reverted` (a rewind made by another
   client) by trimming the transcript the bridge serves. Remove it from the
   ignore list in the same change.
3. **Codex archive.** Use `thread/archive` / `unarchive` for a user explicitly
   removing a session from the resume list. Never `thread/delete`.
4. **Cursor archived agents.** Read `SDKAgentInfo.archived` and hide archived
   agents in the resume list by default.
5. **Claude decisions.**
   - Message-level rewind (`rewindMessages`) through the SDK's resume-at
     options: offer it or record why not.
   - Rehydrate subagent detail on resume with `getSubagentMessages()`.

### Qualification

- Fork and rewind on Codex, Pi and Cursor fixtures, then reload. The resume list
  shows the branch structure and the provider agrees on the next transcript
  read.
- After item 1: a new session on each platform gets a generated title; with the
  generator unavailable it falls back to the first message; a failed provider
  push keeps the backend title.

## Constraints and rationale

- Titles are never generated in the renderer.
- A failed push to the provider never loses the backend title.
- Title generation must not inherit the user's tools, MCP servers, settings,
  hooks or plugins, and must not leave a resumable transcript behind. Claude
  uses `--safe-mode` rather than `--bare` because `--bare` also disables
  OAuth/Keychain authentication.
- Never `thread/delete` a Codex thread.
- A history action a provider lacks is a `false` capability bit; the renderer
  hides it.

## Related

- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md) and
  [agent-engines.md](../../architecture/agent-engines.md) "Closing a tab retains
  the conversation" (archive semantics must agree with the explicit-delete
  path).
- [0008-opencode-v2.md](0008-opencode-v2.md) (staged revert is
  2.x only).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the provider runs.
- [0038-design-agent-conversation-links.md](../design-canvas/0038-design-agent-conversation-links.md)
  waits on the archive work here: once a native conversation can be archived,
  design links add an archived state.

## Replaces

- `docs/plans/sdk-coverage/09-session-history-fork-rewind-titles.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` ("Session titles")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.10; Codex §4.12 rollback
  and archive; Cursor §6.7; Pi §8.4–5, §8.8)
