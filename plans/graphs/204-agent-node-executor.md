---
id: 204
title: "Agent node executor and the shared branch runner"
phase: 2
plan: "P2.4"
status: in-progress
depends_on: [103, 105, 106, 203]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-204-agent"
pr: ""
updated: 2026-10-29
---

# 204 · Agent node executor and the shared branch runner

- **Plan:** [P2.4 Agent node executor and the shared branch runner](../composable-graphs.md#p24-agent-node-executor-and-the-shared-branch-runner)
- **Decisions:** D12, D15
- **Depends on:** [103](103-result-kind-registry.md), [105](105-prompt-templates.md), [106](106-capability-profiles.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Agent nodes run on the same hardened machinery as reviewer fan-outs, with per-activation tools and policies.

## Work

- [x] Extract `AgentBranchRunner` from `review-fanout.ts`: admission, session creation with an explicit policy, the dispatch journal and proof-based recovery, observation, result reading, repair, reminder and continuation, token metering, transcript capture.
- [x] Keep review-specific parsing and provenance behind `ReviewFanoutHost`; Multi Review and the pipeline fan-out keep their behaviour.
- [x] Per-activation MCP credential (as `workflowResultConnection`): `submit_<port>`, `validate_<port>`, status; `report_progress` for types with `items`; `read_artifact` for `on-demand` inputs; opt-in tickets, mail and artifacts.
- [x] `ask_human` only on nodes that opt in (D15): a call pauses the activation, the run shows "waiting for you", and the answer returns as the tool result.
- [x] A node completes when every required output has an accepted artifact. Structured-output providers get one combined schema, split by port.
- [x] `session: "fresh"` by default; `session: "continue"` only under the report §5.2 constraints.
- [x] Every bridge (Claude, Codex, OpenCode, Cursor, Pi, ACP/Grok) accepts per-port `submit_<port>`/`validate_<port>`, several slots and the activation's extra tools, so read-only graph nodes can submit (103's open point).
- [x] Push-free builders for the `pull-request-description` and `resolve-conflicts` built-in prompts (D12), and built-in prompt ids bound to today's builders.
- [x] `graph_run_answer` command for `ask_human` answers (208 shares it).

## Tests

- [x] `review-fanout-interleaving.test.ts`, the Multi Review efficiency benchmark and the dispatch tests pass unchanged.
- [x] Executor tests with fake providers: completion, repair, reminder, continuation, restart recovery.
- [x] `ask_human` pause and resume, including a backend restart while waiting.
- [x] `session: "continue"` constraints are enforced.
- [x] Seeded restart interleavings for activations (crash between journal and send, late delivery, `absent`/`lost`/unknown dispatch answers), per-port tools, `read_artifact` bounds, read-only turn policy, bridge unit tests.

## Done when

- [x] Agent nodes run end to end on fake providers, and the extraction is behaviour-neutral for existing fan-outs.

## Notes

**2026-10-29 · Extraction (behaviour-neutral).** `agent-branch-runner.ts` (`AgentBranchRunner<B>`:
`advance`, `advanceIsolated`, `abandonLive`, `prepareContinuation`, `beginPass`, `commit`,
`stageObservation`, `flushObservations`, `record`) with collaborators taking one shared context
(`AgentBranchContext`): `agent-branch-types.ts` (`AgentBranchRecord`, `AgentBranchHost<B>`,
wording, model rule, retryable pre-dispatch errors), `agent-branch-commits.ts` (the serialized
write queue: safety commits applied inside their own write, staged observations, fence errors),
`agent-branch-observation.ts` (usage metering, progress and stall thresholds, transcript mirror,
commit nudge, `commitProgressObservation`), `agent-branch-stall.ts` (idle-poll bound, unreachable
provider, terminal failure), `agent-branch-turns.ts` (repair ≤ 3, the one reminder after the
idle-poll bound, the one restart continuation, and an owner continuation for `ask_human`). No
`extends`. `review-fanout.ts` keeps the panel (evidence check before admission, provisional
findings, admission-queue projection, fan-in outcome) and adapts each reviewer onto the runner
through `reviewBranchHost` (review prompt, structured-review contract and repair prompt,
provenance on acceptance, reviewer wording); `ReviewFanoutHost` and every export are unchanged
(`commitProgressObservation`, `attachAgentBeforeDispatch`, `resolveUnattendedReviewerInteractions`
are re-exported). Proof: `git diff --stat` on every review-fanout*, multi-review* and
build-pipeline-review-fanout* test and test-support file is empty; those suites, the interleaving
suite (24 default seeds plus 300 seeds locally) and the Multi Review efficiency benchmark pass.

**2026-10-29 · Executor files.** `graph-node-agent.ts` (`GraphAgentNodeExecutor`, kind `agent`;
`start`/`observe`/`recover` all advance the activation's branch, `cancel` aborts the session,
closes its slots and releases a held question), `graph-agent-host.ts` (`GraphAgentBranchHost`: one
activation as the runner's host, built per call), `graph-agent-policy.ts` (policy, turn mode, tier,
floor), `graph-agent-state.ts` (branch ↔ session mapping, `graphAgentResultKey`,
`graphAgentSessionKey`, usage deltas), `graph-agent-results.ts` (slots per request, combined schema,
acceptance, item ids), `graph-agent-prompt.ts` (input loading and verification, render via
`renderGraphNodePrompt`), `graph-agent-builtins.ts` (built-in ids → builders), `graph-agent-tools.ts`
(`report_progress`, `read_artifact`, `ask_human`; `GraphActivationToolHost`), `graph-agent-questions.ts`,
`graph-agent-providers.ts`, `graph-agent-wiring.ts` (`installGraphAgentExecutor`, called from
`index.ts`), `commands-registry-graph-runs.ts` (`graph_run_answer`). Protocol:
`graphs/run-agent-session.ts` (session fields, question, progress; exported from `./graphs/run`).
Tests: `graph-node-agent.test.ts`, `-questions`, `-sessions`, `-interleaving` (seeded, 16 by
default, 200 locally clean), `graph-agent-builtins.test.ts`, `graph-agent-test-support.ts` (real
result service and agent tools server, fake provider whose agent calls its tools over MCP,
crashable backend "processes").

**2026-10-29 · Contract changes in 201–203 (minimal).** `GraphExecutorContext.journal(facts)`
(`graph-run-executors.ts`, implemented in `graph-run-pass.ts`): applies facts without moving the
state and saves at once, serialized per pass; usage and `observeAfterMs` are reported, not
journaled; a failed write rejects with `GraphActivationJournalFenceError` and the call reports
`unchanged`. The runner's every write goes through it, so `dispatching` is durable before `send`.
`GraphRunService.updateActivation(runId, key, change)` (locked, refuses state/output changes and
non-admitted activations, flags the activation for observation) and
`activationForResultKey(environmentId, key)`. `GraphActivationSession` gains the branch fields
(`sessionKey`, `continuedFrom`, `turnMode`, `startedAt`, `resultSubmission`, `repairAttempts`,
`repairPrompt` ≤ 192 KiB, `continuationPrompt` ≤ 16 KiB, `reminderSent`,
`restartContinuationSent`, `idlePolls`, `usagePolls`, `progressAt`, `progressDigest`,
`stalledSince`, `commandSandboxOff`, `question`, `questionsAsked` ≤ 8, `progress` ≤ 50), validated
in `checkSession`. Fixed: `passFailed` treated a `revision-conflict` (which carries revisions as
limit/actual) as a storage bound and failed the run; a conflict is a lost race and now keeps the
key on its cadence.

**2026-10-29 · Decisions.**
- Result keys: UUID-shaped SHA-256 of run id, activation key, request id and port (unique across
  runs; the activation capability needs UUID keys). One port uses `workflowResultConnection`,
  several `workflowResultActivationConnection`. The status tool is the real
  `get_workflow_result_status` (106's `result_status` was provisional; 105's contract and
  `graphGrantedActionNames` now say so).
- `workspace@1` outputs have no slot or tool (`graphNodeResultSlots` skips them; the plan's
  `grantedActions` still list their names, unchanged so plan digests do not move). After the turn
  the runtime reads `HEAD^{commit}` and the branch and stores `{branch, headRef, baseRef}`;
  `baseRef` is the input `workspace@1` commit, else the baseline. Every output artifact carries
  lineage = the consumed input ids and `workspace {headRef, baseRef}` (none for
  `workspaceAccess: none`). Agent nodes produce value artifacts only (a reference output fails
  the step). A step with no submitted outputs completes when its turn ends normally (status
  `idle`, settled, not restart-interrupted); such a step has no activation credential, so no
  `ask_human`/`read_artifact` (limitation).
- Read-only policies run as read-only turns (`plan` mode, `readOnly`), OpenCode's reviewer marker
  only when the shell is allowed. **Researcher on Claude** runs as an ordinary turn whose policy
  denies file writes, the shell and fetching, so hosted search stays on; its tier is capped at
  `provider-configured` with `GRAPH_RESEARCHER_ON_CLAUDE_REASON`. Researchers elsewhere run
  read-only. Containers assume no Claude command sandbox (never overstates the tier). The node's
  `minEnforcement` is re-checked before the session (fails `guard-violation`); 209 owns the
  guards proper.
- Structured output (when the rollout disables tool results): one combined schema; the answer is
  split by port and each value checked with its slot's validation; issues map back
  (`$.port.field`) into the bounded repair (3). Tool transport needs no repair turn: slots refuse
  invalid submissions themselves.
- Reminder: the shared idle-poll bound (5 observations, `ElapsedPollGate` at the 3 s cadence), as
  for reviewers; the report's "after 2 minutes" is not a separate timer.
- `ask_human` (D15): recorded on `session.question` through `updateActivation` → the activation
  reports `awaiting-human` (`observeAfterMs: null`), the run `waiting`. The call holds up to
  `GRAPH_ASK_HUMAN_HOLD_MS` (45 s, under every provider's MCP tool timeout) and returns the answer
  as its tool result (`delivered: "tool"`, claimed atomically with the answer write); otherwise it
  tells the agent to end its turn, and the executor sends the answer as the next turn in the same
  session once the asking turn settled (`delivered: "turn"`). A backend restart keeps the
  question (record) and loses only the held call; a re-ask of the same text re-attaches. Answers:
  `answered` (text and/or one of the choices) or `declined`; stale, malformed or oversized ones
  are refused (`graphAgentAnswerProblem`); a cancelled or timed-out step releases the call. Answer
  text reaches the agent only inside an evidence frame. At most 8 questions per activation.
- `read_artifact(id, path?)`: only ids in the activation's inputs, verified first, ≤ 64 KiB of JSON
  per read (larger parts return their shape and a hint); reference artifacts return their file
  and descriptor. `report_progress(resultKey, item)`: the port must take items; the item is
  checked against the list's element schema and ≤ 8 KiB; entries wait in an in-memory inbox
  (bounded) and fold into `session.progress` on the next observation; the accepted result drops
  them.
- Opt-in groups: tickets (read/write) and mail/schedules (when agent messaging is on, acting as
  the environment's caller mailbox) are registered on the activation's credential; transcript
  artifacts use the per-turn artifact grant (`artifactTurns`).
- OpenCode: graph outputs go through the broker's `submit_graph_output` with each slot's key and
  one capability (the activation capability, which `brokerAttempt` now accepts for a key it
  covers); the broker always lists the three extra tools (authorized per call); the contract
  names the generic tools (`resultTools: "broker"`).
- `session: "continue"`: the compiler's §5.2 checks stand (`session-not-predecessor`,
  `session-role-mismatch`, `session-replicated`, `session-source-invalid`); the runtime sends the
  turn into the source activation's provider session (`continuedFrom`), counting its usage from
  the source's counters.
- Item ids: `<node>[.<branch>][@<iteration>]/<idPrefix>-<n>` for types with `items`.
- Consumption: an accepted slot whose consumption fails is retried in memory on later calls
  (bounded); environment deletion removes the rest.
- Bridges: see `docs/architecture/agent-engines.md` "Graph activation turns". Claude and Cursor
  hold keys for graph turns only, so kind-tool turns keep the backend's key-naming refusal.

**2026-10-29 · Left for later items.** Rendering input item ids into user-template prompt frames
(cite provenance needs them; built-in consolidation stamps them) is not done — 205/301. Durable
transcript capture: the executor calls `captureTranscript` on settling turns and records the
returned reference; 211 supplies it.

**2026-10-29 · Audit: log prefix.** The shared branch runner logged graph
activations under `[review-fanout]`. `AgentBranchHost.logPrefix` (default
`AGENT_BRANCH_LOG_PREFIX`, `[review-fanout]`) now prefixes the runner's,
commit queue's and observation's lines; `GraphAgentHost` sets `[graph-agent]`
and the describe host `[graph-describe]`. Review logs are unchanged. Test:
`agent-branch-log-prefix.test.ts`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Extracted `AgentBranchRunner` from the reviewer fan-out, behaviour-neutral. · Graph agent executor next.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Graph agent node executor on the runner: policy and tier first, journaled dispatch, per-port slots and activation tools, `ask_human`, session continue, workspace outputs, bridges taught per-port tools, push-free built-ins; tests incl. seeded restart interleavings. · complete; awaiting PR
- 2026-10-29 · coordinator · Ticked the Phase 2 exit criterion on unchanged engine suites, citing this item's commits. · Awaiting PR.
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · graph activations log under `[graph-agent]` · awaiting PR
