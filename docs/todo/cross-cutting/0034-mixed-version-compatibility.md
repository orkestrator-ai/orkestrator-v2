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
    [`remote-gateway.md`](../../architecture/remote-gateway.md) documents it.
  - MCP apply runtimes may carry an optional `cancelReason`
    (`superseded-external` / `superseded-local`, `packages/protocol/src/mcp-management.ts`)
    when the saved change is no longer in its file. It is additive in both
    directions: an older renderer ignores it and still offers "Retry apply",
    which a current backend refuses with `revision-conflict` and a reason the
    toast shows; a newer renderer on an older backend never sees it and keeps
    Retry, which that backend re-plans as before. No compatibility path to
    retire.
  - A newer renderer meets an older backend in two supported ways.
    `apps/web-public` (orkestrator.dev, deployed from `main`) lazy-loads the
    full web app (`PublicApp.tsx`) and connects to any user's backend. The
    Electron app loads its bundled renderer but can connect to a remote backend
    (`apps/desktop/electron/connection-manager.ts`).
  - Since #970 and #971 (first released in 2.19.17) the backend normalises
    OpenCode build-pipeline and Multi Review transcripts
    (`apps/backend/src/core/opencode-display-transcript.ts`), and the renderer
    has no OpenCode normaliser. A backend at 2.19.16 or older still sends the
    stored `{ info, parts }` envelopes. A current renderer used to drop most
    of them without a trace (text, reasoning and tool parts) and show the rest
    as empty rows, so the stage read as silent. Now `toPipelineTranscript`
    classifies each entry by shape (`apps/web/src/lib/chat/transcript-skew.ts`,
    checked at `9906db30`) and puts one muted system row in place of each run
    of raw envelopes, naming the count and telling the user to update the
    backend to 2.19.17 or later. Entries with no field of a display row get the
    same treatment with a neutral "update the older one" note. The reverse
    skew (old gateway tab, new backend) is benign for this.
  - The authenticated `/__orkestrator/status` route (`apps/backend/src/gateway-auth.ts`)
    answers only `{ ok: true }`. The desktop (`backend-process.ts`,
    `connection-manager.ts`), `apps/web-public/src/connection.ts` and the iOS
    `GatewayConnectionValidator.swift` use it as a reachability probe. The
    public CLI has its own schema handshake
    ([`public-cli.md`](../../architecture/public-cli.md)).
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
2. **Give `export_build_pipeline_for_downgrade` an owner.** It was added in
   #875 (`commands-registry-build.ts` →
   `StorageService.exportBuildPipelineForDowngrade` in
   `storage-build-pipelines.ts`). It is a read-only export of one pipeline in
   the pre-split inline schema, bounded by the old 32 MiB snapshot limit. No
   client calls it, it can only be invoked by name through the gateway, and no
   doc describes it. This file owns it: either document it in
   [`storage.md`](../../architecture/storage.md) as the supported downgrade aid
   until the support window ends, or remove it with its tests.
3. **Count legacy-path use.** Once the window is agreed, each path in the index
   should report a content-free counter, so retirement rests on evidence
   rather than a guess. Some already count, such as `transcript.ui_fallback`,
   but nothing records them in production.

### Compatibility paths awaiting retirement

Each is retired by its owner once the support window allows. All were checked
in code at `2459b05c`.

