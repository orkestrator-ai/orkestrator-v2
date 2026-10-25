# Composer model parameters

Checked against `main` at `2459b05c` (2026-10-15). Code items finished on
branch `todo-0004-composer-model-params-803868a90fcb` (2026-10-25, from
`20f6de91`).

Every model axis that only some providers have renders through the generic
`parameters` descriptors, with its value held in backend session state, and no
axis needs its own UI. Reasoning and speed, which every provider has, stay
first-class `AgentModel` fields by recorded decision (item 2). Every
forwarded-but-unsourced value is resolved: Codex summary and personality, the
Claude `permissionMode` parameter and `maxBudgetUsd` are gone, and a per-turn
model on a Codex dispatch is now applied. What is left is a live Cursor
qualification run and one optional preflight case.

## Current state

- Protocol (`packages/protocol/src/native-agent.ts`):
  - `AgentModel.parameters` (`AgentModelParameter[]`) for provider-only axes;
    `reasoning` / `defaultReasoningId` / `supportsSpeed` for the two shared
    axes, with the reason recorded on `AgentModel`;
  - `NativeAgentComposerState.parameterValues` and `persistedDefaults`;
  - `SUPPRESSED_COMPOSER_PARAMETERS` with `isSuppressedComposerParameter`, the
    single list of parameters the input bar must not show: Claude `thinking`
    and `context1m`, Cursor `variant`. Codex has no entry.
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
  - Codex: no parameters. Its turns run the bridge session's `config.model`;
    a dispatch naming another model is applied to that config first
    (`apps/backend/src/core/native-agent-dispatch-model.ts`).
- The Codex bridge's `POST /session/:id/config` replaces the whole session
  config. The backend restates every field a control update leaves alone
  (`updateCodexSessionConfig` in `http-bridge-codex-config.ts`), so a model or
  fast-mode pick no longer resets a Plan session to Build.

## Outstanding work

### Code

