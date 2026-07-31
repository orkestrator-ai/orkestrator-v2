# Milestone 1 — Contract, facts, and failure injection

Status: In progress

Depends on: Nothing

Unblocks: Milestones 2 and 3

## Outcome

Establish one bounded provider-neutral interaction vocabulary, one persisted
session-policy model, and reproducible fixtures before changing production
behavior.

This milestone also answers the blocking implementation question: whether
Claude's `canUseTool` callback receives `AskUserQuestion` under
`permissionMode: "bypassPermissions"`.

## Scope

Primary files:

- `packages/protocol/src/agent-interactions.ts` (new)
- `packages/protocol/src/agent-interactions.test.ts` (new)
- `packages/protocol/package.json`
- `packages/protocol/src/build-pipeline.ts`
- `packages/protocol/src/review-workflow.ts`
- `apps/backend/src/core/models.ts`
- `apps/backend/src/core/storage.ts`
- `apps/backend/src/core/native-agent-service.ts`
- `bridges/claude-bridge/src/services/session-manager.ts`
- provider bridge/adapter fixtures and focused tests

## Contract checklist

- [x] Add provider, interaction-kind, origin, state, presentation, resolution,
      apply-result, and policy types.
- [x] Cover questions, plan/command/file approvals, permissions, MCP form/URL
      elicitations, generic elicitations, and terminal selections.
- [x] Keep normalized IDs opaque and stable for the request lifetime.
- [x] Keep option identity separate from display labels and provider values.
- [x] Retain provider generation/session/thread/item identity behind adapters.
- [x] Represent `expiresAt` as authority-owned absolute epoch milliseconds and
      allow absence only when the authority publishes no deadline.
- [x] Add exhaustive runtime guards and public package export.
- [x] Add explicit maximums for request count, question count, option count,
      text length, answer count, free-text bytes, and serialized payload bytes.
- [x] Reject unknown kinds, duplicate question IDs, invalid option references,
      cross-session answers, invalid timestamps, and oversized payloads.
- [x] Prove secret answer values cannot enter draft, app-owned persistence,
      transcript-event, failure-summary, or telemetry serializers.

## Policy and persistence checklist

- [x] Define `interactive` and `unattended` policies.
- [x] For unattended input requests, encode `decline-and-continue`.
- [x] For unattended authorization requests, encode `deny-and-fail`.
- [x] Treat unknown unattended kinds as `deny-and-fail`.
- [x] Add session origin and policy to backend-created logical session metadata.
- [x] Default existing user-created sessions to `interactive` during migration.
- [x] Add a versioned, bounded interaction-resolution journal with states such
      as `claimed`, `provider-resolved`, and `workflow-recorded`.
- [x] Include the pipeline/review generation or revision fence in each claim.
- [x] Add `interactive-request` to build and review failure kinds for denied
      authorization requests or unsafe response failures.
- [x] Define bounded attempt/workflow summaries: provider, kind, phase, session
      ID, timestamps, outcome, and count—never full request content.
- [x] Add normal cleanup rules for terminal journal records.

## Baseline and fact-finding checklist

- [x] Add a focused Claude test that forces `AskUserQuestion` while using
      `bypassPermissions`.
- [x] Record whether `canUseTool` parks the request or the SDK auto-allows it.
- [x] Add a comment beside the relevant Claude tool configuration documenting
      the pinned behavior and enforcement implication.
- [x] Confirm whether the tmux ten-minute timeout is intentional. Preserve it
      with a rationale if hook/poll latency requires it; otherwise plan the
      shared five-minute value in Milestone 2.
- [x] Record current block duration and visible status for Claude, OpenCode,
      and Codex in a build pipeline.
- [x] Record current looped-review behavior for every provider when a question
      is issued.
- [ ] Verify current authoritative snapshots and reconnect callers for each
      interactive provider before changing their contracts.

## Failure-injection fixtures

- [ ] Create a deterministic provider fixture that asks one question despite
      “do not ask” prompt guidance.
- [ ] Create a deterministic fixture that requests one unexpected permission
      or approval.
- [ ] Cover Claude, OpenCode, and Codex with equivalent product-level cases.
- [ ] Add duplicate-label and comma-containing-option fixtures.
- [ ] Add short-deadline, provider-withdrawal, stale-response, and
      generation-death fixtures.
