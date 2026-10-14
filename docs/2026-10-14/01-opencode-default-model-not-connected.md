# OpenCode defaults to a model whose provider is not connected

Status: Active — found 2026-10-14 during live QA, not fixed.

**Severity: high.** A user whose OpenCode login covers only some of the
allowlisted providers cannot send the first prompt in a new OpenCode tab, and
every OpenCode build with no explicit model fails at its first turn.

## Symptom

On a host whose OpenCode login has exactly one connected provider,
`opencode-go` (`~/.local/share/opencode/auth.json`), with the default provider
allowlist `["opencode", "opencode-go"]`
(`DEFAULT_OPENCODE_MODEL_PROVIDERS`, `packages/protocol/src/native-agent.ts:151`):

- A new OpenCode tab preselects `opencode/claude-sonnet-5`, shown as
  "claude-sonnet-5 (Default)". "(Default)" is the reasoning label
  (`apps/web/src/components/chat/AgentModelPicker.tsx:797-798`), not a claim
  that OpenCode chose the model. The first prompt is rejected:
  "The selected OpenCode model is not connected or is no longer available.
  Choose an available model and retry."
- `create_feature_build` with `agentType: "opencode"` and no step model
  started its build session on `opencode/claude-sonnet-5` and the pipeline
  failed with the same error. Two QA pipelines failed this way before the
  model was pinned explicitly.
- After the model was switched to `opencode-go/deepseek-v4.1-flash`, turns,
  compaction, fork and a full build stage all worked.

## Root cause

The default model is chosen without looking at connectivity, at every layer:

1. **The shipped default is a fixed model in a provider many users do not
   have.** `DEFAULT_OPENCODE_MODEL_ID = "opencode/claude-sonnet-5"`
   (`apps/backend/src/core/storage-opencode-models.ts:60`), written into fresh
   configuration (`storage-shared-core.ts:1936`,
   `apps/web/src/stores/configStore.ts:104`).
   `selectableOpenCodeDefaultModel` (`storage-opencode-models.ts:84-106`) and
   `normalizeOpenCodeRepositoryDefaults` (`:127-161`) repoint a default only
   when its provider is outside the allowlist. They have no connectivity
   input, and their fallback is the same shipped default.
2. **Tabs create the session with that model before anything checks it.**
   `apps/web/src/components/native-agent/AgentNativeTab.controller.tsx:246-252` passes the configured model as
   `defaultAgentModel`. `useNativeAgentSession.connect()` sends it to
   `ensureNativeAgentSession` (`apps/web/src/hooks/useNativeAgentSession.ts:2478-2492`).
   The backend stores it as the session's controls
   (`native-agent-service-base.ts:849-864`), which outrank the catalogue in
   `resolveNativeComposerModelId` (`packages/protocol/src/native-agent.ts:254-262`).
   When the connected-only catalogue does not contain the id,
   `withResolvedNativeComposerModel` (`native-agent.ts:273-311`) adds a
   synthesized row for it. That is why the picker shows the lowercase
   id rather than a catalogue name.
3. **Builds resolve the same configured model.** With no step model,
   `stepSettings` (`build-pipeline-service-recovery.ts:436-467`) falls back to
   `connectionDefaultsFor` → `resolveAgentPlatformSettings(...).model`
   (`build-pipeline-service-helpers.ts:200-219`). `createProvider` passes it as
   the connection model (`build-pipeline-service-recovery.ts:598-611`), and
   `OpenCodeProvider.send` rejects it in preflight
   (`opencode-provider.ts:750` → `opencode-provider-helpers.ts:120-160`).
4. **The model list pickers read is not filtered by connectivity.**
   `get_native_agent_model_catalog`
   (`apps/backend/src/core/commands-registry-projects.ts:547`) returns the
   durable cache when no bridge is running, and `rawModelCatalog()`
   (`opencode-provider.ts:417-431`, `requireConnected: false`) when one is. Both
   are filtered by the allowlist only (`:680-682`, `:720-722`, `:751-754`).
   The durable snapshot (`OpenCodeModelCatalogEntry`, `apps/backend/src/core/models.ts:172-196`;
   `cacheOpenCodeModelCatalog`, `storage-config.ts:316-359`) does not persist
   which providers are connected, so even a pre-bridge read cannot know.
   Only `preflightOpenCodeModel` and the fallback guard in
   `selectOpenCodeComposerCatalog` (`opencode-model-catalog.ts:490`) read
   `connected`.
5. **OpenCode's own default is never parsed.** The v2 SDK types
   `provider.list().default` as `{ [providerID: string]: modelID }`
   (`@opencode-ai/sdk@1.19.0`, `dist/v2/gen/types.gen.d.ts:7960`).
   `openCodeCatalogDefault` (`opencode-model-catalog.ts:148-178`) only reads
   `default.model.{providerID,modelID}`, `default.providerID`/`provider` and
   `default.modelID`, so against a real response it returns `{}`. Catalogue
   default selection therefore always falls through to `models[0]`. The test
   mocks use the shape the parser expects rather than the SDK's
   (`opencode-provider-runtime.test.ts:760`, `797`, `1073`, `1166`, `1234`,
   `1266`), which is why this was never caught.

## Fix

One connectivity-aware notion of "the effective OpenCode default", used
everywhere a default is chosen:

1. Parse `provider.list().default` as the SDK map. Choose the first entry whose
   provider is both allowlisted and in `connected`. Fix the test mocks to the
   real shape, with a fixture taken from a live `provider.list` response.
2. When the configured model's provider is not connected (OpenCode positively
   reports `connected` and the provider is absent), substitute the effective
   default:
   - for tabs, in the value the renderer uses as `defaultAgentModel` (or in
     `ensureSession` before it stores controls);
   - for builds, in `connectionDefaultsFor` / `resolveSelection`
     (`build-pipeline-service-recovery.ts:510-536`, which already has a
     catalogue reader). Both `stepSettings` and `createProvider` go through it.

   Do not overwrite the user's saved configuration. Substitute at resolution
   time and keep the explicit choice for when the provider reconnects.
   Surface the substitution, for example "Claude Sonnet 5 isn't available with
   your OpenCode login; using DeepSeek V4.1 Flash".
3. Persist `connectedProviderIds` (with a timestamp) next to the durable
   catalogue snapshot, so pre-bridge pickers can mark or hide disconnected
   providers. When a bridge is live, return the connected list
   (`listProjectionModels`) to pickers while still caching the raw one.
4. Reconsider whether a fixed `DEFAULT_OPENCODE_MODEL_ID` should ship at all,
   or whether "unset" should mean "OpenCode's own connected default".

## Tests that pin today's behaviour

These will need deliberate updates:

| Behaviour | Tests |
| --- | --- |
| Shipped default `opencode/claude-sonnet-5` | `apps/backend/src/core/storage.test.ts:57`, `apps/web/src/stores/configStore.test.ts:13` |
| Allowlist-only repointing to the shipped default | `storage.test.ts:452-593` (for example line 471) |
| Raw catalogue unfiltered | `opencode-provider-runtime.test.ts:1359-1395` |
| Allowlist-only catalogue command | `commands-state-sync.test.ts:854`, `1060`, `1080`, `1095-1147` |
| Wrong `default` shape in mocks | `opencode-provider-runtime.test.ts` lines listed above |
| Composer resolution order | `packages/protocol/src/native-agent.test.ts` |

New tests should cover a login with only `opencode-go` connected: a new tab's
first prompt dispatches, a build with no step model starts, and the picker
does not preselect a disconnected model.
