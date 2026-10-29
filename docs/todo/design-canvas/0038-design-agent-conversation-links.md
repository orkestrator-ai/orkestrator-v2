# Design agent conversation links

Checked against `main` at `2459b05c` (2026-10-15). Code items done on
2026-10-24 against `main` at `8454d18b8`; the two-client Resume run and the
bridge-restart close done on 2026-10-25 against `main` at `00a0cb82e`; see
[`design-canvas.md` → Agent context](../../architecture/design-canvas.md#agent-context)
for how links, link states and Resume now work.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Archived link state**: show "archived" for a link whose conversation the provider has archived. Status: blocked (on native archive semantics, 0006 item 3).
2. **Live close after the bridge lost the session**: an optional live check of decision 11's fallback, the identity kept on the mapping. Status: partly done (a bridge restart before close is exercised live; the lost-session branch is deterministic only).
3. **Stale 0082 cross-reference**: the "Codex rerun is owed there" note under Live spec run. Status: done (0082 reran both Codex design specs on 2026-10-26).

### 1. Archived link state

**Problem.** The Ask agent dialog has no "archived" state. If a provider archives a design conversation, the link can still read "can be resumed", and the result of pressing Resume is unknown.

**Context.** This is what is left of code item 3. 0006 owns archive semantics. Its item 3 (Codex `thread/archive` / `unarchive`) already names this file as waiting on it, and its task analysis recommends a shared archive/unarchive session action with a capability bit, Codex and Cursor first. Design conversations are Claude or Codex only (`DESIGN_AGENTS`, used at `apps/web/src/components/design/DesignWorkspaceDialog.tsx:214`).

**Investigation.** Still blocked:
- Nothing calls `thread/archive`. The pinned protocol has it (`bridges/codex-bridge/src/app-server/generated/typescript/v2/ThreadArchiveParams.ts`), and the reducer ignores `thread/archived` and `thread/unarchived` (`IGNORED_METHODS`, `bridges/codex-bridge/src/app-server/event-reducer.ts:99`, entries at `:160-161`).
- The pinned Claude Agent SDK (0.3.309) has no session archive concept. So of the two design agents, only Codex could ever report "archived". Cursor's `SDKAgentInfo.archived` does not matter here, because Cursor cannot be a design agent.
- Link states come from `sessionLinkStates` (`apps/backend/src/core/design/session-links.ts:96`) and are mapped in the client at `apps/web/src/components/design/design-session-links.ts:34-74`. Adding a state means a new kind there plus a backend read.
- A Codex thread archived outside Orkestrator (in the Codex CLI) would most likely fail `thread/resume` and surface through the existing "a conversation the agent no longer has" error, which is safe. This was not verified.

**Decisions.**

- **How to proceed while 0006 is open?**
  - **Keep this item blocked here, and add the archived state in the same change that lands 0006 item 3 (recommended).**
    - Pros: one owner per behaviour; the state is designed against the real archive action, not a guess; the file stays Low and small.
    - Cons: the file cannot be marked Finished until 0006 moves, which may be never if archive is deprioritised.
  - **Retire the item now: record in `design-canvas.md` that an archived conversation surfaces as a resume error, and delete this file.**
    - Pros: the file closes; 0006 item 3's context already records the dependency, so the requirement is not lost.
    - Cons: depends on the unverified assumption that resuming an archived Codex thread fails cleanly; a future archive action could make "can be resumed" wrong with no open item to catch it.
- **When archive lands, should an archived link offer Resume (with unarchive) or only Remove?**
  - **Offer "Unarchive and resume" as the default action, with Remove beside it (recommended).**
    - Pros: matches the dialog's "the way back is not lost" goal (decision 1); archive is reversible.
    - Cons: one more action and state to test, and a write to provider state from a design dialog.
  - **Show "archived" with Remove only.**
    - Pros: simplest; never changes provider state.
    - Cons: the user has to leave Orkestrator to unarchive the thread, which defeats the link.

### 2. Live close after the bridge lost the session

**Problem.** Decision 11 makes teardown fall back to the resume identity kept on the mapping when the live read fails. That fallback is proved only by deterministic tests.

**Context.** The file calls the live check optional: run a Codex turn in a design tab, restart the profile's Codex bridge, close the tab, and confirm the link reads "can be resumed".

**Investigation.** `e2e/agent-testing/design-resume-clients-live.spec.ts:219-233` already restarts the Codex bridge before close (`stop_local_codex_server_cmd`, then `start_local_codex_server_cmd`, asserting a new PID) and then closes and resumes. That spec passed on 2026-10-25 (Concurrency review follow-up) and again on 2026-10-26 under 0082. But the comment at `:219-221` notes that current bridges restore registrations from disk, so the live read probably succeeds after the restart and the fallback branch is not reached. The fallback is wired at `apps/backend/src/core/commands-registry-teardown.ts:666` (`resumableSessionIdIfRunning`) and `:680` (`recordDesignLinkSession`), and the identity store is `StorageService.recordNativeAgentSessionResumeIdentity` (`apps/backend/src/core/storage-native.ts:850`), fed by `apps/backend/src/core/native-agent-resume-identity.ts:36`.

**Decisions.**

- **Keep, strengthen or retire the optional live check?**
  - **Retire it as covered (recommended).** The restart path is live-proved, and the lost-session branch is pinned by `commands-registry-teardown.test.ts` ("a Codex session the bridge lost…") and the projection test that fails without the capture.
    - Pros: no extra live spend; the branch cannot be reached live without a fault hook anyway.
    - Cons: the storage write from the read path under the session lease has never run against a real bridge that lost a session.
  - **Strengthen the live spec: delete the bridge's persisted registration between stop and start, so the restarted bridge really has lost the session.**
    - Pros: exercises decision 11 end to end.
    - Cons: needs knowledge of the Codex bridge's state file inside a spec; brittle across bridge versions; adds a test-only fault path to a live spec.

### 3. Stale 0082 cross-reference

**Problem.** "Live spec run" says a Codex rerun is owed in 0082. It is not.

**Context.** 0082 fixed the resumed `<environment_context>` reader on 2026-10-26.

**Investigation.** Todo 0082 (retired on 2026-10-29; see the Codex bridge's [`AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md#when-touching-the-app-server-engine)) item 3 recorded both design specs rerun on 2026-10-26 with pinned Codex 0.164.0, with the exclusion dropped: two clients with 1 user row live and 1 resumed, and the full cycle with 3 live and 3 resumed, 13 design MCP calls and 0 failed.

**Decisions.**

- **How to record it?**
  - **Strike the "a Codex rerun is owed there" clause and link 0082 item 3 (recommended).**
    - Pros: the file stops implying open work.
    - Cons: none beyond a one-line edit.
  - **Leave it until the file is retired.**
    - Pros: no edit now.
    - Cons: misleads anyone triaging the folder.

A design canvas remembers the conversations that worked on it, and **Ask
agent** and **Use as implementation reference** put revisioned design context
into a conversation's draft. Links used to point at pane tabs only, so closing
the agent tab lost the way back even though native sessions can be resumed,
and design context became plain text in a brand-new conversation. Both are
fixed; only the archived state, blocked on native archive semantics, remains
(see [Remaining work](#remaining-work)).

## Current state

- `DesignSessionLink` (`packages/protocol/src/design-operations.ts`) keeps
  `tabId` (the tab the conversation was last opened in) and `sessionId` (the
  identity a resume names), plus platform, role, creation time and an optional
  checkpoint. Still at most `DESIGN_LIMITS.sessionLinksPerCanvas` (8).
- Link logic: `apps/backend/src/core/design/session-links.ts` (link, unlink,
  `sessionLinkStates`, `resumeSessionLink`, `recordTabSession`), commands
  `design_session_link_states` and `design_session_resume`
  (`apps/backend/src/core/design/commands.ts`), the teardown hook
  `recordDesignLinkSession` (`apps/backend/src/core/commands-registry-teardown.ts`)
  and `NativeAgentService.resumableSessionIdIfRunning`.
- Client: `apps/web/src/components/design/design-session-links.ts` (status,
  resume tab id, `resumeDesignLink`) and `DesignAgentDialog.tsx`.
- The unassigned (new-tab) composer shows annotations as removable chips and
  sends them with the first prompt
  (`UnassignedNativeAgentComposer`, `apps/web/src/components/native-agent/AgentNativeTab.helpers.tsx`);
  `planDesignDraft` no longer has an `inlineText` path.

## Outstanding work

### Code

1. ~~**Persist the native session identity.**~~ Done. Tab teardown records the
   resumable identity on every link naming the closing tab as it retires the
   tab's native-session mapping: Codex's thread id, read from the session
   before it is closed through an observe-only state read, and Claude's
   session id. The link is written after the teardown lock is released. An
   identity that cannot be read is not recorded. While the tab is open the tab
   id still resolves the mapping. Resume validates environment
   ownership and session existence through the ordinary native resume
   (`resumeProjectionSession`). Evidence: `session-links.test.ts` ("a closing
   tab's session is recorded once, only on its own environment's links"),
   `commands-registry-teardown.test.ts` ("records the closing session on a
   design link as the tab mapping is retired", "records a Codex thread, read
   before the close, and never guesses one", "a design link that cannot be
   updated never holds up the close"), `native-agent-service-close.test.ts`
   ("reads the identity a later resume needs, and never guesses one"), and the
   live runs below.
2. ~~**Offer Resume conversation.**~~ Done. A closed link that can be resumed
   shows **Resume conversation** and is the default destination ahead of a new
   conversation ("Resume and add to composer"). `design_session_resume` resumes
   the session for a derived tab id and moves the link only on success; the tab
   opens with `resumeSessionId`, `requireExistingResumeSession` and no initial
   prompt. Evidence: `DesignAgentDialog.test.tsx` ("offers Resume for a closed
   conversation the backend retains, without resending anything", "resumes and
   adds the design context as a chip …", "a conversation the agent no longer
   has is reported, and nothing opens"), `design-session-links.test.ts`, and the
   live runs below.
3. ~~**Report link state from authoritative projections.**~~ Done.
   `design_session_link_states` reads each link's tab mapping from backend
   storage (no bridge, no liveness route) once per dialog open and on
   **Retry**. States: open, can be resumed, no conversation to resume, could not
   check (failure or no answer within 8 s), closed (older backend or agent
   without resume). Archived is not modelled: native agents have no archive
   state yet ([0006](../agent-engines/0006-session-titles-and-history.md)).
   Evidence: `design-session-links.test.ts` (`designLinkStatus`),
   `DesignAgentDialog.test.tsx` ("a conversation that never started offers
   removal, not Resume", "a disconnected backend shows Retry …", "a backend
   that never answers the check offers Retry …"),
   `commands-registry-design.test.ts`, and the live runs below.
4. ~~**Drop the inline-text path.**~~ Done. The shared unassigned composer now
   renders and sends annotations, and `planDesignDraft` always adds a `design`
   annotation. Evidence: `AgentNativeTab.test.tsx` ("shows a draft's
   annotations as removable chips and sends them with the first prompt",
   "removes a draft's annotations from the unassigned composer"),
   `design-agent-context.test.ts`, `DesignAgentDialog.test.tsx`, and a live
   Codex run where the new tab showed a removable **Design context** chip and
   the agent received it as a structured reference.
5. ~~**Test concurrent Resume.**~~ Done. Backend: two concurrent
   `resumeSessionLink` calls resume the provider once, move the link once and
   return the same link and live session (`session-links.test.ts`), also
   through the command registry with a real `StorageService`
   (`commands-registry-design.test.ts`). Client: two simulated clients resuming
   at once converge on one tab id and one association and dispatch nothing,
   and two clicks in one client share one attempt (`design-session-links.test.ts`).

### Qualification

- ~~Create a design conversation, close its tab, reopen the canvas and resume:
  same session, no duplicate initial prompt.~~ Done live on mbp3, 2026-10-24,
  disposable profile `todo0038-links` (fixture environment, host logins):
  - Claude, staged launch (opening prompt): after close and reload the link
    read "can be resumed"; Resume opened `design-resume-…` mapped to the same
    provider session (`session-client-7aaec8e1…`), the Claude transcript still
    held exactly one user prompt, and no turn ran. (This run used the first
    build, where the tab adopted the recorded id; the final backend resume path
    is covered for Claude by the live spec run below.)
  - Codex, Ask agent → new conversation, on the final resume path: the link
    recorded the thread id (`01a16b4d-…`) at close; "Resume and add to composer" reopened the thread in
    a new tab with the context as an unsent chip; the rollout held one task.
  - The opt-in live spec `e2e/agent-testing/design-live.spec.ts` now ends with
    this close-and-resume step for each provider (result recorded under
    [Live spec run](#live-spec-run)).
- ~~A missing or detached session and a disconnected backend each lead to the
  right recovery, never a silent replacement session.~~ Done live, same
  profile:
  - Provider lost the session (Claude transcript file moved away): the resumed
    tab showed "Native agent provider session was not found" with Retry and
    created no mapping and no new transcript; after restoring the file, Retry
    recovered the same session. The final design moves this check into
    `design_session_resume`, so a lost session is now an error in the dialog
    (unit- and dialog-tested; the first Codex attempt, before that change,
    failed the same visible way).
  - A link whose tab closed before links kept sessions reads "no conversation
    to resume" and offers removal or a new conversation.
  - Backend paused (`SIGSTOP` on the profile backend): the dialog showed
    "could not check the backend" with Retry instead of "Checking…" forever;
    after `SIGCONT` the late answer replaced it. No tab was opened.
- The live Claude and Codex design-tool cycle is tracked in
  [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md).

### Live spec run

`e2e/agent-testing/design-live.spec.ts` with the new step 5, on mbp3,
2026-10-24, disposable profile `qa-design-live-0038` (`--credential-source
claude --credential-source codex`): Claude passed the full cycle including
close and resume (4.8 min run); Codex passed it on the rerun (136 s). Two
problems the spec found were fixed before those passes:

- After the handoff step the handoff tab is focused, so the canvas toolbar
  was hidden after the reload; the step now activates the canvas tab first.
- A resumed Codex transcript shows Codex's synthetic `<environment_context>`
  as a user message the live tab never showed (3 user messages live, 4 after
  resume, with one turn per prompt in the rollout: nothing was sent). Filed as
  todo 0082; the step excluded that block until 0082 fixed the reader on
  2026-10-26, and now counts every user message (a Codex rerun is owed there).

Every earlier step (launch, stale Ask agent, approval, handoff) also passed
for both providers, so the handoff's design context now arriving as a chip in
the unassigned composer did not regress it.

### Concurrency review follow-up (2026-10-25)

Identity captures now complete before a successful state/projection read
returns. Full and progressive snapshot reads and their captures share a bounded
per-session lane; supplementary metadata never delays the capture. Teardown
reads the mapping after queued session mutations, and storage normalizes the
identity before comparison and persistence. Controlled regressions cover a
capture held behind a mutation lease during teardown, a full projection delayed
behind metadata after a newer progressive thread, ordered in-flight reads, and
missing snapshots carrying an unverified identity. Repeated padded identities
are verified to leave the record unchanged.

The live companion spec now requires overlapping request intervals and verifies
a new Codex bridge process before close/resume. On disposable fixture profile
`qa-design-resume-races`, both providers passed (78.7 seconds, two passed, zero
skipped), using `claude-haiku-4-5` and the account's `gpt-6.1-sol`. Claude requests
started together and finished at +36/+37 ms; Codex requests started at +0/+1 ms
and finished at +2259/+2260 ms. Both clients converged on one tab and session,
with unchanged user turns and no prompt sent. Current Codex bridges can restore
registrations across a restart; the deterministic tests separately cover a
bridge that has lost the live session. The profile was stopped and reset.

Focused identity/teardown and progressive/lifecycle suites, formatting, lint and
typechecking passed. The repository suite reached the outer 30-minute watchdog
after a 876.2 s workspace capacity wait and is incomplete. Five unrelated test
cases failed in four files; every complete unchanged owner passed alone. They
are recorded in flake cases 0259 (disk report), backend/tooling 0692 (CLI shared
deadline), 0931 (Multi Review state wait) and 0932 (MCP lock setup). No passing
full-suite result is claimed.

## Remaining work

What was left of items 1, 3 and 5, narrowed; nothing here is new scope.

1. ~~**Two real clients pressing Resume at the same moment** (the live half of
   item 5).~~ Done live on arktech-mini, 2026-10-25, disposable profile
   `qa-design-resume-0038` (`--fixture --credential-source claude
   --credential-source codex`), with the new opt-in spec
   `e2e/agent-testing/design-resume-clients-live.spec.ts`. Each provider
   launched a design workspace with a one-word brief, the conversation's tab
   was closed (the link recorded its session), and two separately signed-in
   browser contexts opened Ask agent on the canvas and pressed **Resume
   conversation** together:
   - Claude: both `design_session_resume` requests were sent at +0 ms and
     answered at +33 ms and +34 ms, with the same `design-resume-…` tab and the
     same live session. The shared layout held exactly that one agent tab, the
     link named it, and the transcript kept its one user turn (nothing sent).
   - Codex (`ORKESTRATOR_AGENT_TEST_DESIGN_MODELS=codex=gpt-6-sol`; the
     profile default `gpt-5.4` is not offered to this ChatGPT login): both sent
     at +0 ms, both answered at +1656 ms with the same tab and the same live
     bridge session. A second Codex resume would have opened a second bridge
     session with a different id, so this also shows the provider was resumed
     once. Layout, link and transcript checks as for Claude.
2. ~~**A close replayed after a bridge restart** (an edge of item 1).~~ Done
   2026-10-25 (decision 11). Every native state read (the progressive state
   view and the full projection) now keeps the resume identity the provider
   reports for the open session on the tab's mapping
   (`PersistedNativeAgentSession.resumeIdentity`,
   `StorageService.recordNativeAgentSessionResumeIdentity`), written only when
   it changes and only for the provider session it was read from. Teardown
   prefers the live read, then that kept identity, then (not for Codex) the
   session id. The identity read before a close was already journaled on the
   teardown intent, so a close whose response is lost and is replayed after a
   restart records the same one. Evidence:
   `commands-registry-teardown.test.ts` ("a Codex session the bridge lost is
   named by the thread it reported while open"),
   `storage-native-agent-resume-identity.test.ts` (kept per mapped session,
   written only on change, seen by another process, never lands on a mapping
   that moved on, malformed or stale values read as absent), and
   `native-agent-service-projection-transcript.test.ts` ("keeps the thread an
   open session reports, for a close after the session is gone"; it fails
   with the capture removed). Deterministic only: no live run restarted a
   bridge between a turn and a close. That is not needed for the decision,
   and a live check is optional: run a Codex turn in a design tab, restart the
   profile's Codex bridge, close the tab and confirm the link reads "can be
   resumed".
3. **Archived state** (the part of item 3 with nothing to read yet). Still
   blocked on native archive semantics
   ([0006](../agent-engines/0006-session-titles-and-history.md)), checked
   2026-10-25: nothing calls Codex `thread/archive`, Cursor never reads
   `SDKAgentInfo.archived`, and no platform has an archive state for a link to
   report. Add an archived state to the dialog when that lands.
   Unblocked 2026-10-27 by 0006: Codex conversations can be archived from the
   resume list (`thread/archive`, capability `actions.archive`, backend
   command `set_native_agent_resumable_session_archived`), and Cursor's list
   hides agents the SDK reports `archived`. No platform reports a per-session
   archived flag a link could read yet; Codex's `thread/list` with
   `archived: true` is the source to read
   ([agent-engines.md](../../architecture/agent-engines.md#removing-a-conversation-from-the-resume-list)).

## Assumptions and decisions

Each decision lists the options considered, the choice, why, and its pros and
cons.

1. **Should a link survive tab closure?** (the former open question)
   - Options: (a) keep "closing a native tab ends its conversation" and drop
     items 1–3; (b) links survive and offer Resume.
   - Chosen: (b).
   - Why: closing a tab retains the conversation on every platform
     (`AGENTS.md` → Tab close and conversation retention); the old sentence in
     `design-canvas.md` was stale.
   - Pros: the way back to a design conversation is not lost. Cons: links can
     outlive what the user remembers; the 8-link cap and Remove link handle it.
2. **When to record the durable identity.**
   - Options: (a) a client watcher writes the tab's session id when it
     appears; (b) the backend backfills from the tab's native mapping when the
     dialog opens; (c) tab teardown records it just before retiring the
     mapping; (d) stop retiring the mapping on close.
   - Chosen: (c). (b) was built first and failed live: teardown retires the
     mapping, so a closed tab's lookup finds nothing. The identity is read
     inside the teardown lock (before the close) and written after it is
     released, because a resume holds its canvas lane while waiting for that
     lock.
   - Why: teardown is the one moment that always runs, on every client and
     replay, exactly when the tab id stops leading to the conversation.
   - Pros: works with no dialog or canvas open; no client involvement. Cons:
     design code hooks into teardown (best effort, never blocks the close); a
     close that lands after the bridge lost the session cannot read Codex's
     thread id, so teardown falls back to the identity kept on the mapping
     (decision 11).
3. **Which identity to record.**
   - Options: (a) the live provider session id; (b) the identity the
     provider's resume accepts.
   - Chosen: (b), read with an observe-only state read
     (`resumableSessionIdIfRunning`); Claude reports none and resumes by its
     session id; for Codex nothing is recorded when the thread id cannot be
     read.
   - Why: live testing showed Codex's bridge session id dies with the tab;
     only the thread id resumes.
   - Pros: correct for both providers; never guesses. Cons: one extra bridge
     state read during teardown.
4. **How Resume reopens the conversation.**
   - Options: (a) open a tab with `resumeSessionId` set to the recorded id and
     let it adopt; (b) the backend resumes through `resumeProjectionSession`
     for the new tab, moves the link only on success, and the tab adopts the
     returned live session.
   - Chosen: (b).
   - Why: (a) cannot resume Codex (adoption needs a live bridge session) and
     turns a lost session into a broken tab.
   - Pros: ownership and existence are checked by the ordinary native API; a
     lost conversation is an error in the dialog; no empty replacement. Cons:
     the resume runs inside the canvas lane, so other operations on that canvas
     wait for it (seconds).
5. **Concurrent Resume.**
   - Options: (a) random resume tab ids; (b) client-side locking only;
     (c) a tab id derived from the link plus a compare-and-set and the resume
     in the canvas lane.
   - Chosen: (c), plus a per-client in-flight share.
   - Why: (a) gives two tabs and two sessions; (b) cannot coordinate clients.
     Every client derives the same id from the same link state, as the
     one-shot environment launch already does.
   - Pros: one resume, one link, one tab id across clients. Cons: a client
     whose layout does not show the other's tab opens its own tab with the same
     id and logical session; that is the intended convergence, not a second
     session.
6. **Where link state comes from.**
   - Options: (a) the renderer's `nativeAgentProjectionStore`; (b) the resume
     list or discovery APIs; (c) a backend storage read of each link's tab
     mapping plus the identity on the link.
   - Chosen: (c).
   - Why: (a) only holds mounted or cached tabs; (b) contacts bridges and can
     start one, defeating idle detachment.
   - Pros: no bridge contact, cheap, authoritative. Cons: cannot say whether
     the provider still has a recorded session until Resume tries (which
     reports it).
7. **How often to check, and a hung backend.**
   - Options: poll; check once with no deadline; check once per dialog open
     and on Retry with an 8 s deadline.
   - Chosen: the last. A hung backend left "Checking…" forever in the live run.
   - Pros: no polling; the user always has an action. Cons: a slow backend
     shows "could not check" briefly before its late answer replaces it.
8. **Dropping `inlineText`.**
   - Options: wait for separate composer work; implement annotation support in
     the shared unassigned composer now.
   - Chosen: implement it now (shared, not design-specific: chips, Remove, and
     the same `buildPromptWithTranscriptAnnotations` the locked composer uses).
   - Pros: design context is a removable chip everywhere, and any annotation in
     a new tab's draft is sent. Cons: a first prompt's fallback title can show
     the fence; filed as
     [0081](../agent-engines/0081-annotation-fence-in-session-titles.md)
     (not new: the inline path produced the same title).
9. **Links closed before this change.** Options: guess a session from the
   provider's resume list; leave them as "no conversation to resume". Chosen:
   leave them; guessing could attach the wrong conversation. Pro: never wrong.
   Con: those links can only be removed.
10. **Older backends.** An "Unknown backend command" answer reads as
    `unsupported`: links show the old "Closed — conversation ended" and Remove
    link, so a new client on an old backend behaves as before.

11. **Covering a close that lands after the bridge lost the session**
    (Remaining work 2).
    - Options: (a) leave it: the link reads "no conversation to resume";
      (b) persist the resume identity on the native-session record when the
      session is created; (c) keep the identity the provider reports on every
      state read of the open session on the tab's mapping, and fall back to it
      at teardown; (d) have teardown start a bridge to read it.
    - Chosen: (c), scoped to the provider session it was read from and
      written only when it changes; teardown order is live read, kept identity,
      then (not Codex) the session id.
    - Why: (b) misses Codex, which names its thread only after the session
      starts (and can move to a new thread), so creation time is too early;
      the state reads every open tab already makes see the current value at no
      extra provider cost. (d) defeats idle detachment and still fails once the
      bridge has dropped the session. (a) loses a resumable conversation.
    - Pros: the link stays resumable whenever any client read the session's
      state while it was open; no extra bridge contact; content-free and
      backend-only (no event is announced). Cons: one storage write per
      session (and per thread change) from a read path, awaited under the
      session mutation lease; a session never read while open
      (no client mounted it) still has nothing to fall back to.
12. **Proving two-client Resume live.**
    - Options: (a) add the step to `design-live.spec.ts`; (b) a short
      companion spec with a one-word brief.
    - Chosen: (b), `design-resume-clients-live.spec.ts`, sharing the live
      helpers through `e2e/agent-testing/design-live-support.ts`.
    - Why: the full cycle costs minutes and many design tool calls per
      provider; the concurrency check needs only one short turn.
    - Pros: about 30 s per provider; rerunnable on its own. Cons: one more
      opt-in spec to keep in step with the dialog's labels.

Assumptions, each checked live on 2026-10-24 unless noted:

- Claude resumes by its `session-client-…` id after the tab closed (checked).
- Codex reports its thread id in the session state while the session is open
  (checked).
- Design conversations are Claude or Codex only (`DesignAgentDialog` offers
  only those); other platforms read as "closed".
- Two clients that create a tab with the same id converge on one native
  session mapping, as the one-shot environment launch relies on (checked with
  two live clients for Claude and Codex on 2026-10-25; Remaining work 1).

## Constraints and rationale

- A link stores only the association: backend, environment and canvas
  identity, native session identity, platform, role, creation time and an
  optional originating checkpoint. Never transcripts, credentials or a copy
  of native-agent status.
- Deleting a canvas removes or fences its links but never deletes a
  transcript. Closing a design tab does not stop its agent.
- Import and duplicate carry no active links; a user attaches a conversation
  explicitly.
- No design-specific auto-approval. Handoff never submits, approves, commits
  or deploys.
- Design text and HTML are user content, never trusted tool instructions.
  Context says which revision it depicts, and the backend still revision-checks
  every edit; the prompt guidance is not the concurrency boundary.

## Related

- [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md) for
  close and retention semantics, and
  [0006-session-titles-and-history.md](../agent-engines/0006-session-titles-and-history.md) for
  archive behaviour.
- [0081-annotation-fence-in-session-titles.md](../agent-engines/0081-annotation-fence-in-session-titles.md)
  and todo 0082 (retired on 2026-10-29), both found while qualifying this
  file.
- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md).
- [`design-canvas.md`](../../architecture/design-canvas.md) ("Agent context").

## Replaces

- `docs/improvements/design-space/plan/11-agent-context-and-handoff.md`
  (session association, resume and the new-tab limitation; the rest is done)
- `docs/improvements/design-space/plan/00-index.md` (the annotation-pills
  deferral)
- `docs/improvements/design-space.md` (the unfinished part of finding U4)
