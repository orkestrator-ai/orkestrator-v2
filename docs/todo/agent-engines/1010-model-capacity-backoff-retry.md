# Retry "Selected model is at capacity" with exponential backoff

## Task analysis

Analysed 2026-10-30 against `main` at `361dc0a6e`.

### Tasks

1. **Codex: continue a turn the model refused for capacity**: the bridge retries `serverOverloaded` and `policyCapacityUnavailable` with backoff and jitter, keeps the session `running`, and continues the same turn under the same request id. Status: done (2026-10-30; `policyCapacityUnavailable` added 2026-10-31).
2. **Codex: live evidence of a real refusal**: watch a real `serverOverloaded` turn retry and recover. Status: open; needs a real capacity refusal, which cannot be provoked without billed turns.
3. **Claude: unattended sessions and Claude Code's own 529 retry**: Multi Review, build and graph sessions run with a longer Claude Code overload backoff. Status: done (2026-10-31); a real overload has not been observed through it.
4. **Cursor: classify capacity refusals from `@cursor/sdk`**: the SDK bridge has no retry for transient provider errors. Status: open (needs evidence of the error shape; the 1.2.0 SDK reading in 1020 does not give it).
5. **Grok (ACP bridge): bring the existing retry in line**: the ACP retry uses the shared backoff with jitter and a per-wait cap, shows its wait, and ends at once on Stop. Status: done (2026-10-31); how a real Grok overload reaches the bridge is unobserved.
6. **OpenCode: unattended sessions skip turn recovery**: unattended turns ended by an overload are continued inside the provider, keeping their request and grant. Status: done (2026-10-31); a real overload has not been observed through it.
7. **Pi: rely on the SDK's own retry**: Pi's `auto_retry_start`/`auto_retry_end` already covers overloads. Status: done (no change needed).

### 1. Codex: continue a turn the model refused for capacity

**Problem.** Codex turns on busy models (GPT-6.1-Sol) end with "Selected model is at capacity. Please try a different model." An interactive turn stops part-way and someone has to type "Please continue"; an unattended turn fails its workflow. On 2026-10-29 two Multi Review fix sessions (04:30, and 07:35 on omarchy-hp) failed this way, opened no PR, and had to be rerun by hand with `address_multi_review`.

**Context.** app-server ends the turn with `turn/completed` `status: "failed"` and `error.codexErrorInfo: "serverOverloaded"`. That message is the `Display` text of `CodexErr::ServerOverloaded` (`codex-rs/protocol/src/error.rs`; the pinned 0.164.0 binary carries the same string). The pinned protocol's `CodexErrorInfo` (`bridges/codex-bridge/src/app-server/generated/typescript/v2/CodexErrorInfo.ts`) has a distinct `serverOverloaded` variant, separate from `usageLimitExceeded`, `rateLimitExceeded`, `flexUnavailable`, `unauthorized` and `badRequest`. `toTurnError` (`app-server/event-reducer.ts:71`) keeps it as `EngineError.code`.

**Investigation.**
- **What app-server already retries.** It retries stream disconnects and 5xx/transport errors itself (`stream_max_retries`, `request_max_retries`; it reports those as a standalone `error` notification with `willRetry: true`). It does not retry `ServerOverloaded`; the observed failures are exactly that turn ending. Codex's own Python SDK documents `retry_on_overload(...)` with exponential backoff and jitter as the caller's job.
- **No way to retry or resume a turn.** The pinned protocol has `turn/start`, `turn/steer` and `turn/interrupt`, and no turn retry or resume. `thread/resume` reattaches a thread and starts nothing. `turn/start` rejects an empty `input` ("input must not be empty" in the 0.164.0 binary), so continuing needs some input.
- **How the backend reads a failure.** It never sees the code. Every unattended workflow polls `readProviderStatus` and fails on the first read of `status: "error"` that is not a restart interruption:
  - Multi Review steps: `multi-review-service.ts:4311`, and reviewers through `agent-branch-runner.ts:704`;
  - build stages: `build-pipeline-service-supervisor.ts:690`.

  Only the message text crosses the bridge (`throwExplainedTurnFailure`, `http-bridge-transport.ts:282`). A brief `failed` → `running` flip would fail the step if any poll landed in the gap.