1. ~~**Codex reasoning summary and personality.**~~ Done 2026-10-25: removed.
   The bridge no longer reads `parameterValues.summary` / `personality`
   (`app-server-runtime-lifecycle.ts` `toEngineConfig`), `EngineTurnConfig`
   drops both fields, and `turn/start` / `thread/start` no longer send them
   (`engine/app-server-engine.ts`). The `parameter:summary` suppression entry
   is gone, and the table's comment now says an entry needs a descriptor that
   produces it. Evidence: Codex's generated protocol marks `personality`
   deprecated on `TurnStartParams` and `ThreadStartParams` ("`friendly` and
   `pragmatic` no longer select a style") and `Model.supportsPersonality` as
   "Always false"; `Model` has no summary-support field, so `model/list` cannot
   report where `summary` is supported. Tests: the backend projection test now
   expects Codex to pass `parameter:summary` through
   (`native-agent-service-projection.test.ts`), and the renderer test
   "suppresses no Codex parameter control" (`AgentNativeTab.test.tsx`).
2. ~~**Reasoning and speed axes.**~~ Done 2026-10-25: decision recorded to keep
   both models, on the `AgentModel` doc comment in `native-agent.ts` (see
   Assumptions and decisions). No renderer code branches on an axis name: the
   input bar renders `reasoning` / `supportsSpeed` as fields and every
   `parameter:*` control generically, filtered only through
   `withoutSuppressedComposerControls`. Checked with a search of
   `apps/web/src` for parameter-id literals and `parameterValues.<id>` reads;
   none exist outside tests.
3. ~~**Claude `parameterValues.permissionMode`.**~~ Done. The prompt body and
   the bridge's `/config` route stopped reading it when approval modes shipped
   (#1015): the prompt's `permissionMode` comes from read-only, plan or
   `approvalMode`, and `/config` derives it from `mode` and `approvalMode`
   (`bridges/claude-bridge/src/routes/session.ts`, test "config applies %s
   and ignores stale permission parameters"). The residue went on 2026-10-25:
   a stored legacy value is dropped by every control update
   (`storage-native.ts`, `native-agent-retired-parameters.ts`) and is never
   forwarded in a prompt's `parameterValues` (`http-bridge-prompt-body.ts`).
   Tests: "drops a stored pre-approval-mode permissionMode value on any
   control update" (`storage-native-agent-sessions.test.ts`) and the
   `parameterValues` assertion in "runs Claude build turns in the session's
   approval mode" (`http-bridge-provider.test.ts`).
4. ~~**`maxBudgetUsd`.**~~ Done 2026-10-25: dropped from the Claude bridge.
   `PromptOptions.maxBudgetUsd`, the launch profile's `maxBudgetUsd` and its
   "cost budget" launch conflict, the SDK query option and the
   `error_max_budget_usd` notice are removed. A result with that subtype (which
   no longer occurs, since the option is never set) falls to the generic
   "Claude query failed" handling. The relaunch test that used it now toggles
   prompt suggestions (`session-manager-runtime-idle.test.ts`).
5. ~~**A per-turn model on a Codex dispatch.**~~ Done 2026-10-25: applied as a
   model pick is. `dispatchAdmittedPrompt` calls
   `applySessionHeldDispatchModel` after ensuring the session and before
   anything is journaled. For a platform whose policy has
   `runsSessionHeldModel` (Codex), an explicit model that differs from the
   stored `controls.modelId` goes through `updateNativeAgentSessionControls`
   with the provider's `updateInteractiveControls`, persisted under the
   session lease. An inherited default (`modelSource: "default"`) and
   platforms whose prompts carry the model are untouched. A dispatch
   `reasoningEffort` rides along; without one, Codex applies the new model's
   default effort. This exposed a real defect in the model-pick path itself,
   fixed in the same change: Codex `/config` is a full replace, so a model-only
   or fast-only update reset a Plan session to Build (read-only sandbox to
   full access) and the fast tier to off, while the backend's mode cache still
   said Plan, so the next Plan turn ran in Build. The backend now reads the
   current config and restates the untouched fields
   (`http-bridge-codex-config.ts`, split out of `http-bridge-provider.ts`,
   which also keeps that module under the 1,500-line provider limit). A 404/409 maps to the
   retryable `ProviderUnavailableError`. Tests:
   `native-agent-service-dispatch-model.test.ts` (applied before the turn,
   persisted, not reapplied; inherited default untouched; Claude unaffected)
   and four new cases in `http-bridge-provider.test.ts` (approval and fast
   updates restate the config, a model pick keeps Plan and fast and drops the
   old effort, a 409 is retryable, a durable mode update spares the next send
   a reconciliation).
6. **Refuse a Codex send on a model the login does not offer.** Done for a
   dispatch that changes the model (2026-10-25): before the change is applied,
   `provider.resolveDefaultModel` checks it against the live `model/list`
   (`supportedModelIds`, the same evidence rule as new sessions). On a positive
   "not offered" answer the prompt is refused with `PromptRejectedError`
   before journaling, so the draft is kept: "gpt-x isn't available with your
   Codex login, so this prompt was not sent. Pick another model, such as
   gpt-y, and send it again." An unreadable catalogue lets the dispatch
   proceed. Test: "refuses a Codex model the login does not offer, keeping the
   session's model".
   - **Open, optional:** a send on a session that already holds an unoffered
     model, with no model change, still reaches Codex and fails with its HTTP
     400, which names the model. Preflighting every send would add a
     `model/list` round trip (the bridge deliberately does not cache it) to
     every Codex turn. Do it only if the 400 proves confusing in practice;
     the shape would be a cached availability answer invalidated on account
     switch.

### Qualification

- Change an extra Cursor axis, send a turn, reload, and confirm the value comes
  back from the backend. Not run: it needs a real-stack browser session with a
  Cursor login (the CLI has no parameter control), and this branch changed no
  Cursor code. Unit tests cover a Cursor `parameterValues` update being
  validated and re-projected ("carries the bridge's premium indicator only for
  the selection it describes", `native-agent-service-projection.test.ts`), not
  the full change, turn and reload path.
- Live Codex check of items 5 and 6 and of the config-merge fix: in a Plan
  session, pick another model in the picker and confirm the next turn is still
  read-only; send a Control MCP `dispatch_native_agent_prompt` with another
  `model` and confirm the rollout's `turn_context.model`. Not run on this
  branch (unit and provider tests only).
- ~~After item 2: the reasoning and speed controls on every platform round trip
  through `NativeAgentControlUpdate` and survive a reload.~~ Not applicable:
  item 2 kept both models, so nothing moved. They already round trip as
  `reasoningId` / `fastMode` on `NativeAgentControlUpdate`.

## Assumptions and decisions

- **Codex summary and personality (item 1).**
  - Options: (a) add an agent or environment setting that supplies both and
    advertise `summary` where `model/list` reports support; (b) remove the
    bridge plumbing and the suppression entry.
  - Choice: (b).
  - Why: `model/list` has no summary-support field to advertise from, and
    Codex deprecated `personality` (no style is selected any more). A setting
    would be UI for a value Codex ignores (personality) or cannot advertise
    per model (summary).
  - Pros: no control nothing produces; one fewer suppression entry; smaller
    turn and thread payloads.
  - Cons: no in-app way to change Codex's reasoning summary. Codex's own
    `config.toml` (`model_reasoning_summary`) still applies. Re-adding it
    later means a descriptor from the bridge, not a suppression.
- **Reasoning and speed axes (item 2).**
  - Options: (a) migrate `reasoning` / `supportsSpeed` onto `parameters`,
    keeping aliases until the renderer reads only `parameters`; (b) keep both
    models and record why.
  - Choice: (b).
  - Why: every provider has both axes, so they are not provider-only. They are
    read far outside the session composer (launch dialogs, Build and Multi
    Review stages, settings defaults, the public API, coordinator launch
    defaults) before any session or backend composer state exists, and they
    persist as `reasoningId` / `fastMode`. Both already render correctly and
    without branching on the axis name. Migrating would touch about 30
    renderer and backend files for no user-visible change.
  - Pros: no churn or alias period; launch surfaces keep typed fields.
  - Cons: two shapes for model axes stay in the protocol; a provider that
    gains a third shared axis has to choose between them.
- **Claude `permissionMode` residue (item 3).**
  - Options: (a) leave the stored legacy value (bridges ignore it); (b) drop it
    on every control update and strip it from prompt bodies.
  - Choice: (b).
  - Why: the item asks that it is no longer forwarded, and a value nothing may
    act on should not survive in session state.
  - Pros: prompts never carry it; records clean themselves on the next
    control change.
  - Cons: a record that never gets another control update keeps it on disk
    (harmless, never sent).
- **Budget cap (item 4, and the open question "per environment or per agent
  default?").**
  - Options: (a) a backend-owned per-environment budget setting with
    `error_max_budget_usd` mapped to a `stopped` notice; (b) a per-agent
    default; (c) drop the option from the bridge.
  - Choice: (c).
  - Why: nothing in the product asks for a spend cap, most Claude logins are
    subscriptions where the SDK's USD figure is notional, and with a warm CLI
    across turns (0005) the SDK's per-query budget no longer maps to a turn
    or a session, so either setting would promise semantics it cannot keep.
    Dead plumbing also cost a launch-only conflict axis ("cost budget").
  - Pros: removes unsourced plumbing and a launch conflict; no setting with
    unclear meaning.
  - Cons: no spend cap. If one is wanted, it should be a new todo with its own
    design (scope, warm-runtime semantics, notice).
- **Per-turn model on a Codex dispatch (item 5).**
  - Options: (a) apply it to the session config before `turn/start`, as a
    model pick does; (b) reject a differing model with a message; (c) send
    `model` on the Codex prompt and change the bridge to apply it.
  - Choice: (a), in the backend service, keyed on `runsSessionHeldModel`.
  - Why: it matches how Claude, Cursor, Grok and Pi treat a dispatch model,
    keeps backend selection state, bridge config and the run model the same,
    and needs no bridge change (so it works with every bridge in the
    compatibility window). (c) would change the bridge's prompt contract and
    still leave the backend's stored selection stale.
  - Pros: the turn runs the requested model; the picker shows it; one code
    path for picks and dispatches.
  - Cons: a session started on Codex's unset default gets one config round
    trip on its first prompt that names a model (it then holds it). A
    dispatch's model change persists even if the send itself then fails,
    as a pick would.
- **Codex config merge (found while doing item 5).**
  - Options: (a) merge in the backend from a `GET /config`; (b) merge in the
    bridge's `updateConfig`.
  - Choice: (a).
  - Why: it fixes the defect against every bridge in the compatibility window
    and reuses the read `ensureCodexMode` already did.
  - Pros: no bridge contract change; Plan stays read-only across picks.
  - Cons: one extra bridge read per Codex control change (rare, user-driven).
- **Unoffered-model preflight (item 6).**
  - Options: (a) preflight every Codex send; (b) preflight only when a
    dispatch changes the model; (c) none (Codex's 400 already names the
    model).
  - Choice: (b).
  - Why: (b) catches the case the user just chose, at no cost to ordinary
    turns. (a) adds a `model/list` round trip to every turn.
  - Pros: an explicit wrong pick fails before anything is sent, with the
    draft kept and a model to pick named.
  - Cons: a session already holding an unoffered model still fails at Codex
    (listed as open above).

## Constraints and rationale

- The backend owns the selection state. The renderer renders descriptors and
  sends `NativeAgentControlUpdate`; it never decides which axes exist.
- One suppression table. Every projection path and renderer filters through
  `isSuppressedComposerParameter`, so a control hidden on one read cannot
  reappear on another. An entry needs a descriptor that produces it.
- Provider-only axes are fine; provider-only UI is not.
- Approval behaviour is bounded by the execution policy. The compose bar's
  approval mode chooses within that bound and never widens it.
- A parameter whose change needs a new process is launch-only: changing it
  against a running Claude CLI is a conflict, not a silent relaunch.
- The shown and the run model must be the same. Fixed for Codex on
  2026-10-17 (branch `fix/codex-stored-model-mismatch`, from `9da80451`), and
  for a Codex dispatch naming a model on 2026-10-25 (item 5). A new
  install's Codex default `gpt-5.4` is not in a ChatGPT login's `model/list`.
  The picker showed that list's first row while every turn ran `gpt-5.4` and
  failed with HTTP 400.
  - Codex turns run the bridge session's `config.model`; the prompt carries
    none. Claude, Cursor, Grok and Pi carry the composer's `selectedModelId`
    on every prompt (`AgentNativeTab.controller.tsx`, `send` options). For
    Codex the backend applies a differing dispatch model to the session first
    (`native-agent-dispatch-model.ts`).
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
    a wrong choice should fail loudly; a dispatch that changes the model to
    one the live list positively lacks is refused before sending (item 6).
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

- ~~Is migrating reasoning and speed worth the churn, given that both already
  render correctly?~~ No; see Assumptions and decisions (item 2).
- ~~Should a Claude budget cap be per environment or per agent default?~~
  Neither for now: the option was dropped (item 4).

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
