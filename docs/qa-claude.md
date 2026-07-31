# Agent Questions & Answers — Cross-Surface Review and Remediation Plan

Status: proposed — one policy decision taken (see [Decision log](#decision-log))
Date: 2026-07-31
Scope: every path by which an agent asks the user a question and receives an
answer — Claude native, Claude tmux, Codex native, OpenCode native, and the
fully automated surfaces (build pipeline, looped review, feature planner).

This document is a review first and a plan second. Part 1 records what exists,
Part 2 records what is wrong or missing with file-level evidence, Part 3 is the
remediation plan.

---

## Part 1 — What exists today

### 1.1 The three prompt families

The codebase deliberately distinguishes three kinds of blocking prompt, all
rendered in the same visual container:

| Family | Meaning | Cards |
| --- | --- | --- |
| **Approval / permission** | "may I run this?" | `CodexApprovalCard`, `OpenCodePermissionCard`, `TmuxPermissionCard` |
| **Plan approval** | "is this plan right?" | `ClaudePlanApprovalCard`, `TmuxPlanCard`, `CodexPlanModeCard` |
| **Question** | "which of these do you want?" | `ClaudeQuestionCard`, `OpenCodeQuestionCard`, `CodexInteractionCard` |

This review covers the **question** family, and the approval family only where
it establishes a pattern the question family has failed to adopt.

### 1.2 Shared components

- `apps/web/src/components/chat/BlockingPromptCard.tsx` — one amber-accented
  container for every prompt the turn is blocked on. Accepts `role` /
  `aria-label` / `data-*` passthrough.
- `apps/web/src/components/chat/QuestionCard.tsx` — the agent-neutral
  multi-question wizard: option list, per-question tab strip, committed custom
  answer chips, uncommitted-draft merge at submit, deadline countdown,
  submit/dismiss with delivery-failure toasts.
- `apps/web/src/stores/promptDraftStore.ts` — in-memory, non-persisted drafts
  keyed by request id so in-progress answers survive tab/environment switches.
  Namespaced key builders exist for all five prompt sources and every store
  clears its own keys on resolution (verified: `claudeStore.ts:610,657,688`,
  `claudeTmuxStore.ts:293,394`, `codexStore.ts:434,487,602,617`,
  `openCodeStore.ts:324,368,417`).
- `apps/web/src/hooks/usePromptDeadline.ts` — shared `m:ss` countdown. Fails
  closed only on *invalid* deadlines; an elapsed deadline does not disable the
  card, because the browser clock may not match the bridge's (often inside a
  Docker VM) and the response endpoint returns `stale` authoritatively.
- `apps/web/src/hooks/useGlobalActivityMonitor.ts:367` — "blocked on the user"
  beats "still running", so a parked question drives the amber sidebar state.

### 1.3 Per-agent wire protocols

| Agent | Trigger | Transport | Answer shape | Deadline |
| --- | --- | --- | --- | --- |
| Claude native | `AskUserQuestion` intercepted in `canUseTool` (`session-manager.ts:4260`) | bridge SSE `question.asked` + `GET /session/:id/questions` | `Record<questionText, string>` | 300 s (`session-manager.ts:165`) |
| Claude tmux | `AskUserQuestion` hook matcher (`tmux.ts:967`) | hook file poll → `pendingQuestions` | per-hook payload | 600 s (`tmux.ts:38`) |
| Codex native | `item/tool/requestUserInput`, `mcpServer/elicitation/request` | bridge SSE `session.interaction-requested` + `GET /session/:id/interactions` | `Record<questionId, {answers: string[]}>` | 300 s (`server-request-router.ts:154`) |
| OpenCode | `question.asked` SSE | SDK v2 `question.list()` / `question.reply()` | `string[][]` | none |

All four have an authoritative rehydration endpoint and all four are actually
called on reconnect (`ClaudeChatTab.tsx:607,1746`, `OpenCodeChatTab.tsx:719`,
`useCodexBackgroundSync.ts:107`, `claudeTmuxStore.ts:465`). **The
background-reliability invariants in `AGENTS.md` are met for questions.** The
problems below are consistency, headless policy, and visibility problems, not
state-authority problems.

### 1.4 Surface matrix

| Surface | Shared `QuestionCard`? | Amber container? | Countdown? | Draft survives unmount? |
| --- | --- | --- | --- | --- |
| Claude native (`ClaudeChatTab.tsx:2797`) | yes | yes | yes | yes |
| Claude tmux (`ClaudeTmuxChatTab.tsx:1813`) | yes | yes | **no** | yes |
| Claude tmux TUI selection prompt (`:1859`) | yes | yes | no | no (screen-derived identity — by design) |
| OpenCode (`OpenCodeChatTab.tsx:2755`) | yes | yes | **no** (protocol has no deadline) | yes |
| Codex native (`CodexChatTab.tsx:2737`) | **no** | **no** | **no** | yes |
| Build pipeline (`BuildChatTab.tsx`) | — | — | — | no card at all |
| Looped review (`LoopedReviewTab.tsx`) | — | — | — | no card at all |
| Feature planner (`FeaturesView.tsx`) | — | — | — | plain-markdown questions by prompt convention |
| iOS (`RemoteWebView.swift`) | inherits web | inherits web | inherits web | inherits web |
| web-public (`PublicApp.tsx`) | inherits web | inherits web | inherits web | inherits web |

iOS and web-public are `WKWebView`/browser hosts over the gateway and render the
same React tree, so they inherit whatever the web surface does — including its
defects. They are not separate implementations and need no separate cards, but
they do need the responsive and touch checks in Phase 5.

---

## Part 2 — Findings

### A. Interactive surfaces

#### A1 — Codex questions are a second, poorer implementation (high)

`CodexInteractionCard.tsx` is 377 lines that re-solve what `QuestionCard`
already solves, and solve less of it. It renders its own container
(`CodexInteractionCard.tsx:182`, `bg-card` + `border-border`) rather than
`BlockingPromptCard`, so a Codex question is the **only** blocking prompt in the
product that is not amber — including next to `CodexApprovalCard`, which *is*
amber, in the same stack (`CodexChatTab.tsx:2726-2745`).

Concretely missing versus the shared card:

- No multi-question tab strip or `n/m answered` progress; every question is
  stacked into one `max-h-72` scroller.
- **No multi-select**, despite the wire format being `answers: Array<string>`
  (`generated/typescript/v2/ToolRequestUserInputAnswer.ts`). Selection is
  hardcoded to a single index (`CodexInteractionCard.tsx:222`).
- No committed custom-answer chips, and free text is mutually exclusive with a
  selected option (`:224-226`, `:255-257`) — you cannot answer "Option B, and
  also this note".
- Free text is only offered when `isOther` is set or there are no options
  (`:247`), so a Codex question with options and no `isOther` has no escape
  hatch. Claude and OpenCode both default to allowing a custom answer.
- Button labels diverge: `Cancel`/`Submit` vs the shared `Dismiss`/`Next`/`Submit`.
- No delivery-failure retry copy shared with the other agents; it has its own
  `error` banner (which is good) that the shared card lacks (which is not).

The existing `docs/native-tab-consistency-report.md` unified Claude and
OpenCode onto `QuestionCard` and explicitly left Codex out. This is the
remaining third of that job.

#### A2 — Codex ignores its own deadline (high)

`InteractionRequest.expiresAt` is computed and sent
(`app-server/interactions.ts:171-173`, honouring the server's `autoResolutionMs`
when it is shorter than the bridge's 300 s default), and
`CodexInteractionCard` never reads it. The consequence is not just a missing
countdown: when the bridge auto-cancels, `session.interaction-resolved` removes
the card and **it simply vanishes mid-answer with no explanation**. Claude's
card at least renders "This request expired and was declined".

`CodexApprovalCard.tsx:105` already consumes `usePromptDeadline` correctly — the
pattern exists one file away.

#### A3 — tmux questions carry no deadline (medium)

`TmuxPendingQuestion` (`claudeTmuxStore.ts:88-94`) has no `expiresAt`, and
`ClaudeTmuxChatTab.tsx:1815-1820` constructs a `ClaudeQuestionRequest` without
one. The hook *does* time out — `HOOK_TIMEOUT_SECS = 600` (`tmux.ts:38`) — and
the backend writes a timeout marker and emits a timeout event
(`tmux.ts:942,1939-1948`). The deadline is known; it is just never surfaced.

#### A4 — Four different timeouts, none documented as a product decision (medium)

300 s (Claude bridge), 300 s (Codex bridge), 600 s (tmux hook), unbounded
(OpenCode). A user answering the same question in two environments gets two
different windows. Nothing anywhere states what the intended window is.

#### A5 — Claude's multi-select answers are lossy on the wire (medium)

`bridges/claude-bridge/src/routes/session.ts:763`:

```ts
answersRecord[q.question] = questionAnswers.join(", ");
```

The Agent SDK's answer contract is `Record<questionText, string>`, so joining is
forced — but joining with `", "` is ambiguous whenever an option label contains
a comma ("Yes, but only in CI" and "Yes" + "but only in CI" are indistinguishable
to the model). The duplicate-question-text guard at `:4264-4275` shows the
codebase already fails closed on the *key* side of this contract; the *value*
side has no equivalent.

#### A6 — Codex secret answers get the weakest handling (medium)

`CodexInteractionCard.tsx:249` honours `isSecret` with `type="password"`, then
stores the typed value in the shared `promptDraftStore` under
`codex-interaction:<id>` (`:86-90`). The store is renderer-memory only and never
persisted (`promptDraftStore.ts:18`), and the draft is cleared on resolution, so
this is not a disk leak — but a secret lives in a global store keyed by a stable
id for as long as the interaction is pending, and is retained across unmount by
design. No other surface handles secrets at all.

#### A7 — `ClaudeQuestionCard`'s callback mode is documented for callers that do not exist (low)

`ClaudeQuestionCard.tsx:33-34` says "the feature planner and build pipeline
reuse this card without a live Claude session behind it". Neither does. The only
non-bridge caller is `ClaudeTmuxChatTab`. `FeaturesView` asks its questions as
plain prose driven by `FEATURE_PLANNER_SYSTEM_PROMPT`
(`feature-planner.ts:31-32`, "Ask no more than 3 questions in one response"),
and `BuildChatTab` renders no prompt cards at all. Stale comment, and a
misleading signpost for anyone extending the card.

#### A8 — No accessible announcement when a question arrives (low)

`QuestionCard` renders `BlockingPromptCard` with no `role` or `aria-label`
(`QuestionCard.tsx:521`), while `CodexApprovalCard.tsx:95-98` passes
`role="group"` and a label. Nothing announces the arrival of a blocking prompt
to a screen reader; the only signal is the visual amber card and the sidebar
dot. This matters most on iOS, where the card can arrive while the user is
scrolled elsewhere.

#### A9 — "Waiting on you" is per-environment only (medium)

`useGlobalActivityMonitor` correctly turns the environment amber and
`App.tsx:241-245` counts pending prompts, but there is no cross-environment
list, no count, no OS notification, and no way to jump to the next unanswered
question. With several environments running, finding the one that is blocked
means visually scanning the sidebar. On iOS in a `WKWebView`, backgrounded, there
is no signal at all.

### B. Automated surfaces

This is where the real exposure is.

#### B1 — Only OpenCode has a headless question policy (high)

`build-pipeline-provider.ts:143-160` defines `autoAnswerRequests`, and it is
implemented **only** in `OpenCodeProvider` (`:600-627`). `HttpBridgeProvider`,
which serves both Claude and Codex, has no equivalent. For pipeline runs:

- **Claude**: `permissionMode: "bypassPermissions"`
  (`build-pipeline-provider.ts:323-324`) suppresses *permission* prompts. It says
  nothing about `AskUserQuestion`, which is explicitly in `allowedTools`
  (`session-manager.ts:4220`) and intercepted in `canUseTool` (`:4260`). An
  `AskUserQuestion` in a pipeline parks the turn for the full 300 s, then denies
  with "Question timed out after 5 minutes" and the model continues. Repeat per
  question.
- **Codex**: `plan`/`build` mode does not gate `item/tool/requestUserInput`. The
  interaction is registered, presented to zero subscribers, and auto-cancelled
  after 300 s (`server-request-router.ts:154`).

So the failure mode is a silent 5-minute stall per question, on a run nobody is
watching, with the environment reporting `running` the whole time.

> **Verify before implementing:** `allowedTools` is documented in the Agent SDK
> as "auto-allowed without prompting", and `AskUserQuestion` is listed there
> (`session-manager.ts:4211-4225`). It is not established from the code alone
> whether `canUseTool` still fires for `AskUserQuestion` under
> `permissionMode: "bypassPermissions"`. If it does not, the pipeline failure
> mode is worse than described — the tool would be auto-allowed with no answers
> rather than stalling. **Task P0.1 below pins this down with a test before any
> other work depends on it.**

#### B2 — Prompt text is the only control (high)

Every automated path relies on instructing the model not to ask:

- `build-pipeline-prompts.ts:9,34,96,113` — "without asking questions", "Do not
  ask questions", ×4.
- `looped-review-prompts.ts:218,254,284,308,326` — "Do not ask questions or wait
  for interactive input", ×5.

These are the right instructions and they mostly work. They are not a
guarantee, and there is no backstop when they fail. Compare `AGENTS.md`'s own
standard for the approval path: *"Approval timeout, disconnect, malformed
answers, and generation death deny rather than approve."* Questions have no
equivalent rule.

#### B3 — The three agents fail three different ways (high)

| Agent | Pipeline behaviour on a question | Net effect |
| --- | --- | --- |
| OpenCode | rejected immediately, session marked blocked (`:617`), `status()` returns `"error"` (`:747`) | attempt **fails fast**, correctly |
| Claude | 300 s stall → deny → model continues on its own assumption | attempt **succeeds slowly**, with an unrecorded guess |
| Codex | 300 s stall → auto-cancel → model continues | attempt **succeeds slowly**, with an unrecorded guess |

Whatever the right answer is, it should not be three answers. **Resolved by
Decision D1:** all three converge on decline-and-continue, which means
OpenCode's fail-fast behaviour is the one that changes.

#### B4 — A blocked automated run is invisible (high)

`BuildChatTab.tsx` and `LoopedReviewTab.tsx` contain no reference to questions,
approvals, permissions or interactions. Pipeline and review sessions are driven
by the backend / the supervisor, not by a mounted chat tab, so no card renders
anywhere. There is no transcript entry, no status, and no metric recording that
an agent asked something and was refused. From the outside, a 5-minute stall is
indistinguishable from a slow turn.

#### B5 — No stall watchdog (medium)

`build-pipeline-service.ts` has no stall or watchdog logic. `status()` is polled
and a session that is `running` is trusted indefinitely. This is correct for a
genuinely long turn and wrong for a parked one — and the provider *knows* the
difference for OpenCode (`blockedSessions`) but throws that information away for
the other two.

#### B6 — The feature planner is a fourth Q&A dialect (low)

`FeaturesView` runs a genuine question-and-answer loop with the user, entirely
through prose plus a `<feature_planner_state>` block
(`feature-planner.ts:26-53`). It has no structured options, no multi-select, no
draft persistence, and no relationship to `QuestionCard`. It works, and
converting it is not urgent — but it should be named as a deliberate exception
rather than left as an accident.

---

## Part 3 — Remediation plan

Ordered so that each phase is independently shippable and each later phase
depends only on earlier ones.

### Decision D1 — headless questions auto-decline and the run continues

**Decided 2026-07-31.** When an agent asks a question in a non-interactive
session, the bridge declines it immediately with a structured refusal and the
turn carries on. The attempt is **not** failed.

Rationale: the pipeline and review prompts already instruct the model to make
its best judgment (`build-pipeline-prompts.ts:9,34,96,113`,
`looped-review-prompts.ts:218,254,284,308,326`). A question in a headless run is
the model asking for a confirmation it was already told to assume — that is a
reason to answer it deterministically, not a reason to throw away the work
completed so far.

The cost of this choice is that **every auto-decline is an unrecorded
assumption**. That makes Phase 4's transcript record and summary count
load-bearing rather than nice-to-have: they are the only thing standing between
"the model guessed" and "nobody knows the model guessed". Phase 3 and Phase 4
ship together; do not land P3.2 without P3.3.

Consequences:

- OpenCode's current fail-fast behaviour changes. `blockedSessions`
  (`build-pipeline-provider.ts:617,747`) stops being raised by a rejected
  question and is retained only for the case where the rejection call itself
  fails — which is a genuine provider failure, not a model choice.
- All three agents converge on one behaviour, closing finding B3.
- `ProviderStatus`'s new `blocked` variant (Phase 4.4) therefore describes only
  "parked on a prompt in an interactive session", never a headless run.

### Phase 0 — Establish the facts and the contract

**P0.1 Pin down Claude's headless question behaviour** *(blocking for Phase 3)*

Add `bridges/claude-bridge/src/services/session-manager.question-policy.test.ts`
driving a real session with `permissionMode: "bypassPermissions"` and a prompt
that forces `AskUserQuestion`. Assert which of these happens: `canUseTool` fires
and the request parks; or the tool is auto-allowed and returns without answers.
Record the answer in this document and in a comment at
`session-manager.ts:4211`.

**P0.2 Define the blocking-prompt contract in `packages/protocol`**

New `packages/protocol/src/blocking-prompt.ts`:

```ts
export type PromptInteractivity = "interactive" | "headless";

export interface AgentQuestionOption { label: string; value?: string; description?: string }
export interface AgentQuestion {
  id: string;
  header?: string;
  question: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  isSecret?: boolean;
}
export interface AgentQuestionRequest {
  requestId: string;
  sessionId: string;
  agent: "claude" | "codex" | "opencode";
  origin: "native" | "tmux";
  questions: AgentQuestion[];
  /** Absolute epoch ms. Required — every producer must publish one. */
  expiresAt: number;
}
export type QuestionResolution =
  | "answered" | "dismissed" | "timed-out"
  | "auto-declined-headless" | "session-closed" | "generation-lost";
```

Validators live beside it, matching the existing protocol package conventions.
This is the type `QuestionCard` consumes and the type every bridge emits.

**Acceptance:** `packages/protocol` exports the contract with validators and
tests. No behaviour change yet.

---

### Phase 1 — Codex onto the shared card *(fixes A1, A2)*

1. Split `CodexInteractionCard` by kind. The MCP form and MCP URL branches are
   genuinely different UIs and stay; only `kind === "question"` moves.
2. New `CodexQuestionCard.tsx` wrapping the shared `QuestionCard`, mirroring
   `OpenCodeQuestionCard`:
   - map `InteractionQuestion` → `QuestionCardQuestion`, with
     `allowCustomAnswer: question.isOther || !question.options?.length`;
   - keep `exclusiveSingleSelect={false}` — the wire accepts `string[]`, so
     enable multi-select and option+custom combinations;
   - **preserve the index-keyed selection.** Codex option labels are untrusted
     MCP text and are not de-duplicated upstream
     (`CodexInteractionCard.tsx:72-75`). `QuestionCard` keys by value/label. Add
     an `optionKey` escape hatch to `QuestionCardOption`, or de-duplicate labels
     at the mapping boundary by appending a disambiguating suffix and stripping
     it before submit. This is a real constraint, not an implementation detail —
     do not drop it.
   - pass `expiresAt={interaction.expiresAt}`;
   - keep `codexInteractionDraftKey` so existing draft clearing keeps working.
3. Wrap the surviving MCP form/URL branches in `BlockingPromptCard` and give
   them `expiresAt` too.
4. Lift the `error` banner from `CodexInteractionCard` into the shared
   `QuestionCard` as an inline delivery-failure region (currently only a toast),
   so all agents get the retryable-error affordance Codex already had.
5. Keep `role="group"` + `aria-label` passthrough — see Phase 5.

**Acceptance:** a Codex question renders amber, counts down, supports multiple
questions and multi-select, and survives a tab switch mid-answer. Two options
with identical labels remain independently selectable (regression test).

---

### Phase 2 — Deadline parity *(fixes A2, A3, A4)*

1. Adopt one constant, `BLOCKING_PROMPT_TIMEOUT_MS = 5 * 60_000`, exported from
   `packages/protocol`. Replace `QUESTION_TIMEOUT_MS` /
   `PLAN_APPROVAL_TIMEOUT_MS` (`session-manager.ts:165-166`),
   `DEFAULT_APPROVAL_TIMEOUT_MS` (`server-request-router.ts:154`) and
   `HOOK_TIMEOUT_SECS` (`tmux.ts:38`) with it.
   - **Check before changing tmux:** 600 s may have been chosen because hook
     polling latency plus container round-trips eat into the window. If so, keep
     600 s for tmux and document *why* next to the constant rather than
     silently diverging.
2. Add `expiresAt` to `TmuxPendingQuestion`, computed at hook-receipt time from
   `receivedAt + HOOK_TIMEOUT_SECS`, and pass it through
   `ClaudeTmuxChatTab.tsx:1815`.
3. OpenCode has no protocol deadline. Do **not** invent a client-side one —
   `usePromptDeadline` already treats an absent deadline as "not expired", which
   is the correct representation of "this protocol does not publish one". Record
   that as a deliberate gap here and in `OpenCodeQuestionCard`.
4. Make the Codex auto-cancel visible: when
   `onInteractionResolved` fires with resolution `timed-out`, emit a transcript
   note ("Codex's question expired unanswered and was declined") the same way
   `abandonGeneration` withdraws an approval with an explanation, rather than
   letting the card vanish silently.

**Acceptance:** every question card that has a deadline shows the same
countdown; an expired Codex question leaves a transcript trace.

---

### Phase 3 — Headless question policy *(fixes B1, B2, B3)*

This is the core of the automated-environment work. It implements Decision D1:
auto-decline, continue the run, record the decline. Ships with Phase 4.

**P3.1 Thread `PromptInteractivity` through session creation.**

`POST /session/create` on both bridges accepts `interactivity: "interactive" |
"headless"`, defaulting to `"interactive"`. It is stored on the session and
persisted, so a bridge restart cannot silently promote a headless session to
interactive. `HttpBridgeProvider.createSession`
(`build-pipeline-provider.ts:262-292`) sends `"headless"`.

**P3.2 Enforce it at the point of ask, not at the point of render.**

- Claude (`session-manager.ts:4260`): when the session is headless, return
  `{ behavior: "deny", message: <structured refusal> }` **immediately** — no
  pending entry, no 300 s wait. The refusal message must tell the model what to
  do instead:

  > "This session is non-interactive; no user can answer. Choose the option you
  > judge most likely to be correct, state the assumption explicitly in your
  > next message, and continue."

  If P0.1 shows `canUseTool` does not fire under `bypassPermissions`, enforce it
  by adding `AskUserQuestion` to `disallowedTools` for headless sessions
  instead, and say so in the system prompt append.
- Codex (`server-request-router.ts`): when the session is headless, answer
  `item/tool/requestUserInput` immediately with the equivalent structured
  refusal rather than parking it. This respects the existing invariant that
  every server request is answered exactly once.
- OpenCode: keep `autoAnswerRequests`, but stop marking the session blocked
  (`build-pipeline-provider.ts:617`). Reject the question **and** let the run
  continue, matching Claude and Codex per Decision D1. Retain `blockedSessions`
  only for the case where the rejection call itself fails, and drop the
  `question.replied` unblock path at `:600-603` with it — that branch exists
  only to release a session this provider blocked, so it becomes dead once
  questions no longer block. Its comment ("someone in the OpenCode UI resolved
  what this provider could not") describes a human rescuing a pipeline-owned
  session, which was never a supported flow.

**P3.3 Record every auto-decline.**

Each auto-decline emits a first-class event carrying the question text, the
options offered, and the resolution `auto-declined-headless`. It lands in:
the session transcript (so it shows in `BuildChatTab` and the review tab), the
pipeline attempt record, and a counter. Per `AGENTS.md` invariant 12, log the
*fact* and the question **header**, never the full prompt body, in metrics.

**Acceptance:** a pipeline or review run where the agent asks a question
completes without a 5-minute stall, on all three agents, and the transcript
shows exactly what was asked and that it was auto-declined. Add a fixture-driven
test per agent, plus an OpenCode regression test asserting the attempt now
**succeeds** where it previously failed.

---

### Phase 4 — Automated-surface visibility *(fixes B4, B5)*

**Ships with Phase 3.** Under Decision D1 a headless run never stops on a
question, so items 1 and 2 are the *only* evidence that the model was asked
something and answered it itself. They are not polish.

1. Render auto-decline records in `BuildChatTab` and `LoopedReviewTab` as a
   distinct, muted transcript entry — deliberately *not* a `BlockingPromptCard`,
   since there is nothing to answer. "Claude asked: <header> — auto-declined
   (non-interactive run)".
2. Surface the count on the pipeline/review summary, and on the ticket/attempt
   record so it survives past the session. A run that auto-declined three
   questions produced three unrecorded guesses and the reviewer must know that
   before reading the diff — a zero-question run and a three-question run
   otherwise look identical.
3. Add a stall watchdog to `build-pipeline-service.ts`: if a session reports
   `running` with no transcript growth for `2 × BLOCKING_PROMPT_TIMEOUT_MS`,
   log a warning and record it on the attempt. Do not auto-abort — a genuinely
   long turn must not be killed. This is a backstop for the case where a
   *future* blocking prompt is added without a headless policy.
4. Extend `ProviderStatus` with a `blocked` variant so the provider can report
   "parked on a prompt" distinctly from `running` and `error`, instead of
   OpenCode's current overload of `error` (`:747`).

**Acceptance:** an automated run that hits a question is visibly distinguishable
from one that did not, in the UI and in the attempt record.

---

### Phase 5 — Interactive polish *(fixes A5, A6, A8, A9)*

1. **A5** — replace `", "` joining (`routes/session.ts:763`) with a delimiter
   that cannot occur in an option label, or emit a numbered list
   (`"1. Option A\n2. Option B"`). Add a test with a comma-containing option
   label asserting the model receives an unambiguous answer.
2. **A6** — do not route `isSecret` answers through `promptDraftStore`. Keep
   them in component state (pass `draftKey: undefined` for that field), accept
   that switching tabs mid-answer loses a secret, and say so in the placeholder.
   Losing a secret draft is strictly better than retaining one.
3. **A8** — `QuestionCard` passes `role="group"` and
   `aria-label={title}` to `BlockingPromptCard`, plus a single polite live
   region announcing arrival ("Claude needs your input — 2 questions"). Do
   **not** make the countdown live; `CodexApprovalCard.tsx:107-110` already
   documents why (`aria-live="off"`).
4. **A9** — a global "needs you" affordance: a count in the app header derived
   from the same store selectors `App.tsx:241-245` already uses, clicking
   through to the next blocked environment. Behind that, an Electron
   `Notification` on arrival when the app is not focused, and a Web Push /
   badge path for the iOS `WKWebView` host. Scope the notification work
   separately if it grows — the in-app count is the valuable 20%.
5. **A7** — delete the dead `onSubmitAnswers` union branch documentation or
   correct it to name `ClaudeTmuxChatTab` as the only caller.
6. **B6** — add a comment at `feature-planner.ts:26` naming the planner as a
   deliberate prose-based exception, with the reason (it is a discovery
   conversation, not a bounded choice) and a pointer to this document.

---

### Phase 6 — Test matrix

Fill the gaps found in `e2e/` and `tests/`, which today cover the tmux store,
`ClaudeTmuxChatTab`, and the feature planner but not the question path
end-to-end.

| Test | Location | Asserts |
| --- | --- | --- |
| Headless auto-decline ×3 agents | `tests/integration/` | no stall, transcript record, run completes |
| OpenCode no longer fails the attempt | `build-pipeline-provider.test.ts` | question rejected → status stays `running`/`idle`, never `error` |
| Auto-decline count reaches the attempt record | `build-pipeline-service.test.ts` | a 3-question run reports 3, a 0-question run reports 0 |
| Interactive session still parks | same | headless policy did not leak into interactive sessions |
| Codex duplicate option labels | `CodexQuestionCard.test.tsx` | independently selectable |
| Codex multi-select round-trip | `bridges/codex-bridge` | `answers: string[]` with >1 entry reaches app-server |
| Claude comma-in-label answer | `bridges/claude-bridge/src/routes/session.test.ts` | unambiguous serialization |
| Deadline parity | `QuestionCard.test.tsx` | all four surfaces render a countdown where a deadline exists |
| Inactive-environment answer | new | ask → switch environment → return → card and draft intact (per `AGENTS.md` §4) |
| Mobile question card | `e2e/` | card reachable and submittable at 390×844 with the keyboard open |

The mobile e2e case matters because the dock bounds blocking cards at
`max-h-[60vh]` (`NativeComposeDock.tsx:63`); with an iOS keyboard raised, a
three-question card plus a custom-answer input needs checking against a real
viewport, not a desktop one.

---

## Summary of priorities

| Priority | Items | Why |
| --- | --- | --- |
| **P0** | P0.1, Phase 3 **+ Phase 4.1–4.2** | Automated runs silently stall and then guess, with no record. This is the only finding that affects correctness of shipped work. Decision D1 keeps the run going, so the record is part of the same change, not a follow-up. |
| **P1** | Phase 1, Phase 4.3–4.4 | Codex users get a visibly and functionally worse card; the watchdog and `blocked` status are backstops rather than the primary signal. |
| **P2** | Phase 2, Phase 5 (A5) | Correctness-adjacent: lossy answers, inconsistent deadlines. |
| **P3** | Phase 5 (A6, A8, A9), Phase 6 | Polish, accessibility, coverage. |

## Open questions for the maintainer

1. **P0.1's answer changes Phase 3's implementation.** If `canUseTool` is
   bypassed under `bypassPermissions`, headless enforcement must move to
   `disallowedTools`.
2. **Is the tmux 600 s window intentional?** Phase 2 preserves it if so.

Resolved: whether a headless question should fail the attempt or be
auto-declined — see [Decision D1](#decision-d1--headless-questions-auto-decline-and-the-run-continues).

## Decision log

| Id | Date | Decision | Supersedes |
| --- | --- | --- | --- |
| D1 | 2026-07-31 | Headless questions are auto-declined with a structured refusal; the run continues. Every decline is recorded in the transcript and counted on the attempt. | OpenCode's fail-the-attempt behaviour (`build-pipeline-provider.ts:617,747`) |
