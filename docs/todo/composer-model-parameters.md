# Composer model parameters

Checked against `main` at `2459b05c` (2026-10-15).

Every model axis should render through the generic `parameters` descriptors,
with its value held in backend session state, and no axis should need its own
UI. The descriptor model is in place and drives Claude, Cursor, ACP and Pi
controls. What is left is either migrating the two legacy axes (reasoning and
speed) onto it or recording that both models stay, plus four values the bridges
forward that nothing in the backend supplies.

## Current state

- Protocol (`packages/protocol/src/native-agent.ts`):
  - `AgentModel.parameters` (`AgentModelParameter[]`);
  - `NativeAgentComposerState.parameterValues` and `persistedDefaults`;
  - `SUPPRESSED_COMPOSER_PARAMETERS` with `isSuppressedComposerParameter`, the
    single list of parameters the input bar must not show.
- The backend builds composer controls from `parameters` generically
  (`native-agent-service-shared.ts`) and keeps `parameterValues` in session
  state, so a reload restores them.
- Per provider:
  - Claude: `thinking` and `context1m` from `claudeModelParameters`
    (`packages/protocol/src/claude-model-catalog.ts`). Both are suppressed in
    the input bar as settings-backed session defaults. They are applied live
    through `applyClaudeLiveSettings` (`setMaxThinkingTokens`) when a turn joins
    a running CLI; the 1M-context beta is a launch option.
  - Cursor: `thinking`, `context` and `cyber` (`bridges/cursor-bridge/src/models.ts`).
    The retired `variant` cross product is suppressed.
  - ACP: agent config options become parameters
    (`bridges/acp-bridge/src/session-config.ts`).
  - Pi: `setModel(model, { persist })` through `applyComposerToSession`
    (`bridges/pi-bridge/src/agent-session.ts`).
- Legacy axes: `AgentModel.reasoning`, `defaultReasoningId` and `supportsSpeed`
  are still separate fields, and the renderer's launch paths still build or read
  them (`apps/web/src/lib/agent-launch.ts`, `BuildLaunchDialog.tsx`,
  `FeatureBuildFields.tsx`). OpenCode variants and Grok effort map onto
  `reasoning`.
- Forwarded but unsourced:
  - Codex: the bridge reads `parameterValues.summary` and `personality`
    (`bridges/codex-bridge/src/app-server-runtime-lifecycle.ts`) and sends them
    on `turn/start` / `thread/start`. No Codex catalogue advertises either
    parameter, and no setting supplies them. `SUPPRESSED_COMPOSER_PARAMETERS`
    still hides `parameter:summary` with the comment "configured outside the
    input bar".
  - Claude permission mode: `http-bridge-prompt-body.ts` forwards
    `parameterValues.permissionMode` (falling back to `bypassPermissions`), and
    the bridge route accepts `acceptEdits`. No descriptor offers it.
  - Claude budget: the bridge forwards `options.maxBudgetUsd` and handles
    `error_max_budget_usd` (`session-manager-prompt-handlers/result.ts`).
    Nothing in `apps/backend` supplies it.

## Outstanding work

### Code

1. **Codex reasoning summary and personality.** Either add an agent or
   environment setting that supplies `summary` and `personality`, and advertise
   `summary` where `model/list` reports support, or remove the bridge plumbing
   and the `parameter:summary` suppression entry. Do not leave a suppression
   for a control nothing produces.
2. **Reasoning and speed axes.** Migrate `AgentModel.reasoning` /
   `supportsSpeed` onto `parameters`, keeping the old fields as aliases until
   the renderer reads only `parameters`. Move OpenCode variants and Grok effort
   with them. Or record a decision to keep both models, with the reason, in
   `native-agent.ts`. Done when one of the two is true and no renderer code
   branches on the axis name.
3. **Claude `parameterValues.permissionMode`.** `acceptEdits`, `auto` and
   `default` are now approval modes (`controls.approvalMode`, see
   [Approval modes](../architecture/agent-engines.md#approval-modes)), so no
   descriptor will ever offer this parameter. Stop forwarding it from the
   prompt body and the `/config` route.
4. **`maxBudgetUsd`.** Add a backend-owned per-environment budget setting, with
   `error_max_budget_usd` mapping to a `stopped` notice, or drop the option from
   the bridge.
5. **A stored model the catalogue does not offer.** Found in the slash-command
   qualification run (2026-10-17, `31d0fb06`, Codex 0.162.1, ChatGPT login):
   - A new profile's default Codex model is `gpt-5.4`
     (`storage-shared-core.ts:1941`). The renderer creates the tab's session
     with it, so the session stores `controls.modelId: "gpt-5.4"`.
   - That login's `model/list` does not offer `gpt-5.4`, so the projection
     reports the first catalogue model (`selectedModelId: "gpt-6.1-sol"`) and
     the picker shows it.
   - Turns still run the stored model. The Codex bridge uses
     `session.config.model` (`app-server-runtime-prompt.ts:459`), and the
     dispatch's own `model` (`gpt-6.1-sol`) only seeds a new session
     (`native-agent-service-provider.ts:366`). Every turn fails with "The
     'gpt-5.4' model is not supported when using Codex with a ChatGPT
     account", while the picker shows a model that would have worked.

   Make the shown and the run model the same. Either resolve an unoffered
   stored model to the catalogue's choice and persist it, or show the stored
   model as unavailable and refuse to send until the user picks one. Check the
   other providers for the same fallback. The live slash-command spec works
   around it by launching Codex on `ORKESTRATOR_AGENT_TEST_MODEL`.

   The Codex sub-agent qualification independently reproduced this with both
   the composer and an explicit `ensure_native_agent_session` model. Evidence:
   [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md#codex-sub-agent-cards-evidence).

### Qualification

- Change an extra Cursor axis, send a turn, reload, and confirm the value comes
  back from the backend.
- After item 2: the reasoning and speed controls on every platform round trip
  through `NativeAgentControlUpdate` and survive a reload.

## Constraints and rationale

- The backend owns the selection state. The renderer renders descriptors and
  sends `NativeAgentControlUpdate`; it never decides which axes exist.
- One suppression table. Every projection path and renderer filters through
  `isSuppressedComposerParameter`, so a control hidden on one read cannot
  reappear on another.
- Provider-only axes are fine; provider-only UI is not.
- Approval behaviour is bounded by the execution policy. The compose bar's
  approval mode chooses within that bound and never widens it.
- A parameter whose change needs a new process is launch-only: changing it
  against a running Claude CLI is a conflict, not a silent relaunch.

## Open questions

- Is migrating reasoning and speed worth the churn, given that both already
  render correctly?
- Should a Claude budget cap be per environment or per agent default?

## Related

- [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md) (live
  setting changes need a warm Claude runtime between turns).
- [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md)
  (execution policy and approvals).

## Replaces

- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md` (except the
  mid-session item, which moved to
  [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.9 and the composer half
  of §3.11; Cursor §6.9)
