# Mixed-version compatibility

Checked against `main` at `2459b05c` (2026-10-15).

The renderer, backend, bridges and stored data do not always run at the same
version. The hosted web client follows `main` while users' backends update on
their own schedule. The desktop app can connect to another machine's backend. A
gateway tab can outlive a backend upgrade. A container keeps running its old
bridge until it restarts. And an older backend can open a data directory that a
newer one wrote. Many features added a compatibility path "for one release",
but there is no agreed support window, so none of them can be retired. This
file holds that shared decision, the renderer–backend skew decision, one
dead-code removal, and an index of compatibility paths with the todo file that
owns each.

## Current state

- **Renderer–backend skew.**
  - `BackendVersionReminder` (`apps/web/src/components/BackendVersionReminder.tsx`,
    mounted in `App.tsx`) compares the bundled version with the backend's
    `get_app_version` on load and after every event-stream reconnect. On a
    mismatch it shows a toast that names the older side and how to update it.
    A dismissal lasts for the session, until either version changes. It warns
    only; it never blocks or translates anything. "Version reminders" in
    [`remote-gateway.md`](../architecture/remote-gateway.md) documents it.
  - A newer renderer meets an older backend in two supported ways.
    `apps/web-public` (orkestrator.dev, deployed from `main`) lazy-loads the
    full web app (`PublicApp.tsx`) and connects to any user's backend. The
    Electron app loads its bundled renderer but can connect to a remote backend
    (`apps/desktop/electron/connection-manager.ts`).
  - Since #980 the backend normalises OpenCode build-pipeline and Multi Review
    transcripts (`apps/backend/src/core/opencode-display-transcript.ts`), and
    the renderer has no OpenCode normaliser. A newer renderer on an older
    backend therefore shows raw `{ info, parts }` envelopes as nearly empty
    rows. The reverse skew (old gateway tab, new backend) is benign for this.
  - The authenticated `/__orkestrator/status` route (`apps/backend/src/gateway-auth.ts`)
    answers only `{ ok: true }`. The desktop (`backend-process.ts`,
    `connection-manager.ts`), `apps/web-public/src/connection.ts` and the iOS
    `GatewayConnectionValidator.swift` use it as a reachability probe. The
    public CLI has its own schema handshake
    ([`public-cli.md`](../architecture/public-cli.md)).
- **Dead prompt-queue claim path.** The backend `PromptQueueDrainer`
  (`prompt-queue-drainer.ts`) claims and dispatches through storage directly
  (`reservePromptQueueHeadForDispatch` and the dispatch acknowledgements). Left
  behind, and checked on 2026-10-15 to have no caller outside tests in the
  renderer, CLI, `apps/web-public`, the public API, the desktop app or the iOS
  app:
  - backend commands `requeue_prompt_queue_message`,
    `claim_prompt_queue_head`, `acknowledge_prompt_queue_claim` and
    `reject_prompt_queue_claim` (`commands-registry-prompts.ts`), and the
    `StorageService` methods of the same names (`storage-prompts.ts`), which
    only those commands and storage tests call;
  - renderer wrappers `requeuePromptQueueMessage`, `claimPromptQueueHead`,
    `acknowledgePromptQueueClaim` and `rejectPromptQueueClaim`
    (`apps/web/src/lib/backend/workflows.ts`), and the helper
    `claimPromptQueueHead` (`apps/web/src/lib/prompt-queue-persistence.ts`).

  No renderer on `main` since at least 2026-08-01 called them outside these
  wrappers, so removing them breaks no supported client.

## Outstanding work

### Code

