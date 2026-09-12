# 10 — Composer: model axes and settings

**Status:** 🟨 In progress · ~60% · Depends on: 02

Refreshed 2026-09-11. Generic `parameters` / `parameterValues` drive composer
controls for Claude, Cursor, Pi, and ACP. Still open: Codex
`summary`/`personality`, reasoning/speed alias cleanup, mid-session Claude
parameter changes (blocked on plan 05), browser QA.

## Goal

The composer already renders generic control descriptors (`select`,
`segmented`, `toggle` in `packages/protocol/src/native-agent.ts:367-392`)
built by the backend from a fixed set of axes: model, reasoning, speed,
mode, execution profile. Several SDKs expose more axes that are dropped today
(Cursor `thinking`/`context`/`cyber` and variants, Claude thinking budget and
betas, Codex reasoning summaries, Pi persisted defaults) and some existing
axes are only partly wired (Claude permission modes). Make model parameters a
generic, per-model descriptor list so any axis renders through the same
controls, and keep the selection state in the backend.

## Normalized model

`AgentModel` (`native-agent.ts:96-111`) gains:

```
parameters?: Array<{
  id: string                     // "thinking", "context", "effort", …
  label: string
  kind: "select" | "toggle"
  options?: Array<{ id: string; label: string; description?: string }>
  defaultValue?: string | boolean
  scope: "session" | "turn"      // whether changing it mid-session is cheap
}>
```

`NativeAgentComposerState` gains `parameterValues?: Record<string, string |
boolean>` and `NativeAgentControlUpdate` accepts the same. The existing
`reasoning` and `speed` axes become the first two entries of `parameters`
over one release, with the old fields kept as aliases until the renderer
reads only `parameters`.

`NativeAgentComposerState.persistedDefaults?: boolean` lets a "make this my
default" toggle render only where a provider can persist (Pi, Claude
`updateSettings`).

## Tasks

### Protocol, backend, renderer

- [ ] Add `parameters`, `parameterValues`, `persistedDefaults`; protocol
  tests. `native-agent-service-shared.ts:459-547` builds controls from
  `parameters` generically; reasoning and speed migrate onto it.
- [ ] Renderer: the compose bar renders `parameters` through the existing
  descriptor components; delete any remaining per-axis special cases that
  are not presentation.
- [ ] Backend persists `parameterValues` per session in the projection so a
  reload restores them; the bridge is told through the existing
  `/session/:id/config` route.

### Cursor bridge

- [ ] Map `ModelListItem.parameters` fully (`models.ts:16-17` drops
  `thinking`, `context`, `cyber`) and `variants` as a `select`; send them
  through `SendOptions`/`AgentOptions` per turn. `aliases` populate
  `AgentModel.aliases`.

### Claude bridge

- [ ] `thinking` as a parameter: `adaptive` (default) vs an explicit budget
  (`ThinkingEnabled { budgetTokens }`) vs `disabled`; today hard-coded at
  `session-manager-prompt.ts:777`. Effort stays the reasoning axis.
- [ ] `betas` as a toggle for the 1M-context beta where the model supports
  it; report the resulting context window in usage (plan 11).
- [ ] Permission mode: the route accepts six modes but the backend sends two
  (`http-bridge-provider.ts:406`). Expose `acceptEdits` as a third generic
  mode option ("Auto-accept edits") on the existing `mode` axis for Claude,
  and leave `dontAsk`/`auto`/`default` unexposed with a comment.
- [ ] Mid-session change via `setModel()`/`applyFlagSettings()` when plan 05
  has landed; until then, `scope: "session"`.
- [ ] `maxBudgetUsd` as an optional per-session cap set from Orkestrator's
  environment settings (backend-owned); the SDK's `error_max_budget_usd`
  result then maps to a `stopped` notice.

### Codex bridge

- [ ] `summary` (reasoning summary level) on `turn/start` as a parameter
  where `model/list` reports support; `serviceTier` already sent.
- [ ] `personality` on `thread/start`/`turn/start` only if the backend has
  an environment-level setting for it; otherwise leave absent and note it.

### Pi bridge

- [ ] `persistedDefaults: true`; when the user chooses "make default", call
  `setModel`/`setThinkingLevel` with `{ persist: true }` (never persisted
  today, `agent-session.ts:550,561`).
- [ ] `scopedModels`/`cycleModel` are not needed for the picker; leave
  unused with a comment.

### OpenCode and Grok

- [ ] OpenCode variants already map to reasoning; move them onto
  `parameters` with the migration. Grok `--reasoning-effort` likewise.

## Verification

- [ ] Backend tests: control list built from `parameters` for each
  platform's fixture catalogue.
- [ ] Renderer tests: descriptors render; a `toggle` and a `select` round
  trip through `NativeAgentControlUpdate`.
- [ ] Browser: Cursor fixture shows the extra axes; change one, send a turn,
  reload, confirm the value persisted from the backend.

## Out of scope

Provider selection for OpenCode/Pi beyond what exists. Codex `config/*`
writes (config stays CLI overrides at spawn, see plan 12 for policy).
