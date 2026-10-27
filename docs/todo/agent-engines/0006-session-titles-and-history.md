# Session titles and history

Checked against `main` at `863b5782` (2026-10-27).

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
through the shared session-action bus. Every code item is done (2026-10-27):
titles are generated by the backend for every platform, Codex adopts rewinds
made by other clients and can archive a conversation out of the resume list,
Cursor hides archived agents, and Claude rehydrates subagent detail on resume.
Offline qualification now runs the pinned provider binaries/SDKs with temporary
homes and scripted loopback endpoints. Authenticated product-level QA remains.

## Current state

- Protocol (`packages/protocol/src/native-agent.ts`): `actions.rewindMessages`,
  `actions.branches` and `actions.archive` (Codex only), the `rewind-messages`
  and `switch-branch` session actions, and `parentId` / `branchLabel` on resume
  entries.
- Rewind and branches per provider:
  - Codex: `rewind-messages` through `thread/revert`
    (`bridges/codex-bridge/src/engine/app-server-engine.ts`). A rewind by
    another client (`thread/reverted`) is adopted: the bridge reads the
    surviving turns with `thread/read` and trims the transcript it serves
    (`sessions/external-revert.ts`, `reconcileExternalRevert` in
    `app-server-runtime-sessions.ts`). Reads are fenced by the attached sessions'
    transcript revisions, context identity and engine generation. Rollout replay
    follows 0.164's `history_base` prefix references after a revert and also
    supports older `thread_rolled_back` markers (`history/rollout.ts`).
  - Cursor: checkpoint revert to a run's `startCheckpointRef`
    (`bridges/cursor-bridge/src/agent-session.ts`). The resume list pages with
    `nextCursor`, keeps tool failures in replay, and leaves out agents the SDK
    reports `archived`.
  - Pi: `navigateSessionHistory` → `navigateTree`. Fork uses
    `runtime.fork(entryId, { position: "before" })` and hands the selected
    message back as a composer draft (`bridges/pi-bridge/src/agent-session.ts`).
  - Claude: fork at a message with `forkSession(upToMessageId)`
    (`session-manager-persistence.ts`). Only `rewindFiles` is offered, not
    message rewind (decision 6). A resumed session shows its subagents' steps
    again (`session-manager-subagent-rehydration.ts`, `getSubagentMessages`).
  - OpenCode: undo/redo through `session.revert` / `unrevert`; the transcript
    hides a pending revert until the next prompt commits it (0175).
  - Grok: no rewind or fork on ACP v1.
- Archive: the resume dialog's **Remove from list** (with **Undo**) calls
  `set_native_agent_resumable_session_archived`, which reaches the Codex
  bridge's `POST /session/list/:threadId/archive` / `unarchive` and
  `thread/archive` / `thread/unarchive`. The resume list leaves archived
  threads out. Nothing calls `thread/delete`.
