# Cleanup follow-ups, decisions to confirm and watch items

Status: Active — collected 2026-10-14. Done 2026-10-15: 1, 2, 3, 7. Decided
2026-10-15: 4 (kept as is). Partly done: 5 (users are now told to update on a
mismatch; no renderer guard for raw envelopes). Pointers only, no action: 6, 8.

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

**Done 2026-10-15.** All of the exports above are gone, with the tests that
covered only them. Removing `mergeNativeMessagesPreservingClientOnly` also
removed its fingerprinting helpers, `normalizeMessageContent` and
`carryOverMessagesAddedDuringFetch` (also unused). No client (renderer, CLI,
public API, gateway, iOS) invoked `transfer_prompt_queue_message_to_compose_draft`,
so the backend command and `StorageService.transferPromptQueueMessageToComposeDraft`
were removed too. Drafts persisted by older versions can still carry its
`sourcePromptQueue` provenance, so that field is still validated on load.

Left for a follow-up: removing the four claim helpers leaves the renderer's
`claimPromptQueueHead` (`prompt-queue-persistence.ts`) and the
`claimPromptQueueHead`, `requeuePromptQueueMessage`,
`acknowledgePromptQueueClaim` and `rejectPromptQueueClaim` wrappers in
`apps/web/src/lib/backend/workflows.ts` reachable only from tests (including
the Claude Tmux test mocks). The matching backend commands have no client
outside tests either; the backend `PromptQueueDrainer` calls storage directly.

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

**Done 2026-10-15.** `agentModelCatalogStore` now holds `claudeModels`,
`claudeModelCatalogs` and `codexModels` beside the ACP lists, with the fallback
policy in its doc comment. `getClaudeModels(environmentId)` prefers the
environment's catalogue; `setCodexModels([])` restores `CODEX_MODELS`, which is
also the initial value. Both old stores are deleted and their tests moved.

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

**Done 2026-10-15.** The Bun version now reads 1.4.3, and the plan item is
ticked after confirming the backend passes `OpenCodePromptPart[]` (the SDK's
part-input union) to `session.promptAsync` uncast.

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

**Decided 2026-10-15: keep the broad match.** A terminal notice is dropped
only when the *last* transcript row has an `error-` id *and* its text equals
the notice or ends with `: <notice>`, so a false suppression needs a second
provider to write an inline error row repeating the same message, which is
exactly the duplicate the check exists to remove. The broad match means a
provider that adopts `providerInlineErrorMessageId` later is covered without
touching the projection. Narrowing to `error-opencode-` would buy exactness
for a case that cannot occur today, at the cost of a silent duplicate row the
first time another provider writes inline errors.

## 5. Known limitation: renderer and backend must match

OpenCode build-pipeline and Multi Review transcripts are now normalized by the
backend when served (`apps/backend/src/core/opencode-display-transcript.ts`),
and the renderer no longer has an OpenCode normalizer. A renderer from this
branch talking to an older backend would show raw OpenCode `{ info, parts }`
envelopes as nearly empty rows. Desktop builds ship both together, and the
remote gateway serves the renderer from the same backend, so this only matters
if a deployment can mix versions. If one can, add a version handshake or a
renderer-side guard.

**Finding 2026-10-15: deployments can mix versions.** Two supported paths put
a newer renderer in front of an older backend:

- `apps/web-public` (orkestrator.dev, deployed from `main`) lazy-loads the full
  web app (`apps/web-public/src/PublicApp.tsx:44`) and connects to any user's
  backend, whose version follows that user's desktop updates.
- The Electron app always loads its bundled renderer
  (`apps/desktop/electron/window.ts`) but can connect to a remote backend on
  another machine (`apps/desktop/electron/connection-manager.ts`).

Neither checks versions: `/__orkestrator/status` answers only `{ ok: true }`
(`apps/backend/src/gateway-auth.ts:366`). The renderer compares versions only
for the Settings Debug note. A gateway-served tab left open across a backend
upgrade gives the reverse skew (old renderer, new backend), which is benign
here.

**Update 2026-10-15: version reminder added.** The renderer now compares its
bundled version with the backend's `get_app_version` on load and after every
event-stream reconnect, and shows a warning toast naming the older side and
how to update it (`apps/web/src/components/BackendVersionReminder.tsx`; see
"Version reminders" in `docs/architecture/remote-gateway.md`). It does not
block or translate anything, so a newer renderer on an older backend still
shows near-empty OpenCode rows until the backend is updated. A renderer-side
guard for raw envelopes remains open if that is not enough.

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

**Done 2026-10-15.** `e2e/agent-testing/opencode-live.spec.ts`, skipped unless
`ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1`, with the pinned model in
`ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL`. How to run it is in
`docs/development/agent-testing.md`. It typechecks and skips cleanly by
default, but has not yet been run live. Known weak spots: undo asserts the
success toast and an idle turn, not that the reverted turn disappears, and the
build-pipeline case needs a model that emits reasoning.

## 8. Watch item: OpenCode fault isolation

OpenCode deliberately has no bridge. See "Why OpenCode has no bridge" in
`docs/architecture/agent-engines.md`. The accepted cost is that SDK or SSE
client failures surface in the backend process. The patched SSE client bug
once turned `OpenCodeProvider.dispose()` into a dead backend. If a similar
failure recurs, revisit the bridge decision, or at least isolate the OpenCode
event stream so its failure cannot take the backend down.