1. **Remove the prompt-queue claim commands and wrappers.** Delete the four
   commands, the renderer wrappers and the persistence helper with the tests
   that cover only them. Update the Claude Tmux test mocks
   (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`,
   `ClaudeTmuxChatTab.parts.test.tsx`) and the wrapper-to-command map in
   `apps/backend/tests/commands-registry-coverage.test.ts`. Then remove the
   four storage methods and their storage tests, unless the drainer's
   reservation path still shares their claim state. Done when no storage
   method is left without a production caller.
2. **Decide and implement the renderer–backend skew guard** (see Open
   questions). Whatever is chosen, add one sentence to "Version reminders" in
   `remote-gateway.md` naming the near-empty OpenCode rows as the known
   symptom.
3. **Give `export_build_pipeline_for_downgrade` an owner.** It was added in
   #875 (`commands-registry-build.ts` →
   `StorageService.exportBuildPipelineForDowngrade` in
   `storage-build-pipelines.ts`). It is a read-only export of one pipeline in
   the pre-split inline schema, bounded by the old 32 MiB snapshot limit. No
   client calls it, it can only be invoked by name through the gateway, and no
   doc describes it. This file owns it: either document it in
   [`storage.md`](../architecture/storage.md) as the supported downgrade aid
   until the support window ends, or remove it with its tests.
4. **Count legacy-path use.** Once the window is agreed, each path in the index
   should report a content-free counter, so retirement rests on evidence
   rather than a guess. Some already count, such as `transcript.ui_fallback`,
   but nothing records them in production.

### Compatibility paths awaiting retirement

Each is retired by its owner once the support window allows. All were checked
in code at `2459b05c`.

| Path | Where | Owner |
| --- | --- | --- |
| Legacy slash catalogue routes `/plugins/commands` (Claude, Pi) and `/global/slash-commands` (Codex, Cursor) | `HttpBridgeCatalogAdapter.commandCatalogue` (`apps/backend/src/core/http-bridge-catalog.ts`) on a session-route 404 and for sessionless reads; `bridges/claude-bridge/src/routes/plugins.ts`, `bridges/pi-bridge/src/http.ts`, `bridges/codex-bridge/src/index.ts`, `bridges/cursor-bridge/src/http.ts` | [slash-command-catalogue.md](slash-command-catalogue.md) |
| Legacy preview loopback route `/__orkestrator/browser/loopback/<port>/` and the shared per-window preview partition | `GatewayProxy.proxyToTarget` (`apps/backend/src/gateway-proxy.ts`); `browserPreviewPartitionForWindow` (`apps/desktop/electron/desktop-window-lifecycle.ts`) | [service-preview-rollout.md](service-preview-rollout.md) |
| Joined `sync-v1` history paging | `native-agent-service-projection.ts` (the `sync-v1` projection and v1 cursor namespace) | [transcript-history-efficiency.md](transcript-history-efficiency.md) |
| Reviewer-transcript compatibility read (`fallback: true`) and the Multi Review rollback gates (`evidencePermits`, `adaptiveScheduling`) | `multi-review-reviewer-transcript.ts`; `MultiReviewServiceOptions` (`multi-review-service.ts`) | [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md) |
| Keyed-scheduling, observation-sharing and metrics rollback switches | `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`workflow-supervisor.ts`), `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` (`index.ts`), `ORKESTRATOR_RECURRING_METRICS=0` (`recurring-work-metrics.ts`); allowlisted in `apps/desktop/electron/backend-process.ts` | [recurring-work-qualification.md](recurring-work-qualification.md) |
| Container `legacy-layer` storage, `host-mounts` inputs and network policy 1 | `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` (`container-storage.ts`); `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` and `ORKESTRATOR_NETWORK_POLICY=1` (`commands-containers.ts`) | [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md) |
| Deprecated execution-policy env overrides | `CURSOR_BRIDGE_SANDBOX`, `CURSOR_BRIDGE_PROJECT_SETTINGS` (`bridges/cursor-bridge/src/config.ts`); `PI_BRIDGE_REQUIRE_APPROVAL`, `PI_BRIDGE_PROJECT_RESOURCES` (`bridges/pi-bridge/src/config.ts`); `ACP_APPROVE_PROJECT_MCPS`, still set by `host-model-catalog-refresh.ts` but no longer read by the ACP bridge | [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md) |
| Legacy `DELETE` close for bridges that predate `POST /session/:id/close`, and the `bridge-upgrade-required` restart notice for old Claude bridges | `closeBridgeSessionRetaining`, `LEGACY_DELETE_RETAINS_HISTORY` (`apps/backend/src/core/bridge-session-close.ts`) | [session-lifecycle-consistency.md](session-lifecycle-consistency.md) |
| Bridges that predate `/transcript`: progressive reads fall back to the whole `/messages` body | `readHttpBridgeTranscriptSnapshot` (`apps/backend/src/core/http-bridge-progressive.ts`) | [transcript-history-efficiency.md](transcript-history-efficiency.md) (decided with the sync-v1 fallback) |
| Bridges older than the MCP configuration report: an `mcpConfig` without the `mcpConfigReporting` marker still counts as reporting, and a body with neither gets the older-bridge apply outcome | `bridgeReportsMcpConfig` (`apps/backend/src/core/http-bridge-runtime-health.ts`), `olderBridgeOutcome` (`apps/backend/src/core/mcp-management/evidence.ts`) | [mcp-management.md](mcp-management.md) |
| Build-pipeline downgrade export | `export_build_pipeline_for_downgrade` | This file (Code item 3) |

