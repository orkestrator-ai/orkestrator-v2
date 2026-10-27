# Review fan-out dispatch recovery

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

The file is Finished: both code items are done and merged, the open question
and the needs-verification item are answered, and the remaining provider work
lives in 0223.

1. **Retire the file**: the branch it was kept for has merged; delete it under
   the README rules. Status: open.
2. **Optional live restart observation** (Qualification): see the new
   `interruptedRequestId` on a real killed-Claude run. Status: deferred (the
   file says it is not needed).

### 1. Retire the file

**Problem.** The file is kept "only until this branch's Multi Review reads it,
then deleted". The branch has merged, so the file and its index row
(`0000-index.md:21`, Finished: Yes) are stale.

**Context.** README "Maintaining the folders": move durable behaviour into
`architecture/`, delete the file, remove its index row. Its split-out work is
[0223](0223-provider-non-delivery-proof.md), which is open and rated Medium.

**Investigation.** The fix landed as `71abfcfb` "fix(review): settle recovered
fan-out dispatches on proof and scope restart notices (todo 0112) (#1288)", an
ancestor of `863b5782`. Every reference still holds:
`ReviewFanoutRunner.commit(transition?)` at
`apps/backend/src/core/review-fanout.ts:762` (apply at `:768`, revert at
`:773`); `recoveredDispatchAcceptance` at `review-fanout.ts:1897`, called at
`:1278`, with the "lost in a provider restart" and "could not be confirmed"
errors at `:1285` and `:1291`; `readProviderStatus` and the `turnSettled:
false` reading at `apps/backend/src/core/agent-provider-contract.ts:256-272`;
`ProviderDispatchStatus = "dispatched" | "pending" | "unknown" | "lost"` at
`agent-provider-contract.ts:346`; Codex `DispatchJournal.requestIdForTurn` at
`bridges/codex-bridge/src/sessions/dispatch-journal.ts:478`, used at
`app-server-runtime-sessions.ts:1310`; Claude's `interruptedRequestId` across
`session-manager-turn-interruption.ts` and the prompt modules;
`REGRESSION_SEEDS` with fence-loss 861 and 1251 at
`apps/backend/src/core/review-fanout-interleaving.test.ts:31-34`. The durable
behaviour is already written up in
`docs/architecture/review-preparation.md:289` ("Dispatch recovery") and
`docs/architecture/agent-engines.md:1109` ("Restart continuation"). Inbound
links: 0027 (lines 560, 912) and 0223 (lines 6, 106), plus the code comment
`// 0112: …` in `review-fanout-interleaving.test.ts:33`.

**Decisions.**

- **What to do with the file now?**
  - **Delete it and its index row now; repoint the 0027 and 0223 links to
    `review-preparation.md#dispatch-recovery` (recommended).**
    - Pros: follows the README rule; the architecture docs already carry the
      behaviour; 0223 already restates the per-bridge survey it needs.
    - Cons: decisions 8 and 9 (why `pending`, why the dispatch-journal
      confirmation) are richer here than in `review-preparation.md`, so copy
      the gist first or lose it; the `// 0112:` test comment then names a
      deleted file (harmless, the number is never reused).
  - **Keep it until 0223 is finished, as background for that work.**
    - Pros: 0223's implementer has the full history in one place.
    - Cons: contradicts the README and the file's own "kept only until"
      line; 0223 already summarises what it needs.

### 2. Optional live restart observation

**Problem.** The `interruptedRequestId` field and the `pending` dispatch answer
are proven by deterministic tests and the real-bridge
`tests/multi-review-claude-bridge-restart.test.ts`, not by a live provider run.

**Context.** The Qualification section says no live run can force these
interleavings, and 0027's killed-Claude case would only show the field.

**Investigation.** The real-bridge test exercises the actual Claude bridge
process restart (8 of 8 passes recorded in decision 8), which covers the part a
live run could add except the model itself. Nothing in 0024 or 0027 lists it as
a required check.

**Decisions.**

- **Keep a live observation as a task?**
  - **No: drop it with the file (recommended).**
    - Pros: the field is additive and the real-bridge test already restarts
      the real bridge; a live run cannot force the race.
    - Cons: Codex's half (`requestIdForTurn`) has no real-bridge restart test,
      only `app-server-runtime-lifecycle.test.ts` and `dispatch-journal.test.ts`.
  - **Fold a check into 0027's killed-Claude live case.**
    - Pros: costs almost nothing when that run happens anyway.
    - Cons: adds an item to an existing file, which the README forbids; it
      would need a new file or a narrowing edit to 0027's existing case.

Found on 2026-10-25 by the seeded interleaving tests that
[0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md)
added (`apps/backend/src/core/review-fanout-interleaving.test.ts`). Checked
against `main` at `ba7cc8d4`. Both bugs affect standalone Multi Review and
Build Pipeline review stages, because both use `ReviewFanoutRunner`.

**Finished on 2026-10-26** against `main` at `93018933`. Every item is done;
the one part of item 1 no provider can support yet (re-sending a request the
provider proves never arrived) moved to
[0223-provider-non-delivery-proof.md](0223-provider-non-delivery-proof.md).
The durable behaviour is in
[review preparation, "Dispatch recovery"](../../architecture/review-preparation.md#dispatch-recovery)
and [agent engines, "Restart continuation"](../../architecture/agent-engines.md).
Kept only until this branch's Multi Review reads it, then deleted.

## Current state

What the file found, and what changed.

- **A `dispatching` record was treated as sent.** On recovery,
  `ReviewFanoutRunner` (`review-fanout.ts`, the
  `dispatchState === "dispatching"` branch) rewrote a durable `dispatching`
  reviewer to `sent` without asking the provider. The store can hold
  `dispatching` for a request that never reached the provider:
  - a peer's commit saves this reviewer's in-memory `dispatching` before its
    own commit and send, and the fence is then lost or the backend dies;
  - a send refused before the prompt was written resets to `prepared`, but
    that commit loses the fence;
  - the backend dies between the durable write and the send.

  The next owner then watched an idle session that was never prompted. A
  tool-transport reviewer got the result reminder ("your analysis is
  already done") as its first turn; a structured-output reviewer failed as
  idle without its report. Seeds: fence-loss 24 and 34, restart 13, 17 and 24.

  The review fixes of #1247 (merged after this file was written) already made
  the runner ask `dispatchStatus` and park on anything but `dispatched`. This
  change removes the first cause and settles more recovered requests on proof
  (item 1).
- **A takeover mid-continuation counted the old restart twice.** The new
  owner read the session's status before the in-flight restart continuation
  started, saw the previous turn's `interruption: "restart"` again, and failed
  the reviewer as restarted twice. Seeds: fence-loss 861 and 1251. The #1247
  gate hid it in the harness (status is read only once the continuation is
  journaled), but a real bridge journals a request before its turn starts, so
  the window stayed open (item 2).
- Both used to be `test.todo` cases in "runner bugs found by interleaving";
  #1247 turned them into tests, and they pass.

## Outstanding work

### Code

1. ~~**Reconcile a recovered `dispatching` request with the provider.**~~
   Done on 2026-10-26, narrowed: re-sending a request "the provider says
   never arrived" moved to [0223](0223-provider-non-delivery-proof.md),
   because no provider can say that soundly (decision 1).
   - **The peer-commit cause is gone.** `ReviewFanoutRunner.commit` takes a
     `transition` that is applied when the reviewer's own write reaches the
     front of the serialized queue and reverted if that write fails; the
     dispatch sets `dispatching` through it. Evidence: an A/B sweep of
     fence-loss and chaos seeds 1–1500 found 30 durable `dispatching` records
     that no send was ever attempted for on `main` (`93018933`; seeds 6, 24,
     40, 55, 148, …) and 0 with the change. The harness now fails any seed
     without a crash that leaves one behind
     (`review-fanout-interleaving-support.ts`, the end of `run`), which seeds
     6 and 24 of the CI list would catch.
   - **Proof before promotion.** `recoveredDispatchAcceptance` promotes a
     recovered request to `sent` on `dispatched`, or on a result for this exact
     request id (the tool-transport slot, or a structured result whose
     `requestId` matches). A report submitted before a provider restart is
     used instead of discarded.
   - **`lost` fails at once** ("lost in a provider restart and cannot be
     resent safely"): the provider refuses the id for good and a new id could
     run the turn twice, so waiting out the idle bound changed nothing.
   - **Documented fallback.** `unknown`, a failed read and a provider without
     `dispatchStatus` park within the idle-poll bound and fail closed ("dispatch
     acceptance could not be confirmed"). Nothing is re-sent, under a new id
     or the same one. Recorded in
     [review-preparation.md](../../architecture/review-preparation.md#dispatch-recovery).
   - Tests: `review-fanout-dispatch.test.ts` ("a lost request fails at once…",
     "a structured result for the exact request proves a … dispatch ran", "a
     submitted tool result proves a dispatch the provider retired", the
     parking cases); the regression case "a dispatch that never reached the
     provider is not treated as sent" in `review-fanout-interleaving.test.ts`.
2. ~~**Tie a restart interruption to the request it interrupted.**~~ Done on
   2026-10-26.
   - The Codex and Claude bridges name the interrupted request beside the
     notice (`interruptedRequestId`). Codex looks it up in its dispatch
     journal by the interrupted turn id (`DispatchJournal.requestIdForTurn`),
     so its persisted session record is unchanged. Claude sets it on a killed
     turn and on a released turn killed outside the prompt, and writes the
     turn's request id into the `turnInFlight` mark, so a later process
     restores it; older marks and bridges simply omit it.
   - `throwExplainedTurnFailure` parses it (bounded to 512 characters), and
     `readProviderStatus` reads a notice naming another request than the one
     watched, while the provider's dispatch journal reports the watched one
     accepted and unfinished (`pending`), as "this request's turn has not
     settled" (`idle`, `turnSettled: false`). Without that the notice is
     taken at face value (decisions 8 and 9). That fixes the fan-out, the Multi Review steps,
     Build Pipeline consolidation and the Build Pipeline stage supervisor (which
     had the same "interrupted again" failure) in one place.
   - The interleaving harness starts half of all continuation turns late,
     answering the first status read with the previous turn, and its restart
     notice names the interrupted request. With the comparison disabled, CI
     seeds fail in every flavour (plain 2, 14, 22; fence-loss 1, 5, 6, 24; …);
     with it, all pass. Seeds 861 and 1251 now run in the fence-loss suite's
     CI list too (`REGRESSION_SEEDS`).
   - Tests: `review-fanout-restart-continuation.test.ts` ("waits out the
     notice about the turn its continuation replaced", which fails without the
     fix, and "fails closed when the notice names the continuation itself"),
     "fails closed on a stale name once the bridge no longer holds the
     continuation"), `build-pipeline-restart-continuation.test.ts` ("pipeline
     stage handles stale-notice after restart", which also fails without the
     fix), the real-bridge `tests/multi-review-claude-bridge-restart.test.ts`,
     `http-bridge-provider.test.ts` ("a restart notice about an earlier request
     is not the watched request's outcome"), the Claude bridge's
     `session-manager-turn-interruption.test.ts` and `routes/session.test.ts`,
     and the Codex bridge's `app-server-runtime-lifecycle.test.ts` and
     `dispatch-journal.test.ts`.

### Qualification

- None beyond the deterministic tests: both are interleavings no live run can
  force on purpose. The bridge field is additive; a live restart run
  (0027's killed-Claude case) would show it but is not needed to trust it.

## Constraints and rationale

- The ten fan-out invariants in 0027 apply, above all at-most-once dispatch
  (never retry an ambiguous send under a new request id) and fail-closed
  recovery.
- A fix must keep `dispatching` → send as the only fallible step, and must
  not hold a storage lock across provider I/O. Both hold: the transition runs
  inside the existing commit, and the proof reads happen before any write.

## Assumptions and decisions

1. **Re-send a request the provider says never arrived, or park it.**
   Options: (a) re-send under the same id on `unknown`, relying on bridge
   deduplication; (b) add an `absent` answer and implement it on the bridges
   that can prove it; (c) park and fail closed, and file the provider work.
   Chosen: (c). Why: a survey of every bridge (summarised in 0223) found that
   none can tell "never arrived" from "delivered, then evicted, lost to a
   restart or never saved durably": Claude does not journal structured
   prompts durably at all, Pi and ACP evict unresolved entries, OpenCode has
   no durable journal, and Codex could answer only through a `thread/read`
   its read-only `/dispatch` route does not make. (a) would run turns twice;
   (b) needs per-bridge "journal complete" tracking with its own compatibility
   work, and a runner path with no producer would be dead code. Pros: no
   at-most-once risk, and the fallback is explicit. Cons: a reviewer whose
   send provably never happened still fails after the idle bound instead of
   running.
2. **Fix the peer-commit cause in the runner, not only by recovery.** Options:
   leave it to recovery (park, then fail), or stop peers writing it. Chosen:
   apply `dispatching` inside the reviewer's own serialized commit and revert
   it on failure. Why: it removes the most common unsent-dispatch cause (30 of
   the sweep's records) outright, with no provider involvement, and keeps the
   send the next fallible step. Pros: those reviewers now run normally.
   Cons: `commit` gains a small callback parameter.
3. **What counts as proof of delivery.** Options: the dispatch journal only,
   or also a result. Chosen: also a result for the exact request id (tool slot
   keyed by the request and written with that attempt's capability, or a
   structured result whose `requestId` matches). Why: only that request's turn
   can produce it, and Build Pipeline already treats a result as proof. Pros:
   a report submitted before a restart is kept. Cons: one extra result read
   per pass while a request is parked, bounded by the idle-poll bound.
4. **Fail `lost` at once or keep parking.** Chosen: fail at once, after the
   result check. Why: the provider will refuse that id forever, and invariant 3
   forbids a new one, so the bound only delayed a certain failure. Pros: a
   faster, clearer error. Cons: none found.
5. **Where to scope a restart notice.** Options: in each caller, or in
   `readProviderStatus`. Chosen: `readProviderStatus`, reading a notice about
   another request as `idle` with `turnSettled: false`. Why: every workflow
   caller already waits on `turnSettled === false`, and the Build Pipeline
   supervisor had the same bug. Pros: one rule for four callers. Cons: the
   wait is not counted against the idle bound; decisions 8 and 9 confine it
   to a request the provider reports in flight, so it lasts only until the
   bridge starts that turn.
6. **How Codex names the request.** Options: add it to the persisted restart
   notice, or look it up. Chosen: look it up in the dispatch journal by turn
   id. Why: the session record validator rejects unknown fields, so a new
   field would make an older bridge drop the whole session after a downgrade.
   Cons: once the journal drops the record (24 h, or past its caps) the notice
   names nothing and is taken at face value, as before.
7. **The other step runners.** The Multi Review steps and Build Pipeline
   consolidation keep their own parking (no `lost` fast-fail or result proof).
   Why: they have one writer per request, so the peer-commit cause cannot
   arise, and they get the restart scoping through `readProviderStatus`.

8. **Trust the name alone, or also ask the dispatch journal.** First
   implementation: the name alone. The real-bridge test
   `multi-review-claude-bridge-restart.test.ts` then failed 1 run in 5:
   Claude writes the turn-in-flight mark asynchronously after the turn
   starts, so a bridge killed before the continuation's rewrite lands
   restores the original request's name, and the continuation's second
   restart read as "not started yet", waiting forever. Options: make the mark
   write synchronous before the turn starts (latency on every Claude prompt),
   bound the wait with the idle-poll counter (still waits minutes, and the
   test's four passes would still fail), or require the provider to confirm it
   holds the watched request. Chosen: the confirmation (`dispatchStatus` is
   `dispatched`). Why: in the real late-start window the bridge has just
   journaled the request, so it always is; a restarted bridge never holds the
   request it lost (Claude answers `lost` or `unknown`), so a stale name falls
   back to the old reading and fails closed. Pros: no bridge timing change,
   and a stale name can only cost the fix, never a hang. Cons: one dispatch
   read, only when a notice names another request; providers without
   `dispatchStatus` keep the old behaviour. 8 of 8 runs of the real-bridge
   test passed afterwards.
9. **`dispatched` or `pending` as that confirmation** (Multi Review finding,
   2026-10-26). `dispatched` also covers a finished request, so a workflow
   still watching a finished request could read a *later* turn's restart
   notice as superseded and wait without a bound (a queued Build Pipeline
   message dispatched under a fresh id while the stage's
   `structuredRequestId` stays watched). Options: a new `pending` answer, or
   report the latest accepted request id and require it to match. Chosen:
   `pending`. The Claude and Codex `/dispatch` routes add `pending: true`
   beside `dispatched` for a request still in flight, `HttpBridgeProvider`
   maps it to `pending`, and every consumer that promotes on `dispatched`
   accepts `pending` too. Why: the flag is additive (an older backend reads
   it as `dispatched`, an older bridge never sends it and so never
   supersedes), and it answers exactly the question asked. Cons: a widened
   `ProviderDispatchStatus` union every consumer must handle; all five do.

## Multi Review outcome

The branch's Multi Review (2026-10-26) reported one finding and six test
coverage gaps; its automatic Fix stopped on a model-capacity error, so the
fixes were finished and checked by hand. All were accepted.

- **Finding (P2): a finished watched request could make a later restart
  notice look superseded.** Fixed with `pending` (decision 9). Tests:
  `workflow-dispatch-observation.test.ts` ("only a pending watched request
  supersedes a named restart", which fails under the old rule), the
  `http-bridge-provider.test.ts` restart-notice and dispatch-status cases, and
  the Claude and Codex `/dispatch` route tests.
- **Gaps, each now covered:** the commit transition reverted when its own save
  throws, then sent exactly once (`review-fanout-dispatch.test.ts`); a `lost`
  or `unknown` dispatch promoted by a matching structured result on the first
  poll; the released-turn kill naming its request and an owned mark renamed
  by a new turn (`session-manager-turn-interruption.test.ts`); and a provider
  without `dispatchStatus` keeping the notice at face value
  (`workflow-dispatch-observation.test.ts`).

## Open questions

- ~~Which bridges can answer "did request X arrive" today?~~ Answered on
  2026-10-26: all six answer `dispatched` from their own records, and Claude,
  Cursor, Pi and ACP also answer `lost`; none can answer "never arrived". The
  per-bridge detail and the work to change that are in
  [0223](0223-provider-non-delivery-proof.md).

## Needs verification

- ~~Whether the same `dispatching` recovery gap exists in Multi Review's step
  runner and Build Pipeline's `pendingPromptAttempt`.~~ Checked on
  2026-10-26. `MultiReviewService` (the `request.state === "dispatching"`
  branch) and Build Pipeline consolidation already ask `dispatchStatus` and
  park, as the fan-out did (#1247); each request has one writer, so the
  peer-commit cause does not arise. Build Pipeline's stage prompts are
  different: `pendingPromptAttempt` is redispatched under the same id
  whenever the stage is not running, trusting the bridge to deduplicate, which
  does not hold for a Claude structured prompt after a bridge restart. Filed
  as 0223 item 3.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md):
  the interleaving tests, invariants and error scopes.
- [0223-provider-non-delivery-proof.md](0223-provider-non-delivery-proof.md):
  the provider work split out of item 1, and the Build Pipeline redispatch gap.

## Replaces

- Nothing; new work found on 2026-10-25.
