# Cleanup follow-ups, decisions to confirm and watch items

Status: Active — collected 2026-10-14, none done.

Smaller items left over from the OpenCode boundary cleanup branch
(`opencode-bridge-a8c2ab5c85b9-r1`) and its validation. None is user-visible
breakage; they are kept here so nothing found that day is lost.

## 1. Dead renderer helpers left after the Claude/Codex cleanup

Removing the renderer-direct Claude, Codex and OpenCode clients left these
exports with no production caller (verified 2026-10-14: the only references
outside tests are their own definitions or doc comments):

| Export | Defined at | Notes |
| --- | --- | --- |
| `mergeNativeMessagesPreservingClientOnly` | `apps/web/src/lib/chat/client-only-messages.ts:430` | Also named in doc comments at `:83` and `:409`; update those when removing it. |
| `preserveMessageIdentities` | `apps/web/src/lib/chat/message-identity.ts:88` | |
| `reconcileTimedSession` | `apps/web/src/lib/session-timer.ts:78` | |
| `updateTimedSessionLoading` | `apps/web/src/lib/session-timer.ts:108` | |
| `recordComposeDraftRevision` | `apps/web/src/lib/compose-draft-persistence.ts:28` | |
| `isComposeDraftOccupiedBackendError` | `apps/web/src/lib/prompt-queue-errors.ts:45` | |
| `transferPromptQueueMessageToComposeDraft` | `apps/web/src/lib/backend/workflows.ts:1239` | Renderer wrapper only. `tests/unit/electron/commands-registry-coverage.test.ts` maps wrappers to backend commands. Decide whether the backend command (`commands-registry-prompts.ts`, `storage-prompts.ts`) is still needed by any client (CLI, gateway) before removing either side. |
| `claimAgentPromptQueueHead`, `requeueAgentPrompt`, `acknowledgeAgentPromptClaim`, `rejectAgentPromptClaim` | `apps/web/src/lib/prompt-queue-sources.ts:78`, `:131`, `:168`, `:181` | Already unused before the branch. The backend `PromptQueueDrainer` owns claim/requeue/acknowledge. |

Fix: delete them with the tests that cover only them, then run the web
typecheck, the web suite and `tests/` (renderer tests live there too).

## 2. Fold the Claude and Codex model stores into one catalogue store

After the cleanup, `apps/web/src/stores/claudeStore.ts` (51 lines) and
`codexStore.ts` (21 lines) hold nothing but model catalogues:

- `claudeStore`: a global `models` list plus per-environment `modelCatalogs`,
  with `getModels(environmentId)` falling back to the global list.
- `codexStore`: one `models` list that falls back to the bundled
  `CODEX_MODELS` (`apps/web/src/lib/codex-models.ts`) when given an empty list.

`agentModelCatalogStore.ts` already holds Cursor and Grok catalogues. They
were not merged because the two fallback behaviours differ, and moving them
was not clearly behaviour-preserving. Readers include Claude Tmux, launchers,
settings, `FeaturesView`, review options and the startup catalogue load.
Fix: give `agentModelCatalogStore` per-platform entries with an explicit
fallback policy (per-environment for Claude, bundled list for Codex), migrate
the readers and delete both stores.

## 3. Documentation drift

- `docs/development/agent-testing.md:17` says "repository-pinned Bun 1.4.2";
  `mise.toml:2` pins `bun = "1.4.3"`.
- `docs/plans/sdk-coverage/13-opencode-v1-streaming-and-cleanup.md`, item
  "Type the prompt payload": the backend half appears done. Prompt parts are
  now typed (`openCodeFileParts` returns `FilePartInput[]`,
  `apps/backend/src/core/opencode-provider-helpers.ts:501`, used at
  `opencode-provider.ts:804`). The only remaining `as never` in
  `opencode-provider.ts` (`:157`) is the discovery fan-out's generic
  `optionalSdkCall`, not the prompt. Confirm, then tick the item.

## 4. Decision to confirm: inline-error duplicate check

The branch moved the inline error-row id convention into
`@orkestrator/protocol/native-agent`
(`NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX = "error-"`,
`providerInlineErrorMessageId`, `isNativeInlineErrorMessageId`). The shared
projection's duplicate-terminal-row check
(`apps/backend/src/core/native-agent-service-projection.ts:4293`) now matches
any `error-` row instead of only `error-opencode-`. No backend or bridge
produces other `error-` transcript rows today, so behaviour is unchanged. If an
exact OpenCode-only match is preferred, narrow the check.

## 5. Known limitation: renderer and backend must match

OpenCode build-pipeline and Multi Review transcripts are now normalized by the
backend when served (`apps/backend/src/core/opencode-display-transcript.ts`),
and the renderer no longer has an OpenCode normalizer. A renderer from this
branch talking to an older backend would show raw OpenCode `{ info, parts }`
envelopes as nearly empty rows. Desktop builds ship both together, and the
remote gateway serves the renderer from the same backend, so this only matters
if a deployment can mix versions. If one can, add a version handshake or a
renderer-side guard.

## 6. Flaky tests recorded that day

The flake registry (`docs/tests/flaky-tests/`) stays the only place flakes are
tracked. These two were added on 2026-10-14 and are listed here only as
pointers:

| ID | Test | Case file |
| --- | --- | --- |
| 0207 | `e2e/StreamingTranscript.spec.ts:137` "non-sticky history keeps its anchor while new transcript rows stream" | `docs/tests/flaky-tests/0207-streaming-transcript-non-sticky-anchor-under-load.md` |
| 0208 | `e2e/agent-testing/design-canvas.spec.ts:230` "private canvases survive reload and can be retired to recover quota" | `docs/tests/flaky-tests/0208-design-canvas-private-import-picker-disabled-in-suite.md` |

## 7. Commit a live OpenCode real-stack spec

The live OpenCode QA on 2026-10-14 used a throwaway Playwright spec against a
`dev:test --fixture` profile with host credentials. It covered a real turn,
inactive-environment rehydration, hard reload, Agent Info metrics, undo, redo,
compact, fork, and an OpenCode build-pipeline transcript (thinking and tool
rows with durations, no raw envelopes, survives reload). Nothing in the repo
covers these end to end. Add it as an opt-in spec, skipped unless a live
OpenCode variable is set, like the existing live-review and Docker opt-ins.
Things the throwaway spec had to learn:

- The pre-session composer's send button is named "Send", not "Send message".
- `list_build_pipelines` requires `projectId` and returns records shaped
  `{ id, snapshot: { phase, environmentId, sessions[].messageRevision, … } }`.
- `create_feature_build` writes its own pane layout (Build tab plus a
  terminal), so the spec must activate the "Build: <title>" tab.
- Wait for `sessions[0].messageRevision` to grow, not just for a non-`building`
  phase, or the spec cancels during setup.
- Pin a model from a connected provider until
  `01-opencode-default-model-not-connected.md` is fixed.
- Never click **Share…**: it publishes the conversation.

`agent-browser` (the CLI some QA instructions expect) is not installed on this
machine. Repository-owned Playwright specs avoid depending on it.

## 8. Watch item: OpenCode fault isolation

OpenCode deliberately has no bridge. See "Why OpenCode has no bridge" in
`docs/architecture/agent-engines.md`. The accepted cost is that SDK or SSE
client failures surface in the backend process. The patched SSE client bug
once turned `OpenCodeProvider.dispose()` into a dead backend. If a similar
failure recurs, revisit the bridge decision, or at least isolate the OpenCode
event stream so its failure cannot take the backend down.