Downgrade fences are a separate class. They let older software refuse or
safely ignore newer data, so they stay while downgrade to those versions is
supported:

- the `retain-history-close:` teardown-intent fence
  (`packages/protocol/src/tab-teardown.ts`);
- Cursor's legacy `overflow` boolean written beside `steerFence.overflowBefore`;
- `sourcePromptQueue` provenance on compose drafts, still validated on load;
- the container lifecycle schema floor (`container-lifecycle.md`, "Schema floor
  and downgrade").

## Constraints and rationale

- A 404 or 405 from a newer route means the other side predates it. It is never
  evidence that a session, workflow or resource is missing.
- A missing capability selects a bounded compatibility path or reports a clear
  limitation. It never silently degrades a safety property (close never deletes
  history; dispatch stays at most once).
- Support only the pairings a rolling upgrade actually produces, not a
  combinatorial matrix.
- Every gate needs an owner and a removal condition. "Kept for one release"
  without a window is how this backlog formed.
- Persisted format changes stay additive, with a recorded downgrade behaviour.

## Open questions

- **Support window.** How long must a backend keep serving older renderers and
  bridges, and older data, and how long must a renderer cope with an older
  backend? Releases or calendar time? Should it differ per client: hosted web
  (tracks `main`), desktop bundle (renderer, backend and bridges together),
  remote desktop-to-backend, iOS, container bridges that run until restarted?
  Once agreed, record it in an architecture doc and use it as every retirement
  condition in the index.
- **Renderer–backend skew.** Is the reminder enough? The alternatives are a
  renderer-side guard (detect a raw `{ info, parts }` envelope and say "update
  the backend" instead of rendering an empty row), or a version handshake.
  `/__orkestrator/status` is authenticated, so it could carry the app version
  and a protocol or capability revision without disclosing them to anonymous
  callers, and every client already probes it.

## Needs verification

- That no external tool outside the repository invokes the prompt-queue claim
  commands or `export_build_pipeline_for_downgrade` by name through
  `/__orkestrator/invoke`.

## Related

- [remote-client-bandwidth.md](remote-client-bandwidth.md) and
  [client-reconnect-and-freshness.md](client-reconnect-and-freshness.md): other
  remote-client behaviour.
- [slash-command-qualification.md](slash-command-qualification.md) and
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md):
  mixed-version and old-bridge runs.

## Replaces

- `docs/2026-10-14/07-cleanup-follow-ups.md` (§1 "Left for a follow-up" and §5
  "Known limitation: renderer and backend must match")
