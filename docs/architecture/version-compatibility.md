# Version compatibility

The renderer, backend, bridges and stored data do not always run at the same
version. The hosted web client follows `main` while users' backends update on
their own schedule. The desktop app can connect to another machine's backend. A
browser tab can outlive a backend upgrade. A container keeps running its old
bridge until it restarts. And a backend can open a data directory another
version wrote. This document sets how long each side must cope with an older
other side (the **support window**), how compatibility code is written and
counted, and lists every compatibility path with its owner and removal
condition. Decided on 2026-10-24 in todo 0034 (retired on 2026-10-29; git history
keeps it).

## The support window

**Supported versions are every published release at or after the floor.** The
floor is the newest Stable release that was published at least **60 days**
ago. While no Stable release is that old, the floor is **v2.21.0**, the first
published release (2026-10-16).

- *Published* means a non-draft GitHub release on `orkestrator-ai/orkestrator-v2`
  on any channel ([releasing.md](../development/releasing.md#update-channels)).
  Drafts that were never published (v2.24.0-alpha to v2.26.0-alpha) and source
  or dev builds (version `0.0.0`, or any commit between releases) are not
  covered. Nothing before v2.21.0 was ever published as a release or on npm, so
  only source builds ever ran it.
- Prereleases are ordered by version, so a Beta or Unstable release at or
  after the floor is covered like any other.
- The floor moves by itself: it becomes v2.21.1 on 2026-12-15, v2.22.3 on
  2026-12-16 and v2.23.0 on 2026-12-18. Nobody needs to announce it.
- **Today (2026-10-24) the floor is v2.21.0.**

A compatibility path that exists for peers older than version X may be removed
once the floor is at or above X: that is, 60 days after the first Stable
release at or above X was published. For anything older than v2.21.0 that is
already true.

Why this shape: releases ship several times a week, so a count of releases
would last days, while hosts update on their own schedule, a remote backend
can sit unattended and a container keeps its bridge until it restarts.
Anchoring on a Stable release ties the floor to what the "everyone" channel
installs. 30 days was judged too short for unattended hosts and long-lived
containers, 90 days would keep about three months of paths; the usage counters
are the evidence for revising the figure. One window covers every pairing
because they all ride the same release train, and separate windows would
multiply the conditions owners must check.

### What must work across the window

Only the pairings a rolling upgrade produces, never a combinatorial matrix.

| Pairing | Rule |
| --- | --- |
| Hosted web client (`apps/web-public`, follows `main`) → any user's backend | The renderer works with every backend in the window. |
| Desktop app → a remote backend (`connection-manager.ts`), either side newer | Renderer and backend each work with the other side in the window. The bundled local backend always matches. |
| Open browser tab → upgraded backend | The backend serves renderers in the window; `BackendVersionReminder` asks the user to reload. |
| Backend → bridges (a running container, or a bridge process that predates the backend upgrade) | The backend drives every bridge in the window. A bridge newer than its backend only happens after a downgrade, and is covered the same way. |
| Public CLI → backend | Its own schema handshake ([public-cli.md](public-cli.md)); outside it the CLI reports `backend-incompatible`. |
| iOS app | A shell around the web interface the backend serves, so renderer and backend match. Its native contract (the `/__orkestrator/status` probe and the cookie sign-in) only changes additively. |
| Data directory, upgrade | A backend opens data written by any version, including source builds older than the floor. Migrations and record upgrades (`storage-record-upgrades.ts`) are permanent. A record from before the floor must still load without loss, but behaviour that needs a field the old version never wrote may take a safe, explicit outcome instead (a refusal, a restart notice), never a silent one. |
| Data directory, downgrade | Supported to any release in the window through downgrade fences: the older release refuses or safely ignores newer data. Full function after a downgrade is not promised. A fence can stop being written once the floor is at or above the release that reads the newer data natively. |

Outside the window nothing is promised beyond the permanent safety rules
below and the version reminder naming which side to update.

### Rules for compatibility code

- Detect by shape or capability, not by version number. A version comparison
  misfires on dev builds that report `0.0.0` and needs a round trip; shape and
  capability checks do not. Use the version only to write down when a path
  can go.
- A 404 or 405 from a newer route means the other side predates it, never that
  a session, workflow or resource is missing.
- A missing capability selects a bounded compatibility path or reports a clear
  limitation. It never weakens a safety property: close never deletes history,
  dispatch stays at most once, a correlated retry never runs twice.
- Persisted formats change additively, with a recorded downgrade behaviour.
- Every path gets an owner, a removal condition stated against the floor, a
  row in the register below, and a usage counter if the backend can see it.
- Rollback switches (environment variables that restore an older code path)
  and unmigrated user state (old containers, legacy URL tabs) are not version
  skew. The window does not retire them; their owners retire them on
  qualification evidence or after a migration.

## Usage counters

Each path the backend can observe records a content-free count in
`compatibility-path-usage.ts`: a fixed path id, the number of uses, and the
first and last time. No session, agent, URL, port or peer version is recorded.
Counts are kept in memory and merged into the `compatibility-path-usage`
database document (see [storage.md](storage.md)) at most once a minute, on
every read and at shutdown, so they survive restarts and upgrades.

Read them with the `get_compatibility_path_usage` backend command or the
`compatibilityPaths` block of the gateway's `/__orkestrator/metrics`. Before removing a
path whose condition is met, check its counter on the machines you can reach:
a recent `lastSeenAt` means some peer still needs it, and the right response is
usually to tell that user to update rather than to keep the path. The counters
are local to each backend; nothing is sent anywhere.

Renderer-only and desktop-only paths are not counted. The renderer has the
one-request launch fallbacks in the register below (no backend sees them), and
the joined-cursor mint in **Load earlier messages**, whose pages the backend
counts under `history.joined-v1-page` and its two cause ids (the transcript
"unrecognized" notice is permanent, not a compatibility path), and the desktop's shared preview
partition goes with the legacy preview route.

The legacy slash catalogue routes and their 404 fallback were retired on
2026-10-24 by [0016](../todo/cli-and-slash-commands/0016-slash-command-catalogue.md).
A session-route 404 now returns `outdated-bridge` without reading a global
list. Each rejected read records `slash-catalogue.outdated-bridge` in the
persistent usage counters, alongside the per-agent in-memory count.

The legacy `DELETE` close was retired the same way on 2026-10-31 (see Retired).
A 404 or 405 from `POST /session/:id/close` now keeps the close pending with the
`bridge-upgrade-required` restart notice on every platform, and records
`bridge-close.upgrade-required`. A stored `bridge-close.legacy-delete` count is
kept in the document and no longer reported.

## Register

Paths waiting for retirement. When a Stable release is published, check this
table for conditions that are now met
([releasing.md](../development/releasing.md#cutting-a-release)). Versions name
the first release that made the path unnecessary; "in v2.21.0" means every
supported peer already has the newer behaviour.

| Path | Where | Counter | Serves | Retire when | Owner |
| --- | --- | --- | --- | --- | --- |
| Bridges whose `/transcript` answers 404 for a session it has not loaded: progressive reads fall back to the whole `/messages` body | `readHttpBridgeTranscriptSnapshot` (`http-bridge-progressive.ts`) | `bridge-transcript.messages-fallback` (counted only when `/messages` served the session) | Bridges before #670 (2026-09-09), and every Claude bridge before 2026-10-26, v2.21.0 included: its `/transcript` reads only resident sessions, so after a bridge restart only `/messages` loads a persisted one | The floor is at or above the first Stable release whose Claude bridge loads the session on `/transcript` (0050 item 3) | [0050](../todo/transcripts-and-observation/0050-transcript-history-efficiency.md) item 3 |
| Joined `sync-v1` history paging, the v1 cursor namespace, and the renderer's mint of a joined cursor | `getMessagePage` → `refreshProjection(… "sync-v1")`, `projectionHistory` (`native-agent-transcript-projection.ts`); the sync-v1 mint in `loadEarlierMessages` (`useNativeAgentSession.ts`) | Split by why the session's latest view had no direct cursor (0232 item 3): `history.joined-v1-page.unpaged-source` (its source has no direct pages; quiets with the `/messages` fallback row), `history.joined-v1-page.unnamed-cursor` (its source pages, but no kept row named a cursor, including a first-message snapshot whose projected rows exceed the backend byte bound, or the cursor was too long to wrap), and `history.joined-v1-page` (the view offered a direct cursor, or none was read: a caller paging with a v1 cursor it did not need). Before 2026-10-29 the base id counted every joined page. The mint itself is renderer-side; the pages after it are counted | Views without a direct cursor. Since 0232 (2026-10-27) a backend names one on a view whose provider pages when a usable whole-message boundary remains, including byte-bounded views, and every renderer in the window adopts it (v2.21.0 does), so on such a backend this serves only sources without direct pages (the `/messages` fallback above, a bridge without page routes), a provider cursor too long to wrap, a first-message snapshot whose projected rows exceed the backend byte bound without naming a new cursor, and an OpenCode view retaining only a failed message's inline error row after its main row was byte-omitted. The renderer's mint also serves backends before 0232, whose byte-bounded views carry no cursor | The `/messages` fallback row has retired, the floor is at or above the first Stable release with 0232, the remaining first-message byte-bound, cursor-boundary and cursor-length cases have direct recovery, and all three counters are quiet on the machines you can reach (0232 item 4) | [0232](../todo/transcripts-and-observation/0232-direct-history-cursor-minting.md) |
| Bridges older than the MCP configuration report: `mcpConfig` without `mcpConfigReporting` still counts as reporting, and a body with neither gets the older-bridge apply outcome | `bridgeReportsMcpConfig` (`http-bridge-runtime-health.ts`), `olderBridgeOutcome` (`mcp-management/evidence.ts`) | `mcp-report.unmarked-config`, `mcp-report.older-bridge-outcome` (counts evaluations) | Bridges before #1025; the Claude, Cursor, Pi and ACP bridges in v2.21.0 send the marker | The window allows it now for those bridges. Confirm first how Codex reaches this rule: its bridge sends no marker | [0039](../todo/mcp/0039-mcp-management.md) |
| Legacy preview loopback route `/__orkestrator/browser/loopback/<port>/` and the shared per-window preview partition | `GatewayProxy.proxyToTarget` (`gateway-proxy.ts`); `browserPreviewPartitionForWindow` (`desktop-window-lifecycle.ts`) | `preview.legacy-loopback-route` (counts requests) | Desktops with the transport off or older than the default, web clients without private origins, and `localhost` URL tabs, which never migrate | The floor is at or above the first Stable release with service previews as the desktop default, and the `localhost` URL tabs have an answer. The default flip and the migration of matching tabs are in (2026-11-04) | [0042](../todo/previews-and-annotations/0042-service-preview-rollout.md) item 6 |
| Preview tunnel v1, one WebSocket with HELLO and OPEN per upstream connection: the backend still accepts `orkestrator.preview-tunnel.v1`, and the desktop opens v1 when an attachment does not advertise `multiplexSubprotocol` | `PreviewTunnelServer.handleUpgrade`/`accept` (`preview-tunnel-server.ts`); `PreviewTunnelConnector.open` → `openPreviewTunnel` (`preview-tunnel-session.ts`, `preview-tunnel-client.ts`) | `preview.tunnel-v1` (counts v1 sockets the backend accepts; the desktop side is not counted) | Desktops and backends before tunnel v2 (4500, 2026-11-04) | The floor is at or above the first Stable release with tunnel v2 and the counter is quiet | [4500](../todo/cross-cutting/4500-preview-tunnel-one-socket-per-connection.md) |
| Backends without the built-in container resource default: Settings disables "Built-in default" and says none applies when `get_docker_capacity` has no `builtInDefault` | `legacyBackend` (`ContainerResourceLimitsSettings.tsx`) | None (renderer side) | Backends before the default (todo 0022, 2026-10-25) | The floor is a release with `builtInDefault` | [0022](../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md) |
| Build Pipeline Address sessions without the typed report marker: Verify reads the session's last assistant text instead of its `fix-result` | `verificationAddressReport` (`build-pipeline-address-findings-report.ts`); `finishAddress` (`build-pipeline-service-recovery.ts`) advances such a session without reading a result | `build-pipeline.address-text-report` (counts Verify prompts built for such a session) | Pipeline records whose Address session started before the typed handoff (graphs item 004, 2026-10-29) and is still resumed or restarted from Verify | The floor is at or above the first Stable release with 004 and the counter is quiet. A record from before then may take a safe, explicit outcome instead: Verify told no Address report is available | [004](../../plans/graphs/004-typed-address-report.md) |
| Self-reminders spelled `source: "workflow"` in the carrier, with `selfReminder: true` | `carrierActor` (`packages/protocol/src/agent-mail.ts`), read by `peerMailFromPayload` (`client-only-messages.ts`) | None (renderer side) | Renderers before `self-reminder` (2026-11-05), which refuse any other `source` and would show the raw carrier. The stored message and the mail tools already carry the real value | The floor is at or above the first Stable release with `self-reminder`. Then write the real value and drop the flag | X1, [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) |
| Leaves without `node-mail-turn-origin`: a coordinator's mail reaches them without saying it arose from agent mail | `turnOrigin` in `send_coordinator_node_mail` (`commands-registry-coordinator-nodes.ts`) | None | Leaves before `node-mail-turn-origin` (2026-11-05), which refuse the unknown key. They frame mail as they always did, so no property weakens | The floor is at or above the first Stable release with `node-mail-turn-origin` | X1, [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) |
| Leaves without `node-coordinator-build-origin`: new-environment builds are refused before launch | `start_coordinator_node_build_pipeline` | `coordinator-build.origin-upgrade-required` | Leaves predating admission identity (2026-11-05) | The floor includes the first Stable release with admission identity; retain legacy snapshot refusals permanently | X1 |
| Live prompt-queue claim state (`outstandingClaim`) | `restoreLegacyPromptQueueClaims`, queue mutation and reservation guards | None (read normalization) | Claims from releases through v2.29.0-beta (the last with the claim commands), including external callers. Those releases refuse a schema-5 database (from v2.34.4-beta), so a claim seen here was either carried across the upgrade or written by a backend that opened the database before that migration and is still running | Claim-writing peers can no longer share the database; retain exclusion until settlement or expiry meanwhile | [0078](../todo/cross-cutting/0078-legacy-prompt-queue-claim-state.md) |
| New names for the Rework and Address Findings steps in stored and transmitted data: this build writes `fix`, `fixing`, `address`, `addressing`, `fixModel` and the rest, and reads the new names as well | `workflow-vocabulary.ts`, run by the renderer's stores and the backend's start commands; `normalizeActionDefaults` reads a saved `addressFindings` key; `workflow-tab-title.ts` reads the former `Fix` tab title; the CLI's former flags | None (renderer side and a read normalization) | Peers on the build that flips the names ([4740](../todo/cross-cutting/4740-workflow-vocabulary-stage-two.md)), and restored tabs with the former title | The floor is at or above the first Stable release with the flip. The user approved flipping before the window ends, once their own machines are updated (2026-11-04); the readers still stay for the window | [4740](../todo/cross-cutting/4740-workflow-vocabulary-stage-two.md) |
| Backends without `launch_build_pipeline`: the renderer merges the saved Build defaults itself and calls `start_build_pipeline` | `legacyBuildPipelineStartInput` (`apps/web/src/lib/build-pipeline-launch-compat.ts`), chosen in `useBuildPipeline.ts` by `isUnsupportedBackendCommand` | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `launch_build_pipeline` | Build launch |
| Releases without a published lockfile: `installRelease` installs them with a plain `bun install`, so their transitive dependencies resolve afresh | The `else` branch in `installRelease` (`packages/protocol/src/node/standalone-service.ts`) | None (runs in the service's installing process) | `service install --release` of a release older than `resources/release-runtime/` (2026-11-04), v2.36.3-beta and earlier | The floor is at or above the first Stable release with `resources/release-runtime/` | [5022](../todo/cross-cutting/5022-release-chain-live-evidence.md) |
| Releases without a published lockfile, first run through the site's `install.sh`: it runs them through `bun x`, so their transitive dependencies resolve afresh | The branch in `main` of `apps/web-public/public/install.sh` that finds no `resources/release-runtime/` in the fetched package | None (runs on the user's host before any backend) | `PINNED_RELEASE` 2.36.1, the pin at the time of writing, and any `ORKESTRATOR_INSTALL_VERSION` older than `resources/release-runtime/` (2026-11-04), v2.36.3-beta and earlier | `PINNED_RELEASE` is a Stable release with `resources/release-runtime/`, and older releases are outside the window | [5022](../todo/cross-cutting/5022-release-chain-live-evidence.md) task 4 |
| Backends without `start_feature_plan_build`: the renderer sequences ticket, claim, start and link with its own rollbacks | `legacyStartFeaturePlanBuild` (`apps/web/src/lib/feature-plan-build-compat.ts`), chosen in `FeaturesView.tsx`; `claim_feature_plan_build` stays registered for it | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `start_feature_plan_build`; `claim_feature_plan_build` and the store's `claimFeatureBuild` retire with it | Build launch |
| Backends without `launch_multi_review`: the renderer reuses an active review, fills the branch and instruction, starts the review and opens its tab | `legacyLaunchMultiReview` (`apps/web/src/lib/multi-review-launch-compat.ts`), chosen in `useActionBarController.ts` | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `launch_multi_review` | Multi Review |
| Backends without `record_renderer_errors`: a desktop window's renderer stops sending its error ring for that load when the backend answers "Unknown backend command", and keeps the entries in memory | `startRendererErrorUpload` (`apps/web/src/lib/renderer-error-upload.ts`) | None (renderer side) | Backends before the renderer error ring (E16, 2026-11-05), such as a remote backend a newer desktop connects to | The floor is at or above the first Stable release with `record_renderer_errors`; then a failed send is retried like any other | [logging.md](logging.md#renderer-failures-in-the-essential-log) |
| Leaves without `node-coordinator-mail`: mail from a command node's coordinator to that leaf's coordinator is refused with "update that machine", and `list_mailboxes` with its `nodeId` reports the coordinator unreachable. Nothing is sent to the leaf | `olderNodeRefusal` (`coordinator-node-coordinator-mail.ts`) | `node-coordinator-mail.older-node` (counts refusals and unreachable answers) | Leaves before coordinator-to-coordinator node mail (2026-11-02); their workers can still be mailed | The floor is at or above the first Stable release that advertises `node-coordinator-mail`, and the counter is quiet; then the check can go, since every leaf in the window understands the address | [coordinator.md](coordinator.md#coordinators-on-two-nodes) |
| Nodes without `node-mail-attachments`: a command node refuses a coordinator's mail with images to such a leaf with "update that machine", and a leaf's coordinator's mail with images stays in its outbox until its command node has the capability | `assertNodeTakesMailAttachments` (`coordinator-mail-attachments.ts`), `LeafNodeMail.collect` (`nodes/node-mail.ts`) | `node-mail-attachments.older-node` (counts refusals) | Nodes before coordinator image mail (2026-11-04); their plain mail is unaffected | The floor is at or above the first Stable release that advertises `node-mail-attachments`, and the counter is quiet; then the check can go | [command-nodes.md](command-nodes.md#images-between-nodes) |
| Leaves without `node-mail-return`: an agent's mail to "coordinator" for a repository with no coordinator on the command node stays in the leaf's outbox, as it always did, instead of being handed back to the leaf's own coordinator. A leaf newer than its command node has the same wait, which the leaf cannot see | `NodeMailCollector.handBack` (`nodes/node-mail-collector.ts`) | `node-mail-return.older-leaf` (counts collect attempts that could not hand back) | Leaves before the command node became the default destination (2026-11-04); mail with a coordinator to reach is unaffected | The floor is at or above the first Stable release that advertises `node-mail-return`, and the counter is quiet; then the check can go | [command-nodes.md](command-nodes.md#updates-from-leaves) |
| Leaves without `ticket-sync`: the command node does not sync tickets with them and its board shows "update that machine". A coordinator's ticket tools with their `nodeId` read and write the leaf's own board as before (a ticket created for it stays there), and `start_build_pipeline` with a ticket of the command node's board is refused with what to do instead | `olderLeafTicketMessage` (`nodes/node-ticket-sync.ts`), `coordinator-node-tickets.ts` | `ticket-sync.older-node` (counts tool calls and refused builds) | Leaves before Kanban sync (2026-11-03) | The floor is at or above the first Stable release that advertises `ticket-sync`, and the counter is quiet | [tickets.md](tickets.md#sync-across-machines) |
| Command nodes without `coordinator-notices`: a leaf that never received `coordinatorNotices` on `collect_node_outbox` from a command node keeps its notices on its own coordinator, and that command node hears of the leaf's automatic switches through its event stream only. A queued notice handed to a downgraded command node goes back to the leaf; if a downgraded leaf still holds one, it is collected as ordinary agent mail, which is why its `body` is readable | `CoordinatorNoticeRouter.route`, `LeafNodeMail.collect` | `coordinator-notices.older-command-node` (counts notices kept) | Command nodes before the notice hierarchy (2026-11-04) | The floor is at or above the first Stable release that advertises `coordinator-notices`, and the counter is quiet | [coordinator.md](coordinator.md#who-hears-a-notice) |
| Leaves without `coordinator-notices`: a command node mails its coordinators about their automatic switches from `AGENT_ACCOUNT_AUTO_SWITCHED_EVENT`, which a link drop loses, sends them no new `collect_node_outbox` key, and receives no notices from them | `bridgeRemoteAutoSwitchNotices` (`agent-accounts-auto-switch-notices.ts`), `NodeMailCollector.collectOnce` | `coordinator-notices.older-leaf` (counts switches heard this way) | Leaves before the notice hierarchy (2026-11-04) | The floor is at or above the first Stable release that advertises `coordinator-notices`, and the counter is quiet; the event and the bridge can then go | [coordinator.md](coordinator.md#who-hears-a-notice) |
| Nodes without `get_machine_load`: `list_nodes` shows their load as unavailable with reason `older-version` | `readNodeMachineLoad` (`control-mcp-machine-load.ts`) | `machine-load.older-node` (counts asks, up to one per node per `list_nodes` call) | Nodes before the machine-load change; the rest of `list_nodes` is unaffected | The floor is at or above the first Stable release with `get_machine_load`, and the counter is quiet | [1030](../todo/coordinator-and-multi-review/1030-coordinator-machine-load.md) |
| Bridges without compaction instructions: `/compact <instructions>` on Claude or Pi sends `{ instructions }`, an older bridge ignores the body and compacts plainly, and the missing `instructions: "applied"` comes back as an applied outcome with `instructionsIgnored`; the composer clears the draft and says the instructions were not used (restart the environment). Never a failure, which would invite a second compaction | `compactBridgeSession` (`http-bridge-compact.ts`); the compact branch of `submitDraft` (`AgentNativeTab.controller.tsx`) | `compact.instructions-ignored` (counts compactions whose instructions were not confirmed) | Claude and Pi bridges before compaction instructions (0007 task 8, 2026-11-03), typically a container that predates the backend upgrade | The floor is at or above the first Stable release with compaction instructions and the counter is quiet | [0007](../todo/agent-engines/0007-provider-sdk-adoption-backlog.md) task 8 |
| Container bridges holding a plain token: a bridge an older backend started, or any bridge on an image without `bridge-credential`, keeps its token in a `node`-readable `/tmp` file and in its environment, and its token may have no `okb_` prefix. The same goes for OpenCode's server password, which has its own file there. `BRIDGE_TOKEN_PATTERN` accepts both forms, `readContainerBridgeToken` falls back to the `/tmp` file, and each bridge still takes `<TOKEN_ENV>` from an older backend | `container-bridge-credential.ts`, `local-server-runtime.ts`, `loadBridgeCredential` (`bridge-credential.ts`) | `bridge-credential.token-file` (counts reads that found a token in `/tmp`) | Running bridges from before the verifier (2026-11-04), and images that predate it, whose containers keep the agent-readable token until rebuilt | The floor is at or above the first Stable release with `bridge-credential=1`, no supported backend starts a bridge with a plain token, and the counter is quiet. The `bridge-credential` image check stays for older images, as unmigrated state | To-do 3930 (deleted 2026-11-06) |
| Realms from before `patch_global_config` saving a model favourite: a workspace client (a client grant, or the relay) may not change global settings, but an `update_global_config` or `patch_global_config` that would change nothing on the machine is answered with its current settings instead of refused. Any change is still refused with 403 | `GatewayHandlers.handleInvoke` (`gateway-handlers.ts`), `answerConfigEcho` (`nodes/node-relay.ts`), `isGlobalConfigEcho` (`nodes/workspace-grant-scope.ts`) | `workspace-grant.config-echo` (counts answered echoes) | Command nodes through v2.35.1-beta, whose realms write a favourite to the command node and then send the leaf's own settings back unchanged with `preserveInheritedSettings` | The floor is at or above v2.36.0, the first Stable release whose realms use `patch_global_config`, and the counter is quiet; then the two config writes are refused outright | [command-nodes.md](command-nodes.md) |
| Clients that still send `experimentalCodexRawEventLogging`, the retired Codex raw event logging setting: a workspace client's write is not refused for that key alone, because an older form sends it whatever the machine stores. Nothing reads the key; a direct save stores it as it stores any unknown key, and a stored one stays in `config.json` for a downgrade | `RETIRED_GLOBAL_SETTING_KEYS` (`nodes/workspace-grant-scope.ts`) | `workspace-grant.config-echo` (shared with the row above) | Clients from before the setting's removal (2026-11-05). A downgrade reads the key as before, and a client that finds none falls back to its old default, on, which captures nothing | The floor is at or above the first Stable release without the setting; then remove the set. The stored key is harmless and needs no migration | [logging.md](logging.md) |

| Backends without `get_client_state_capabilities`: coordinator tab groups, upstream-merge declines and notice dismissals stay in the browser's copy, the renderer decides the merge question itself, and the "agent stopped" sound is inferred from `hasUnreadWork` edges | `coordinatorPaneLayoutStore.ts`, `coordinator-upstream-check.ts`, `nativeNoticeDismissalStore.ts`, `useNotificationSoundService.ts` | None (renderer side) | Backends before the client state repository (2026-11-01) | The floor is a release with the capability. The one-time import of browser copies is unmigrated user state, not skew, and goes separately once no supported renderer can hold one | Backend-owned client state ([storage.md](storage.md)) |
| Preview registry snapshots without `entryServiceId`: the renderer resolves the entry service from `services` with the same protocol rule | `environmentBrowserTarget` (`preview-service-entry.ts`) | None (renderer side) | Backends before `entryServiceId` (2026-11-01) | The floor is a release with `entryServiceId` | Preview services ([browser-previews.md](browser-previews.md)) |
| Terminal WebSocket servers whose `ready` frame does not list the `ping` feature: on every return to the page the renderer replaces the terminal socket and reconciles every channel instead of probing it, and never sends such a server a `ping`, which it would close the socket for | `onVisibilityChange` (`apps/web/src/lib/native/terminal-websocket-client.ts`) | None (renderer side) | Backends before the terminal liveness probe (1202 task 3, 2026-11-04) | The floor is a release whose terminal server advertises `ping`; the replacement path itself stays for a probe that goes unanswered | [1202](../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 3 |
| Terminal WebSocket clients that offer only `orkestrator-terminal.v1`: the server answers each input with its own `operation-result` instead of a cumulative `input-results` frame | `ready`, `operationResult` (`terminal-websocket-server.ts`) | `terminal-websocket.per-input-results` (counts authenticated sockets) | Renderers before input results (1202 task 11, 2026-11-04): a browser tab that outlives the upgrade, or a desktop connected to a newer backend | The floor is at or above the first Stable release whose renderer offers the subprotocol, and the counter is quiet. `operation-result` itself stays for failures and resizes | [1202](../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 11 |
| Terminal WebSocket servers that select `orkestrator-terminal.v1`: the renderer settles each input from its own `operation-result`, and offers v1 after input results so such a server can select it | `TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS` (`terminal-websocket.ts`); `onMessage` (`terminal-websocket-client.ts`) | None (renderer side) | Backends before input results (1202 task 11, 2026-11-04) | The floor is a release whose terminal server selects the subprotocol; the v1 entry can then leave the offer | [1202](../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 11 |
| Renderers that predate paged tmux transcripts: `claude_tmux_transcript` without `page` still answers the whole file as an array | `claude_tmux_transcript` (`tmux-commands.ts`), `TmuxTranscriptReader.readWhole` (`tmux-transcript-reader.ts`) | `tmux-transcript.whole-read` (counts whole reads) | Renderers before paged tmux transcripts (BG-14, 2026-11-04), such as a browser tab open across a backend upgrade | The floor is at or above the first Stable release with paged tmux transcripts, and the counter is quiet | Claude tmux tab |
| Backends that ignore `page` on `claude_tmux_transcript`: they answer an array, which the renderer reads as a whole transcript with nothing earlier to load | `getTranscriptPage` (`apps/web/src/lib/claude-tmux-client.ts`); the permission-mode line scan in `ClaudeTmuxChatTab.tsx` | None (renderer side) | Backends before paged tmux transcripts (BG-14, 2026-11-04) | The floor is at or above the first Stable release with paged tmux transcripts | Claude tmux tab |
| Backends whose `get_file_subtree` and `get_local_file_subtree` ignore `knownDigest` and return the directory itself: the renderer reads that as changed, with no digest to send next time | `normalizeFileSubtreeSnapshot` (`files-sessions.ts`) | None (renderer side) | Backends before conditional folder reads (2026-11-04) | The floor is at or above the first Stable release that answers `knownDigest` on both commands | Files panel |
| Backends that do not list `liveUpdateVersions` in `get_native_agent_sync_capabilities`: a background round sends `get_native_agent_transcript_update` and `get_native_agent_session_state_update` separately, and is never sent `get_native_agent_live_update`. A backend that advertised it and then answers the command as unknown (a downgrade before the next resync) falls back in the same round | `nativeLiveUpdateSupported`, `readLiveUpdate` (`useNativeAgentSession.ts`) | None (renderer side) | Backends before the combined read (E8, 2026-11-04) | The floor is at or above the first Stable release that advertises `liveUpdateVersions` | Native agents |
| `native-agent-session` changes with no `cause`: the renderer treats each as naming discovery, so a running tab on such a backend reads discovery on every change instead of only those that name it. It still leaves the timed round | `nativeSessionInvalidationNamesDiscovery` (`native-agent-observation.ts`) | None (renderer side) | Backends before causes (v2.36.0, 2026-11-03) | The floor is at or above the first Stable release with causes. A cause this client does not know keeps counting: a newer backend may add one | Native agents |
| Claude and Codex bridges that send no `errorCode`: a failed turn's usage limit is recognised from its error text, as it always was | `turnOutcomeFailureKind` (`agent-usage-limits.ts`), `usageLimitFailure` (`@orkestrator/protocol/agent-usage-limits`) | `usage-limit.text-classified` (counts Claude and Codex outcomes recorded as a usage limit from text alone) | Bridges before the structured signal (2026-11-05), typically a container that predates the backend upgrade, and Claude refusals that arrive without a rejected `rate_limit_event` | The text classifier itself is permanent: Grok, OpenCode, Pi and Cursor have no signal, and outcomes recorded before the field carry none. Once the floor is at or above the first Stable release with the signal, a counter still rising shows a refusal path the code misses, which needs its own signal rather than retiring anything | [agent-accounts.md](agent-accounts.md#usage-limit-signal) |
| Backends without `get_environment_snapshot`: a lone `environment` announcement falls back to the project's whole list | `refreshEnvironmentSnapshot` (`useEnvironments.ts`), `singleReadsUnavailableRef` (`useEnvironmentListSync.ts`) | None (renderer side) | Backends before the single-environment read (2026-11-04) | The floor is at or above the first Stable release with `get_environment_snapshot` | Environment list |
| Streams that do not say how they want relayed node events, and desktops that ask for the old name: each relayed event still reaches them as `relayed-node-event`, with no `id`, because it is no longer in the window they replay, and a reconnect that replayed is sent a `resync` frame for each node that relayed something since its cursor | `GatewayEvents.emit`, `writeLegacyRelayedResyncs` (`gateway-events.ts`), `parseRelayedEventsMode` (`gateway-support-extra.ts`) | `relayed-node-event.legacy-stream` (frames to a stream with no `relayedEvents` parameter); `relayed-node-event.legacy-desktop-stream` (frames to a stream asking for `relayedEvents=legacy`) | Renderers and desktops before per-node names (E18, 2026-11-05): a browser tab that outlives the upgrade, or a desktop connected to a newer backend. Also a desktop from E18 until its main process took per-node events (2026-11-05), whose main stream asks for `legacy` | The floor is at or above the first Stable release whose main process asks for `relayedEvents=per-node`, and both counters are quiet. Then the old-name frames, their resyncs and the `legacy` mode can go. Nothing current sends `legacy` any more | [command-nodes.md](command-nodes.md) |
| Command nodes without per-node relayed events: `watch_node_events` answers with no `perNodeEvents` and the gateway ignores `relayedEvents=per-node`, so frames arrive on the main stream as `relayed-node-event`, which the renderer always listens for, and no per-node listener or stream opens. On the desktop's relay the same frames reach main's main stream, and main forwards the old name to every renderer on that connection, since a window reports only per-node listens | `syncWatch` (`apps/web/src/lib/federation/node-events.ts`), `eventStreamPath` (`web-gateway.ts`), `consumeEvents` (`apps/desktop/electron/backend-process.ts`), `listensTo` (`desktop-window-contexts.ts`) | None (renderer and desktop side) | Backends before per-node names (E18, 2026-11-05) | The floor is at or above the first Stable release with per-node names. Then the old-name listener and main's forwarding of the old name can go | [command-nodes.md](command-nodes.md) |
| Renderers before per-conversation startup errors: they read `lifecycleState`, which a failed conversation leaves `ready`, so the rest of their panel carries on and the failed pane shows the refusal from `ensure_native_agent_session` as its connection failure, which names the error. Their only recovery is opening the panel: `ensure_project_coordinator` without `keepConversationErrors` clears every conversation's error, so the next connect starts the bridge again. The backend still refuses a failed conversation its credential and mail whatever the client reads | `ensure` (`coordinator-service.ts`), `ensure_project_coordinator` (`commands-registry-coordinator.ts`) | `coordinator-ensure.conversation-errors-cleared` (counts opens that cleared an error) | Renderers before the field (C6, 2026-11-05): a browser tab open across an upgrade, or a desktop connected to a newer backend | The floor is at or above the first Stable release with `retry_coordinator_conversation` and the counter is quiet; then `keepConversationErrors` can go and `ensure` stops clearing errors | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends that record a startup failure on the workspace, and records such a backend stored: the panel keeps its workspace-level banner, whose Retry runs `ensure_project_coordinator`, and holds sending in every pane, for `lifecycleState: "error"` and `lastStartupError`. A new backend writes neither, and still recovers a stored `error` on `ensure` | The `lifecycleState === "error"` banner (`CoordinatorPanel.tsx`), `sendingHeldReason` (`CoordinatorConversationPane.tsx`), `heldCoordinatorConversation` (`coordinator-runtime.ts`), `ensure` | None (renderer side) | Backends before the field (C6, 2026-11-05). A downgrade ignores `startupError`, which is additive, so that backend simply tries the conversation again; a later upgrade shows the old error until the next start or Retry clears it | The floor is at or above the first Stable release with `retry_coordinator_conversation`. The `ensure` recovery of a stored `error` stays while a data directory can hold one | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends whose transcript and session-state reads refuse a held coordinator conversation (before saved reads for paused conversations, #1476, for a failed one, or for one whose platform is unavailable): such a pane reads nothing and says only why sending is held. It never starts a provider, because those backends refuse the runtime first | `errorMessage` and `connectionState` (`AgentNativeTab.controller.tsx`) with `sendingHeld` (`useNativeAgentSession.ts`) | None (renderer side) | Backends before C6 (2026-11-05), and for an unavailable platform backends before its saved reads (2026-11-05) | The floor is at or above the first Stable release with saved reads for an unavailable platform | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends whose `docker_cleanup_preview` has no `legacyRuntimes`: the cleanup review shows no older-containers section and makes no claim about them. Each environment's own inputs section still reports `host-mounts` | `DockerCleanupReview.tsx` | None (renderer side) | Backends before the list (S-0080, 2026-11-05). A renderer older than the list ignores the two fields | The floor is at or above the first Stable release with `legacyRuntimes`; the field can then stop being optional | Container lifecycle |
| Machines whose environment summaries have no `deleteFailure` or `deletingSince`: a failed delete on such a machine reads as still `deleting` and spins, and a slow one never says how long it has run, which is all they ever did. A client older than the fields ignores them and reads `deleting: true`, keeping the tombstone unavailable and showing its old spinner. Current rows use `deleteFailure` to stop spinning and offer Retry. The failure field contains a fixed message, never the raw error. `deletionError` is an additive record field: a downgraded backend ignores it and its row spins again, while restart recovery still finishes the delete. `deletingStep` (from the additive record field `deletionStep`, 2026-11-06) is relayed only for a running delete and only as one of the known stage names; a client drops a stage it does not know, and an older machine simply never says which stage a slow delete is on | `nodeEnvironmentRowFacts` (`environment-row-facts.ts`) | None (renderer side) | Backends before delete failure reporting (2026-11-05) | The floor is at or above the first Stable release with the fields; they can then stop being optional | Environment list |

Not governed by the window (listed so nobody waits on it):

- `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`, `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`,
  `ORKESTRATOR_RECURRING_METRICS=0`:
  [0048](../todo/transcripts-and-observation/0048-recurring-work-qualification.md).
- Container `legacy-layer` storage, `host-mounts` inputs and network policy 1:
  the switches that forced them on a capable image were removed on
  2026-10-25. An older image or Engine keeps them as its guarded behaviour,
  decided by the image's persisted capabilities rather than a window
  ([container lifecycle](container-lifecycle.md#rollout-switches-and-legacy-runtimes)).
  No new container gets `host-mounts` inputs: creating one from such an image
  has been refused since 2026-11-05, and a runtime that already has them stays
  until the user rebuilds it. That is unmigrated user state, not skew.
- A hello with no `buildCommit` (added 2026-11-05): `list_nodes` reports `null`
  and lists the node normally. This is detected by shape and is permanent, with
  no code to retire and no counter: development, test and modified builds send
  no commit either, so a missing field never shows that a peer is old. An older
  client's `parseBackendHello` ignores the field, and nothing stores it, so a
  downgrade leaves nothing behind.
- Egress gateways from images without `egress-filter`, which enforce
  addresses only (no SNI, Host or DNS name checks), and gateways created with
  the `ORKESTRATOR_EGRESS_FILTER=off` rollback switch: each gateway records its
  shape at its first boot, so neither a start nor a backend upgrade changes
  it, and the backend reports such a gateway's `egressFilter` as `null` or
  `off`. They change only when the user rebuilds the environment
  ([container lifecycle](container-lifecycle.md#name-checks-egress-filter1)).
  Unmigrated user state and a rollback switch, not skew.

| Renderers that build, deliver and prune "Continue in…" handoffs themselves: `save_agent_handoff`, `delete_agent_handoff` and `prune_agent_handoffs` stay registered, and a prompt that already holds its carrier is recognised rather than prefixed again | `commands-registry-prompts.ts`; `promptWithPendingAgentHandoff` (`native-agent-handoffs.ts`) | `agent-handoff.renderer-saved`, `agent-handoff.renderer-carried` | Renderers before `create_agent_handoff` (2026-11-01) | The floor is at or above the first Stable release with it and both counters are quiet. Stored handoffs need no migration: the record is unchanged, and the destination's transcript proves whether one was already delivered | Native agents |
| Backends that do not deliver or prune handoffs: the renderer prepends the history, marks the tab consumed and prunes on hydration when `get_agent_handoff_capabilities` says so. Continue in… itself reports that the backend must be updated | `useAgentHandoff.ts`, `AgentNativeTab.controller.tsx`, `pruneUnreferencedAgentHandoffs` (`paneLayoutStore.ts`), `createAgentHandoff` (`lib/agent-handoff.ts`) | None (renderer side) | Backends before `create_agent_handoff` (2026-11-01) | The floor is a release with `get_agent_handoff_capabilities` | Native agents |
| Backends that do not hold a prompt Claude refused for want of a login: the sign-in card asks the user to resend, as it does for any refusal the backend does not hold | `useSignInResendPending.ts` | None (renderer side) | Backends before `get_native_agent_sign_in_resend` (2026-11-01) | The floor is a release with it; the card's wording remains for prompts a backend restart lost | Native agents |
| Backends whose `transcript_media_open_stream` requires an `environmentId`: a detached transcript's host media, sent with none, is refused with `invalid_input`, and the renderer reads the bounded base64 copy instead | `mediaStreamFailure` (`media-presentation.ts`) treating `invalid_input` as fallback, used by `FilePreview.tsx` | None (renderer side) | Backends before readable-roots streams (batch E-0580, 2026-11-05) | The floor is at or above the first Stable release with readable-roots streams | [5800](../todo/cross-cutting/5800-file-read-streaming-leftovers.md) |
| Backends without `get_database_stats` or `plan_diagnostics_bundle`: Settings → Debug says the database figures are unavailable, and Export diagnostics says the backend is too old | `DatabaseStorageCard.tsx`, `failureText` (`DiagnosticsExportCard.tsx`) | None (renderer side) | Backends before the release that adds them | The floor reaches the first release with these commands | Logging and diagnostics |
| Backends that do not report `egressFilter`: the Network section says nothing about the gateway's name checks either way, rather than reading the missing field as an older image | `NameChecks` (`EnvironmentNetworkPolicyStatus.tsx`) | None (renderer side) | Backends before the gateway's name checks (S-0100, 2026-11-05) | The floor is at or above the first Stable release that reports `egressFilter` | Containers |

### Downgrade fences

These let older software refuse or safely ignore newer data. They stay while
the window includes a release that needs them:

- the `retain-history-close:` teardown-intent fence
  (`packages/protocol/src/tab-teardown.ts`);
- Cursor's legacy `overflow` boolean written beside `steerFence.overflowBefore`;
- `sourcePromptQueue` provenance on compose drafts, still validated on load;
- the container lifecycle schema floor ([container-lifecycle.md](container-lifecycle.md),
  "Schema floor and downgrade").

### Retired

| Path | Retired | Why it could go |
| --- | --- | --- |
| Renderer recognition of raw OpenCode `{ info, parts }` envelopes (the `opencode-envelope` entry of `LEGACY_TRANSCRIPT_SHAPES`, `apps/web/src/lib/chat/transcript-skew.ts`) | 2026-10-24 | Served backends before 2.19.17. The registry and the permanent "unrecognized" notice stay. |
| Design receipts with no intent digest matched on kind, preconditions, gesture and client ids (`settledMatches`, `core/design/records.ts`) | 2026-10-24 | Digests shipped in v2.21.0. A receipt without one now never matches: the retry is refused with `reusedCorrelation`, runs nothing, and `operation_status` still answers. |
| `export_build_pipeline_for_downgrade` (one pipeline in the pre-split inline schema) | 2026-10-24 | The split (#875) is in v2.21.0, so every release in the window reads the current format; the export only served unpublished builds. |
| Prompt-queue claim commands (`claim_prompt_queue_head`, `acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`, `requeue_prompt_queue_message`) and their renderer wrappers | 2026-10-24 | No client has called them since at least 2026-08-01; the backend drainer dispatches through storage. |
| Legacy `DELETE` close for bridges before `POST /session/:id/close` (`LEGACY_DELETE_RETAINS_HISTORY`, `bridge-close.legacy-delete`) | 2026-10-31 | All five bridges in every published release from v2.21.0 serve the route and answer an unknown session in band, so only an unpublished source build reaches it. That build now gets the restart notice instead. |

## Renderer–backend skew

`BackendVersionReminder` (`apps/web/src/components/BackendVersionReminder.tsx`)
compares the bundled version with the backend's `get_app_version` on load and
after every event-stream reconnect and names the older side
([remote-gateway.md](remote-gateway.md#version-reminders)). It warns and never
blocks.

Transcript views that render backend transcripts directly (build-pipeline
stages, Multi Review reviewers) classify each entry by shape at
`toPipelineTranscript` (`transcript-skew.ts`). An entry in a known legacy shape
(none are registered today) or with no field of a display row becomes one
muted notice row per run instead of an empty row or nothing. The
"unrecognized" notice is permanent; each legacy entry retires with the window.

There is no version or capability handshake. `/__orkestrator/status` is
authenticated and every client already probes it, so it could carry the app
version and a capability revision later. Add one only when a change cannot be
detected from the payload (a change of behaviour rather than of shape).

### Coordinator build admission identity

Owner: coordinator workflow admission. New pipeline snapshots carry the additive
`coordinatorLaunchId` installed by the backend at admission. Older snapshots or
leaves without an echo cannot prove creation. The command node requires
`node-coordinator-build-origin` before sending a new-environment start, so an
older leaf is explicitly refused before launch. A missing or mismatched echo
also refuses creation authority. Existing recorded creation
receipts still load. `environmentCreationSettledAt` is additive bookkeeping;
older backends ignore it and conservatively retain and poll those records.
The refusal must remain for legacy data; peer handling can retire once the
support floor includes admission identity in every published backend.

### Log detail expiry metadata

A backend that implements log-detail expiry returns `logDetailExpiresAt` for saved
raised detail, or `logDetailKeepRaised: true` when kept on. Until either is present,
the renderer does not promise automatic reversion or offer Keep raised. Older
backends ignore those keys and require the user to lower detail manually. On a
new backend, saving raised detail supplies the expiry and enables the controls.