- Titles (`docs/architecture/agent-engines.md`, "Session titles"):
  - `native-agent-session-titles.ts` decides the shown title on every
    projection read (legacy, progressive transcript and state views) and
    chooses one once per provider session, when the provider has none of its
    own and the read reaches the start of the conversation.
  - `session-title-service.ts` writes it, for interactive and coordinator
    sessions, with whichever of Codex or Claude this machine is signed in to
    (the session's own platform first): the hermetic `codex exec` runner and
    `claude --print --safe-mode` (`session-title-runners.ts`). Pipeline
    sessions and sessions no generator could title keep the first-message
    fallback (`session-title-text.ts`).
  - The choice is stored on the session record (`backendTitle`) and pushed
    through `setSessionTitle`; an unaccepted title outranks the provider's
    own, so a failed push never loses it. Cursor and Grok have no setter, so
    the backend title is authoritative there.
  - No bridge generates a title: the Codex runner (`session-titles.ts`) and
    Claude's `generateTitleViaCli` are gone. The Codex bridge keeps only its
    title index (`session-title-index.ts`) and no longer reports a title it
    read back from the first prompt.

## Outstanding work

### Code

Every code item is done (2026-10-27):

1. ~~Backend-owned title generation.~~ Done: see Current state, decisions 1–4.
2. ~~External Codex rewinds.~~ Done; `thread/reverted` is off the ignore list.
3. ~~Codex archive.~~ Done; see decision 5.
4. ~~Cursor archived agents.~~ Done; hidden by default (decision 8).
5. ~~Claude decisions.~~ Message rewind not offered (decision 6); subagent
   detail rehydrated on resume (decision 7).

### Qualification

Pinned-provider and browser qualification is recorded below. Authenticated
end-to-end product QA is still listed separately.

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

## Qualification (2026-10-27)

- `bridges/codex-bridge/src/app-server/live-resume-context.test.ts` runs the
  pinned 0.164 app-server with synthetic credentials and a scripted loopback
  Responses endpoint. A real turn pair, `thread/revert`, a follow-up, archive,
  unarchive and disk replay agree on the retained turns. It also observes
  `thread/reverted`. Run with `RUN_LIVE_CODEX_APP_SERVER=1`.
- That capture disproved the previous marker assumption for paginated history:
  0.164 creates a new `rollout-<timestamp>-<thread>_<leaf>.jsonl`. Its
  `session_meta.payload.history_base` contains `thread_id`,
  `end_ordinal_exclusive` and `end_byte_offset`. Replay follows the referenced
  prefix with a 64-level bound, rejects missing/cyclic/incomplete bases, and
  keeps legacy rollback-marker support. Repeated reverts reference the previous
  leaf by its UUID suffix. `history/fixtures/revert-session-meta.json` retains
  the minimized, identifier-scrubbed provider header from this qualification. Steers with a shared turn ID count
  as one turn; oversized rollback counts clear all replayed turns.
- `session-title-claude-live.test.ts` runs the pinned Claude CLI against a
  scripted local Anthropic endpoint using the production title runner. Stdin
  works with all isolation flags, and no transcript or scratch directory is
  left. The fake-executable regression separately verifies source absence in
  argv and presence in stdin.
- `session-title-production.test.ts` exercises the production title-service
  factory with synthetic account boundaries and real runner subprocesses using
  fake executables:
  sign-in selection, managed binaries, active-account environment precedence,
  GitHub-token stripping, pinned Claude runtime flags and generation gates.
  No operator credentials are read or used.
- `bridges/cursor-bridge/src/archive-sdk.test.ts` uses the real pinned SDK
  and `JsonlLocalAgentStore` under a temporary root. Archived state survives
  the SDK list conversion and is excluded by the bridge picker.
- `session-manager-subagent-rehydration.test.ts` uses the real pinned Claude
  SDK's filesystem readers: the `.meta.json` field is `toolUseId`, which the
  SDK returns as `parent_tool_use_id`; the detail is restored under its call.
- Runtime tests hold a revert read across a completed new turn, cover detached
  contexts, empty surviving histories and mixed/no turn IDs. Projection tests
  hold generation across provider replacement and check cached title/revision.
- Controller, hook and command-wrapper tests cover lineage mapping and archive
  capability/command plumbing. `e2e/NativeResumeSession.spec.ts` checks visible
  branch labels and selection at desktop and mobile widths.

### Remaining authenticated product QA

The checks above qualify actual pinned binaries and SDK filesystem contracts
without external model calls. They do not claim a real-account browser run
across all six platforms, Cursor's own archive UI, a newly spawned Claude
subagent across a full app restart, or production title cost/latency. Those
remain in [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Assumptions and decisions

Decisions made on 2026-10-27 while doing the items.

1. **Where generation runs and which login it uses.** Options: (a) keep the
   generators in the bridges, each titling its own sessions; (b) a backend
   service that runs the host's managed `codex` / `claude` CLI on the active
   account (`applyActiveAgentAccountEnvironment`), the session's own platform
   first, then the other, skipping a platform that is not signed in; (c) a
   backend service that calls a provider API directly with a stored key.
   Chose (b). Pros: one implementation for six platforms, the same
   credentials and isolation the bridges already use, Cursor/Grok/Pi/OpenCode
   sessions get model titles from whichever login exists, and the environment
   (local or container) does not matter because the run is a host CLI with no
   workspace. Cons: a container environment is titled with the host's login,
   not the container's; a machine with neither Codex nor Claude signed in only
   ever gets fallbacks; one CLI spawn per new session.
2. **Which sessions get a model title.** Options: every session, or only
   interactive and coordinator sessions. Chose the latter. Pros: a build
   pipeline or Multi Review round runs many short sessions nobody picks from a
   list, and each would cost a spawn and tokens. Cons: those sessions keep the
   80-character first-message title, as they had in the backend before.
3. **Title precedence and failed pushes.** Options: (a) the provider's title
   always wins once it has one; (b) a backend title the provider has not
   accepted outranks the provider's own, and once accepted the provider wins
   (a later rename there is respected). Chose (b), with acceptance recorded on
   the session record (`backendTitle.pushed`) and a push retried at most every
   five minutes. Pros: meets "a failed push never loses the backend title"
   (a restarted Claude bridge reports the SDK summary, which would otherwise
   replace it); Cursor and Grok, which have no setter, keep the backend title.
   Cons: a rename made in the provider during the few seconds between the
   backend choosing a title and the push succeeding is overwritten.
4. **When a title is chosen.** Options: on any read with a user message, or
   only on a read whose window reaches the start of the conversation. Chose
   the latter. Pros: a long conversation resumed without a title is not named
   after a message from its middle. Cons: such a conversation shows the
   first visible message (not stored) until a read covers its start.
5. **What "remove from the resume list" is in the UI.** Options: (a) a remove
   button per row with an Undo toast that unarchives; (b) a "Show archived"
   toggle in the picker with restore; (c) no UI, an API only. Chose (a). Pros:
   the smallest surface that covers "explicitly removing a session" with a way
   back; the provider keeps the conversation either way. Cons: once the toast
   is gone there is no in-app way to list archived Codex conversations (the
   Codex CLI can).
6. **Claude message-level rewind.** Options: (a) offer `rewindMessages` by
   resuming with `resumeSessionAt` (and `resumeDropsTurn`); (b) keep only fork
   at a message and `rewindFiles`. Chose (b), not offered. Why:
   `resumeSessionAt` is consumed only when a headless CLI boots, while the
   bridge keeps one warm CLI per session (`bridges/claude-bridge/AGENTS.md`,
   "One CLI per session"), so a rewind would have to retire the runtime and
   wait for it to end; the truncation reaches the JSONL only when the next
   prompt writes a new leaf, so until then every reader (`getSessionMessages`,
   transcript v2, the resume list, fork) would need a staged-rewind marker
   that survives a bridge restart, as OpenCode's revert needed (0175); and a
   refused `resumeDropsTurn` must fall back to a plain resume. Fork at a
   message already gives the user the same result without changing the
   conversation. Pros: no new state machine beside the one-CLI invariant.
   Cons: Claude has no in-place message rewind, unlike Codex, Cursor and Pi.
7. **Claude subagent detail on resume.** Implemented with `listSubagents` +
   `getSubagentMessages`, placing each subagent's parts in the row holding
   its call (nested subagents follow their parent), bounded at 64 subagents
   per hydration and the live stream's 128 parts per call. Options for the
   link to the call: the SDK's `parent_tool_use_id` (from the subagent's
   sidecar) or matching the subagent's first prompt to the call's input.
   Chose the SDK field. Pros: exact, no text matching. Cons: a subagent whose
   sidecar is missing is not placed (its call still shows).
8. **Cursor archived agents.** Options: hide them, or list them marked
   archived. Chose hide, with no include switch. Pros: the pinned SDK refuses
   a follow-up run on an archived agent and only unarchives cloud agents, so a
   listed one could only fail. Cons: no way to see them from Orkestrator.
9. **The Codex bridge's prompt-derived titles.** Options: keep setting a
   7-word title from the first prompt, or stop. Chose to stop setting it on a
   prompt and to leave a title read back from the first prompt (`titleSource:
   "prompt"`) out of the status the backend reads. The resume list keeps its
   first-message label for untitled threads. Pros: the backend decides every
   title, including for resumed threads. Cons: none found; the resume-list
   label still comes from the bridge, as a label rather than a title.
10. **Placeholder push.** The old projection pushed the provider's own
    placeholder back to it when nothing better existed (asserted by 0081's
    test). Now only a title the backend chose is pushed; that test asserts no
    push.

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
  was waiting on the archive work here; it can now add an archived state.
- [0081-annotation-fence-in-session-titles.md](0081-annotation-fence-in-session-titles.md)
  (#1318): the annotation strip it added to the backend fallback now lives in
  `session-title-text.ts`.

## Replaces

- `docs/plans/sdk-coverage/09-session-history-fork-rewind-titles.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` ("Session titles")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.10; Codex §4.12 rollback
  and archive; Cursor §6.7; Pi §8.4–5, §8.8)
