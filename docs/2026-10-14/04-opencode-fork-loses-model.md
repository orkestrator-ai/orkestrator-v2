# A forked OpenCode session does not keep its model

Status: Active — found 2026-10-14 during live QA, not fixed.

**Severity: medium.** A fork silently switches to whichever model happens to
be first in the catalogue, so the user's next prompt in the fork runs on a
different model, and possibly a different provider and price, from the
conversation it came from.

## Symptom

The source tab ran on `opencode-go/deepseek-v4.1-flash`. Agent Info → **Fork
session** opened "OpenCode 2" with the forked transcript, but its composer
showed **MiMo-V2.6-Pro (Default)**.

## Root cause

- `forkCurrent` (`apps/web/src/components/layout/AgentInfoButton.tsx:616-625`)
  → `fork_native_agent_session` (`commands-registry-native.ts:415`) →
  `forkProjectionSession` (`native-agent-service-dispatch.ts:715-727`) →
  `OpenCodeProvider.forkSession` (`opencode-provider.ts:1351-1369`). The last
  step returns only `{ sessionId, title }`, so the forked session's
  `Session.model` is dropped.
- `openForkTab` (`AgentInfoButton.tsx:497-529`) deliberately builds the tab
  without `initialAgentModel` or `initialReasoningEffort` (comment at 504-511).
  The in-tab fork (`apps/web/src/components/native-agent/AgentNativeTab.controller.tsx:1795-1844`) also adopts
  without controls.
- On mount, `connect()` adopts with no model
  (`apps/web/src/hooks/useNativeAgentSession.ts:2435-2443`), so the backend
  stores empty controls (`native-agent-service-base.ts:919`).
- With no controls, the composer depends on inferred hints. The OpenCode
  session-state view (`readProgressiveSessionState`,
  `native-agent-service-projection.ts:2656-2674`) builds them from
  `sessionStateSnapshot`, which carries neither messages nor composer
  (`opencode-snapshots.ts:77-125`). Its `sessionModel` comes only from stream
  events (`opencode-stream-state.ts:212-218`), and a freshly forked session
  has none yet.
- The catalogue default is also always empty (see
  `01-opencode-default-model-not-connected.md`, root cause 5), so selection
  falls to `models[0]`. The renderer then takes the state view's composer
  (`useNativeAgentSession.ts:1765`). That MiMo is the first catalogue row is
  inferred from the label, not confirmed against the provider order.

## Fix

Carry the source selection into the fork through the backend, so every fork
entry point gets it:

1. Add the source session's controls (or composer `selectedModelId` and
   `selectedReasoningId`) to `NativeAgentForkOutcome` in
   `forkProjectionSession`, and have the adopt call send them as `controls`.
2. Have `OpenCodeProvider.forkSession` return the fork's `Session.model`.
   Either seed the stream state's `sessionModel` from it, or include it in
   `sessionStateSnapshot`, so inference works even without controls.
3. Prefer this over setting `initialAgentModel` in `openForkTab`:
   `AgentInfoButton.test.tsx:3284-3334` (line 3329) asserts a fork tab has no
   `initialAgentModel`, and a backend-side fix also covers the in-tab fork.

Test: fork a session that ran on a non-first catalogue model and assert the
fork's composer selects the same model and reasoning profile, before any
prompt is sent.