| Path | Where | Owner |
| --- | --- | --- |
| Legacy slash catalogue routes `/plugins/commands` (Claude, Pi) and `/global/slash-commands` (Codex, Cursor) | `HttpBridgeCatalogAdapter.commandCatalogue` (`apps/backend/src/core/http-bridge-catalog.ts`) on a session-route 404 and for sessionless reads; `bridges/claude-bridge/src/routes/plugins.ts`, `bridges/pi-bridge/src/http.ts`, `bridges/codex-bridge/src/index.ts`, `bridges/cursor-bridge/src/http.ts` | [0016-slash-command-catalogue.md](../cli-and-slash-commands/0016-slash-command-catalogue.md) |
| Legacy preview loopback route `/__orkestrator/browser/loopback/<port>/` and the shared per-window preview partition | `GatewayProxy.proxyToTarget` (`apps/backend/src/gateway-proxy.ts`); `browserPreviewPartitionForWindow` (`apps/desktop/electron/desktop-window-lifecycle.ts`) | [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) |
| Joined `sync-v1` history paging | `native-agent-transcript-projection.ts` (the `sync-v1` projection and v1 cursor namespace) | [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md) |
| Reviewer-transcript compatibility read (`fallback: true`) and the Multi Review rollback gates (`evidencePermits`, `adaptiveScheduling`) | `multi-review-reviewer-transcript.ts`; `MultiReviewServiceOptions` (`multi-review-service.ts`) | [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md) |
| Keyed-scheduling, observation-sharing and metrics rollback switches | `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`workflow-supervisor.ts`), `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` (`index.ts`), `ORKESTRATOR_RECURRING_METRICS=0` (`recurring-work-metrics.ts`); allowlisted in `apps/desktop/electron/backend-process.ts` | [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) |
| Container `legacy-layer` storage, `host-mounts` inputs and network policy 1 | `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` (`container-storage.ts`); `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` and `ORKESTRATOR_NETWORK_POLICY=1` (`commands-containers.ts`) | [0021-container-rebuild-state-preservation.md](../containers-and-environments/0021-container-rebuild-state-preservation.md) |
| Legacy `DELETE` close for bridges that predate `POST /session/:id/close`, and the `bridge-upgrade-required` restart notice for old Claude bridges | `closeBridgeSessionRetaining`, `LEGACY_DELETE_RETAINS_HISTORY` (`apps/backend/src/core/bridge-session-close.ts`) | [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md) |
| Bridges that predate `/transcript`: progressive reads fall back to the whole `/messages` body | `readHttpBridgeTranscriptSnapshot` (`apps/backend/src/core/http-bridge-progressive.ts`) | [0050-transcript-history-efficiency.md](../transcripts-and-observation/0050-transcript-history-efficiency.md) (decided with the sync-v1 fallback) |
| Bridges older than the MCP configuration report: an `mcpConfig` without the `mcpConfigReporting` marker still counts as reporting, and a body with neither gets the older-bridge apply outcome | `bridgeReportsMcpConfig` (`apps/backend/src/core/http-bridge-runtime-health.ts`), `olderBridgeOutcome` (`apps/backend/src/core/mcp-management/evidence.ts`) | [0039-mcp-management.md](../mcp/0039-mcp-management.md) |
| Build-pipeline downgrade export | `export_build_pipeline_for_downgrade` | This file (Code item 2) |
| Renderer recognition of raw OpenCode envelopes from backends older than 2.19.17 (the "unrecognized" fallback stays) | The `opencode-envelope` entry of `LEGACY_TRANSCRIPT_SHAPES` (`apps/web/src/lib/chat/transcript-skew.ts`) | This file; retire once the window no longer covers backends older than 2.19.17 |

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
- **Renderer–backend skew is guarded by shape, not by version** (decided
  2026-10-16). Three options were considered: a version or capability check,
  per-entry shape detection, and restoring a renderer OpenCode normaliser.
  - A capability check cannot help with the backends that exist today. Older
    backends will never report a capability, so its absence would just mean
    "older than 2.19.17", which is a version comparison. Version comparisons
    misfire when a backend reports no version (dev builds, `0.0.0`), and they
    need an async read in pure display code.
  - Shape detection is exact, synchronous and free. It runs at the single
    chokepoint both views share (`toPipelineTranscript`, which feeds
    `BuildChatTab`, `MultiReviewReviewerTab` and the Multi Review inspector
    tail), and it cannot fire on what a current backend serves. A test runs
    the backend normaliser's own output through it to prove that.
  - Restoring a normaliser would undo #970's reason for moving it.
- **Unreadable entries become one notice row per run.** The rejected options
  were a banner above the view and refusing to render. The row is a muted
  system row, styled like the auto-decline record, and sits where the entries
  were. That needs no change to either view (Multi Review is busy in other
  branches), keeps the stage from reading as empty, and stays in place when
  interactions are merged by time. Its id comes from the run's first entry,
  so it keeps its identity as the run grows. The `BackendVersionReminder`
  toast still names the versions. To make the notice louder, give it the
  inline-error id prefix (`ERROR_MESSAGE_PREFIX`) instead of the system role.
- **The guard is provider-neutral.** `LEGACY_TRANSCRIPT_SHAPES` lists each
  known old shape with the first backend version that stopped sending it. Any
  record with no display-row field (`role`, `content` or `parts`) is
  "unrecognized" and gets a neutral note, so a future shape change in either
  direction is visible instead of silent. Non-record entries are still
  dropped silently as corruption. The unrecognized fallback is permanent.
  Each legacy entry retires with the support window.
- **No version handshake for now.** `/__orkestrator/status` is authenticated
  and every client already probes it, so it could later carry the app version
  and a capability revision without exposing them to anonymous callers.
  Nothing needs that yet. Revisit when a change cannot be detected from the
  payload (a behavioural rather than a shape change), together with the
  support window.

## Open questions

- **Support window.** How long must a backend keep serving older renderers and
  bridges, and older data, and how long must a renderer cope with an older
  backend? Releases or calendar time? Should it differ per client: hosted web
  (tracks `main`), desktop bundle (renderer, backend and bridges together),
  remote desktop-to-backend, iOS, container bridges that run until restarted?
  Once agreed, record it in an architecture doc and use it as every retirement
  condition in the index.

## Needs verification

- That no external tool outside the repository invokes the prompt-queue claim
  commands or `export_build_pipeline_for_downgrade` by name through
  `/__orkestrator/invoke`.

## Related

- [0052-remote-client-bandwidth.md](../transcripts-and-observation/0052-remote-client-bandwidth.md) and
  [0051-client-reconnect-and-freshness.md](../transcripts-and-observation/0051-client-reconnect-and-freshness.md): other
  remote-client behaviour.
- [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md) and
  [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  mixed-version and old-bridge runs.

## Replaces

- `docs/2026-10-14/07-cleanup-follow-ups.md` (§1 "Left for a follow-up" and §5
  "Known limitation: renderer and backend must match")
