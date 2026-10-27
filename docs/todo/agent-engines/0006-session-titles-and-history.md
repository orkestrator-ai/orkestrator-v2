# Session titles and history

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Backend-owned title generation**: move title generation out of the Codex and Claude bridges into one backend service. Status: open (Claude's generator is already dead code).
2. **External Codex rewinds**: adopt `thread/reverted` and trim the served transcript. Status: open.
3. **Codex archive**: offer `thread/archive` / `unarchive` for explicit removal from the resume list. Status: open.
4. **Cursor archived agents**: hide `SDKAgentInfo.archived` agents in the resume list. Status: open.
5. **Claude history decisions**: decide message-level rewind and `getSubagentMessages()` rehydration. Status: open.
6. **Fork and rewind live qualification**: Codex, Pi and Cursor fork/rewind plus reload. Status: open.
7. **Title live qualification**: generated, fallback and failed-push titles on every platform. Status: blocked (on task 1).

### 1. Backend-owned title generation

**Problem.** Titles come from three places with different behaviour. Codex sessions get a model-generated title from a bridge subprocess; Claude, Cursor, Grok, Pi and OpenCode sessions get the backend's first-message fallback or the provider's own title. Users see inconsistent title quality by platform.

**Context.** The file's constraints apply: never generate in the renderer, never inherit the user's tools/MCP/settings/hooks, leave no resumable transcript, and keep `--safe-mode` (not `--bare`) for Claude so OAuth still works. Credentials differ per environment (host vs container), which is why the bridges did this originally.

**Investigation.** Still accurate, with one sharpening. Codex still generates live: `generateSessionTitleWithCodexExec` (`bridges/codex-bridge/src/session-titles.ts:386`) is wired at `bridges/codex-bridge/src/index.ts:816-819` and called once per session from `bridges/codex-bridge/src/app-server-runtime-prompt.ts:1354-1380`, which dual-writes `thread/name/set` and the bridge's `session-titles.jsonl` index. `session-titles.ts` is not only the generator: it also owns that index (`readPersistedSessionTitleEntries` :467, `persistSessionTitle` :529, `normalizeExplicitSessionTitle` :19), imported by six other modules, so "delete `session-titles.ts`" really means "delete its generator half". Claude's `generateTitleViaCli` (`bridges/claude-bridge/src/services/session-manager-core.ts:1509`) is reached only from `generateAndSetSessionTitle` (:1556), which has no caller, so Claude sessions get no generated title today, only the backend fallback. The backend fallback and push-back are at `apps/backend/src/core/native-agent-transcript-projection.ts:5076-5100`. No title service exists under `apps/backend/src/core/` (only `tmux-transcript-title.test.ts`). Recent title work (#1318, `9791a425`) only changed fallback filtering.

**Decisions.**

- **Where does the generator run?**
  - **Backend service that runs the hermetic CLI through the environment's runtime (recommended).** One service in `apps/backend/src/core/`, choosing a strategy from the credentials the environment already has, executing host-side or via `docker exec` for containers.
    - Pros: matches the file's goal; one place for the isolation flags; Cursor, Grok, Pi and OpenCode can gain generated titles.
    - Cons: the backend must know how to spawn each CLI per runtime; container exec adds latency and a failure mode.
  - **Keep generation in the bridges, add a shared route.** Each bridge exposes `POST /session/:id/title/generate`; the backend decides when to call it.
    - Pros: credentials stay where they already work; smaller change.
    - Cons: still N implementations; Cursor and Grok bridges would need generators they lack.
- **What to do with Claude's dead generator now?**
  - **Delete `generateTitleViaCli` / `generateAndSetSessionTitle` in a small change first (recommended).** Move the flag list into the new service when it lands.
    - Pros: removes unreachable code that suggests Claude titles work; independent of the larger design.
    - Cons: the flag list must be recovered from git history later.
  - **Leave it until the backend service lands.**
    - Pros: code stays as a reference.
    - Cons: misleads readers today; the persistence comment at `session-manager-persistence.ts:200` already refers to it as live.
- **Which model generates when an environment has several credentials?**
  - **The session's own platform first, then any other signed-in platform, then the first-message fallback (recommended).**
    - Pros: no surprise cross-vendor spend; still gives a title on Cursor/Grok when Codex or Claude is signed in.
    - Cons: a cross-vendor call sends the first prompt to a second vendor; needs a setting or disclosure.
  - **Own platform only, else fallback.**
    - Pros: no data crosses vendors.
    - Cons: Cursor, Grok, Pi and OpenCode keep fallback titles unless they get their own strategy.

### 2. External Codex rewinds

**Problem.** If another Codex client rewinds a thread Orkestrator also serves, the bridge keeps serving the removed turns, so the tab shows history the model no longer has.

**Context.** Only matters when a second client (Codex CLI or IDE) shares the same `CODEX_HOME` and thread. The ignore list comment says adopting it would drop transcript with no way back.

**Investigation.** Still ignored at `bridges/codex-bridge/src/app-server/event-reducer.ts:154-157`; the comment there cites "plan 09", a retired plan that this file replaced (stale reference). New detail from the pinned 0.164.0 protocol: `ThreadRevertedNotification` carries only `{ threadId }` (`bridges/codex-bridge/src/app-server/generated/typescript/v2/ThreadRevertedNotification.ts`), so the bridge cannot trim locally; it has to re-read the thread (`thread/read`) and replace the rows. The bridge's own rewind is `revertThread` at `bridges/codex-bridge/src/engine/app-server-engine.ts:2376`.

**Decisions.**

- **How to apply an external revert?**
  - **Re-hydrate the thread with `thread/read` and publish the replacement rows as a revision gap (recommended).**
    - Pros: authoritative; fits the "missed events are detectable" invariant; no guessing which turns went.
    - Cons: a full read of a long thread; must never be awaited on the stdout loop, so it needs an off-loop queue.
  - **Mark the transcript stale and let the next tab read reconcile.**
    - Pros: cheap; no new read path.
    - Cons: an inactive tab shows wrong history until something reads it.
- **Keep or retire the task?**
  - **Keep at low priority (recommended).**
    - Pros: a real, if rare, correctness gap.
    - Cons: needs a two-client test fixture to prove.
  - **Retire as out of scope (Orkestrator owns its threads).**
    - Pros: no work.
    - Cons: shared `CODEX_HOME` on the host is a supported setup.

### 3. Codex archive

**Problem.** Users cannot remove a Codex session from the resume list without deleting it, and deletion is forbidden.

**Context.** `thread/delete` is banned by the transport invariants. Design-canvas todo 0038 waits on an archived state.

**Investigation.** The pinned protocol has `thread/archive`, `thread/unarchive`, `thread/archived` and `thread/unarchived` (`.../generated/typescript/ClientRequest.ts`, `ServerNotification.ts`). Nothing calls them. `listThreads` already forwards an `archived` filter (`bridges/codex-bridge/src/engine/app-server-engine.ts:2438`), but the option is named `includeArchived` (`bridges/codex-bridge/src/engine/types.ts:336`) while `ThreadListParams.archived = true` returns **only** archived threads (`.../v2/ThreadListParams.ts:39-42`); no caller sets it yet, but the name will mislead whoever does. There is no archive session action in `packages/protocol/src/native-agent.ts` and no renderer surface.

**Decisions.**

- **Is archive Codex-only or a shared session action?**
  - **Shared `archive` / `unarchive` session action with a capability bit; Codex and Cursor first (recommended).**
    - Pros: one UI; Cursor already has `Agent.archive`; 0038 gets one archived state.
    - Cons: needs protocol, backend and renderer work for what starts as two platforms.
  - **Codex-only bridge route.**
    - Pros: quickest.
    - Cons: a second platform-specific path the renderer must special-case.
- **Rename `includeArchived`?**
  - **Rename to `archivedOnly` (or a tri-state) in the same change (recommended).**
    - Pros: matches the wire semantics and prevents an "include" caller hiding every live thread.
    - Cons: touches the engine type and tests.
  - **Keep the name, document it.**
    - Pros: no churn.
    - Cons: a trap for the first caller.

### 4. Cursor archived agents

**Problem.** Archived Cursor agents (archived in Cursor's own UI) still appear in Orkestrator's resume list.

**Context.** Related to task 3; both should behave the same.

**Investigation.** Pinned `@cursor/sdk` is now `1.0.40` (`bridges/cursor-bridge/package.json`). `SDKAgentInfo.archived?: boolean` exists (`bridges/cursor-bridge/node_modules/@cursor/sdk/dist/cjs/agent.d.ts:96-100`). `listResumableSessions` (`bridges/cursor-bridge/src/agent-session.ts:838`) lists every page and never reads it.

**Decisions.**

- **Filter in the bridge or pass the flag through?**
  - **Pass `archived` through on each resume entry and let the renderer hide archived by default with a "show archived" toggle (recommended).**
    - Pros: one behaviour for Codex and Cursor; reversible by the user.
    - Cons: a protocol field and renderer change rather than a one-line filter.
  - **Drop archived items in the bridge.**
    - Pros: one line; immediate.
    - Cons: no way to resume an archived agent from Orkestrator.

### 5. Claude history decisions

**Problem.** Claude offers fork and file rewind but not message-level rewind, and resumed sessions lose subagent detail.

**Context.** Claude actions are `{ compact, rewindFiles, steer }` (`packages/protocol/src/native-agent.ts:1139`); Codex, Cursor and Pi offer `rewindMessages`. Fork is `sdk.forkSession` at `bridges/claude-bridge/src/services/session-manager-persistence.ts:744`.

**Investigation.** Pinned SDK `0.3.309`. It has `resumeSessionAt` and a new `resumeDropsTurn` validator (`bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2138-2190`), which refuses a truncating resume when the discarded range holds anything other than the named turn, and is print/headless-lane only. `getSubagentMessages` exists (`sdk.d.ts:957`). The bridge uses neither.

**Decisions.**

- **Offer Claude message rewind?**
  - **Offer it as truncating resume with `resumeSessionAt` plus `resumeDropsTurn`, mapping a refusal to a plain resume with a notice (recommended).**
    - Pros: parity with Codex/Cursor/Pi; the validator makes the truncation safe against absorbed mid-turn messages.
    - Cons: interacts with the warm CLI (0005), which must be restarted on the truncated chain; refusal handling is a new path.
  - **Record "fork only" as the Claude answer.**
    - Pros: no new state; fork already gives a branch point.
    - Cons: parity gap stays; fork leaves the old session in the list.
- **Rehydrate subagent detail on resume?**
  - **Yes, lazily through transcript v2 detail reads (recommended).**
    - Pros: no cost until the user expands a subagent card; fits the detail-locator design.
    - Cons: needs a locator per subagent card.
  - **Eagerly on resume.**
    - Pros: simple.
    - Cons: large sessions pay a read per subagent on every hydrate.

### 6. Fork and rewind live qualification

**Problem.** Fork, rewind and branch navigation are unproven on the real stack for Codex, Pi and Cursor.

**Context.** Belongs with the batched runs in 0031.

**Investigation.** Code paths exist (Codex `revertThread`, Cursor checkpoint revert at `bridges/cursor-bridge/src/agent-session.ts:703`, Pi fork at `bridges/pi-bridge/src/agent-session.ts:1352` and `navigateSessionHistory` at :1370). No browser spec covers them.

**Decisions.**

- **How to run it?**
  - **Isolated `dev:test` profile with `--fixture`, one pass per provider, then reload and compare the next provider transcript read (recommended).**
    - Pros: matches the agent-testing procedure; reload proves rehydration.
    - Cons: needs live logins for three providers.
  - **Add a permanent browser spec with fake bridges first.**
    - Pros: regression guard.
    - Cons: does not prove the vendor agrees, which is the point of the run.

### 7. Title live qualification

**Problem.** The backend title path is not proven for generation, fallback and failed push.

**Context.** Depends on task 1.

**Investigation.** The fallback and ignored-push behaviour exist today (`native-agent-transcript-projection.ts:5076-5100`), so two of the three checks could run now.

**Decisions.**

- **Wait for task 1 or run the fallback checks now?**
  - **Run the fallback and failed-push checks now with a deterministic test, leave the generated-title run for after task 1 (recommended).**
    - Pros: covers existing behaviour without a live provider.
    - Cons: splits the item.
  - **Wait for task 1.**
    - Pros: one run.
    - Cons: shipped fallback stays unproven meanwhile.

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
  - OpenCode: undo/redo through `session.revert` / `unrevert`; the transcript
    hides a pending revert until the next prompt commits it (0175).
  - Grok: no rewind or fork on ACP v1.
- Titles:
  - The backend projection title (`native-agent-transcript-projection.ts`) uses
    the provider's title, then the first user message, without framed system
    instructions or transcript-annotation blocks, cut to 80 characters
    (Claude's placeholder titles count as absent; see 0081). It pushes the
    result back through `setSessionTitle`. A failed push is ignored and the
    projection keeps its title.
  - Setters: Codex `thread/name/set`, OpenCode `session.update`
    (`opencode-capabilities.ts`), Pi `setSessionName`, Claude through the
    bridge's `/session/:id/rename` route. Cursor and Grok have none, so the
    backend title is authoritative there.
  - Generation still happens in two bridges:
    - Codex: the hermetic `codex exec` runner in
      `bridges/codex-bridge/src/session-titles.ts`;
    - Claude: `generateTitleViaCli` (`claude --print --safe-mode` with tools,
      MCP, slash commands, settings and session persistence all off) in
      `session-manager-core.ts`, called from `generateAndSetSessionTitle`,
      which nothing has called since #599 (checked 2026-10-26 for 0081).
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