- [ ] Scrub fixtures and confirm they contain no real prompt, file, path,
      credential, token, or attachment content.

## Required tests

- [x] All supported contract kinds and states validate.
- [x] Invalid, unknown, cross-session, and oversized objects fail validation.
- [x] Policy and journal versions round-trip through storage.
- [x] Existing persisted sessions migrate to `interactive` without data loss.
- [x] Secret-bearing inputs are rejected by app-owned persistence serializers.
- [ ] Provider fixtures reliably force the requested interaction.
- [x] Claude's headless behavior test is stable in isolation and in the bridge
      suite.

## Commands

```bash
bun test packages/protocol --parallel
bun test bridges/claude-bridge/src/services/session-manager.test.ts --parallel
bun run --cwd packages/protocol typecheck
bun run --cwd apps/backend typecheck
```

## Exit criteria

- [ ] The shared contract, bounds, guards, exports, policy, and persistence
      versions are implemented and tested.
- [ ] Claude's actual `bypassPermissions` behavior is documented by a test.
- [ ] The tmux deadline decision is recorded.
- [ ] Baseline provider/surface behavior and invisible-wait duration are
      recorded.
- [ ] Every provider can be forced to produce both an input request and an
      authorization request in tests.
- [ ] No production policy behavior changes in this milestone.

## Evidence and decisions

Record:

- Claude `AskUserQuestion` result and chosen future enforcement hook;
- tmux timeout rationale and selected value;
- baseline behavior matrix with elapsed times;
- final contract limits and persistence version;
- fixture scrub results;
- focused test and typecheck output.

### Evidence recorded 2026-07-31

- Claude SDK fact: a bounded live probe against
  `@anthropic-ai/claude-agent-sdk` `0.3.219` forced one
  `AskUserQuestion` under `bypassPermissions`. `canUseTool` was invoked once and
  a deliberately delayed callback was awaited for at least 250 ms. The SDK
  warns that ordinary tools are auto-approved before `canUseTool`; therefore
  `canUseTool` is the input-request hook, while authorization enforcement needs
  `PreToolUse` or an equivalent provider-authoritative path.
- Tmux timeout decision: the existing hook timeout is 600 seconds. The hook
  checks responses four times per second and the backend polls at 250 ms, so no
  transport-latency requirement justifies ten minutes. Milestone 2 should use
  the shared five-minute authority and publish its absolute deadline; Milestone
  1 preserves production behavior.
- Current build-pipeline baseline from focused source/tests:

  | Provider | Question/input behavior | Authorization behavior | Pipeline-visible state |
  | --- | --- | --- | --- |
  | Claude | `AskUserQuestion` parks in the bridge for up to 5 minutes; no backend interaction monitor | `bypassPermissions` auto-allows ordinary tools | Session remains `running`; request is only visible through the interactive bridge surface |
  | OpenCode | Backend monitor rejects immediately and marks the owned session blocked/error | Backend monitor replies `once` immediately | Question becomes an error; permission is invisible and pipeline continues |
  | Codex | App-server retains the pending request until its 5-minute fail-closed deadline; no backend interaction monitor | Same pending approval path | Session remains `running`; request is only visible through the interactive bridge surface |

- Current looped-review baseline: Claude and Codex use backend-admitted logical
  sessions but phase advancement is renderer-owned and does not monitor pending
  interactions, so questions park and appear as continued `running` work.
  OpenCode's provider-specific monitor rejects questions and turns the session
  into an error; permissions are currently answered `once`. New logical review
  sessions now persist `origin: "looped-review"` with the unattended policy,
  but Milestone 1 does not enforce it.
- Final contract limits: 64 pending requests; 16 questions per request; 32
  options per question; 16,384 characters per text field; 16 answers; 16,384
  UTF-8 bytes per free-text answer; 256 KiB per serialized payload; 512 journal
  entries; 64 workflow summaries. Contract, policy, journal, and summary
  versions are all `1`.
- Validation completed: protocol suite 172 tests (including the new contract),
  native-session/storage focused suites 96 tests, selected web suites 129
  tests, and the isolated Claude session-manager suite 281 tests all passed.
  Protocol, backend, and web typechecks passed.
- Fixture scrub evidence is still pending because the provider failure-injection
  fixtures have not yet been added.
