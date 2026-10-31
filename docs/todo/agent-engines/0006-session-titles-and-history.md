# Session titles and history

Checked against `main` at `931e55417` (2026-10-31).

Every session should have a sensible title that the backend owns. Fork, rewind
and branch navigation should be offered wherever the vendor supports them,
through the shared session-action bus.

## Task analysis

Analysed 2026-10-31 against main at `931e55417`, with Claude CLI 2.1.314 and Agent SDK 0.3.314, Codex 0.166.0 and `@cursor/sdk` 1.2.0.

The previous analysis was written against `863b5782`, before #1337 landed, so it listed tasks 1 to 5 as open while the rest of this file said they were done. This analysis replaces it. Each task below says what was already there, what the recheck found and what changed.

### Tasks

1. **Backend-owned title generation**: one backend service, nothing in the bridges. Status: done (#1337; hardened on 2026-10-31).
2. **External Codex rewinds**: adopt `thread/reverted` and trim the served transcript. Status: done (#1337; rechecked at 0.166.0).
3. **Codex archive**: explicit removal from the resume list, as a shared action. Status: done (#1337 for Codex; Cursor added on 2026-10-31).
4. **Cursor archived agents**: out of the resume list by default, reachable by a toggle. Status: done (2026-10-31; supersedes the hide-only decision 8).
5. **Claude history decisions**: subagent rehydration and message-level rewind. Status: open (rehydration done; message rewind awaits the user's decision).
6. **Fork and rewind live qualification**: Codex, Pi and Cursor fork/rewind plus reload. Status: open (needs signed-in runs).
7. **Title live qualification**: generated, fallback and failed-push titles on every platform. Status: open (offline half done; the signed-in run remains).

### 1. Backend-owned title generation

**Problem.** Titles came from three places with different behaviour, so title quality depended on the platform.

**Context.** Never generate in the renderer, never inherit the user's tools, MCP, settings, hooks or plugins, leave no resumable transcript, and keep `--safe-mode` (not `--bare`) for Claude so OAuth still works.

**Investigation.** The service is live: `session-title-service.ts` and `session-title-runners.ts`, called from `native-agent-session-titles.ts`. No bridge generates a title. Three things were found on 2026-10-31.

- The Codex run was not hermetic. Against the real CLI (0.164.0 and 0.166.0) and a loopback endpoint, each title request carried the name and description of every skill in `$CODEX_HOME/skills` and `~/.agents/skills`, offered `request_user_input` and `view_image`, and included the permissions text and environment context. At 0.166.0, a `$skill` in the first message also sent that skill's whole `SKILL.md`; that was not tried on 0.164.0. The old parser test ran only `--help`, so it could not see any of this.
- The recommended option's cost, "needs a setting or disclosure" for a first message crossing vendors, had not been met: the only control was an environment variable.
- To-do 1020's question is answered: `claude -p` exiting 1 on startup failure does not affect titles. See below.

*`claude -p` exit codes.* The pinned CLI and 2.1.309 were run with the production arguments against a loopback endpoint. Missing credentials, HTTP 400, 401, 403, 404, low credit and 529, an unusable proxy, an unusable temporary directory and a malformed response all exit 1 on both versions, with the error on stdout or stderr. `runCommand` rejects any non-zero exit, so the error text does not become a title; the service rests that strategy and moves to the next. The two versions behaved the same in every case tried, so the change the upstream note describes was not reproduced. Exit 1 is the safe direction either way: the runner treats exit 0 stdout as the title, so only a failure that exited 0 could have been misread. Most `SDKStartupFailureReason` values could not be triggered offline (the `org_*` and managed-settings reasons need a policy), and that rests on the upstream note that they exit 1.

**Decisions.**

- **Where does the generator run?**
  - **Backend service that runs the host's CLI on the active account (recommended).**
    - Pros: one implementation and one place for the isolation flags; every platform can get a generated title.
    - Cons: a container environment is titled with the host's login; one CLI spawn per new session.
  - **Same service, through `docker exec` for containers.**
    - Pros: a container's session uses that container's login.
    - Cons: needs a CLI and a login inside each container; adds latency and a failure mode for a title.
- **Which login writes the title?**
  - **The session's own platform first, then the other signed-in one, with a setting that can stop it crossing vendors (recommended).**
    - Pros: Cursor, Grok, Pi and OpenCode get real titles by default, and the user can see and change where the message goes.
    - Cons: by default a first message reaches a second vendor; the disclosure lives in Settings, not at the moment it happens.
  - **The session's own platform only, by default.**
    - Pros: no data crosses vendors unless the user opts in.
    - Cons: Cursor, Grok, Pi and OpenCode keep first-message titles unless the user finds the setting.
- **What to do about the global `AGENTS.md`?**
  - **Accept it and document it (recommended).**
    - Pros: Codex has no switch for it, and it goes to the vendor the user already gave it to; the title model has no tools and a strict output schema, so the worst outcome is a worse title.
    - Cons: a Cursor session's title request carries the user's Codex instructions; a few extra tokens.
  - **Run with a scratch `CODEX_HOME` holding a copy of the login.**
    - Pros: fully hermetic.
    - Cons: a token refresh in the copy can rotate the refresh token and sign the user out of their real login.

### 2. External Codex rewinds

**Problem.** If another Codex client rewinds a thread Orkestrator also serves, the tab would keep showing turns the model no longer has.

**Context.** Only matters when a second client shares the same `CODEX_HOME` and thread.

**Investigation.** Done in #1337 (`sessions/external-revert.ts`, `reconcileExternalRevert`). `ThreadRevertedNotification` is still `{ threadId }` at 0.166.0, so the re-read design still applies. `app-server/live-resume-context.test.ts` passes against the real 0.166.0 binary and a loopback endpoint; `app-server-runtime-revert.test.ts` and `external-revert.test.ts` pass. No code changed on 2026-10-31.

**Decisions.**

- **How to apply an external revert?**
  - **Re-read the thread with `thread/read` and publish the replacement (recommended).**
    - Pros: authoritative; no guessing which turns went.
    - Cons: a full read of a long thread, off the stdout loop.
  - **Mark the transcript stale and let the next tab read reconcile.**
    - Pros: cheap.
    - Cons: an inactive tab shows wrong history until something reads it.

### 3. Codex archive

**Problem.** Users could not remove a session from the resume list without deleting it, and deletion is forbidden.

**Context.** `thread/delete` is banned by the transport invariants. Design-canvas to-do 0038 waits on an archived state.

**Investigation.** #1337 shipped the action for Codex with `actions.archive`, and renamed the misleading option to `onlyArchived`. Decision 8 kept Cursor out because its SDK could only unarchive cloud agents. That is false at 1.2.0: the real SDK's `Agent.archive` and `Agent.unarchive` both work on a local agent (`JsonlLocalAgentStore`), despite `stubs.d.ts` saying "Cloud-only". So the recommended shared action is now possible, and Cursor has it.

**Decisions.**

- **Is archive Codex-only or a shared session action?**
  - **Shared action with a capability bit, Codex and Cursor (recommended).**
    - Pros: one UI; 0038 gets one archived state.
    - Cons: protocol, backend and renderer work for two platforms.
  - **Codex-only.**
    - Pros: already shipped.
    - Cons: Cursor users can archive in Cursor and never get the agent back from here.

### 4. Cursor archived agents

**Problem.** Archived Cursor agents appeared in the resume list, then failed when chosen.

**Context.** Should match task 3.

**Investigation.** The local store refuses a follow-up on an archived agent ("Unarchive it first") and `unarchiveAgent` sets it back to idle, so a listed agent can be recovered by restoring it first. `archive-sdk.test.ts` runs this round trip through the real SDK and disk store.

**Decisions.**

- **Filter in the bridge or pass the flag through?**
  - **Pass `archived` through and let the picker hide archived rows behind a "Show archived" toggle (recommended).**
    - Pros: one behaviour for Codex and Cursor; reversible; also gives Codex the way back that decision 5 lacked.
    - Cons: protocol and renderer change.
  - **Drop archived agents in the bridge.**
    - Pros: one line.
    - Cons: no way to get one back from Orkestrator.
- **What does choosing an archived row do?**
  - **Restore it, then resume it (recommended).**
    - Pros: one click for the obvious intent; a refused restore does not resume.
    - Cons: choosing a row changes its archived state, though that is what continuing it requires anyway.
  - **Require an explicit restore first.**
    - Pros: no implied state change.
    - Cons: two steps, and a row that looks clickable but cannot be resumed.

### 5. Claude history decisions

**Problem.** Claude offers fork and file rewind but not message-level rewind, and resumed sessions used to lose subagent detail.

**Context.** Fork is `sdk.forkSession`. The bridge keeps one warm CLI per session (`bridges/claude-bridge/AGENTS.md`, "One CLI per session").

**Investigation.** Rehydration shipped in #1337, eagerly and bounded, not lazily as first recommended. Its cost was measured on 2026-10-31 with the real SDK reader and synthetic transcripts: 8 subagents of 200 KB took 14 ms, 64 of 200 KB took 60 ms, and the largest the bound allows that was tried, 64 of 2 MB, took 91 ms. That excludes turning records into parts, which is capped per call. It runs once per session per bridge process (`persistedMessagesLoaded`), not per tab read, so a lazy path would save little.

Message rewind was probed against the real 2.1.314 CLI and a loopback endpoint, three turns in a temporary home:

- Booting with `resumeSessionAt` and no prompt writes nothing; every reader still shows all three turns. So decision 6 is right that a rewind must be staged until the next prompt.
- `resumeDropsTurn` naming a turn when the range holds more is refused with `Resume rejected by --resume-drops-turn:`, with no model call and no change to the transcript. The SDK surfaces it as a thrown error.
- A plain truncating resume keeps the same session id, and afterwards `getSessionMessages` shows only the kept turn and the new one. There is no id change for the backend to follow.

That removes two of the risks, but the staged state is still needed in every reader and has to survive a bridge restart.

**Decisions.**

- **Offer Claude message rewind?**
  - **Stay with fork at a message (recommended).**
    - Pros: no new state beside the one-CLI invariant, where the recent Claude bridge bugs have been; fork already gives the same result without changing the conversation.
    - Cons: Claude alone lacks in-place rewind among Codex, Cursor and Pi; forks accumulate in the resume list.
  - **Truncating resume with a persisted staged marker.**
    - Pros: parity; the probe shows a stable id and a safe refusal, and OpenCode's revert (0175) is a precedent.
    - Cons: retires the warm CLI on rewind; every reader (`getSessionMessages`, transcript v2, resume list, fork) must honour the marker across restarts; a new refusal path; its own branch.
  - **Fork at the message and move the tab onto the fork.**
    - Pros: no staged state, and the transcript is right immediately.
    - Cons: the provider session id changes under the tab, the abandoned session stays in the list, and running background work needs an answer.
- **Rehydrate subagent detail on resume?**
  - **Eagerly, bounded, once per session per process (recommended).**
    - Pros: shipped; measured at under 100 ms at the bound; the row's parts match the live stream.
    - Cons: a session with more than 64 subagents shows the rest as calls only.
  - **Lazily through transcript v2 detail reads.**
    - Pros: no read until a card is expanded.
    - Cons: a locator per card and a second path to the same parts, to save about 100 ms.

### 6. Fork and rewind live qualification

**Problem.** Fork, rewind and branch navigation are unproven on the real stack for Codex, Pi and Cursor.

**Context.** Belongs with the batched runs in 0031. Needs billed turns.

**Investigation.** Unchanged. Offline coverage is listed under Qualification below. Not run on 2026-10-31.

**Decisions.**

- **How to run it?**
  - **Isolated `dev:test` profile with `--fixture`, one pass per provider, then reload and compare the next provider transcript read (recommended).**
    - Pros: matches the agent-testing procedure; reload proves rehydration.
    - Cons: needs live logins for three providers.
  - **Add a permanent browser spec with fake bridges first.**
    - Pros: regression guard.
    - Cons: does not prove the vendor agrees, which is the point of the run.

### 7. Title live qualification

**Problem.** The backend title path is not proven for generation, fallback and failed push on a real login.

**Context.** Was blocked on task 1, which is done.

**Investigation.** The offline half is done. `native-agent-session-titles.test.ts` runs the fallback and failed-push checks for all six platforms, and the real CLIs generate titles and fail correctly against loopback endpoints (`session-title-codex-live.test.ts`, `session-title-claude-live.test.ts`). A signed-in run across the platforms, and real title cost and latency, remain.

**Decisions.**

- **How to finish it?**
  - **Batch the signed-in run with task 6 and 0031 (recommended).**
    - Pros: one signed-in session covers several checks.
    - Cons: real-login evidence comes later than the code.
  - **Run it on its own now.**
    - Pros: earlier evidence.
    - Cons: a second billed session for a few cents of titles.

## Current state

- Protocol (`packages/protocol/src/native-agent.ts`): `actions.rewindMessages`,
  `actions.branches` and `actions.archive` (Codex and Cursor), the
  `rewind-messages` and `switch-branch` session actions, and `parentId`,
  `branchLabel` and `archived` on resume entries.
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
    `nextCursor` and keeps tool failures in replay. Agents the SDK reports
    `archived` are listed only on request.
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
  `set_native_agent_resumable_session_archived`, which reaches the bridge's
  `POST /session/list/:id/archive` / `unarchive`: `thread/archive` /
  `thread/unarchive` on Codex, `Agent.archive` / `Agent.unarchive` on Cursor.
  The live list leaves archived conversations out. **Show archived** lists them
  below the live rows; choosing one restores it and resumes it. Nothing calls
  `thread/delete` or `Agent.delete`.
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
  - The **Session titles** setting (`sessionTitleGeneration`) says which logins
    may write a title: any signed-in one (default), the session's own, or none.
  - The Codex run gets no tools and no skill list, and a `$skill` in the first
    message is escaped so Codex does not load it. Its global `AGENTS.md` still
    reaches the title model; Codex has no switch for it.
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

Only one decision is left. Tasks 1 to 4 are done.

1. **Claude message rewind**: not built. Task 5 has the options and the probe
   results. It needs the user's decision, and its own branch if the answer is
   to build it.

### Qualification

Tasks 6 and 7 need signed-in runs. Pinned-provider and browser qualification is
recorded below; authenticated end-to-end product QA is listed separately.

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

## Qualification (2026-10-31, at the new pins)

All of this ran offline, with temporary homes and loopback endpoints: no billed
turn, no real login. The Codex and Claude binaries were downloaded to a
temporary directory and matched the manifest's archive and executable SHA-256,
then passed through `CODEX_PROTOCOL_BINARY` and
`ORKESTRATOR_POLICY_CLAUDE_PATH`. The real toolchain directory has neither
version on this machine, so without those variables the live tests skip.

- `session-title-codex-live.test.ts` (new) runs the production runner on real
  Codex 0.166.0 in a home seeded with skills and a `config.toml`. It asserts no
  tools, no skill text, no config text, and nothing left to resume, and that a
  refused request rejects. With the fix removed its first case fails.
- `session-title-claude-live.test.ts` runs real Claude 2.1.314 and now also
  covers an unusable proxy, missing credentials and a refused request: each
  rejects with no title.
- `archive-sdk.test.ts` round-trips archive and restore through the real
  `@cursor/sdk` 1.2.0 and its disk store.
- `app-server/live-resume-context.test.ts` passes on real Codex 0.166.0 with
  `RUN_LIVE_CODEX_APP_SERVER=1`.
- `e2e/NativeResumeSession.spec.ts` checks the archived toggle, ordering, width
  and restore-then-resume in Chromium at phone and desktop sizes.

### Remaining authenticated product QA

The checks above qualify actual pinned binaries and SDK filesystem contracts
without external model calls. They do not claim a real-account browser run
across all six platforms, Cursor's own archive UI, resuming a restored agent on
a real Cursor login, a newly spawned Claude subagent across a full app restart,
or production title cost/latency. Those
remain in [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Assumptions and decisions

### 2026-10-27 (#1337)

Decision 8 is superseded by the 2026-10-31 entry below, and the "no in-app way"
cost in decision 5 no longer applies.

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

### 2026-10-31 (tasks 1, 3, 4 and 5)

#### Task 1: close the Codex title leak with flags and an escape

Added `--disable view_image`, `skills.include_instructions=false`,
`tools.experimental_request_user_input.enabled=false` and the three
`include_*` switches, and JSON-escaped `$` in the prompt as `\u0024`. The escape
is there because no flag stops `$skill` loading a skill; the model still reads
the same string. `skills.bundled.enabled=false` was tried and left out: the
instruction switch already removes the leak, so it would add a flag for nothing.

#### Task 1: a setting, default unchanged

Added `sessionTitleGeneration` (`any-signed-in`, `own-platform`, `off`) to
Settings, with the disclosure beside it. The default stays `any-signed-in`, as
the file recommended, so existing users keep the titles they have. It is read
per generation. It travels from a command node to its leaves, because the
choice is a preference about where a message may go, not a fact about one
machine. A policy that cannot be read counts as `off`, so an unknown choice
sends nothing.

#### Task 1: `claude -p` needs no code change

Added regression tests instead, against fake and real CLIs. See the task's
Investigation.

#### Tasks 3 and 4: decision 8 superseded

Decision 8's premise (only cloud agents can be unarchived) does not hold at SDK
1.2.0, so the recommended options apply. Cursor now has the shared action, and
both platforms get the toggle. Decision 5's cost, no in-app way back once the
toast is gone, is gone with it. The picker always asks for archived rows on a
platform that can archive: the bridges read them anyway, so the toggle needs no
refetch. Archive still refuses an agent a tab here holds. A `bc-` cloud id is
refused too, because this bridge lists only local agents and the SDK would send
that id to the Cursor API.

#### Task 5: rehydration stays eager

Chose to keep what shipped over the file's lazy recommendation, on the
measurement in the task's Investigation.

#### Task 5: message rewind left for the user

Not built on this branch. Decision 6's premise was confirmed by probe, and the
work is a new state machine that would make this branch too large to review.

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