- **Result credit.** A workflow result is keyed by the dispatch request id (`workflowResults.prepare({ resultKey: requestId })`). The submit tool checks only that key. Structured output is matched by `session.structuredOutputRequestId === turn.requestId` (`app-server-runtime-lifecycle.ts`, `finalizeTurn`).
- **Other providers.** Covered in tasks 3–7.

**Decisions.** See [Assumptions and decisions](#assumptions-and-decisions) for each choice, its options, and the one taken.

### 2. Codex: live evidence of a real refusal

**Problem.** Every test drives a scripted app-server. Nobody has seen a real `serverOverloaded` refusal go through the retry.

**Context.** A capacity refusal cannot be provoked on demand, and the task forbids billed turns and real logins.

**Investigation.** The rollout fixture in `history/rollout-rows.test.ts` assumes the rollout records `task_complete.error.codex_error_info` as `server_overloaded`. That matches the existing refusal fixture's `codex_error_info: "other"`, but the exact spelling for this variant has not been observed. Replay relies only on the continuation marker, never on that field.

**Decisions.**
- **How to get the evidence?**
  - **Watch the next real refusal (recommended).** Find a `[Orkestrator automatic retry]` user message in a real rollout under `CODEX_HOME/sessions`, and the retry card in the tab.
    - Pros: free; the refusals recur often on GPT-6.1-Sol.
    - Cons: depends on timing.
  - **Point a throwaway `CODEX_HOME` at a fake Responses endpoint** that answers `server_is_overloaded` (a custom `model_providers` entry).
    - Pros: deterministic, and exercises the real binary's error mapping.
    - Cons: needs a fake Responses API server and a throwaway profile; more work than the payoff.

### 3. Claude: unattended sessions and Claude Code's own 529 retry

**Problem.** A Claude turn whose requests keep getting `529 overloaded_error` ends in an error once Claude Code stops retrying, and an unattended step then fails as the Codex ones did.

**Context.** Claude Code retries failed API requests itself (`CLAUDE_CODE_MAX_RETRIES`, default 10). Per its docs it can stop sooner on 529s: with an API key on an Opus model, at the third 529. The bridge already shows each retry as a settling `retry` card (`session-manager-prompt-handlers/system.ts:358`, `api_retry`). Before this task Orkestrator set none of Claude Code's retry variables. The Claude Agent SDK is pinned at 0.3.314 and the CLI at 2.1.314.

**Investigation.** A bridge-side continuation, as for Codex, would stack a second retry loop on top of Claude Code's own. The documented controls are:
- `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` (default 500, up to 32000);
- `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` (default 32000, up to 64000);
- `CLAUDE_CODE_RETRY_WATCHDOG=1`, which retries 429 and 529 indefinitely. It also waits out usage limits, which conflicts with "never retry usage limits".

Read from the 2.1.314 bundle, not run:
- Both overload variables are honoured only for `CV(error)`: a 529 or an `overloaded_error` body. A 429 uses neither.
- Bounds: base 500 to 32000, maximum 32000 to 64000. Waits add up to 25% jitter, and a retry-after up to 25% over the maximum is still honoured.
- At the third overload the CLI switches to a configured fallback model if there is one, and otherwise keeps retrying until `CLAUDE_CODE_MAX_RETRIES`. The bridge passes no `fallbackModel`. So the docs' "stops at the third 529" was not found in this path; a user's `fallbackModel` setting still applies.
- `CLAUDE_CODE_MAX_RETRIES` also governs 429s and is clamped to 15.
- Background query sources do not retry an overload at all.

**Decisions.**
- **What to change for unattended Claude sessions?**
  - **Raise the overload base and maximum delay for Multi Review and build sessions only (recommended).** Set both overload variables in the session's `env`.
    - Pros: covers 529 only; usage limits stay untouched; no second retry loop.
    - Cons: each variable needs a minimum Claude Code version (2.1.292 and 2.1.296), to be checked against the pinned CLI.
  - **`CLAUDE_CODE_RETRY_WATCHDOG=1`.**
    - Pros: waits through long outages.
    - Cons: also waits out usage limits for hours, which the requirements rule out.
  - **A bridge-side continuation like Codex's.**
    - Pros: one policy for every provider.
    - Cons: duplicates Claude Code's loop; a continuation turn costs a prompt round trip that the SDK's request-level retry avoids.

### 4. Cursor: classify capacity refusals from `@cursor/sdk`

**Problem.** The Cursor SDK bridge (`bridges/cursor-bridge`) has no retry for transient provider errors. The ACP bridge's `[resource_exhausted]` retry dates from when Cursor ran over ACP, and the ACP bridge is now Grok-only.

**Context.** `@cursor/sdk` 1.2.0. A failed run settles the session `error` (`agent-session.ts:1094-1097`).

**Investigation.** The SDK's error shape for a capacity refusal is not known from the code, and no fixture shows one. 1020's reading of 1.2.0 does not change that: the error classes are unchanged (`RateLimitError`, `NetworkError`, `isRetryable` on `CursorSdkError`), no overload or capacity code exists, and the SDK's own retries have usually run out by the time the bridge sees an error. `RateLimitError` must stay excluded, and `isRetryable` does not separate a capacity refusal from a rate limit, so there is still nothing safe to classify on.

**Decisions.**
- **How to proceed?**
  - **Record one real refusal first (recommended),** then classify on its structured field, as Codex does.
    - Pros: no guessing at text.
    - Cons: waits on a real refusal.
  - **Match `resource_exhausted` text, as the ACP bridge does.**
    - Pros: available now.
    - Cons: text matching on a shape nobody has seen.

### 5. Grok (ACP bridge): bring the existing retry in line

**Problem.** `acp-prompt.ts` retried `[resource_exhausted]`/`[unavailable]` three times with waits of 1, 2 and 4 s. It had no jitter and no per-wait cap, showed no wait in the transcript, and would have retried a `[resource_exhausted]` that named a usage limit.

**Context.** It already continues with a labelled continuation prompt (`RETRIABLE_PROVIDER_CONTINUATION`). That precedent is what task 1 follows.

**Investigation.**
- Moving it onto `capacityRetryDelayMs` needs the policy in `packages/protocol`, which counts as a wide-reaching change.
- The old wait could not be interrupted, which was harmless at 4 s and is not at 60 s: Stop would have left the turn `running` for up to a minute.
- `[resource_exhausted]` was Cursor's signal, from when Cursor ran over ACP. The Grok 1.0.70 binary instead carries "Grok is temporarily overloaded. Please try again in a moment. (HTTP …)" and "Model is temporarily overloaded. Try again in a moment.". How either reaches ACP is not known: the schema has no overload stop reason or code, and no fixture shows one.

**Decisions.**
- **Share the policy?**
  - **Move `sessions/capacity-retry.ts`'s delay and policy into `packages/protocol` and use them in both bridges (recommended).**
    - Pros: one backoff for every provider.
    - Cons: a protocol change runs the full suite; the env-var name `ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS` must keep working.
  - **Leave it.**
    - Pros: it works.
    - Cons: a burst of Grok sessions retries in lockstep.

### 6. OpenCode: unattended sessions skip turn recovery

**Problem.** `NativeAgentTurnRecovery` (`native-agent-turn-recovery.ts`) retries OpenCode provider errors with backoff: 5, 15 and 45 s (`OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS`). It skips 401/402/403/404/413. It skips build-pipeline and automated-review sessions entirely (`:160-165`), so those failed on an overload.

**Context.** The skip says unattended workflows own their own turn lifecycle.

**Investigation.**
- OpenCode 1.19.5 retries an overload itself: 5 attempts, waits of 2, 4, 8, 16 and 30 s plus up to 25%. Then the turn ends with an `APIError` on the assistant message and the session reads idle.
- Lifting the skip does not work as written. The recovery dispatches under its own request id (`opencode-incomplete-<id>`) with no workflow options. `workflowResults.begin` then moves the turn's owner to that id and denies the result tool, and `settleCompleted` answers `true` for any request that is no longer the owner. The workflow would read its request as settled with no result, on a turn that could no longer submit one.
- Between the refusal and the wait's end, `settleCompleted` would also already have answered `true`.
- `turnSettled: false` is what every workflow owner already waits on: Multi Review, reviewers, build stages, graph nodes and feature planning.

**Decisions.**
- **Lift the skip for overload only?**
  - **Lift it for overload statuses (429 with an overload body, 503, 529) and keep the workflow seeing `running` throughout (recommended).**
    - Pros: the same behaviour as Codex.
    - Cons: needs OpenCode's `turnSettled` to stay false during the wait. The sweep's continuation cannot do this (see Investigation), so it is built inside the provider instead; see Assumptions and decisions.
  - **Leave it.**
    - Pros: no change.
    - Cons: an OpenCode Multi Review step still fails on an overload.

### 7. Pi: rely on the SDK's own retry

**Problem.** Pi sessions face the same transient errors.

**Context.** The Pi SDK retries itself. The bridge renders `auto_retry_start` and `auto_retry_end` as a settling `retry` card (`bridges/pi-bridge/src/state.ts:132-146`, `translate.ts:99`).

**Investigation.** Nothing to add: a second loop would stack on the SDK's.

**Decisions.**
- **Change anything?**
  - **No (recommended).**
    - Pros: one retry loop per provider.
    - Cons: Pi's own limits apply.

## Assumptions and decisions

### Task 1: where the retry lives

- **Options.**
  - **Bridge only (chosen).**
    - Pros: the bridge alone knows the structured code; it can keep the session `running`, the journal record `accepted` and the result key unchanged, so every workflow (Multi Review, build stages, reviewers, graph steps) gets the retry with no change to its state machine.
    - Cons: one implementation per provider.
  - **Backend dispatcher.**
    - Pros: one place for every provider.
    - Cons: the backend gets only message text; there is no shared "dispatch and wait" helper to hook, so each workflow's state machine would change separately; and the step would already have read the failure.
  - **Both.**
    - Pros: none over the bridge alone.
    - Cons: two loops could stack.
- **Chosen:** bridge only, `bridges/codex-bridge/src/app-server-runtime-capacity-retry.ts`, driven from the `turn.completed` handler in `app-server-runtime-lifecycle.ts`.
- **Why:** it is the only place the retry is invisible to every poller. It is also how the ACP bridge already retries Grok's transient errors.
- **What the bridge keeps:** the turn stays one `TurnAccumulator` with its rows and request id; only `turnId` moves to the continuation's. Each turn has its own timer, and no lock is held while waiting.

### Task 1: how errors are classified

- **Options.**
  - **Structured code (chosen).**
    - Pros: exact; `codexErrorInfo` names `serverOverloaded` separately from usage limits, rate limits, flex capacity and login refusals.
    - Cons: a future build could drop the code.
  - **Message text.**
    - Pros: works without a code.
    - Cons: fragile; a substring match could catch a model's own text or another error.
- **Chosen:** `isModelCapacityError` (`sessions/capacity-retry.ts`) retries only `code === "serverOverloaded"`. The exact canonical message is accepted only when no code was sent at all, and never a substring. A 401/403 is refused even under the overload code.
- **Never retried:**
  - `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`: usage limits and quota.
  - `unauthorized` and 401/403 statuses: auth.
  - `badRequest`: invalid requests.
  - A stop the user asked for.
  - Any turn not started by prompt dispatch.
- **`flexUnavailable` is excluded deliberately:** the flex tier is a choice the user made, and Codex reports its own message for it.

### Task 1: how the retry continues the turn

- **Options.**
  - **A turn retry or resume method.**
    - Pros: no prompt sent.
    - Cons: app-server has none (see Investigation).
  - **Resend the user's prompt.**
    - Pros: none.
    - Cons: duplicates the request; repeats work already done.
  - **An internal, labelled continuation (chosen).**
- **Chosen:** `turn/start` on the same thread, the same turn configuration and output schema, and `clientUserMessageId` `<requestId>:capacity-retry:<n>`. A distinct id is needed because `reconcileFromThreadTurns` takes the first turn carrying an id, which would be the failed attempt.
- **Continuation text.** It opens with `[Orkestrator automatic retry] attempt n of N.`, says it was sent automatically, not by the user, and asks the model to continue without repeating completed work.
- **What the transcript shows.**
  - Live: no user row; a `retry` card instead.
  - On reload: replay turns the marked user message back into that card, in place of the refusal line (`history/rollout.ts`).
- **The request id.**
  - The journal record is re-accepted under the new turn id.
  - `/dispatch` answers `pending` until the last attempt ends.
  - A schema turn is credited under the original request id.
- **Ambiguous `turn/start` of a continuation.** It is reconciled by the continuation's own id:
  - attached: the turn is adopted;
  - absent: the turn fails with the refusal;
  - unknown: the thread goes to `recovering` with the ordinary backstop.

### Task 1: the defaults

- **Options.**
  - **5 attempts, waits doubling from 2 s.**
    - Pros: the suggested shape.
    - Cons: about 30 s in total, short for a capacity incident.
  - **5 attempts, waits tripling from 2 s, each capped at 60 s (chosen).**
- **Chosen:** `DEFAULT_CAPACITY_RETRY_POLICY` = 5 attempts in total (the prompt plus four continuations); nominal waits of 2, 6, 18 and 54 s; at most 60 s per wait.
- **Jitter:** "equal jitter", so each wait falls between half and all of its nominal length. At most 80 s in total.
- **Why:**
  - Long enough to ride out a short incident.
  - Far below Multi Review's 45-minute stall abandon (`multi-review-progress.ts:57`).
  - The jitter spreads sessions refused at the same moment.
- **Overrides:** the policy is a runtime option (`capacityRetry`, `capacityRetryRandom`) for tests and embedders, with no env-var surface.
- **What the user sees:**
  - while waiting: "Model at capacity, retrying in 8 s (attempt 2 of 5)";
  - once the continuation starts: "Model at capacity, retried automatically (attempt 2 of 5)";
  - after a Stop: "Model at capacity, automatic retry cancelled".
- **When retries run out:** the turn ends with the original error plus "Automatic retries exhausted after 5 attempts.", keeping the `serverOverloaded` code.

### Task 1: stop, close, restart and shutdown during a wait

- **Stop:** ends the wait and the turn ends interrupted. The bridge sends no `turn/interrupt`, because the refused app-server turn has already ended. A Stop while the continuation's `turn/start` is in flight interrupts the continuation once it is named.
- **Last-tab close:** ends the wait the same way.
- **Parent exit:** ends a waiting turn as a restart interruption, so a workflow continues it once.
- **Bridge shutdown:** fails a waiting turn with its refusal.
- **Bridge restart during a wait:** loses the wait. Startup recovery reconciles the request to the failed attempt and reports the refusal, as before this change.

### Task 1: `policyCapacityUnavailable`

- **Options.**
  - **Retry it like `serverOverloaded` (chosen).**
    - Pros: a 503 saying "Please try again later"; Codex's own source says it "follows the same retry advice as ordinary overloads" and retries it only when the server sends `Retry-After`, so a turn without that header failed unattended work.
    - Cons: if the restriction lasts, about 80 s is spent before the same failure.
  - **Fail at once, like `flexUnavailable`.**
    - Pros: no wait if the capacity never returns.
    - Cons: a transient refusal keeps failing unattended work, which is the problem this to-do exists for.
- **Why not like `flexUnavailable`:** flex is a tier the user chose, reported as a 429. This is a 503 with a retry-later message.
- **Evidence:** `codex-rs/protocol/src/error.rs` and `codex-api/src/api_bridge.rs` upstream, and 1020 task 7. No real refusal has been seen.
- **Transcript:** the cards keep the "Model at capacity" wording for both codes.

### Task 3: longer overload backoff for unattended Claude sessions

- **Chosen:** the recommended option. `withUnattendedOverloadRetry` (`runtime-env.ts`) sets base 4000 and maximum 64000 on the query environment.
- **Which sessions:** the session's own policy id `pipeline`, which the backend resolves for `build-pipeline` and `automated-review` origins and uses for graph nodes. No new wire field. It reads `session.executionPolicy`, not the turn's policy, because a read-only reviewer turn runs under a replacement policy with another id.
- **The values.**
  - **Base 4 s, maximum 64 s (chosen).** About 7.5 minutes over the default 10 retries, against under 3 minutes.
    - Pros: a short blip still recovers within seconds.
    - Cons: an outage longer than 7.5 minutes still fails.
  - **Base 32 s, maximum 64 s.** About 10 minutes.
    - Pros: the longest wait the variables allow.
    - Cons: every blip costs at least 32 s; little gain over 7.5 minutes.
  - **Raise `CLAUDE_CODE_MAX_RETRIES` too.**
    - Pros: up to about 13 minutes.
    - Cons: it also lengthens 429 retries, which the requirements rule out.
- **A user's own value wins:** a variable already in the bridge's environment is left alone.
- **Version:** both variables are present in the pinned 2.1.314, above the 2.1.292 and 2.1.296 minimums. An older CLI ignores them.

### Task 4: left open

The 1.2.0 reading gives no capacity code and no field that separates a capacity refusal from a rate limit. Matching text on an unseen shape risks retrying a rate limit, so the recommended option stands: record one real refusal first.

### Task 5: shared backoff for the ACP bridge

- **Chosen:** the recommended option. `packages/protocol/src/capacity-retry.ts` holds the policy, `capacityRetryDelayMs` and `formatRetryDelay`; `sessions/capacity-retry.ts` re-exports them for Codex, and `RETRIABLE_PROVIDER_RETRY_POLICY` uses them.
- **What changes for Grok:** five attempts instead of four, waits of about 2, 6, 18 and 54 s instead of 1, 2 and 4 s.
- **`ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS`** still sets the base wait. A deployment that pinned it keeps its base but gets the new multiplier, cap, jitter and attempt count.
- **Added beyond the to-do's wording, because the longer wait needs them:**
  - a `retry` card, settled in place; the Stop case is the same as Codex's;
  - `state.wakeRetryWait`, called by Stop, close and agent exit, so none of them sits out a wait.
- **Never retried:** an error naming a usage or rate limit, quota, billing or a login (`namesLimitOrLogin`), even under `[resource_exhausted]`. For assistant text only the matched error suffix is read, so a model's own words cannot stop or start a retry.
- **Grok's overload sentence.**
  - **Accept the two exact sentences on a JSON-RPC error only (chosen).**
    - Pros: if Grok reports an overload that way the retry now fires, where before it could not; a JSON-RPC error is not model-controlled.
    - Cons: the transport is unobserved, so this may never fire; it is text matching.
  - **Leave it until a real refusal is recorded.**
    - Pros: no text match on an unseen shape.
    - Cons: the retry may match nothing Grok actually sends.

### Task 6: where the OpenCode retry lives

- **Options.**
  - **Lift the skip in `NativeAgentTurnRecovery`, as the task's option says.**
    - Pros: one recovery path.
    - Cons: its continuation runs under another request id with no workflow options, which takes away the result tool and reads as settled (see the task's Investigation); fixing that means teaching the sweep every workflow's turn options.
  - **Inside `OpenCodeProvider`, driven by the workflow's status poll (chosen).**
    - Pros: the request, grant, tools, schema and result key all stay put, as in Codex; no workflow state machine changes; nothing runs once nobody polls.
    - Cons: a second OpenCode retry path beside the interactive one; idle rather than `running` during the wait.
- **Chosen:** `opencode-capacity-retry.ts`, called from `settleCompleted` under the dispatch lock. The skip in `appliesTo` stays, so interactive sessions are unchanged.
- **Idle and `turnSettled: false`:** the session reads idle during the wait, because OpenCode itself is idle, and the request reads unsettled. `turnTerminalError` answers unavailable meanwhile, so no outcome is recorded. Activity views may show the session idle for up to a minute.
- **What counts:** an `APIError` with status 503 or 529, or 429 with an overload body, unless the message or body names a limit or login. A 429 without an overload body is a rate limit.
- **The continuation:** the existing `OPENCODE_PROVIDER_ERROR_CONTINUATION` text, with the turn's model, agent, variant, tools, system instruction and schema wrapper. Its message id carries the request's marker (`nextOpenCodeMessageIdForRequest`), so settlement, the terminal error and the structured result read the newest attempt.
- **Budget:** the shared policy, on top of OpenCode's own five attempts, so at most about 7.5 minutes in all.
- **An ambiguous `promptAsync`:** never sent again. The next read of the transcript decides. A definite rejection ends the turn with the refusal.
- **Stop, close, release:** drop the plan.
- **Backend restart during a wait:** loses the retry; the turn fails with its refusal, as before this change.
- **Transcript:** the continuation shows as an ordinary user row, as interactive recovery's does, and each refusal keeps its inline error row. It is not folded into a retry card.

### Task 1: which providers are covered

- **Options.**
  - **Codex only (chosen).**
  - **Every bridge now.**
    - Pros: one behaviour everywhere.
    - Cons: Claude, Pi and Grok already retry inside their runtimes or bridges, and a second loop would stack on theirs. Cursor's error shape is unknown.
- **Chosen at the time:** Codex. The other providers are recorded as tasks 3–7, each with its own reason; tasks 3, 5 and 6 have since been built.

## Current state

- Codex turns started by prompt dispatch retry `serverOverloaded` and `policyCapacityUnavailable` up to five attempts. This covers interactive tabs, Multi Review steps and build stages alike.
- Claude `pipeline` sessions run with a 4 s base and 64 s maximum overload backoff inside Claude Code.
- Grok turns retry on the shared backoff, with a card, and stop at once on Stop.
- Unattended OpenCode turns ended by an overload are continued by the provider on the shared backoff.
- Cursor has no retry (task 4). Pi relies on its SDK (task 7).
- Tests:
  - `app-server-runtime-capacity-retry.test.ts` covers:
    - retry then success;
    - exhaustion;
    - errors that are never retried (usage limit, rate limit, unauthorized, 401, 403, bad request);
    - Stop during the wait, and Stop during the start;
    - the waiting card;
    - an unattended schema turn that reads `running` on every poll and is credited;
    - a continuation that never starts;
    - shutdown during a wait.
  - `sessions/capacity-retry.test.ts` covers the policy.
  - `history/rollout-rows.test.ts` covers the replay.
  - `multi-review-service.test.ts` ("an unattended Fix survives a Codex capacity retry", "an unattended Fix waits out an OpenCode capacity retry") covers the backend side of the contract.
  - `opencode-capacity-retry.test.ts` covers classification, the continuation, backoff, exhaustion, Stop, and rejected and ambiguous sends.
  - `acp-prompt.test.ts` and `acp-reconciliation.test.ts` cover the ACP retry, its card, Stop during a long wait, and errors that name a limit.
  - `runtime-env.test.ts` and `session-manager-prompt.test.ts` cover which Claude sessions get the longer backoff.
  - `packages/protocol/src/capacity-retry.test.ts` covers the shared policy.

## Constraints and rationale

- Never auto-retry an ambiguous dispatch (`bridges/codex-bridge/AGENTS.md`). A continuation is a new turn after a definite terminal failure, not a re-send. Its own ambiguous start is reconciled, never re-sent.
- Never report `idle` or `error` while work may still run. The wait reports `running`.
- The stdout read loop never awaits. `onTurnFailed` only schedules a timer.

## Needs verification

- Task 2: a real refusal retried end to end, for either Codex code.
- The rollout spelling of `codex_error_info` for these variants. Replay does not depend on it.
- Task 3: a real 529 waiting on the longer backoff. The CLI behaviour above is read from the bundle, not run.
- Task 5: how a real Grok overload reaches the bridge, and that the retry fires for it.
- Task 6: a real OpenCode overload ending a workflow turn and the continuation recovering it, against a real `opencode serve`.

## Related

- [1020-provider-upgrade-2026-10-30.md](1020-provider-upgrade-2026-10-30.md): the error shapes at the current pins (task 7).
- [0235-codex-refused-login-turn-invisible.md](0235-codex-refused-login-turn-invisible.md): the refusal line a failed turn shows.
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md).
