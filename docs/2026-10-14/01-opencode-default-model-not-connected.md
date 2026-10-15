# OpenCode defaults to a model whose provider is not connected

Status: Fixed 2026-10-15, all four Fix points. See Resolution.

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

## Resolution (2026-10-15)

Re-checked against `523eb0da` before changing anything: every root cause above
was still present (`openCodeCatalogDefault` still read
`default.model`/`providerID`/`modelID`, and nothing substituted a disconnected
default).

1. **OpenCode's default is parsed as the SDK map.** `openCodeCatalogDefault`
   (`apps/backend/src/core/opencode-model-catalog.ts`) reads
   `{ [providerID]: modelID }` and takes the first entry whose provider is
   allowlisted and, when OpenCode reported `connected`, connected. The map
   carries no variant, so the catalogue no longer reports a
   `selectedReasoningId`. Test mocks use the real shape, and
   `opencode-provider-list-test-fixtures.ts` holds a trimmed live
   `GET /provider` response from OpenCode 1.19.0 (credentials removed), typed
   against the SDK's `ProviderListResponse`.
2. **One effective default, resolved when a session or stage starts.**
   `resolveOpenCodeDefaultModel` answers "which model does OpenCode run for
   this configured default", set or unset. A set model is kept unless
   `openCodeModelSubstitution` replaces it, which happens only when OpenCode
   positively reports `connected` and the model's provider is absent. Unset
   (or the `"default"` placeholder) resolves to the effective default:
   OpenCode's own default among the connected, allowlisted providers, then the
   first such model. It is resolved here rather than left to OpenCode's server,
   whose own default ignores the allowlist. OpenCode exposes this as the
   optional provider capability `resolveDefaultModel`.
   - Tabs: `NativeAgentServiceBase.ensureSession` resolves before it stores a
     new session's controls, so the picker preselects the resolved model and
     the first prompt dispatches. A substitution is returned as a transient
     `modelSubstitution`, which the tab shows as a toast. It is not persisted.
   - Builds: `resolveSelection` resolves a model that came from the configured
     defaults (no step model, or an unpinned step). A model the step pinned is
     left alone. Stage sessions, fan-out reviewers (`ReviewerRecord`) and the
     consolidation session (`ReviewConsolidationSession`) record
     `modelSubstitution`, and the stage rail shows its message as a notice line
     under the row.
   - Multi Review and looped review: they run the launcher's selection, and
     its "Default" reaches the provider as no model. `createBuildPipelineProvider`
     resolves such an unpinned session through the same capability at
     creation, starts it on the effective default, and names that model on the
     session's model-less turns.
   - The saved configuration is never rewritten by resolution, so the user's
     choice returns when the provider reconnects.
3. **Connectivity is persisted.** `OpenCodeModelCatalogSnapshot` gained
   `connectedProviderIds` and `connectedProvidersCheckedAt`.
   `cacheOpenCodeModelCatalog` stores them when given and keeps the last report
   when a source has none. `get_native_agent_model_catalog` persists the live
   report with the raw catalogue. With a live bridge, pickers get only the
   providers it reports as connected. Without one, the persisted report can
   predate a sign-in, so its disconnected providers are marked rather than
   hidden: cached rows and synthesized favourites carry `AgentModel.connected:
   false`, in the environment and coordinator branches.
   `get_opencode_model_catalog_cache` marks its entries the same way, so the
   create-environment dialog and the build and review launchers show them too.
   The shared model picker labels such a row "Not connected" and keeps it
   selectable.
4. **No fixed OpenCode default ships.** `DEFAULT_OPENCODE_MODEL_ID` is gone:
   fresh backend and renderer configs leave `platforms.opencode.model` unset,
   which settings shows as "OpenCode default" and resolves as in point 2.
   `selectableOpenCodeDefaultModel` repoints an allowlist-excluded default to
   the first selectable OpenCode favourite, or else clears it (globally, or for
   a repository, which then inherits). Stored values are kept as they are: a
   previously shipped default cannot be told apart from one the user chose, and
   point 2 substitutes it when its provider is not connected.

Pinned tests, as changed:

| Behaviour | Outcome |
| --- | --- |
| Shipped default `opencode/claude-sonnet-5` | Now unset in `storage.test.ts` and `configStore.test.ts` |
| Allowlist-only repointing to the shipped default | Repoints to a favourite or clears; `storage.test.ts` updated |
| Raw catalogue unfiltered | Unchanged; connectivity is persisted beside it instead |
| Allowlist-only catalogue command | Still holds with no connectivity report; new tests cover live (hide) and persisted (mark) connectivity |
| Wrong `default` shape in mocks | Mocks moved to the SDK map, plus real-fixture tests |
| Composer resolution order | Unchanged; the resolved model is what reaches session controls |

New tests for a login with only `opencode-go` connected:
`native-agent-service-provider.test.ts` (new tab: substitution, picker
preselection, first prompt dispatched on `opencode-go`; unset model resolved),
`build-pipeline-service-supervisor.test.ts` (build with no step model, unset
model, fan-out reviewers, pinned step model kept),
`build-pipeline-provider.test.ts` (unpinned Multi Review and looped review
sessions),
`opencode-provider-runtime.test.ts` (parser, substitution and resolution on the
real fixture), `commands-registry-coverage.test.ts` and
`commands-state-sync.test.ts` (live and persisted connectivity, launch-dialog
cache marks), `storage.test.ts` (snapshot connectivity, clearing),
`AgentNativeTab.test.tsx` (toast), `AgentModelPicker.test.tsx` ("Not
connected" row), `agent-launch.test.ts`, `BuildChatTab.test.tsx` (stage
notice), and the `build-pipeline.test.ts` / `review-fanout.test.ts` validators.

### Also cleaned up

- The OpenCode discovery metadata and composer no longer carry a
  `selectedReasoningId`: the `default` map has no variant, so it was always
  absent.
