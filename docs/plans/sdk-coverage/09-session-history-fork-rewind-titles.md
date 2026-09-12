# 09 — Session history: fork, rewind, revert and titles

**Status:** 🟨 In progress · ~45% · Depends on: 02, 03

Refreshed 2026-09-11. Rewind exists on Codex and Cursor; Pi has fork/tree
primitives. Still open: backend-owned titles (still Codex `session-titles.ts`),
Pi `switch-branch`, Claude `resumeSessionAt`, and resume-tree UX.

## Goal

The shared session actions (`compact`, `rewindFiles`, `undo`, `redo`, `fork`)
are islands: Claude has file rewind, OpenCode has undo/redo, Codex and Cursor
have neither although their SDKs offer message-level rollback and
checkpoints, and Pi forks through a non-SDK path. Session titles exist only
where a vendor happens to provide one. Normalize history actions so each
provider fills what it can, and make titles a backend responsibility for
every platform.

## Normalized model

`capabilities.actions` in `packages/protocol/src/native-agent.ts` gains:

```
rewindMessages?: boolean   // roll the conversation back to a message (Codex rollback, Cursor checkpoint, Pi tree)
branches?: boolean         // the provider keeps a session tree the user can navigate (Pi)
```

`NativeAgentSessionAction` gains `{ kind: "rewind-messages"; messageId }` and
`{ kind: "switch-branch"; entryId }`. `NativeAgentResumeEntry` gains
`parentId?` and `branchLabel?` so a tree renders as an indented resume list
without a tree-specific component.

Titles: `NativeAgentSessionProjection.title` is always set. Source order:
provider-reported title → backend-generated title (the existing Codex
`session-titles.ts` generator, moved to `apps/backend/src/core/` as a
platform-neutral service that uses whichever cheap model the environment
already has credentials for) → first user message truncated. Adapters push
the chosen title back to the provider where a setter exists.

## Tasks

### Protocol and backend

- [ ] Add the capability bits, the two actions and the resume-entry fields;
  protocol tests. `native-agent-service-dispatch.ts` gates them like the
  existing actions (`:606-622`).
- [ ] Move title generation out of `bridges/codex-bridge/src/session-titles.ts`
  into a backend service keyed by environment; keep the hermetic
  `codex exec` runner as one strategy, add a Claude `--print --safe-mode`
  strategy (today in `session-manager-core.ts:1069-1108`), and a
  no-model fallback (first message). The renderer never generates a title.
- [ ] Push titles back: Claude `renameSession()` (route exists, unused from
  the neutral surface), Codex `thread/name/set`, OpenCode `session.update`,
  Pi `setSessionName()`. Cursor and Grok have no setter; the backend title
  is authoritative.

### Codex bridge

- [ ] `rewind-messages` → `thread/rollback` (or `thread/revert` if the
  protocol's semantics fit better; decide from
  `generated/typescript/v2/ThreadRollbackParams.ts`). Consume
  `thread/reverted` (plan 02 routes it here) to trim the bridge transcript.
- [ ] Fork already uses `thread/fork` with `lastTurnId`; add
  `thread/archive`/`unarchive` as the close-tab semantics for sessions the
  user explicitly removes from the resume list (never `thread/delete`).

### Cursor bridge

- [ ] `rewind-messages` → `AgentCheckpointStore` / `CheckpointRef`
  (`run-store-public-types.d.ts:19,155,168-170`); save a checkpoint per turn
  and revert to the chosen one. Set `actions.rewindMessages` from a runtime
  probe since the store backend varies (JSONL vs SQLite).
- [ ] Resume list: paginate with `ListResult.nextCursor` instead of the 200
  cap; read `SDKAgentInfo.archived` and hide archived by default.
- [ ] Resume replay: keep tool outcomes from `Run.conversation()` instead of
  stamping every card `success` (`agent-session.ts:381`).

### Pi bridge

- [ ] Fork through `AgentSessionRuntime.fork()` instead of
  `createBranchedSession` (`agent-session.ts:719`), so `session_before_fork`
  fires, the start reason is `fork`, and the selected message is handed back
  as editable text (`position: "before"`) which the backend passes to the
  composer draft.
- [ ] `branches: true`; resume list from `SessionManager.getTree()` with
  `parentId`/`branchLabel`; `switch-branch` → `navigateTree()`. Keep
  `entry_appended` (plan 02) to refresh labels.
- [ ] Title: `setSessionName()` from the backend title; read
  `session_info_changed` as today.

### Claude bridge

- [ ] `resumeSessionAt` / `resumeDropsTurn` for a fork or rewind from a
  specific message, instead of always whole-session resume; use
  `getSubagentMessages()` so a resumed session re-hydrates subagent detail.
- [ ] Use `Options.title` on the first query so the CLI's own session list
  matches the backend title; drop the separate title subprocess once the
  backend service owns it.

### OpenCode (backend)

- [ ] Map `session.update` for titles; keep undo/redo/share as they are.
  Staged revert is v2 only and stays out.

### Grok bridge

- [ ] No rewind or fork in ACP v1; capabilities stay false. Title from the
  backend service.

## Verification

- [ ] Bridge tests: rewind on Codex and Cursor trims the transcript and the
  provider agrees on the next `messages` read; Pi fork creates a child in
  the tree with the right parent.
- [ ] Backend tests: title source order, and that a provider push failure
  does not lose the backend title.
- [ ] Browser: fork and rewind on Codex and Pi fixtures; reload; resume list
  shows the branch structure.

## Out of scope

Codex thread sections. OpenCode staged revert (v2). Cursor cloud agents.
