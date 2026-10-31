# Retry "Selected model is at capacity" with exponential backoff

## Task analysis

Analysed 2026-10-30 against `main` at `361dc0a6e`.

### Tasks

1. **Codex: continue a turn the model refused for capacity**: the bridge retries `serverOverloaded` with backoff and jitter, keeps the session `running`, and continues the same turn under the same request id. Status: done (2026-10-30).
2. **Codex: live evidence of a real refusal**: watch a real `serverOverloaded` turn retry and recover. Status: open; needs a real capacity refusal, which cannot be provoked without billed turns.
3. **Claude: unattended sessions and Claude Code's own 529 retry**: decide whether Multi Review and build sessions should run with a longer Claude Code overload retry. Status: open.
4. **Cursor: classify capacity refusals from `@cursor/sdk`**: the SDK bridge has no retry for transient provider errors. Status: open (needs evidence of the error shape).
5. **Grok (ACP bridge): bring the existing retry in line**: the ACP retry has no jitter or per-wait cap. Status: open.
6. **OpenCode: unattended sessions skip turn recovery**: `NativeAgentTurnRecovery` retries provider errors only in interactive sessions. Status: open.
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

**Context.** Claude Code retries failed API requests itself (`CLAUDE_CODE_MAX_RETRIES`, default 10). Per its docs it can stop sooner on 529s: with an API key on an Opus model, at the third 529. The bridge already shows each retry as a settling `retry` card (`session-manager-prompt-handlers/system.ts:358`, `api_retry`). Orkestrator sets none of Claude Code's retry variables; nothing under `bridges/` or `apps/backend/src` names them. The Claude Agent SDK is pinned at 0.3.309.

**Investigation.** A bridge-side continuation, as for Codex, would stack a second retry loop on top of Claude Code's own. The documented controls are:
- `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` (default 500, up to 32000);
- `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` (default 32000, up to 64000);
- `CLAUDE_CODE_RETRY_WATCHDOG=1`, which retries 429 and 529 indefinitely. It also waits out usage limits, which conflicts with "never retry usage limits".

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

**Context.** `@cursor/sdk` 1.0.40. A failed run settles the session `error` (`agent-session.ts:1094-1097`).

**Investigation.** The SDK's error shape for a capacity refusal is not known from the code, and no fixture shows one.

**Decisions.**
- **How to proceed?**
  - **Record one real refusal first (recommended),** then classify on its structured field, as Codex does.
    - Pros: no guessing at text.
    - Cons: waits on a real refusal.
  - **Match `resource_exhausted` text, as the ACP bridge does.**
    - Pros: available now.
    - Cons: text matching on a shape nobody has seen.

### 5. Grok (ACP bridge): bring the existing retry in line

**Problem.** `acp-prompt.ts:253-275` retries `[resource_exhausted]`/`[unavailable]` three times with waits of 1, 2 and 4 s (`RETRIABLE_PROVIDER_RETRY_BASE_MS`). It has no jitter and no per-wait cap, and it shows no wait in the transcript.

**Context.** It already continues with a labelled continuation prompt (`RETRIABLE_PROVIDER_CONTINUATION`). That precedent is what task 1 follows.

**Investigation.** Moving it onto `capacityRetryDelayMs` would need the policy in `packages/protocol`, which counts as a wide-reaching change. It is safe, but not cheap enough to fold into this change.

**Decisions.**
- **Share the policy?**
  - **Move `sessions/capacity-retry.ts`'s delay and policy into `packages/protocol` and use them in both bridges (recommended).**
    - Pros: one backoff for every provider.
    - Cons: a protocol change runs the full suite; the env-var name `ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS` must keep working.
  - **Leave it.**
    - Pros: it works.
    - Cons: a burst of Grok sessions retries in lockstep.

### 6. OpenCode: unattended sessions skip turn recovery

**Problem.** `NativeAgentTurnRecovery` (`native-agent-turn-recovery.ts`) retries OpenCode provider errors with backoff: 5, 15 and 45 s (`OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS`). It skips 401/402/403/404/413. It skips build-pipeline and automated-review sessions entirely (`:160-165`), so those still fail on an overload.

**Context.** The skip says unattended workflows own their own turn lifecycle.

**Investigation.** Not changed here. OpenCode sessions are not the ones that failed, and lifting the skip changes how every workflow state machine sees an OpenCode turn.

**Decisions.**
- **Lift the skip for overload only?**
  - **Lift it for overload statuses (429 with an overload body, 503, 529) and keep the workflow seeing `running` throughout (recommended).**
    - Pros: the same behaviour as Codex.
    - Cons: needs OpenCode's `turnSettled` to stay false during the wait, which no workflow test covers today.
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

### Task 1: which providers are covered

- **Options.**
  - **Codex only (chosen).**
  - **Every bridge now.**
    - Pros: one behaviour everywhere.
    - Cons: Claude, Pi and Grok already retry inside their runtimes or bridges, and a second loop would stack on theirs. Cursor's error shape is unknown.
- **Chosen:** Codex. The other providers are recorded as tasks 3–7, each with its own reason.

## Current state

- Codex turns started by prompt dispatch retry `serverOverloaded` up to five attempts. This covers interactive tabs, Multi Review steps and build stages alike.
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
  - `multi-review-service.test.ts` ("an unattended Fix survives a Codex capacity retry") covers the backend side of the contract.

## Constraints and rationale

- Never auto-retry an ambiguous dispatch (`bridges/codex-bridge/AGENTS.md`). A continuation is a new turn after a definite terminal failure, not a re-send. Its own ambiguous start is reconciled, never re-sent.
- Never report `idle` or `error` while work may still run. The wait reports `running`.
- The stdout read loop never awaits. `onTurnFailed` only schedules a timer.

## Needs verification

- Task 2: a real refusal retried end to end.
- The rollout spelling of `codex_error_info` for this variant. Replay does not depend on it.

## Related

- [0235-codex-refused-login-turn-invisible.md](0235-codex-refused-login-turn-invisible.md): the refusal line a failed turn shows.
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md).
