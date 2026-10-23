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
   [Approval modes](../../architecture/agent-engines.md#approval-modes)), so no
   descriptor will ever offer this parameter. Stop forwarding it from the
   prompt body and the `/config` route.
4. **`maxBudgetUsd`.** Add a backend-owned per-environment budget setting, with
   `error_max_budget_usd` mapping to a `stopped` notice, or drop the option from
   the bridge.
5. **A per-turn model on a Codex dispatch.** The Codex prompt body drops
   `model` (`http-bridge-prompt-body.ts`, the `agent === "codex"` branch), so a
   `dispatch_native_agent_prompt` or Control MCP `model` sent to an existing
   Codex session is silently ignored and the turn runs the session's model.
   Claude, Cursor, Grok and Pi carry it on every prompt. Either apply it to the
   session config before `turn/start` (as a model pick does) or reject a
   differing model with a message.
6. **Refuse a Codex send on a model the login does not offer.** An existing
   session that holds an unoffered model now shows it as "not offered to this
   login", but a send still reaches Codex and fails with its HTTP 400. A
   preflight against the live `model/list` could keep the draft and say which
   model to pick instead. Optional: the 400 already names the model.

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
- The shown and the run model must be the same. Fixed for Codex on
  2026-10-17 (branch `fix/codex-stored-model-mismatch`, from `9da80451`). A new
  install's Codex default `gpt-5.4` is not in a ChatGPT login's `model/list`.
  The picker showed that list's first row while every turn ran `gpt-5.4` and
  failed with HTTP 400.
  - Codex turns run the bridge session's `config.model`; the prompt carries
    none. Claude, Cursor, Grok and Pi carry the composer's `selectedModelId`
    on every prompt (`AgentNativeTab.controller.tsx`, `send` options), so for
    them the shown row is the one that runs and only Codex needed a fix.
  - New sessions: a Codex provider's `resolveDefaultModel`
    (`resolveCodexBridgeDefaultModel`, attached in `createNativeAgentProvider`)
    checks an inherited default against the bridge's `/global/models`. If the live list
    does not offer it, the session starts on that list's first model, which is
    the row the picker already falls back to, and the renderer's
    `modelSubstitution` toast says so. The rule is OpenCode's: it applies to
    defaults only and to that session only, and settings keep the user's
    choice so the default returns if the login changes.
  - Only `source: "app-server"` with `supportedModelIds` counts as evidence.
    That list is the complete `model/list` with `includeHidden`, so a model
    Codex supports but hides from the picker is kept. The bridge reads it on
    every request instead of caching it for the process lifetime, so an
    account switch cannot swap a default against the previous login's list.
    The bridge's persisted cache and hardcoded fallback can omit models the
    login serves, so they never trigger a swap. An unreadable or over-long
    list keeps the configured model.
  - An explicit or pinned model is never swapped. That covers a launch-dialog
    pick, a Build step's model and a public API `model`. The user chose it, so
    a wrong choice should fail loudly.
  - Build and Multi Review stages share the rule (`build-pipeline-service-
    agents.ts`, which was OpenCode-only), because a Codex stage on the
    unoffered default failed the same way.
  - Existing sessions: the platform policy's `runsSessionHeldModel` makes the
    projection add the held model as a row marked "session model"
    rather than show the first catalogue row. Nothing is persisted on a read.
    Picking any listed model replaces it through the normal control update.
    Discovery's models section is the shared catalogue, so the renderer keeps
    the selected model's row when discovery replaces the composer's models.
    Without that, the live UI still showed the first catalogue row.
  - The shipped default `gpt-5.4` stays. It is valid for API-key logins, and
    an unset default would hand the choice to Codex's own config while the
    picker showed the first row, which is the same mismatch again.
  - The replacement is the list's first row, not the `model/list` row marked
    `isDefault`. Using `isDefault` would need the bridge to forward that flag
    (`BridgeModel` drops it), and it could pick a model other than the one
    the picker shows for an unset selection.
  - Live evidence, 2026-10-17. Profile `dev:test --fixture --credential-source
    codex`, Codex 0.162.1, ChatGPT login, configured default `gpt-5.4`.
    - A new tab's toast read "gpt-5.4 isn't available with your Codex login;
      using GPT-6.1-Sol."
    - The picker showed GPT-6.1-Sol, and a turn replied with the rollout's
      `turn_context.model` equal to `gpt-6.1-sol`.
    - A tab launched explicitly on `gpt-5.4` showed `gpt-5.4` in the picker.
      Picking GPT-6.1-Sol ran the next turn on `gpt-6.1-sol` and removed the
      not-offered row.

## Open questions

- Is migrating reasoning and speed worth the churn, given that both already
  render correctly?
- Should a Claude budget cap be per environment or per agent default?

## Related

- [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) (live
  setting changes need a warm Claude runtime between turns).
- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  (execution policy and approvals).

## Replaces

- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md` (except the
  mid-session item, which moved to
  [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md))
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.9 and the composer half
  of §3.11; Cursor §6.9)
