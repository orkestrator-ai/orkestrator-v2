# 11 — Usage, cost and limits

**Status:** 🟨 In progress · implementation complete, awaiting browser QA and merge · Depends on: 02

## Goal

`NativeAgentContextUsage` (`packages/protocol/src/native-agent.ts:564-597`)
already has fields for tokens, cost, rate limits, credits and context
categories. Each adapter fills a different subset and several drop data the
SDK hands them. Fill the same shape from every provider, add per-turn cost,
and surface account-level usage generically where a provider reports it.
No new renderer surface beyond the existing usage panel; the Cursor-only
account panel becomes the generic one.

## Normalized model

- `NativeAgentContextUsage.turns?: Array<{ turnId; costUsd?; inputTokens?;
  outputTokens?; durationMs? }>` bounded to the last 20, for a per-turn
  breakdown.
- `NativeAgentContextUsage.account?: { window: string; usedPercent?;
  resetsAt?; spendUsd?; creditsRemaining? }[]` replaces the Cursor-specific
  `packages/protocol/src/cursor-usage.ts` shape. Cursor migrates onto it.
- `source` gains `"cursor" | "grok" | "pi"`.

## Tasks

### Protocol, backend, renderer

- [ ] Add `turns`, `account`, and the `source` values; protocol tests.
- [ ] Generalize `CursorAccountUsagePanel` into the usage panel's account
  section, fed from `account`; delete `cursor-usage.ts` once Cursor's adapter
  writes the generic shape.
- [ ] Projection merges per-turn entries from bridge events and keeps the
  bounded list across reloads.

### Claude bridge

- [ ] Fill `turns` from `result` (`total_cost_usd`, `duration_ms`, `usage`,
  `modelUsage` per model). Read `num_turns`, `ttft_ms` if present.
- [ ] Use `getContextUsage({ detail: "summary" })` for in-turn refreshes
  (`session-manager-core.ts:746-748` always takes the full path) and keep
  the full read for the panel open.
- [ ] Keep `rate_limit_event` mapping; add `permission_denials` count and
  contents to `permissionDenials`.

### Codex bridge

- [ ] `account/rateLimits/updated` is mapped; add `account/usage/read` on
  panel open for `account` windows. `thread/tokenUsage/updated` → `turns`
  per turn id.

### OpenCode (backend)

- [ ] `StepFinishPart.cost`/`tokens` (dropped today) → `turns`; keep
  `info.tokens` as the session total. `session.context` is v2 and stays out.

### Cursor bridge

- [ ] `agent.getUsage({ runId })` per run → `turns` with `rawCostCents` and
  `chargedCents`; `AgentUsage.runs[]` for the list. Write the account
  windows into `account` instead of the Cursor-only shape.
- [ ] `RunResult.requestId` and `model` onto the turn entry for support
  requests.

### Grok bridge

- [ ] Accept Grok's `costUsdTicks` (rejected as undocumented,
  `usage.ts:86-90`) once the unit is confirmed against one real turn; record
  the conversion and the evidence in the adapter comment. Until confirmed,
  keep it out but stop treating it as an error.
- [ ] Keep the uncorrelated-usage latch (`acp-session.ts:954-965`) but
  report it as a `warning` notice so a silently disabled usage source is
  visible.

### Pi bridge

- [ ] `getSessionStats()` → `turns` (tokens breakdown, tool calls) and
  `ContextUsage.percent` → `percentage` (plan 01 fixed the shape). Use
  `getLastAssistantUsage` instead of the hand-summed `turn_end` totals.

## Verification

- [ ] Bridge tests per platform: a fixture turn produces a `turns` entry and
  the session totals match the provider's own numbers.
- [ ] Browser: usage panel on two platforms shows per-turn rows and account
  windows; reload preserves the bounded list.

## Out of scope

Billing or pricing lookups Orkestrator does not already do. Codex
`account/rateLimitResetCredit/consume` and nudge emails.

## Implementation notes

- The provider-neutral projection now retains the newest twenty turn rows and
  sixteen account windows. Opening the information panel requests the richer
  provider snapshot without making billing metadata a transcript dependency.
- Claude, Codex, OpenCode, Cursor, Grok and Pi map their native usage into the
  shared shape. Grok's undocumented `costUsdTicks` remains intentionally
  ignored until its unit can be verified against a real billed turn.
- The generic panel renders account windows and recent turns even while the
  compatibility stores supply fresher live context counters. Automated bridge,
  projection and renderer coverage is in place; two-provider browser/reload QA
  remains required before merge.
