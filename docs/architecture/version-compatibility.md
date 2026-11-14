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
  Drafts that were never published (v2.24.0-alpha to v2.26.1-alpha and
  v2.35.2-beta, although npm carries the alphas), tags with no release
  (v2.22.0 to v2.22.2) and source or dev builds (version `0.0.0`, or any
  commit between releases) are not covered. Nothing before v2.21.0 was ever
  published as a release or on npm, so only source builds ever ran it.
- Prereleases are ordered by version, so a Beta or Unstable release at or
  after the floor is covered like any other.
- The floor moves by itself: it becomes v2.21.1 on 2026-12-15, v2.22.3 on
  2026-12-16 and v2.23.0 on 2026-12-18. Nobody needs to announce it.
- **Until 2026-12-15 the floor is v2.21.0.** To find it on another day, take
  the newest Stable release published at least 60 days earlier, or v2.21.0
  if there is none.

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
| Open browser tab → upgraded backend | The backend serves renderers in the window; `BackendVersionReminder` asks the user to reload. When the server is the older side it says so ("This server runs an older Orkestrator"), and it stops offering a reload once one brought back the same pair of versions (a renderer the server does not bundle). |
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

### Checking a pairing live

`scripts/older-release-stack.ts` starts one side of a pairing from a release
tag on a throwaway root under `output/older-release/<tag>/`: the tag is
archived from this repository (npm carries no v2.21.0 and no renderer),
installed with `--frozen-lockfile --ignore-scripts`, and only what the mode
needs is built. The backend runs as `agent-test` on loopback, never on 34121,
34122 or 45507, with Docker unreachable, no inherited credentials, and its
gateway token in the data directory's owner-only `gateway-auth.json`
(`--url <url> --credential-file <file>` for the CLI, or the login form).

```bash
# An older backend serving today's renderer (a dev:test profile's, or any loopback URL)
bun scripts/older-release-stack.ts backend --tag v2.21.0 --renderer-profile <profile>
# Today's backend serving an older release's renderer
bun scripts/older-release-stack.ts renderer --tag v2.36.1
```

`--toolchain-bin-dir` hands the backend a managed toolchain (a profile's, for
a fake-model turn). `--root` picks another throwaway root; the launcher replaces
`<root>/source` only when it is absent, empty or carries the launcher's own
marker, and otherwise refuses with nothing deleted. The launcher stays attached and stops its backend on
SIGINT or SIGTERM; a profile restart changes the renderer URL, so restart a
`backend` stack after it.

Recorded runs:

- 2026-11-06, v2.21.0's backend with today's renderer and CLI:
  [0048](../todo/transcripts-and-observation/0048-recurring-work-qualification.md#multi-client-restarts-and-an-older-backend-2026-11-06-linux).
- 2026-11-13, v2.21.0's backend with today's renderer (the launcher's first
  run): the version reminder named the older server and offered a reload
  once; after a reload that brought back the same versions it offered none.
- 2026-11-13, today's backend with v2.36.1's renderer, the last Stable
  release before per-conversation startup errors (C6): a coordinator
  conversation whose Claude bridge exited before becoming healthy (a stub
  `bun` in the toolchain) showed in the old pane as "Connection Failed" naming
  the error, with the rest of the panel working; the pane's Retry repeated the
  refusal, and opening the panel again cleared the error and counted
  `coordinator-ensure.conversation-errors-cleared`, as the Register row says.
  The full record is 4880 (retired), in Git history at
  the parent of the commit that deleted it (`git log -1 --diff-filter=D -- docs/todo/coordinator-and-multi-review/4880-c6-live-checks.md`).

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
2026-10-24 by to-do 0016 (retired on 2026-11-11; the retirement is described in
[native-agent-commands.md](native-agent-commands.md#lifecycle)).
A session-route 404 now returns `outdated-bridge` without reading a global
list. Each rejected read records `slash-catalogue.outdated-bridge` in the
persistent usage counters, alongside the per-agent in-memory count. Since
2026-11-13 a 200 answer without `catalogueVersion` is refused the same way
(logged as `unversioned-catalogue`): every bridge from v2.21.0 stamps it on
every `/session/:id/commands` answer (see Retired).

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
| Bridges whose `/transcript` answers 404 for a session it has not loaded: progressive reads fall back to the whole `/messages` body | `readHttpBridgeTranscriptSnapshot` (`http-bridge/progressive.ts`) | `bridge-transcript.messages-fallback` (counted only when `/messages` served the session) | Bridges before #670 (2026-09-09), and every Claude bridge before 2026-10-26, v2.21.0 included: its `/transcript` reads only resident sessions, so after a bridge restart only `/messages` loads a persisted one | The floor is at or above the first Stable release whose Claude bridge loads the session on `/transcript` (0050 item 3) | [0050](../todo/transcripts-and-observation/0050-transcript-history-efficiency.md) item 3 |
| Joined `sync-v1` history paging, the v1 cursor namespace, and the renderer's mint of a joined cursor | `getMessagePage` → `refreshProjection(… "sync-v1")`, `projectionHistory` (`native-agent-transcript-projection.ts`); the sync-v1 mint in `loadEarlierMessages` (`useNativeAgentSession.ts`) | Split by why the session's latest view had no direct cursor (0232 item 3): `history.joined-v1-page.unpaged-source` (its source has no direct pages; quiets with the `/messages` fallback row), `history.joined-v1-page.unnamed-cursor` (its source pages, but no kept row named a cursor, including a first-message snapshot whose projected rows exceed the backend byte bound, or the cursor was too long to wrap), and `history.joined-v1-page` (the view offered a direct cursor, or none was read: a caller paging with a v1 cursor it did not need). Before 2026-10-29 the base id counted every joined page. The mint itself is renderer-side; the pages after it are counted | Views without a direct cursor. Since 0232 (2026-10-27) a backend names one on a view whose provider pages when a usable whole-message boundary remains, including byte-bounded views, and every renderer in the window adopts it (v2.21.0 does), so on such a backend this serves only sources without direct pages (the `/messages` fallback above, a bridge without page routes), a provider cursor too long to wrap, a first-message snapshot whose projected rows exceed the backend byte bound without naming a new cursor, and an OpenCode view retaining only a failed message's inline error row after its main row was byte-omitted. The renderer's mint also serves backends before 0232, whose byte-bounded views carry no cursor | The `/messages` fallback row has retired, the floor is at or above the first Stable release with 0232, the remaining first-message byte-bound, cursor-boundary and cursor-length cases have direct recovery, and all three counters are quiet on the machines you can reach (0232 item 4) | [0232](../todo/transcripts-and-observation/0232-direct-history-cursor-minting.md) |
| Legacy preview loopback route `/__orkestrator/browser/loopback/<port>/` and the shared per-window preview partition | `GatewayProxy.proxyToTarget` (`gateway-proxy.ts`); `browserPreviewPartitionForWindow` (`desktop-window-lifecycle.ts`) | `preview.legacy-loopback-route` (counts requests) | Desktops with the transport off or older than the default, web clients without private origins, and `localhost` URL tabs, which never migrate | The floor is at or above the first Stable release with service previews as the desktop default, and the `localhost` URL tabs have an answer. The default flip and the migration of matching tabs are in (2026-11-04) | [0042](../todo/previews-and-annotations/0042-service-preview-rollout.md) item 6 |
| Preview tunnel v1, one WebSocket with HELLO and OPEN per upstream connection: the backend still accepts `orkestrator.preview-tunnel.v1`, and the desktop opens v1 when an attachment does not advertise `multiplexSubprotocol` | `PreviewTunnelServer.handleUpgrade`/`accept` (`preview-tunnel-server.ts`); `PreviewTunnelConnector.open` → `openPreviewTunnel` (`preview-tunnel-session.ts`, `preview-tunnel-client.ts`) | `preview.tunnel-v1` (counts v1 sockets the backend accepts; the desktop side is not counted) | Desktops and backends before tunnel v2 (4500, 2026-11-04) | The floor is at or above the first Stable release with tunnel v2 and the counter is quiet | [Browser previews: desktop tunnel](browser-previews.md#desktop-tunnel) |
| Backends without the built-in container resource default: Settings disables "Built-in default" and says none applies when `get_docker_capacity` has no `builtInDefault` | `legacyBackend` (`ContainerResourceLimitsSettings.tsx`) | None (renderer side) | Backends before the default (todo 0022, 2026-10-25) | The floor is a release with `builtInDefault` | to-do 0022 (retired 2026-11-11; [Built-in default](container-lifecycle.md#built-in-default)) |
| Build Pipeline Address sessions without the typed report marker: Verify reads the session's last assistant text instead of its `fix-result` | `verificationAddressReport` (`build-pipeline-address-findings-report.ts`); `finishAddress` (`build-pipeline-service-recovery.ts`) advances such a session without reading a result | `build-pipeline.address-text-report` (counts Verify prompts built for such a session) | Pipeline records whose Address session started before the typed handoff (graphs item 004, 2026-10-29) and is still resumed or restarted from Verify | The floor is at or above the first Stable release with 004 and the counter is quiet. A record from before then may take a safe, explicit outcome instead: Verify told no Address report is available | 004 (retired graphs plan item; `git show 2b876486b:plans/graphs/004-typed-address-report.md`) |
| Self-reminders spelled `source: "workflow"` in the carrier, with `selfReminder: true` | `carrierActor` (`packages/protocol/src/agent-mail.ts`), read by `peerMailFromPayload` (`client-only-messages.ts`) | None (renderer side) | Renderers before `self-reminder` (2026-11-05), which refuse any other `source` and would show the raw carrier. The stored message and the mail tools already carry the real value | The floor is at or above the first Stable release with `self-reminder`. Then write the real value and drop the flag | X1, [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) |
| Pre-contract leaves without `node-mail-turn-origin`: a coordinator's mail reaches them without saying it arose from agent mail | The [`node-mail` client](../../packages/protocol/src/contract/domains/node-mail/client.ts)'s version-0 adapter leaves `turnOrigin` out of `deliver_node_mail` for `send_coordinator_node_mail` (`commands-registry-coordinator-nodes.ts`) | `domain-adapter.backend.node-mail.v0` (every call through that adapter) | Leaves before `node-mail-turn-origin` (2026-11-05), which refuse the unknown key. They frame mail as they always did, so no property weakens. Mechanical since 2026-11-07 ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)): only a pre-contract leaf, one whose hello has no `node-mail` range, takes this path, through the client's version-0 adapter; a leaf with the domain has the feature by its version | The floor is at or above the first Stable release with `node-mail-turn-origin`; the adapter goes when the floor passes the first Stable release that advertises `node-mail` | X1, [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) |
| Leaves without `node-coordinator-build-origin`: new-environment builds are refused before launch | `start_coordinator_node_build_pipeline` | `coordinator-build.origin-upgrade-required` | Leaves predating admission identity (2026-11-05) | The floor includes the first Stable release with admission identity; retain legacy snapshot refusals permanently | X1 |
| Live prompt-queue claim state (`outstandingClaim`) | `restoreLegacyPromptQueueClaims`, queue mutation and reservation guards | None (read normalization) | Claims from releases through v2.29.0-beta (the last with the claim commands), including external callers. Those releases refuse a schema-5 database (from v2.34.4-beta), so a claim seen here was either carried across the upgrade or written by a backend that opened the database before that migration and is still running | Claim-writing peers can no longer share the database; retain exclusion until settlement or expiry meanwhile | [0078](../todo/cross-cutting/0078-legacy-prompt-queue-claim-state.md) |
| New names for the Rework and Address Findings steps in stored and transmitted data: this build writes `fix`, `fixing`, `address`, `addressing`, `fixModel` and the rest, and reads the new names as well | `workflow-vocabulary.ts`, run by the renderer's stores and the backend's start commands; `normalizeActionDefaults` reads a saved `addressFindings` key; `workflow-tab-title.ts` reads the former `Fix` tab title; the CLI's former flags | None (renderer side and a read normalization) | Peers on the build that flips the names ([4740](../todo/cross-cutting/4740-workflow-vocabulary-stage-two.md)), and restored tabs with the former title | The floor is at or above the first Stable release with the flip. The user approved flipping before the window ends, once their own machines are updated (2026-11-04); the readers still stay for the window | [4740](../todo/cross-cutting/4740-workflow-vocabulary-stage-two.md) |
| Nodes without shared usage readings: a command node's pass reads `unknown-command` from `collect_shared_usage_readings` as a node that takes no part, and neither sends to it nor retries | `NodeUsageSync.collect` (`apps/backend/src/core/nodes/node-usage-sync.ts`) | None (a node that predates the commands only shows its own readings) | Leaves before shared usage readings (2026-11-09) | The floor is at or above the first Stable release with `collect_shared_usage_readings` | [Agent accounts](agent-accounts.md#shared-readings) |
| Backends without `launch_build_pipeline`: the renderer merges the saved Build defaults itself and calls `start_build_pipeline` | `legacyBuildPipelineStartInput` (`apps/web/src/lib/build-pipeline-launch-compat.ts`), chosen in `useBuildPipeline.ts` when `incompatibility(error, "launch_build_pipeline")` reads `unknown-command` | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `launch_build_pipeline` | Build launch |
| Releases without a published lockfile: `installRelease` installs them with a plain `bun install`, so their transitive dependencies resolve afresh | The `else` branch in `installRelease` (`packages/protocol/src/node/standalone-service.ts`) | None (runs in the service's installing process) | `service install --release` of a release older than `resources/release-runtime/` (2026-11-04), v2.36.3-beta and earlier | The floor is at or above the first Stable release with `resources/release-runtime/` | to-do 5022 (retired 2026-11-14; `git show $(git log -1 --diff-filter=D --format=%h -- docs/todo/cross-cutting/5022-release-chain-live-evidence.md)^:docs/todo/cross-cutting/5022-release-chain-live-evidence.md`) |
| Releases without a published lockfile, first run through the site's `install.sh`: it runs them through `bun x`, so their transitive dependencies resolve afresh | The branch in `main` of `apps/web-public/public/install.sh` that finds no `resources/release-runtime/` in the fetched package | None (runs on the user's host before any backend) | `PINNED_RELEASE` 2.36.1, the pin at the time of writing, and any `ORKESTRATOR_INSTALL_VERSION` older than `resources/release-runtime/` (2026-11-04), v2.36.3-beta and earlier | `PINNED_RELEASE` is a Stable release with `resources/release-runtime/`, and older releases are outside the window | to-do 5022 (retired 2026-11-14; `git show $(git log -1 --diff-filter=D --format=%h -- docs/todo/cross-cutting/5022-release-chain-live-evidence.md)^:docs/todo/cross-cutting/5022-release-chain-live-evidence.md`) task 4 |
| Backends without `start_feature_plan_build`: the renderer sequences ticket, claim, start and link with its own rollbacks | `legacyStartFeaturePlanBuild` (`apps/web/src/lib/feature-plan-build-compat.ts`), chosen in `FeaturesView.tsx`; `claim_feature_plan_build` stays registered for it | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `start_feature_plan_build`; `claim_feature_plan_build` and the store's `claimFeatureBuild` retire with it | Build launch |
| Backends without `launch_multi_review`: the renderer reuses an active review, fills the branch and instruction, starts the review and opens its tab | `legacyLaunchMultiReview` (`apps/web/src/lib/multi-review-launch-compat.ts`), chosen in `useActionBarController.ts` | None (renderer side) | Backends before the one-request launches (2026-11-01) | The floor is at or above the first Stable release with `launch_multi_review` | Multi Review |
| Backends without `get_multi_review_launch_defaults`: the Multi Review configure dialog opens on rows the renderer resolves from its own copy of the settings and model catalogue, instead of the environment's node's answer | `useMultiReviewLaunchDefaults` (`apps/web/src/hooks/useMultiReviewLaunchDefaults.ts`) answering `unsupported`, read by `MultiReviewLaunchDialog.tsx` | None (renderer side) | Backends before the backend-resolved launch defaults (2026-11-08) | The floor is at or above the first Stable release with `get_multi_review_launch_defaults`; then drop the dialog's own row resolution and the plain click's `legacySelection` with the row above | Multi Review |
| Backends without `record_renderer_errors`: a renderer (a desktop window's or a browser tab's) stops sending its error ring for that load when the backend answers "Unknown backend command", and keeps the entries in memory | `startRendererErrorUpload` (`apps/web/src/lib/renderer-error-upload.ts`) | None (renderer side) | Backends before the renderer error ring (E16, 2026-11-05), such as a remote backend a newer desktop connects to, or one a hosted web client signs in to | The floor is at or above the first Stable release with `record_renderer_errors`; then a failed send is retried like any other | [logging.md](logging.md#renderer-failures-in-the-essential-log) |
| Backends whose `record_renderer_errors` refuses any argument but `entries`: when a write with `client` fails with "Unexpected arguments field: client", the renderer sends the batch again without it and leaves `client` out for the rest of that load; such a backend applies only its shared per-minute bound | `rendererErrorSender` (`apps/web/src/lib/renderer-error-client.ts`) | None (renderer side) | v2.36.5-beta and v2.36.6-beta, whose handler checked the keys by hand before the command was defined with a tolerant schema (#1983, v2.37.0-alpha) | The floor is at or above v2.37.0-alpha; then the retry without `client` can go | [logging.md](logging.md#renderer-failures-in-the-essential-log) |
| Leaves without `node-coordinator-mail`: mail from a command node's coordinator to that leaf's coordinator is refused with "update that machine", and `list_mailboxes` with its `nodeId` reports the coordinator unreachable. Nothing is sent to the leaf | `olderNodeRefusal` (`coordinator-node-coordinator-mail.ts`), when the [`node-mail` client](../../packages/protocol/src/contract/domains/node-mail/client.ts) says the leaf lacks `node-coordinator-mail` | `node-coordinator-mail.older-node` (counts refusals and unreachable answers), `domain-adapter.backend.node-mail.v0` | Leaves before coordinator-to-coordinator node mail (2026-11-02); their workers can still be mailed. Mechanical since 2026-11-07 ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)): only a pre-contract leaf, one whose hello has no `node-mail` range, takes this path, through the client's version-0 adapter; a leaf with the domain has the feature by its version | The floor is at or above the first Stable release that advertises `node-coordinator-mail`, and the counter is quiet; then the check can go, since every leaf in the window understands the address | [coordinator.md](coordinator.md#coordinators-on-two-nodes) |
| Command nodes without `node-coordinator-mail`: a leaf coordinator's mail upward (`send_coordinator_command_node_mail`, answered `placement: "node-outbox"`) is held in the leaf's outbox, neither offered nor acknowledged, while that command node collects without `coordinatorMail`; it is delivered once the command node is updated. Such a node would deliver it as a worker's report from a runtime id it has no environment for, outside its pair budget | `LeafNodeMail.collect`/`ack` (`nodes/node-mail.ts`) | `node-coordinator-mail.older-command-node` (counts collects that held one) | Command nodes before coordinator-to-coordinator node mail (2026-11-02). Recorded 2026-11-07 ([7008](../../plans/unified/7008-domain-kanban-mail-accounts-mcp.md), from [1012](../../plans/unified/1012-mixed-version-qualification.md)'s v2.35.1-beta run). Unaffected by the `node-mail` domain: the leaf reads the command node's `collect_node_outbox` keys, which a current command node always sends | The floor is at or above the first Stable release that advertises `node-coordinator-mail`, and the counter is quiet; the filter can then go | [coordinator.md](coordinator.md#coordinators-on-two-nodes) |
| Nodes without `node-mail-attachments`: a command node refuses a coordinator's mail with images to such a leaf with "update that machine", and a leaf's coordinator's mail with images stays in its outbox until its command node has the capability | `assertNodeTakesMailAttachments` (`coordinator-mail-attachments.ts`) through the [`node-mail` client](../../packages/protocol/src/contract/domains/node-mail/client.ts), whose version-0 adapter also refuses `attachments` with a typed `unsupported-field`; `LeafNodeMail.collect` (`nodes/node-mail.ts`) on the leaf | `node-mail-attachments.older-node` (counts refusals), `domain-adapter.backend.node-mail.v0` | Nodes before coordinator image mail (2026-11-04); their plain mail is unaffected. The command node's side is mechanical since 2026-11-07 (1010): a leaf with the `node-mail` domain takes images, and `attachments` is critical on `deliver_node_mail`. The leaf's side still reads the command node's `attachmentMail` flag, which a current command node always sends | The floor is at or above the first Stable release that advertises `node-mail-attachments`, and the counter is quiet; then the check can go | [command-nodes.md](command-nodes.md#images-between-nodes) |
| Leaves without `node-mail-return`: an agent's mail to "coordinator" for a repository with no coordinator on the command node stays in the leaf's outbox, as it always did, instead of being handed back to the leaf's own coordinator. A leaf newer than its command node has the same wait, which the leaf cannot see | `NodeMailCollector.handBack` (`nodes/node-mail-collector.ts`) through the [`node-mail` client](../../packages/protocol/src/contract/domains/node-mail/client.ts), whose version-0 adapter answers `return_node_outbox_mail` with `unknown-command` without the capability | `node-mail-return.older-leaf` (counts collect attempts that could not hand back), `domain-adapter.backend.node-mail.v0` | Leaves before the command node became the default destination (2026-11-04); mail with a coordinator to reach is unaffected. Mechanical since 2026-11-07 ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)): only a pre-contract leaf, one whose hello has no `node-mail` range, takes this path, through the client's version-0 adapter; a leaf with the domain has the feature by its version | The floor is at or above the first Stable release that advertises `node-mail-return`, and the counter is quiet; then the check can go | [command-nodes.md](command-nodes.md#updates-from-leaves) |
| Leaves without `ticket-sync`: the command node does not sync tickets with them and its board shows "update that machine". A coordinator's ticket tools with their `nodeId` read and write the leaf's own board as before (a ticket created for it stays there), and `start_build_pipeline` with a ticket of the command node's board is refused with what to do instead | `olderLeafTicketMessage` (`nodes/node-ticket-sync.ts`), `coordinator-node-tickets.ts`, both deciding through the [`ticket-sync` client](../../packages/protocol/src/contract/domains/ticket-sync/client.ts) (`syncs`) | `ticket-sync.older-node` (counts tool calls and refused builds), `domain-adapter.backend.ticket-sync.v0` | Leaves before Kanban sync (2026-11-03). Mechanical since 2026-11-07 ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)): a leaf with the `ticket-sync` domain range syncs; only a pre-contract leaf is gated on the capability, by the client's version-0 adapter. A leaf whose range shares no version is reported the same way | The floor is at or above the first Stable release that advertises `ticket-sync`, and the counter is quiet; the adapter goes when the floor passes the first Stable release that advertises the `ticket-sync` domain | [tickets.md](tickets.md#sync-across-machines) |
| Command nodes without `coordinator-notices`: a leaf that never received `coordinatorNotices` on `collect_node_outbox` from a command node keeps its notices on its own coordinator, and that command node hears of the leaf's automatic switches through its event stream only. A queued notice handed to a downgraded command node goes back to the leaf; if a downgraded leaf still holds one, it is collected as ordinary agent mail, which is why its `body` is readable | `CoordinatorNoticeRouter.route`, `LeafNodeMail.collect` | `coordinator-notices.older-command-node` (counts notices kept) | Command nodes before the notice hierarchy (2026-11-04) | The floor is at or above the first Stable release that advertises `coordinator-notices`, and the counter is quiet | [coordinator.md](coordinator.md#who-hears-a-notice) |
| Leaves without `coordinator-notices`: a command node mails its coordinators about their automatic switches from `AGENT_ACCOUNT_AUTO_SWITCHED_EVENT`, which a link drop loses, sends them no new `collect_node_outbox` key, and receives no notices from them | `bridgeRemoteAutoSwitchNotices` (`agent-accounts-auto-switch-notices.ts`), `NodeMailCollector.collectOnce`, which share `leafTakesCoordinatorNotices` (`nodes/node-mail-collector.ts`, the [`node-mail` client](../../packages/protocol/src/contract/domains/node-mail/client.ts)) | `coordinator-notices.older-leaf` (counts switches heard this way), `domain-adapter.backend.node-mail.v0` | Leaves before the notice hierarchy (2026-11-04). Mechanical since 2026-11-07 ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)): only a pre-contract leaf, one whose hello has no `node-mail` range, takes this path, through the client's version-0 adapter; a leaf with the domain has the feature by its version | The floor is at or above the first Stable release that advertises `coordinator-notices`, and the counter is quiet; the event and the bridge can then go | [coordinator.md](coordinator.md#who-hears-a-notice) |
| Nodes without `get_machine_load`: `list_nodes` shows their load as unavailable with reason `older-version` | `readNodeMachineLoad` (`control-mcp/machine-load.ts`) | `machine-load.older-node` (counts asks, up to one per node per `list_nodes` call) | Nodes before the machine-load change; the rest of `list_nodes` is unaffected | The floor is at or above the first Stable release with `get_machine_load`, and the counter is quiet | to-do 1030 (retired 2026-11-13; [Choosing a machine](coordinator.md#choosing-a-machine)) |
| Bridges without compaction instructions: `/compact <instructions>` on Claude or Pi sends `{ instructions }`, an older bridge ignores the body and compacts plainly, and the missing `instructions: "applied"` comes back as an applied outcome with `instructionsIgnored`; the composer clears the draft and says the instructions were not used (restart the environment). Never a failure, which would invite a second compaction | `compactBridgeSession` (`http-bridge/compact.ts`); the compact branch of `submitDraft` (`AgentNativeTab.controller.tsx`) | `compact.instructions-ignored` (counts compactions whose instructions were not confirmed) | Claude and Pi bridges before compaction instructions (0007 task 8, 2026-11-03), typically a container that predates the backend upgrade | The floor is at or above the first Stable release with compaction instructions and the counter is quiet | [0007](../todo/agent-engines/0007-provider-sdk-adoption-backlog.md) task 8 |
| Container bridges holding a plain token: a bridge an older backend started, or any bridge on an image without `bridge-credential`, keeps its token in a `node`-readable `/tmp` file and in its environment, and its token may have no `okb_` prefix. The same goes for OpenCode's server password, which has its own file there. `BRIDGE_TOKEN_PATTERN` accepts both forms, `readContainerBridgeToken` falls back to the `/tmp` file, and each bridge still takes `<TOKEN_ENV>` from an older backend | `container-bridge-credential.ts`, `local-server-runtime.ts`, `loadBridgeCredential` (`bridge-credential.ts`) | `bridge-credential.token-file` (counts reads that found a token in `/tmp`) | Running bridges from before the verifier (2026-11-04), and images that predate it, whose containers keep the agent-readable token until rebuilt | The floor is at or above the first Stable release with `bridge-credential=1`, no supported backend starts a bridge with a plain token, and the counter is quiet. The `bridge-credential` image check stays for older images, as unmigrated state | To-do 3930 (deleted 2026-11-06) |
| Realms from before `patch_global_config` saving a model favourite: a workspace client (a client grant, or the relay) may not change global settings, but an `update_global_config` or `patch_global_config` that would change nothing on the machine is answered with its current settings instead of refused. Any change is still refused with 403 | `GatewayHandlers.handleInvoke` (`gateway-handlers.ts`), `answerConfigEcho` (`nodes/node-relay.ts`), `isGlobalConfigEcho` (`nodes/workspace-grant-scope.ts`) | `workspace-grant.config-echo` (counts answered echoes) | Command nodes through v2.35.1-beta, whose realms write a favourite to the command node and then send the leaf's own settings back unchanged with `preserveInheritedSettings`. Unaffected by the `config` domain ([7005](../../plans/unified/7005-domain-projects-config.md), 2026-11-07): the gateway and the relay decide from the raw arguments before the registry runs, and both writes stay registered, now as defined `admin` commands | The floor is at or above v2.36.0, the first Stable release whose realms use `patch_global_config`, and the counter is quiet; then the two config writes are refused outright | [command-nodes.md](command-nodes.md) |
| Clients that still send `experimentalCodexRawEventLogging`, the retired Codex raw event logging setting: a workspace client's write is not refused for that key alone, because an older form sends it whatever the machine stores. Nothing reads the key; a direct save stores it as it stores any unknown key, and a stored one stays in `config.json` for a downgrade | `RETIRED_GLOBAL_SETTING_KEYS` (`nodes/workspace-grant-scope.ts`) | `workspace-grant.config-echo` (shared with the row above) | Clients from before the setting's removal (2026-11-05). A downgrade reads the key as before, and a client that finds none falls back to its old default, on, which captures nothing | The floor is at or above the first Stable release without the setting; then remove the set. The stored key is harmless and needs no migration | [logging.md](logging.md) |
| Clients that still send `openCodeProtocol`, the retired "Use OpenCode 2 for new sessions" setting: a workspace client's write is not refused for that key alone, because an older form sends it whatever the machine stores. Nothing reads the key: OpenCode 2 runs every session since OpenCode 1.x was retired. The field stays in the `config` schema, and the native-session record's `openCodeProtocol` marker stays in the `native-sessions` schema (records the preview wrote still carry `v2`), so neither domain's schema changed | `RETIRED_GLOBAL_SETTING_KEYS` (`nodes/workspace-grant-scope.ts`); the two schema fields (`contract/domains/config/models.ts`, `contract/domains/native-sessions/schemas.ts`) | `workspace-grant.config-echo` (shared with the row above) | Clients from before the retirement (2026-11-11); their settings page still shows the switch, which no longer does anything | The floor is at or above the first Stable release without the setting; then remove the key from the set and both fields from the schemas with a domain version bump | [agent-engines.md](agent-engines.md#opencode) |
| Backends without `get_client_state_capabilities`: coordinator tab groups, upstream-merge declines and notice dismissals stay in the browser's copy, the renderer decides the merge question itself, and the "agent stopped" sound is inferred from `hasUnreadWork` edges | `coordinatorPaneLayoutStore.ts`, `coordinator-upstream-check.ts`, `nativeNoticeDismissalStore.ts`, `useNotificationSoundService.ts` | `domain-adapter.renderer.config.v0` (renderer calls through that adapter) | Backends before the client state repository (2026-11-01). Mechanical since 2026-11-07 ([7005](../../plans/unified/7005-domain-projects-config.md)): the capabilities are part of `config` version 1 (`CONFIG_CLIENT_STATE_CAPABILITIES`), so only a pre-contract backend is asked `get_client_state_capabilities`, through the client's version-0 adapter | The floor is a release with the capability. The one-time import of browser copies is unmigrated user state, not skew, and goes separately once no supported renderer can hold one | Backend-owned client state ([storage.md](storage.md)) |
| Renderers before `config` (pre-contract): the backend keeps `get_client_state_capabilities` registered, now as a defined command, although a renderer with the domain never calls it | `commands-registry-client-state.ts` | None (every renderer in the window is pre-contract and calls it; a renderer with `config` answers it from the version) | Renderers before `config` version 1 (2026-11-07, [7005](../../plans/unified/7005-domain-projects-config.md)) | The floor is at or above the first Stable release that advertises `config`; then the command goes with the client's version-0 adapter | Backend-owned client state ([storage.md](storage.md)) |
| Preview registry snapshots without `entryServiceId`: the renderer resolves the entry service from `services` with the same protocol rule | `environmentBrowserTarget` (`preview-service-entry.ts`) | None (renderer side) | Backends before `entryServiceId` (2026-11-01). Mechanical since 2026-11-07 ([7004](../../plans/unified/7004-domain-previews-annotations-artifacts-design.md)): every backend that advertises `previews` sends it, so only answers through the `previews` client's version-0 adapter lack it (`domain-adapter.renderer.previews.v0`) | The floor is a release with `entryServiceId` | Preview services ([browser-previews.md](browser-previews.md)) |
| Terminal WebSocket servers whose `ready` frame does not list the `ping` feature: on every return to the page the renderer replaces the terminal socket and reconciles every channel instead of probing it, and never sends such a server a `ping`, which it would close the socket for | `onVisibilityChange` (`apps/web/src/lib/native/terminal-websocket-client.ts`) | None (renderer side) | Backends before the terminal liveness probe (1202 task 3, 2026-11-04) | The floor is a release whose terminal server advertises `ping`; the replacement path itself stays for a probe that goes unanswered | to-do 1202 task 3 (retired 2026-11-10) |
| Terminal WebSocket clients that offer only `orkestrator-terminal.v1`: the server answers each input with its own `operation-result` instead of a cumulative `input-results` frame | `ready`, `operationResult` (`terminal-websocket-server.ts`) | `terminal-websocket.per-input-results` (counts authenticated sockets) | Renderers before input results (1202 task 11, 2026-11-04): a browser tab that outlives the upgrade, or a desktop connected to a newer backend | The floor is at or above the first Stable release whose renderer offers the subprotocol, and the counter is quiet. `operation-result` itself stays for failures and resizes | to-do 1202 task 11 (retired 2026-11-10) |
| Terminal WebSocket servers that select `orkestrator-terminal.v1`: the renderer settles each input from its own `operation-result`, and offers v1 after input results so such a server can select it | `TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS` (`terminal-websocket.ts`); `onMessage` (`terminal-websocket-client.ts`) | None (renderer side) | Backends before input results (1202 task 11, 2026-11-04) | The floor is a release whose terminal server selects the subprotocol; the v1 entry can then leave the offer | to-do 1202 task 11 (retired 2026-11-10) |
| Renderers that predate paged tmux transcripts: `claude_tmux_transcript` without `page` still answers the whole file as an array | `claude_tmux_transcript` (`tmux-commands.ts`), `TmuxTranscriptReader.readWhole` (`tmux-transcript-reader.ts`) | `tmux-transcript.whole-read` (counts whole reads) | Renderers before paged tmux transcripts (BG-14, 2026-11-04), such as a browser tab open across a backend upgrade | The floor is at or above the first Stable release with paged tmux transcripts, and the counter is quiet | Claude tmux tab |
| Backends that ignore `page` on `claude_tmux_transcript`: they answer an array, which the renderer reads as a whole transcript with nothing earlier to load | `getTranscriptPage` (`apps/web/src/lib/claude-tmux-client.ts`), through the `claude-tmux` domain client's version-0 adapter, which answers such a backend as sent (plan item 7002; a node that advertises `claude-tmux` always pages); the permission-mode line scan in `ClaudeTmuxChatTab.tsx` | `domain-adapter.renderer.claude-tmux.v0` (renderer calls through that adapter) | Backends before paged tmux transcripts (BG-14, 2026-11-04) | The floor is at or above the first Stable release with paged tmux transcripts; the adapter goes when the floor passes the first Stable release that advertises `claude-tmux` | Claude tmux tab |
| Backends whose `get_file_subtree` and `get_local_file_subtree` ignore `knownDigest` and return the directory itself: the renderer reads that as changed, with no digest to send next time | `normalizeFileSubtreeSnapshot` (`files-sessions.ts`), on the answer of the `files` domain client's version-0 adapter, which passes such a backend's answer through as sent (plan item 7002) | `domain-adapter.renderer.files.v0` (renderer calls through that adapter) | Backends before conditional folder reads (2026-11-04) | The floor is at or above the first Stable release that answers `knownDigest` on both commands; the adapter goes when the floor passes the first Stable release that advertises `files` | Files panel |
| Backends that do not list `liveUpdateVersions` in `get_native_agent_sync_capabilities`: a background round sends `get_native_agent_transcript_update` and `get_native_agent_session_state_update` separately, and is never sent `get_native_agent_live_update`. A backend that advertised it and then answers the command as unknown (a downgrade before the next resync) falls back in the same round | `nativeLiveUpdateSupported`, `readLiveUpdate` (`useNativeAgentSession.ts`) | `domain-adapter.renderer.native-sessions.v0` (renderer calls through that adapter) | Backends before the combined read (E8, 2026-11-04). Mechanical since 2026-11-07 ([7001](../../plans/unified/7001-domain-native-sessions.md)): the capability is part of `native-sessions` version 1, so only a pre-contract backend, one whose hello has no `native-sessions` range, is asked `get_native_agent_sync_capabilities`, through the client's version-0 adapter | The floor is at or above the first Stable release that advertises `liveUpdateVersions` | Native agents |
| `native-agent-session` changes with no `cause`: the renderer treats each as naming discovery, so a running tab on such a backend reads discovery on every change instead of only those that name it. It still leaves the timed round | `nativeSessionInvalidationNamesDiscovery` (`native-agent-observation.ts`) | None (renderer side) | Backends before causes (v2.36.0, 2026-11-03) | The floor is at or above the first Stable release with causes. A cause this client does not know keeps counting: a newer backend may add one | Native agents |
| Claude and Codex bridges that send no `errorCode`: a failed turn's usage limit is recognised from its error text, as it always was | `turnOutcomeFailureKind` (`agent-usage-limits.ts`), `usageLimitFailure` (`@orkestrator/protocol/agent-usage-limits`) | `usage-limit.text-classified` (counts Claude and Codex outcomes recorded as a usage limit from text alone) | Bridges before the structured signal (2026-11-05), typically a container that predates the backend upgrade, and Claude refusals that arrive without a rejected `rate_limit_event` | The text classifier itself is permanent: Grok, OpenCode, Pi and Cursor have no signal, and outcomes recorded before the field carry none. Once the floor is at or above the first Stable release with the signal, a counter still rising shows a refusal path the code misses, which needs its own signal rather than retiring anything | [agent-accounts.md](agent-accounts.md#usage-limit-signal) |
| Backends without `get_environment_snapshot`: a lone `environment` announcement falls back to the project's whole list | `refreshEnvironmentSnapshot` (`useEnvironments.ts`), `singleReadsUnavailableRef` (`useEnvironmentListSync.ts`) | None (renderer side) | Backends before the single-environment read (2026-11-04) | The floor is at or above the first Stable release with `get_environment_snapshot` | Environment list |
| Streams that do not say how they want relayed node events, and desktops that ask for the old name: each relayed event still reaches them as `relayed-node-event`, with no `id`, because it is no longer in the window they replay, and a reconnect that replayed is sent a `resync` frame for each node that relayed something since its cursor | `GatewayEvents.emit`, `writeLegacyRelayedResyncs` (`gateway-events.ts`), `parseRelayedEventsMode` (`gateway-support-extra.ts`) | `relayed-node-event.legacy-stream` (frames to a stream with no `relayedEvents` parameter); `relayed-node-event.legacy-desktop-stream` (frames to a stream asking for `relayedEvents=legacy`) | Renderers and desktops before per-node names (E18, 2026-11-05): a browser tab that outlives the upgrade, or a desktop connected to a newer backend. Also a desktop from E18 until its main process took per-node events (2026-11-05), whose main stream asks for `legacy` | The floor is at or above the first Stable release whose main process asks for `relayedEvents=per-node`, and both counters are quiet. Then the old-name frames, their resyncs and the `legacy` mode can go. Nothing current sends `legacy` any more | [command-nodes.md](command-nodes.md) |
| Command nodes without per-node relayed events: `watch_node_events` answers with no `perNodeEvents` and the gateway ignores `relayedEvents=per-node`, so frames arrive on the main stream as `relayed-node-event`, which the renderer always listens for, and no per-node listener or stream opens. On the desktop's relay the same frames reach main's main stream, and main forwards the old name to every renderer on that connection, since a window reports only per-node listens | `syncWatch` (`apps/web/src/lib/federation/node-events.ts`), `eventStreamPath` (`web-gateway.ts`), `consumeEvents` (`apps/desktop/electron/backend-process.ts`), `listensTo` (`desktop-window-contexts.ts`) | None (renderer and desktop side) | Backends before per-node names (E18, 2026-11-05) | The floor is at or above the first Stable release with per-node names. Then the old-name listener and main's forwarding of the old name can go | [command-nodes.md](command-nodes.md) |
| Command nodes without the multiplexed relay stream: `GET /__orkestrator/nodes/events` answers 404 (it falls under the relay prefix, and `events` is no node) or 405, so a browser reads every relayed leaf's main stream on its own request, as before, for the rest of the page. Any other failure answer, or none, falls back the same way for a minute and then tries again | `openShared` (`apps/web/src/lib/node-scope/multiplexed-relay-stream.ts`) | None (renderer side; an older command node cannot count it) | Command nodes before plan item 5005 (2026-11-07) | The floor is at or above the first Stable release with the route. Then a 404 or 405 can be treated like any other failure answer and the page-long latch (`unsupported`) can go; the per-node streams themselves stay, for one relayed leaf and for direct leaves | [command-nodes.md](command-nodes.md#opening-an-environment-on-another-node) |
| Renderers before per-conversation startup errors: they read `lifecycleState`, which a failed conversation leaves `ready`, so the rest of their panel carries on and the failed pane shows the refusal from `ensure_native_agent_session` as its connection failure, which names the error. Their only recovery is opening the panel: `ensure_project_coordinator` without `keepConversationErrors` clears every conversation's error, so the next connect starts the bridge again. The backend still refuses a failed conversation its credential and mail whatever the client reads | `ensure` (`coordinator-service.ts`), `ensure_project_coordinator` (`commands-registry-coordinator.ts`) | `coordinator-ensure.conversation-errors-cleared` (counts opens that cleared an error) | Renderers before the field (C6, 2026-11-05): a browser tab open across an upgrade, or a desktop connected to a newer backend | The floor is at or above the first Stable release with `retry_coordinator_conversation` and the counter is quiet; then `keepConversationErrors` can go and `ensure` stops clearing errors | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends that record a startup failure on the workspace, and records such a backend stored: the panel keeps its workspace-level banner, whose Retry runs `ensure_project_coordinator`, and holds sending in every pane, for `lifecycleState: "error"` and `lastStartupError`. A new backend writes neither, and still recovers a stored `error` on `ensure` | The `lifecycleState === "error"` banner (`CoordinatorPanel.tsx`), `sendingHeldReason` (`CoordinatorConversationPane.tsx`), `heldCoordinatorConversation` (`coordinator-runtime.ts`), `ensure` | None (renderer side) | Backends before the field (C6, 2026-11-05). A downgrade ignores `startupError`, which is additive, so that backend simply tries the conversation again; a later upgrade shows the old error until the next start or Retry clears it | The floor is at or above the first Stable release with `retry_coordinator_conversation`. The `ensure` recovery of a stored `error` stays while a data directory can hold one | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends whose transcript and session-state reads refuse a held coordinator conversation (before saved reads for paused conversations, #1476, for a failed one, or for one whose platform is unavailable): such a pane reads nothing and says only why sending is held. It never starts a provider, because those backends refuse the runtime first | `errorMessage` and `connectionState` (`AgentNativeTab.controller.tsx`) with `sendingHeld` (`useNativeAgentSession.ts`) | None (renderer side) | Backends before C6 (2026-11-05), and for an unavailable platform backends before its saved reads (2026-11-05) | The floor is at or above the first Stable release with saved reads for an unavailable platform | [coordinator.md](coordinator.md#when-a-conversation-fails-to-start) |
| Backends whose `docker_cleanup_preview` has no `legacyRuntimes`: the cleanup review shows no older-containers section and makes no claim about them. Each environment's own inputs section still reports `host-mounts` | `DockerCleanupReview.tsx` | None (renderer side) | Backends before the list (S-0080, 2026-11-05). A renderer older than the list ignores the two fields | The floor is at or above the first Stable release with `legacyRuntimes`; the field can then stop being optional | Container lifecycle |
| Machines whose environment summaries have no `deleteFailure` or `deletingSince`: a failed delete on such a machine reads as still `deleting` and spins, and a slow one never says how long it has run, which is all they ever did. A client older than the fields ignores them and reads `deleting: true`, keeping the tombstone unavailable and showing its old spinner. Current rows use `deleteFailure` to stop spinning and offer Retry. The failure field contains a fixed message, never the raw error. `deletionError` is an additive record field: a downgraded backend ignores it and its row spins again, while restart recovery still finishes the delete. `deletingStep` (from the additive record field `deletionStep`, 2026-11-06) is relayed only for a running delete and only as one of the known stage names; a client drops a stage it does not know, and an older machine simply never says which stage a slow delete is on | `nodeEnvironmentRowFacts` (`environment-row-facts.ts`) | None (renderer side) | Backends before delete failure reporting (2026-11-05) | The floor is at or above the first Stable release with the fields; they can then stop being optional | Environment list |
| Renderers that build, deliver and prune "Continue in…" handoffs themselves: `save_agent_handoff`, `delete_agent_handoff` and `prune_agent_handoffs` stay registered, and a prompt that already holds its carrier is recognised rather than prefixed again | `commands-registry-prompts.ts`; `promptWithPendingAgentHandoff` (`native-agent-handoffs.ts`) | `agent-handoff.renderer-saved`, `agent-handoff.renderer-carried` | Renderers before `create_agent_handoff` (2026-11-01) | The floor is at or above the first Stable release with it and both counters are quiet. Stored handoffs need no migration: the record is unchanged, and the destination's transcript proves whether one was already delivered | Native agents |
| Backends that do not deliver or prune handoffs: the renderer prepends the history, marks the tab consumed and prunes on hydration when `get_agent_handoff_capabilities` says so. Continue in… itself reports that the backend must be updated | `useAgentHandoff.ts`, `AgentNativeTab.controller.tsx`, `pruneUnreferencedAgentHandoffs` (`paneLayoutStore.ts`), `createAgentHandoff` (`lib/agent-handoff.ts`) | `domain-adapter.renderer.native-sessions.v0` (renderer calls through that adapter) | Backends before `create_agent_handoff` (2026-11-01). Mechanical since 2026-11-07 ([7001](../../plans/unified/7001-domain-native-sessions.md)): creating, delivering and pruning are part of `native-sessions` version 1, so only a pre-contract backend is asked `get_agent_handoff_capabilities`, through the client's version-0 adapter | The floor is a release with `get_agent_handoff_capabilities` | Native agents |
| Renderers before `native-sessions` (pre-contract): the backend keeps `get_native_agent_sync_capabilities` and `get_agent_handoff_capabilities` registered, now as defined commands, although a renderer with the domain never calls them | `commands-registry-native.ts`, `commands-registry-prompts.ts` | None (every renderer in the window is pre-contract and calls them; a renderer with `native-sessions` answers both from the version) | Renderers before `native-sessions` version 1 (2026-11-07, [7001](../../plans/unified/7001-domain-native-sessions.md)) | The floor is at or above the first Stable release that advertises `native-sessions`; then both commands go with the client's version-0 adapter | Native agents |
| Backends that do not hold a prompt Claude refused for want of a login: the sign-in card asks the user to resend, as it does for any refusal the backend does not hold | `useSignInResendPending.ts` | None (renderer side) | Backends before `get_native_agent_sign_in_resend` (2026-11-01) | The floor is a release with it; the card's wording remains for prompts a backend restart lost | Native agents |
| Backends whose `transcript_media_open_stream` requires an `environmentId`: a detached transcript's host media, sent with none, is refused with `invalid_input`, and the renderer reads the bounded base64 copy instead | `mediaStreamFailure` (`media-presentation.ts`) treating `invalid_input` as fallback, used by `FilePreview.tsx` | None (renderer side) | Backends before readable-roots streams (batch E-0580, 2026-11-05). Mechanical since 2026-11-07 ([7004](../../plans/unified/7004-domain-previews-annotations-artifacts-design.md)): every backend that advertises `transcripts` accepts the stream without an `environmentId`, so only a node on the client's version-0 adapter refuses it (`domain-adapter.renderer.transcripts.v0`) | The floor is at or above the first Stable release with readable-roots streams | [5800](../todo/cross-cutting/5800-file-read-streaming-leftovers.md) |
| Backends without `get_database_stats` or `plan_diagnostics_bundle`: Settings → Debug says the database figures are unavailable, and Export diagnostics says the backend is too old | `DatabaseStorageCard.tsx`, `failureText` (`DiagnosticsExportCard.tsx`) | None (renderer side) | Backends before the release that adds them | The floor reaches the first release with these commands | Logging and diagnostics |
| Backends that do not report `egressFilter`: the Network section says nothing about the gateway's name checks either way, rather than reading the missing field as an older image | `NameChecks` (`EnvironmentNetworkPolicyStatus.tsx`) | None (renderer side) | Backends before the gateway's name checks (S-0100, 2026-11-05) | The floor is at or above the first Stable release that reports `egressFilter` | Containers |
| Backends without `list_environment_hydration`: after one "unknown command" the boot batcher reads each environment's prompt queues and Multi Review workflows separately, as before, still within the hydration bound | `EnvironmentHydrationBatcher.sendChunk` (`boot-hydration.ts`) | None (renderer side) | Backends before cold realm boot batching (2026-11-06) | The floor is at or above the first Stable release with `list_environment_hydration` | Federation |
| Backends that do not know `seed: false` on `get_agent_model_catalog_cache`: they treat it as an omitted `seed`, so startup's pre-render read may still run the Pi first-use probe (bounded by the 2 s render wait) | `startApp` (`app-startup.ts`) | None (no code path; the older backend's behaviour) | Backends before cold realm boot batching (2026-11-06) | Nothing to remove; the row records the behaviour until the floor passes that release | Federation |
| Renderers before #1889 (v2.36.5-beta) send `hide_coordinator_work` from the Work panel's "Clear finished"; it stays registered, as a defined command | `commands-registry-coordinator.ts` | `retired-command.hide-coordinator-work` | Renderers before v2.36.5-beta | The floor is at or above the first Stable release without the Work panel's "Clear finished" and the counter is quiet; then remove the command | Coordinator ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| `associate_coordinator_workflow` stays registered, as a defined command, although nothing has called it since #592 (launches record their own associations) | `commands-registry-coordinator.ts` | `retired-command.associate-coordinator-workflow` | No known caller; external scripts only | The counter is quiet for one Stable release; then remove the command | Coordinator ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| `start_coordinator_multi_review` stays registered, as a defined command, although its last caller (Control MCP's `launch_multi_review`, in process) moved off it in #1809 (v2.36.4-beta) | `commands-registry-coordinator.ts` | `retired-command.start-coordinator-multi-review` | No cross-process caller | The counter is quiet for one Stable release; then remove the command | Coordinator ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| `start_coordinator_node_multi_review` stays registered, as a defined command, although its only caller (Control MCP's `launch_multi_review` on the same command node) moved to `launch_coordinator_node_multi_review` in #1809 (v2.36.4-beta) | `commands-registry-coordinator-nodes.ts` | `retired-command.start-coordinator-node-multi-review` | No cross-process caller | The counter is quiet for one Stable release; then remove the command | Coordinator ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| `check_opencode_cli`, `check_codex_cli`, `check_cursor_cli`, `check_grok_cli` and `check_pi_cli` stay registered, as defined commands, although the web stopped calling them in 6a3912cf4 (v2.21.0 calls only `check_claude_cli`, `check_github_cli` and `check_any_ai_cli`) | `commands-registry-tools.ts` | `retired-command.provider-cli-check` | No renderer in the window; external callers only | The counter is quiet for one Stable release; then remove the five commands | Agent servers ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| `cleanup_stale_local_servers_cmd` stays registered, as a defined command that does nothing, since the Electron migration | `commands-registry-pr.ts` | `retired-command.cleanup-stale-local-servers` | Nothing since the Electron migration | The counter is quiet for one Stable release; then remove the command | Agent servers ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)) |
| Peers at version 1 of `agent-mail`, `agent-servers`, `config`, `design`, `docker`, `environments`, `kanban`, `native-sessions`, `projects`, `pull-requests`, `system`, `terminals`: version 2 only removed commands nothing called (Retired, 2026-11-10), so each client keeps a version-1 adapter with the same API, and backends accept `min: 1` | The `1:` adapter of each domain's client (`packages/protocol/src/contract/domains/<domain>/client.ts`) | `domain-adapter.renderer.agent-mail.v1`, `domain-adapter.renderer.agent-servers.v1`, `domain-adapter.renderer.config.v1`, `domain-adapter.renderer.design.v1`, `domain-adapter.renderer.docker.v1`, `domain-adapter.renderer.environments.v1`, `domain-adapter.renderer.kanban.v1`, `domain-adapter.renderer.native-sessions.v1`, `domain-adapter.renderer.projects.v1`, `domain-adapter.renderer.pull-requests.v1`, `domain-adapter.renderer.system.v1`, `domain-adapter.renderer.terminals.v1` (renderer calls through those adapters) | Renderers and backends v2.37.0-alpha to the first release with version 2, the releases that advertise these domains at version 1 | The floor is at or above the first Stable release that advertises the domains at version 2 (the contract CI job then reports each adapter due) | Contract domains ([Domain contracts](#domain-contracts)) |
| Peers at version 2 of `pull-requests` or version 1 of `git`: `pull-requests` version 3 and `git` version 2 only removed commands only tests called (Retired, 2026-11-13), so each client keeps an adapter for the older version with the same API, and backends accept `min: 1` | The `2:` adapter of the `pull-requests` client and the `1:` adapter of the `git` client (`packages/protocol/src/contract/domains/{pull-requests,git}/client.ts`) | `domain-adapter.renderer.pull-requests.v2`, `domain-adapter.renderer.git.v1` (renderer calls through those adapters) | Renderers and backends that advertise `pull-requests` at version 2 (v2.37.5-beta to the first release with version 3) or `git` at version 1 (v2.37.0-alpha to the first release with version 2) | The floor is at or above the first Stable release that advertises `pull-requests` at version 3 and `git` at version 2 (the contract CI job then reports each adapter due) | Contract domains ([Domain contracts](#domain-contracts)) |
| Bridges whose event stream does not confirm `"observe":true`: the session observer closes the stream for good, so that bridge's sessions are woken only by the activity sweep | `HttpBridgeObservationStream` (`http-bridge/observation-stream.ts`) | `bridge-observation.full-stream` (counts streams closed this way) | Bridges before 2026-10-23 (first in v2.27.0-beta), v2.21.0 included | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet; then drop the unsupported branch | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Bridges without `/session/:id/human-prompts`: a 404 or 405 is answered as no human-prompt output | `readBridgeHumanPrompts` (`http-bridge/human-prompts.ts`) | `bridge-human-prompts.missing-route` | Bridges before 2026-10-26 (first in v2.33.0-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet; then a 404 or 405 is an error like any other | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Nodes without `read_host_agent_sign_ins`: the command node's accounts overview lists that machine's accounts without sign-ins | `listMachineAgentAccounts` (`agent-accounts-machines.ts`) | `host-agent-sign-ins.older-node` (counts unknown-command answers) | Nodes before 2026-10-24 (first in v2.29.0-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Nodes that ignore `diffScope` on `get_controller_worker_changes`: the answer carries `diffScopeUnsupported` and only the combined `sinceBase` diff | `olderNodeDiffScopeNote` (`coordinator-worker-changes.ts`) | `worker-changes.diff-scope-older-node` | Nodes before 2026-11-01 (first in v2.35.0-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Nodes whose account list has no automatic-switch state: a coordinator's re-enable of automatic switching ends no pin there ("a machine that predates this") | `set_account_auto_switch` (`control-mcp/account-tools.ts`) | `auto-switch.older-node` | Nodes before 2026-11-01 (first in v2.35.0-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Kanban rows without `sections`: their kind and sections are derived from the text on every read and written back only when the ticket next changes | `normalizeKanbanTask` (`storage-kanban-board.ts`) | `kanban.legacy-row-derived` (counts row reads, not rows; informational only, see the retire condition) | Rows written by v2.21.0 to v2.34.1 (sections arrived in #1388, first in v2.34.2-beta), including after a downgrade, and rows synced from such a node | The floor is at or above v2.36.0 (2027-01-02 at the earliest). The counter does not gate this: an untouched old row on disk keeps it rising on every board read until the upgrade itself rewrites the row, so it cannot go quiet first. Once the floor passes, no supported node writes or syncs such a row; turn the derivation into a one-time upgrade in `storage-record-upgrades.ts` (record upgrades are permanent) and keep the `sectionsBasis` mismatch check | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| `read_file_at_branch` and `read_local_file_at_branch` stay registered, as defined commands, for the diff viewer of v2.21.0 to v2.23.0; no later renderer calls them | `commands-registry-terminal.ts` | `retired-command.read-file-at-branch` | Renderers v2.21.0 to v2.23.0 | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet; then remove both commands | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| `get_coordinator_upstream_auto_merge` and `set_coordinator_upstream_auto_merge` stay registered, as defined commands, for the retired "always merge" setting | `commands-registry-client-state.ts` | `retired-command.coordinator-upstream-auto-merge` | Renderers before v2.36.0 (v2.35.5-beta is the last that calls them) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) and the counter is quiet; then remove both commands | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 2 |
| Claude owner records that hold only a pid: `RecordedOwner` reads them, session-preference lock metadata without `instance` is accepted, and the change-evidence owner file may have two lines | `bridges/claude-bridge/src/services/process-identity.ts`, `services/session-preferences.ts`, `services/change-evidence.ts` | None (bridge side) | Records written by Claude bridges v2.21.0 to v2.33.x (the full identity arrived in 7d8174dff, first in v2.34.2-beta), including after a downgrade | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 3 |
| Codex state written into each account's own directory: `adoptLoginRecords`, the login-directory journal merge, the legacy title index path, the legacy command-change journal and `migrateCodexChangeEvidence` | `bridges/codex-bridge/src/sessions/persistence.ts`, `sessions/dispatch-journal.ts`, `session-title-index.ts`, `sessions/command-changes.ts`, `change-evidence-migration.ts` | None (bridge side) | State written by Codex bridges before #1295 (first in v2.32.0-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest); then adopt leftover titles, change evidence and journals once at bridge start and delete the per-load merges | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 3 |
| Backends without the hello handshake: `checkBackendRoute` falls back to the authenticated status check and answers `legacy`, which the desktop's connection manager uses as its `legacy-backend` route (a command node refuses such a node as needing an update) | `packages/protocol/src/node/node-link/backend-hello.ts`, `apps/desktop/electron/connection-route-selection.ts` | None (desktop side) | Backends v2.21.0 to v2.23.0 (the hello first shipped in the unpublished v2.25.0-alpha; v2.36.0 is the first Stable with it) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 4 |
| Public CLI capability gates: `--node` needs `features.nodeRouting`, and following a transcript sends `knownToken` only with `features.transcriptKnownToken` | `ensureNodeRouting` (`packages/cli/src/client/session.ts`), the follow loop in `packages/cli/src/client/commands/session.ts` | None (CLI side) | Backends before #1268 (first in v2.31.0-beta) and #1668 (first in v2.36.0) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 4 |
| Command nodes that read automatic switches from the event stream and do not know the `five-hour` reason: `legacyAutoSwitchEvent` sends it there as `limit`; the outbox notice keeps the detail | `notify` in `apps/backend/src/core/index.ts`, `packages/protocol/src/agent-account-auto-switch.ts` | None (the backend cannot tell which command node reads the stream) | Command nodes before #1836 (first in v2.36.4-beta), v2.36.0 and v2.36.1 included | The floor is at or above the first Stable release with #1836 | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |
| Backends without `get_ticket_sync_status`: the board's sync strip shows nothing | `TicketSyncStrip.tsx` | None (renderer side) | Backends before v2.36.0 | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without `arrange_projects_by_intent`: the renderer sends the whole arrangement through `arrange_projects` | `lib/backend/projects-environments.ts`, `lib/federation/remote-project-writes.ts` | None (renderer side) | Backends before v2.36.0 (first in the unpublished v2.35.2-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest); check the backend's remaining `arrange_projects` callers at the same time | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without `patch_repository_settings`: the renderer writes the whole repository config | `lib/backend/config-integrations.ts` | None (renderer side) | Backends before v2.36.0 (first in the unpublished v2.35.2-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without `patch_global_config`: a command node's config write reads the node's config and sends it whole through `update_global_config` | `lib/portal/command-node-config.ts` | None (renderer side) | Backends before v2.36.0 (first in the unpublished v2.35.2-beta) | The floor is at or above v2.36.0 (2027-01-02 at the earliest); check the backend's remaining `update_global_config` callers at the same time | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without `get_node_status`: the portal store reads the failure as no command-node support | `lib/portal/portal-store.ts` | None (renderer side) | Backends v2.21.0 to v2.23.0 (first in the unpublished v2.25.0-alpha) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Tickets without `kind` or `sections`: the renderer derives them from the text the way the backend does | `lib/backend/kanban.ts`, `components/tickets/ticket-content.ts` | None (renderer side) | Backends before v2.34.2-beta | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Host update impact without `containerTerminals`: container terminals are counted in with the host's | `HostUpdatesPanel.tsx` | None (renderer side) | Backends before v2.32.0-beta | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without change tracking: a failed change-resource read leaves the components on their older presentation (the transcript-row presentation is permanent) | `lib/changes/subscriptions.ts` | None (renderer side) | Backends before the unpublished v2.24.0-alpha (v2.21.0 to v2.23.0) | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without the MCP environment overlay commands: the overlay reports the action as unavailable (`isUnknownMcpManagementCommandError`) | `McpEnvironmentOverlay.tsx` | None (renderer side) | Backends before v2.27.0-beta | The floor is at or above v2.36.0 (2027-01-02 at the earliest) | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 5 |
| Backends without `record_domain_adapter_usage`: the renderer stops uploading its domain-adapter counts for that load | `lib/domain-adapter-usage-ring.ts` | None (renderer side) | Backends before v2.37.0-alpha | The floor is at or above the first Stable release with the command | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |
| Backends without `get_fleet_update_policy`: the fleet update policy section says the backend does not support it | `FleetUpdatePolicySection.tsx` | None (renderer side) | Backends before v2.37.0-alpha | The floor is at or above the first Stable release with the command | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |
| Backends without `get_coordinator_account_switch_grant` or `reauthenticate_agent_account`: the renderer treats the grant as absent and re-authentication as unavailable | `lib/backend/agent-accounts.ts` | None (renderer side) | Backends before v2.36.2-beta and v2.37.2-beta | The floor is at or above the first Stable release with both commands | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |
| Backends without the coordinator activity or launch-override commands: each store latches unsupported and stops reading for that load | `stores/coordinatorActivityStore.ts`, `stores/coordinatorLaunchOverrideStore.ts` | None (renderer side) | Backends before v2.37.4-beta | The floor is at or above the first Stable release with both commands | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |
| The legacy one-line `/tmp/.claude-state` file the image's hook writes beside `/tmp/.claude-state-snapshot`: v2.21.0 and v2.21.1 backends read only the legacy file (current backends read the snapshot first and the legacy file only when no snapshot exists) | `docker/orkestrator-state-signal.sh` | None (container side) | Backends v2.21.0 and v2.21.1 (the snapshot reader arrived in #1041, first published in v2.22.3) | The floor is at or above v2.22.3 (2026-12-16 at the earliest); then stop writing the legacy file. The backend's fallback read serves containers built before #1041, which is unmigrated user state, not skew | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 7 |
| Backends without `claude_tmux_renew_interactive_terminal`: the renderer reads `unknown-command` from its first renewal as a backend that never detaches on its own and stops renewing; the `leased` argument of `claude_tmux_create_interactive_terminal` is ignored there, so the terminal keeps capturing until the tab detaches it, as before | `renewInteractiveTerminal` (`apps/web/src/lib/claude-tmux-client.ts`), `ClaudeTmuxInteractiveTerminal.tsx` | None (renderer side) | Backends before the interactive terminal lease (to-do 7745, 2026-11-11) | The floor is at or above the first Stable release with `claude_tmux_renew_interactive_terminal` | [recurring-work.md](recurring-work.md) row B19 |
| CLI local connections to backends without a Linux process identity: on Linux, `connection add --profile`/`--data-dir` (and those targets on any command) refuse a descriptor with no `processIdentity` before any token is read, and the refusal names the workaround, `--url <its URL> --credential-file <its data directory>/gateway-auth.json`. A stated limitation, not a fallback: falling back to the start-time check macOS uses would reopen the pid-reuse window #1848 closed | `descriptorProcessRefusal` (`packages/cli/src/client/targets.ts`, `FIRST_LINUX_PROCESS_IDENTITY_RELEASE`) | None (runs in the CLI, before any backend sees the request) | Backends before #1848 (first published in v2.36.4-beta), v2.21.0 included, reached with a CLI from v2.36.4-beta on. Observed 2026-11-06 against v2.21.0: `--data-dir` refused, `--url` with `--credential-file` ran project, environment and session commands (to-do 7120 (retired), task 3) | The floor is at or above the first Stable release with #1848; then drop this row and the workaround text. The refusal itself stays: a descriptor without an identity is never trusted on Linux | [7570](../todo/cross-cutting/7570-compatibility-paths-waiting-on-the-floor.md) task 6 |

Not governed by the window (listed so nobody waits on it):

- `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and `ORKESTRATOR_RECURRING_METRICS=0`
  (`ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` was removed on 2026-11-13):
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
| Looped Review commands (`start_looped_review`, `pause_looped_review`, `resume_looped_review`, `retry_looped_review`, `cancel_looped_review`, `get_looped_review_workflow`, `list_looped_review_workflows`, `save_looped_review_workflow`, `delete_looped_review_workflow`, `generate_looped_review_package`, `verify_looped_review_package`, `get_looped_review_provider_session`, `claim_looped_review_controller`, `release_looped_review_controller`, `validate_looped_review_controller`) and the coordinator's (`start_coordinator_looped_review`, `get_coordinator_looped_review`, `cancel_coordinator_looped_review`) | 2026-10-29 | The feature was removed (#1417, first in v2.34.4-beta), not replaced, so no path was kept: a renderer from v2.21.0 to v2.34.3-beta that calls one gets `unknown-command`. Recorded on 2026-11-07 for the contract CI job ([1008](../../plans/unified/1008-contract-ci-job.md)). |
| Legacy `DELETE` close for bridges before `POST /session/:id/close` (`LEGACY_DELETE_RETAINS_HISTORY`, `bridge-close.legacy-delete`) | 2026-10-31 | All five bridges in every published release from v2.21.0 serve the route and answer an unknown session in band, so only an unpublished source build reaches it. That build now gets the restart notice instead. |
| Renderer v1 design fallback for backends without `design_capabilities`: `design_changes` and `get_canvas_state` snapshots, `design_action` edits, `design_status` readiness, the `list_canvases` library and the `legacy` canvas mode (`design-controller.ts`, `design-launch.ts`, `DesignLibrary.tsx`) | 2026-11-06 | `design_capabilities` shipped in #844 (2026-09-25) and is in every release from v2.21.0, the floor, so only an unpublished source build reached it. That build now gets a typed "too old for the design canvas" failure. `design_action` stays on the backend for MCP, canvas lifecycle and listing. |
| Renderer session reads for backends without projection sync v1 and progressive views v1 (`useNativeAgentSession.ts`): the full-projection read (`getNativeAgentProjection` in `refresh`, and "Load earlier messages" widening its `messageLimit`) for a backend that answered `get_native_agent_sync_capabilities` with `unknown-command` or no sync version, and the joined sync-v1 poll (`getNativeAgentProjectionUpdate` snapshots and deltas) for one with sync v1 but no progressive views | 2026-11-10 | Every release from v2.21.0, the floor, advertises `projectionSyncVersions: [1]` and `progressiveViewVersions: [1]`, so only an unpublished source build reached either. That build now gets `NativeAgentSyncUnsupportedError` ("…Update it.", `native-agent-sync-capabilities.ts`) on the pane's connection-error surface, re-asked every 30 s. `get_native_agent_projection` stays for its direct readers (`RequestInteractions.tsx`, `AgentInfoButton.tsx`), and the joined sync-v1 snapshot stays for minting a history cursor (the joined-paging row in the register). |
| Bridges older than the MCP configuration report: an `mcpConfig` without `mcpConfigReporting` counted as reporting, and a body with neither got a provider-specific older-bridge apply outcome (`bridgeReportsMcpConfig`, `olderBridgeOutcome`; counters `mcp-report.unmarked-config` and `mcp-report.older-bridge-outcome`) | 2026-11-10 | The marker shipped in #1025 and every Claude, Cursor, Pi and ACP bridge from v2.21.0, the floor, puts it on every runtime-health body; Codex and OpenCode never take this rule (`awaitsEvidenceIn` is false for them). A body without the marker now always reads as a bridge that does not report, and gets one generic `restart-required` outcome. Stored counts stay in the document and are no longer reported. |
| Commands no client called: `list_agent_mail_inbox`, `set_agent_messaging_paused`, `cache_opencode_model_catalog`, `cache_agent_model_catalog`, `get_credential_status`, `save_config`, `get_global_config`, `design_status`, `design_changes`, `design_save`, `cleanup_orphaned_containers`, `docker_system_prune`, `docker_version`, `check_base_image`, `list_docker_containers`, `get_container_host_port`, `stream_container_logs`, `set_environment_pending_agent_launch`, `set_environment_initial_prompt`, `add_environment_domains`, `get_feature_planning_snapshot`, `validate_domains`, `list_compose_drafts`, `cleanup_orphaned_buffers`, `remember_environment_agent_selection`, `verify_environment_pr`, `pr_monitor_refresh`, `attach_terminal`, and `get_resource_revision_manifest` (the unscoped manifest, which a renderer from v2.21.0 on sends only after `get_scoped_resource_revision_manifest` answers unknown-command, which no supported backend does), with their definitions, renderer wrappers and handlers. Their domains went to version 2 (min 1), see the register row for their version-1 adapters | 2026-11-10 | No renderer, desktop, CLI, Control MCP or node-to-node caller at HEAD, and none in any tagged release from v2.21.0 (the floor) on: each was reached only by a renderer wrapper that nothing called, or by nothing. A client that still sends one gets `unknown-command`. `disconnect_linear` has no product caller either but stays: it pairs with `connect_linear`. |
| Commands only tests called: `merge_pr_local` and `refresh_environment_diff_stats`, with their definitions and handlers. `pull-requests` went to version 3 and `git` to version 2 (min 1), see the register row for their older-version adapters | 2026-11-13 | No renderer, desktop, CLI, Control MCP or node-to-node caller at HEAD, and none in any tagged release from v2.21.0 (the floor) on: renderers up to v2.37.4-beta exported a wrapper for each that nothing called. The local merge tests now enter through `merge_environment_pr` (the Merge PR dialog's command), and the diff-stat tests and the browser-gateway spec refresh through `changes_refresh` (the Files panel's Refresh). A client that still sends either gets `unknown-command`. |
| Command-catalogue answers without `catalogueVersion` read as unversioned `legacy:` rows (`http-bridge/catalog.ts`, `native-agent-command-dispatch.ts`) | 2026-11-13 | Every Claude, Codex, Cursor, Pi and ACP bridge from v2.21.0, the floor, stamps `catalogueVersion` on every `/session/:id/commands` answer (`git grep catalogueVersion v2.21.0 -- bridges`). Such an answer is now `outdated-bridge`, counted under `slash-catalogue.outdated-bridge`. A catalogue in another version still reads as `legacy:` rows, and `isLegacyCommandId` stays for stored intents ([7571](../todo/cross-cutting/7571-removal-candidates-needing-a-decision.md) task 9). |
| The bridges' full-payload `/event/subscribe` stream (Claude and Codex) and the replay ring only it kept (`packages/protocol/src/node/event-ring.ts`) | 2026-11-13 | No backend from v2.21.0 opens it: v2.21.0 never subscribes, and every later backend sends `observe=1`. A request without `observe=1` now gets 400; the observation stream keeps its cursor echo and gap frames ([7571](../todo/cross-cutting/7571-removal-candidates-needing-a-decision.md) task 1). |
| Renderer readers of state from before v2.21.0: the `orkestrator-build-pipelines` localStorage import (`migrateLegacyBuildPipelines`), `migrateLegacyClaudeTmuxState` with the bare-tab-id tmux fallback, and single-`pipelineId` build-pipeline handoff records (`pane-selection-storage.ts`) | 2026-11-13 | No renderer has written the pipeline key since #178 (2026-07-27), so only a browser idle for over three months could hold one, and it now keeps its pre-July pipelines in its own storage unread. The tmux store was never persisted and no current code writes a bare-key tab. An old handoff record is ignored, so at most one build-pipeline handoff is offered again. `import_legacy_build_pipelines` stays on the backend as the seeding entry point of e2e specs; whether to port them and remove it is a decision on the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md) ([7571](../todo/cross-cutting/7571-removal-candidates-needing-a-decision.md) tasks 8 and 15). |

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

The renderer has no version or capability handshake with its backend.
Backends do have one: the authenticated `GET /__orkestrator/hello`
([federation.md](federation.md#hello-handshake)) carries `appVersion`, a
`clientApi` range and a capability map. A command node checks it for each
leaf it links to (`checkBackendRoute`, `@orkestrator/protocol/node/node-link/backend-hello`)
and sends a newer field or command only to a leaf that advertises it (for
example `node-mail-steer`), or, for a contract domain, by the leaf's domain
version ([Client adapters](#client-adapters)); the desktop main process runs
the same check on a saved machine's route. The renderer parses a node's hello only to confirm
its identity before a direct session with a leaf (`openLeafWorkspace`), and never
reads its capabilities. For the renderer, add a handshake only when a change
cannot be detected from the payload (a change of behaviour rather than of
shape).

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

## Domain contracts

Backend commands are moving from string-registered handlers
(`register("name", handler)`, `(args: JsonRecord, context) => unknown`) to
typed definitions grouped by **domain**, each domain with its own version
([unified federation §11](../reports/unified-federation.md#11-versioned-interfaces),
plan items 1001 to 1011 in `plans/unified/`). The contract code is in
`packages/protocol/src/contract/` (one subpath per module,
`@orkestrator/protocol/contract/<module>`, plus `@orkestrator/protocol/contract`
for all of them); the backend side is
`apps/backend/src/core/commands-registry-contracts.ts`. The schemas are Effect
Schema (`effect/Schema`, `effect` 4.1.2,
[Decision 13.8](../reports/unified-federation.md#138-schema-library)).

**Every new command uses `defineCommand`.** The number of string-registered
(untyped) commands per domain may only fall; `mise run contract:check` fails
when it rises (see [The manifest, the ratchet and CI](#the-manifest-the-ratchet-and-ci)).
Since 2026-11-07 that number is zero in every domain (`untyped-baseline.json`
total 0, `contract-domain-map.ts` empty;
[7009](../../plans/unified/7009-domain-coordinator-servers-system.md) defined
the last five).

### Domains and versions

A domain groups the commands and events that change together. The domain
names are `DOMAIN_NAMES` in `contract/domain.ts` (29 today); `defineDomain`
accepts only those, so a new domain is added there first.

```ts
export const nodeMail = defineDomain({ name: "node-mail", version: 2, min: 1 });
```

- `version` is the newest version this build speaks; `min` is the oldest it
  still accepts from a peer, and defaults to `version`, so accepting older
  peers is always declared. Versions are integers from 1 to 1000. Version 0 is
  reserved for the legacy adapter (see [Client adapters](#client-adapters)).
- A backend accepts the range `[min, version]` of each domain that has at
  least one defined command (`CommandRegistry.domainRanges`), and advertises it
  in its hello.
- **Bump the version** only for a change an older peer cannot handle
  silently: a field removed, renamed, or changed in type or meaning; a new
  must-understand (critical) field; a command removed or its meaning changed.
- **Do not bump** for a new optional field or a new command. Peers ignore
  unknown fields, and a new command is visible in the manifest.
- A bump that keeps serving older clients sets `min` to the oldest version it
  still handles. Raising `min`, or removing a command, drops clients in the
  support window, so it needs a row in the [register](#register) like any
  other compatibility change.

### Defining commands and events

A definition lives in `packages/protocol` (browser-safe; the oxlint override
for `packages/protocol/src/contract/**` refuses `node:` and `bun:` imports), so
the backend, web, desktop and CLI share it. Domain definitions go in
`packages/protocol/src/contract/domains/`. The argument shapes in the examples
here are illustrative.

```ts
import * as Schema from "effect/Schema";
import { defineCommand } from "@orkestrator/protocol/contract/command";

export const deliverNodeMail = defineCommand({
  domain: nodeMail,
  name: "deliver_node_mail",
  since: 1, // the domain version that introduced the command
  access: "workspace", // workspace | admin | internal: the grant allow-list
  read: false, // routing classification
  args: Schema.Struct({
    to: Schema.String,
    body: Schema.String,
    steer: Schema.optionalKey(Schema.Boolean),
  }),
  result: Schema.Struct({ id: Schema.String }),
  critical: ["steer"], // argument keys a receiver must not ignore
});
```

`defineCommand` throws at module load on a name outside lower snake case, a
`since` outside `1..domain.version`, an unknown `access`, or a `critical` key
that `args` does not declare (at most 16). `encoded: true` marks a handler that
returns pre-encoded JSON (the transcript splice); its result is not validated.
`ArgsOf`, `ResultOf`, `EncodedArgsOf` and `EncodedResultOf` give the types.

`access` is enforced (plan item 7012): a client grant and the relay run only
`workspace` commands, failing closed ([command-nodes.md](command-nodes.md#security)).
A new command is refused through a grant until its definition says
`workspace`, so pick it from what reaches the command: `workspace` for
anything a window sends to a node it is not running on (a leaf's
environment, terminal, agent tab, board); `admin` for the machine's own
settings, credentials, diagnostics and updates, which Settings reaches with
`invoke_on_node`; `internal` for node-link and in-process plumbing.

#### Events

Every backend event is defined in its domain's
`packages/protocol/src/contract/domains/<domain>/events.ts` and listed in
`BACKEND_EVENTS` (`@orkestrator/protocol/contract/domains/events`), which the
manifest's `events` section is generated from.

- `defineEvent({ domain, name, payload })` names one event (lower kebab case,
  with at most one `:` suffix as in `claude-tmux:event`).
- `defineEventFamily({ domain, prefix, payload, key? })` names events whose
  name carries a key: `terminalOutputEvents.at(sessionId)` is
  `terminal-output-<sessionId>`. The manifest lists a family as `<prefix>*`.
- The backend emits only definitions: `context.emit(def, payload)`, with the
  payload typed by the schema (`BackendEmit`, `apps/backend/src/core/backend-emit.ts`).
  There is no string form, so there is no untyped event to count. Under tests
  every emit is checked against its schema, its family key pattern and
  `BACKEND_EVENTS`, and a failure throws; in development it is logged
  (`contract` `event.invalid`) and the event is still delivered; production
  does not check. A fixture that records emits by name wraps its recorder in
  `eventSink((event, payload) => …)`.
- Clients subscribe with `client.listen(def, handler)` (`NodeClient`, built
  from `listenEvent` over `listenRaw`). The handler receives payloads that
  decode against the schema, as sent; a payload that does not decode is
  dropped and logged by name only (`contract` `listen.payload-invalid`).
  In the web, `listenInScope(scope, def, handler)` (`lib/node-scope-slots.ts`)
  does the same on any scope, including the app's command scope, whose window
  `listen` suites mock. A name (`listenRaw`, or `listenInScope` with a string)
  is only for an event with no definition: the transport's own
  `native-event-stream-connected` and the desktop shell's events (browser
  previews, connections, SSH prompts, `local-backend-unavailable`).

Payload schemas pin the fields receivers route on and describe model-shaped
parts as `Schema.ObjectKeyword` until the models converge on protocol schemas.
A field an older backend does not send is optional, because a client decodes
every peer's payloads. Optional payload fields use `Schema.optional`, not
`Schema.optionalKey`: emitters set absent fields to `undefined`, which the
wire drops but `optionalKey` refuses.

Schema rules, because the manifest digests each schema's JSON Schema export
(`Schema.toJsonSchemaDocument`) and an export that is not stable changes every
digest:

- `args` is a `Schema.Struct`; its field names are the argument keys.
- Wire numbers are `Schema.Finite` (or `Schema.Int`). `Schema.Number` also
  accepts and exports `"Infinity"`, `"-Infinity"` and `"NaN"`.
- Optional fields are `Schema.optionalKey(...)`. `Schema.optional` exports
  `anyOf [T, null]`.
- A RegExp passed to `Schema.isPattern` has the `u` flag; without it the
  export has no `pattern`.
- A named schema (`identifier` annotation) is one shared constant. Two
  separately built schemas with the same identifier export as `Name` and
  `Name_1`.
- Schemas are JSON-shaped (the decoded `Type` equals the wire `Encoded`, no
  transformations) and need no Effect services: production sends results as
  handlers return them.
- A result's model records (an annotation, a preview service, a design
  snapshot) are described in part until the models converge on protocol
  schemas ([7010](../../plans/unified/7010-converge-models.md)): a plain
  `Schema.Struct` would drop every key it does not declare when a client
  decodes the result. `modelRecord<T>()({ ...fields })`
  (`contract/model-schema.ts`) validates the declared fields (ids,
  revisions, states, kinds) and passes every other key through
  (`Schema.StructWithRest` with a rest of unknown values), typed as the
  model interface `T`; `opaqueRecord<T>()` declares none. Envelopes and small
  results are full structs. The same module holds the other variants every
  domain uses (plan item 7010, documented in its header): `openRecord(fields)`
  (typed as the declared struct, for records whose schema is the model's
  definition), `variantRecord<T>()` (discriminated unions), `OpenObject`,
  `ownedObject<T>()`, `asModel<T>()` and `mutableArray()`. Where a schema is
  the model, the protocol exports the model type (`Mutable`/`DeepMutable` of
  the schema's type) and `apps/backend/src/core/models.ts` and
  `apps/web/src/types/index.ts` re-export it (or declare a view of it, such
  as the web's records generic over an opaque snapshot); such a schema
  requires every field the storage always writes, and its vocabularies are
  literals where the backend keeps only the values it knows (a new value
  bumps the domain). `tests/unit/model-type-convergence.test.ts` fails when a
  name both files export is not the same protocol type, or when either file
  declares its own copy of a type a contract domain exports.

### Tolerant reader and critical fields

A defined command decodes its arguments tolerantly: unknown keys are dropped
(Effect's default `onExcessProperty: "ignore"`), never rejected. Adopting
`defineCommand` therefore makes a strict handler (`assertOnlyKeys`) tolerant;
do not add a hand-written unknown-key rejection to a converted handler, and
never make one of today's lenient handlers strict, because that breaks newer
clients.

A field an older receiver must not silently ignore (a steer flag, an
idempotency key, a safety option) is listed in the definition's `critical`.
The sender's envelope names the critical keys it actually sends
(`buildInvokeEnvelope(def, args, version?)`):

```json
{ "command": "deliver_node_mail", "args": { "to": "…", "body": "…", "steer": true },
  "domain": "node-mail", "version": 2, "critical": ["steer"] }
```

- `command` and `args` are today's invoke body, so an older backend ignores
  the rest. The HTTP gateway decodes the envelope only when the body has
  `domain`, `version` or `critical` (`invocationFromBody`,
  `gateway-handlers.ts`).
- The envelope guard (`decodeInvokeEnvelope`) refuses the whole call when
  `critical` is not an array of at most 16 identifiers of at most 64
  characters, `domain` is not a domain-name shape, or `version` is not an
  integer from 0 to 1000. The gateway answers 400 with a message that names no
  value. Dropping a malformed must-understand list would silently downgrade
  the call. Unknown envelope keys are ignored.
- A receiver refuses with `unsupported-field` a key that the envelope lists
  as critical, that its definition does not declare, and that the arguments
  carry. A listed key that is absent is ignored. A string-registered command
  cannot say it understands anything, so it refuses any critical key its
  arguments carry.
- Every command, defined or not, refuses with `unsupported-version` an
  envelope whose `domain` and `version` fall outside this backend's range for
  that domain. A domain with no defined command has no range and is not
  checked.
- Per call, the registry runs the version check, then argument decoding (or the
  critical check for a string command), the container guard, the handler and,
  in development and tests (`NODE_ENV` `development` or `test`, or
  `validateContractResults`), result validation.
- A schema failure keeps the `commands-validation.ts` wording (`Expected
  projectId to be a string`) and never shows a value. A `message` annotation
  on the schema or check wins, so a converted handler can keep its exact text.

Transports: the web sends the envelope in the invoke body; Electron IPC takes
it in the third argument's `envelope` field (`orkestrator:invoke(command, args,
{ nodeId?, envelope? })`, at most 4096 serialised characters, so send it
without `args`); the node relay forwards the body unchanged; backend to
backend, `NodeLink.invokeCommand(def, args)` adds it only when the peer's hello
advertises the command's domain, and the backend's own domain clients
(`nodes/node-domain-clients.ts`) pass the envelope they picked through
`NodeLink.invoke`/`invokeCommand` (`options.envelope`) and through
`invoke_on_node`'s routing (`NodePortal.invokeOnNode(args, { envelope })`).

### Hello `domains`

The authenticated hello carries `domains`, a map from domain name to the
`{ min, max }` the backend accepts ([federation.md](federation.md#hello-handshake)).
It is always sent (`{}` while no command is defined), is a top-level field
rather than a capability, and leaves `schemaVersion` at 1. `parseHelloDomains`
drops the whole field when any entry is malformed (more than 64 entries, a
bad name or range), and the hello still parses. A hello without `domains`,
or no hello at all, is a **pre-contract** backend (`isPreContract`); every
release in the window today is one. `domainRange(hello, name)` reads one
range.

Every renderer `NodeClient` reads its node's hello once per connection
generation and exposes the result as `client.domains` (the ranges, `null`
while unknown and for a pre-contract node) and `client.capabilities` (the
hello's capability names, which legacy adapters gate on)
([2011](../../plans/unified/2011-scope-domain-negotiation.md),
`apps/web/src/lib/node-scope/negotiation.ts`):

- **Where it is read.** The browser and iOS client reads
  `/__orkestrator/hello` through its own transport (`NodeTransport.hello()`,
  appended to the node's base, so a relayed node answers its own); the page's
  command node through its gateway API (`window.orkestrator.hello`); an
  Electron node scope, and an Electron IPC window's command node, from main's
  `orkestrator:nodes:gateway` snapshot, whose `hello` main reads per
  connection (`ConnectionManager.scopeHello`: the local backend's, a saved
  machine's last hello, or a workspace scope's own, once per connection
  epoch).
- **When.** On creation (or the stream's first open), and again whenever the
  stream reconnects after a drop (Electron's command node: on
  `desktop-connections-changed`). The values change only when the hello is
  of another generation (`installationId` and `generation`), so a reconnect
  to the same process keeps every object and a domain client keeps its
  adapter. A read that cannot tell (unreachable, refused) changes nothing;
  an answer without a hello (a 404, or a page) is pre-contract.
- **Typed calls.** `client.invoke(def, args)` sends the envelope for this
  build's version of the domain (`contractEnvelopeFields`; over IPC as the
  invoke options, never inside the arguments) and decodes the result.
  `client.invokeRaw(command, args, { envelope })` is the transport both it
  and domain clients use; an untyped call sends no envelope.
- **`scope.domain(def)`** is the node scope's memoised `createDomainClient`
  over its client, with `domains`, `capabilities`, the untyped invoke and the
  renderer usage ring. A new generation's objects make it pick again; a
  reconnect that keeps them (a node without a hello) resets the choice too.
- **Proven command id.** A hosted page has no proven command-node id when its
  window scope opens, so its command scope starts under
  `provisional:command-node` and moves to the id the hello proves
  (`WindowScope.adoptCommandNodeId`); the provisional id stays an alias for
  lookups, and byte-budget reservations move with it.

### Typed errors

Version skew is reported with a code, never detected from message text
(`contract/errors.ts`):

| Code | Class | Details |
| --- | --- | --- |
| `unknown-command` | `UnknownCommandError` (`unknownCommand(command, domain?)`) | The `command` and, when the call's envelope named one, its `domain`. The message stays `Unknown backend command: <name>` for older clients. Every backend site that misses a command throws it, nested in-process calls included. |
| `unsupported-version` | `UnsupportedVersionError` (`unsupportedVersion`) | `domain`, the backend's `range` `{ min, max }` and the `command`. |
| `unsupported-field` | `UnsupportedFieldError` (`unsupportedField`) | `domain`, the critical `field` (at most 64 characters) and the `command`. |

The classes are Effect `Data.TaggedError`s with a `code` property. The gateway
answers them with `toWire(error)`: `{ error, code, details: { domain?, range?,
field?, command? } }`, never an argument value (`command` only when it is an
identifier of at most 64 characters); `fromWire(body)` rebuilds the class.

Each transport keeps the code and details:

- **Web HTTP:** `GatewayHttpError` (`apps/web/src/lib/native/gateway-http-error.ts`)
  has `status`, the body's `code` and an incompatibility's bounded `details`.
- **Node link:** `NodeLink` rethrows `fromWire(body)`, so a routed call
  (`invoke_on_node`) and the command node's own callers see the leaf's class.
- **Electron IPC:** the desktop backend client rebuilds the class, and main's
  `orkestrator:invoke` sends it in the message form
  `[code key=value …] text` (`contract/ipc-error.ts`, values URI-encoded;
  the same form carries every [registered code](#registered-error-codes)),
  because only a message crosses IPC and the context bridge. The preload
  also sets `error.code` and `error.details`; the renderer reads the message
  form through `incompatibility()`.

Callers use `incompatibility(error, command)`, which reads `code` (or the IPC
message form) first and falls back to the legacy text only for the named
command (a pre-contract node). An incompatibility whose `details.command`
names another command (a nested call's) reads as `null`, so a fallback never
fires for a command that ran. A fallback to an older command checks
`?.code === "unknown-command"`; a "this backend cannot" state accepts any
code. Classifiers that do not know the command use
`incompatibilityOfAnyCommand(error)`, which accepts legacy text only at the
start of the message. No renderer code matches `Unknown backend command`
itself (`tests/unit/unknown-command-text-guard.test.ts`).

The one UI text is `describeIncompatibility(error, machine, command?)`
(`apps/web/src/lib/describe-incompatibility.ts`): "Not available on
<machine> (version x). Update it."

### Registered error codes

The same codec carries any other code a caller must branch on, so no
decision matches an error's prose. `REGISTERED_ERROR_CODES`
(`contract/ipc-error.ts`) lists each code with the detail keys it may name,
each of a bounded kind: `text` (at most 64 characters), `range` (`min-max`) or
`count` (a non-negative integer). A detail is never an argument value.

| Code | Thrown by | Details | Read by |
| --- | --- | --- | --- |
| The three incompatibility codes | [Typed errors](#typed-errors) | as above | `incompatibility()` |
| `kanban-request-id-conflict` | `KanbanRequestIdConflictError` (`storage-kanban.ts`): a ticket, comment or image `requestId` reused with different arguments | `record` | `features/build.ts`, which returns the existing ticket on a retry |
| `native-job-receipt-capacity` | `NativeJobReceiptCapacityError` (`storage-prompts.ts`): the job queue holds its 256 receipts | `limit` | `native-agent-job-tab-reuse.ts`, which rethrows it rather than falling back |
| `native-agent-provider-session-missing` | `NativeAgentProviderSessionMissingError` (`native-agent-service-shared.ts`): a provider probe proved the session gone | none | the renderer (`isProviderSessionMissingError` in `useNativeAgentSession.ts`), the only answer that may replace a restored session |
| `container-lifecycle` | `ContainerLifecycleError` (`container-lifecycle.ts`) and the backend errors that carry its marker: a container lifecycle refusal; message `ContainerLifecycleError:<reason>: text` | `reason` (a `CONTAINER_LIFECYCLE_ERROR_CODES` member) | `parseContainerLifecycleError` (backend operation records, environment settings, rebuild, recovery copies, cleanup review) |
| `mcp-management` | `McpManagementFailure` (`mcp-management.ts`) and the gateway's oversized-change answer; message `McpManagementError:<reason>: text` | `reason` (a `MCP_MANAGEMENT_ERROR_CODES` member) | `mcpManagementErrorFromUnknown` (the MCP servers settings) |
| `pane-layout-revision-conflict` | `PaneLayoutRevisionConflictError` (`pane-layout-conflict.ts`): a pane layout save named a stale revision | none | `isPaneLayoutRevisionConflict` (the renderer's rebase-and-retry, worker and workflow tab actions) |
| `design-revision-conflict` | `DesignError` (`design/errors.ts`) for a conflict led by `Design revision conflict:` | none | `toDesignFailure`, the web design client's `failureOf` |
| `prompt-queue-message-conflict` | `PromptQueueMessageConflictError` (`storage-prompts.ts`): an idempotent enqueue reused an id for a different body | none | `isPromptQueueMessageConflict` (goal carriers, web annotation dispatch) |
| `unknown-node`, `node-admin-refused`, `node-scope-closed`, `node-unavailable` | Desktop main's `NodeRefusal` (`node-ipc.ts`), message `[code] text` | none | `nodeRefusalCode` (`contract/node-refusal.ts`) |

Rules:

- **A thrower** is an Effect `Data.TaggedError` with a `code` literal (and
  its details as own properties), in the backend next to its throw site or in
  `contract/errors.ts`. Its message keeps the words it had before the code
  existed.
- **A reader** calls `errorCode(error)` (`contract/ipc-error.ts`), which
  reads an own `code` in the code form (registered or not: the gateway's
  `code` kept by `GatewayHttpError` or `NodeLink`, the preload's copy) and
  otherwise a message led by a *registered* code's prefix. An unregistered
  `[word] ` prefix is text, and a Node `ENOENT`-style code is not in the code
  form. A reader that must work against an older peer falls back to the old
  words only when `errorCode` returns `undefined`; when a code is present, it
  alone decides.
- **The gateway** answers `codedErrorWire(error)`: an incompatibility's
  `toWire` body, otherwise `{ error, code, details? }` with only the code's
  bounded keys; an error without a registered code is answered as before.
- **Desktop main.** The backend client rebuilds a registered code with
  `fromCodedWire(body)` (the incompatibility class, else `CodedError`), and
  `orkestrator:invoke` rethrows it as `[code key=value …] text`
  (`ipcErrorMessage`); an error whose message is already in that form is
  rethrown unchanged. The text after the brackets is the thrower's message
  unchanged, so an older renderer's text match still finds it; the preload
  copies `code` and `details`.
- **The renderer.** The context bridge drops those copies, so the renderer's
  two desktop invoke clients (`command-client.ts`, `desktop-node-client.ts`)
  pass every rejection through `readableCodedError`, which moves the prefix
  onto the error's own `code` and `details` and leaves the thrower's text as
  its message. A screen that shows `error.message` therefore shows no prefix.
  Text received any other way uses `ipcErrorText(message)`.
- **The preload** imports only `contract/ipc-error.ts`, which has no Effect
  import; the classes and Schemas live in `contract/errors.ts`.
- **Adding a code** is additive: an older reader leaves it in the message and
  still matches the words. Renaming or removing one is not.

The domains that used to put their code only in a message marker
(`ContainerLifecycleError:<reason>:`, `McpManagementError:<reason>:`,
`Pane layout revision conflict:`, `Design revision conflict:`,
`Prompt queue message conflict:` and desktop main's node refusals) are
registered above and keep the marker in the message for older peers. Their
readers use `hasErrorCode(error, code, legacyMarker)` or the domain parser,
which read the registered code first and the marker only when no *registered*
code is present: an older backend answered any code-form `code` over the
gateway (a design conflict as `conflict`), and that must not suppress the
fallback.

Change tracking's internal reasons (`capture-timeout`, `capture-storage-quota`,
`commit-not-found`, …) are not wire codes. They are one `CaptureError`
(`change-tracking/capture-error.ts`) whose `reason` is typed against
`CAPTURE_ERROR_REASONS`, read with `captureErrorReason(error)`; the message is
the reason, and reasons that leave the backend do so as data (a capture's
`unavailable` reason, a scope's `unavailableReason`).

### Client adapters

A client calls a domain through one API with an adapter per domain version
it can speak (`domainClient` in
[`contract/client.ts`](../../packages/protocol/src/contract/client.ts)):

```ts
export const nodeMailClient = domainClient(nodeMail, {
  2: (call) => ({ deliver: (mail) => call(deliverNodeMail, mail) }),
  1: (call) => ({ deliver: (mail) => call(deliverNodeMailV1, toV1(mail)) }),
  0: (call) => legacyNodeMailApi(call), // today's capability gating
});
```

- An adapter for the domain's current version is required, and adapter keys
  must be `0..domain.version`.
- `pickVersion(versions, range)` takes the highest client version inside the
  node's advertised range; no range (a pre-contract node, or a domain the node
  does not advertise) means version 0 only, and disjoint ranges give `null`.
- **Version 0 is the legacy adapter**: today's capability-gated behaviour
  (the per-domain `*_capabilities` commands or the hello `capabilities`) for
  nodes without a range, so callers are already version-agnostic.
- `createDomainClient(def, { call, domains, capabilities?, invoke?, usage? })`
  binds a definition to one node's transport. `client.api()` picks once per
  connection generation (per `domains` object identity; `reset()` forgets it),
  caches the adapter and throws the coded `unsupported-version`, with the
  node's range, when nothing overlaps. `call(def, args, envelope)` gets the
  envelope fields `{ domain, version, critical? }` without `args` (they stay
  under desktop IPC's 4096-character bound), and none for adapter 0, so a
  pre-contract node gets today's body. Results are decoded tolerantly with the
  command's schema. Adapter 0's context has the hello `capabilities`, an
  untyped `invoke`, and `capability(command)`, which reads one of the domain's
  `LEGACY_CAPABILITY_COMMANDS` once per generation (`null` when the node
  predates it). Node scopes expose it as `scope.domain(def)`, memoised per
  scope over the scope's client ([Hello `domains`](#hello-domains)).
- **Pilot domains** ([1010](../../plans/unified/1010-pilot-node-mail-and-ticket-sync.md)):
  `node-mail`, `node-files` and `ticket-sync`, all at version 1 (min 1),
  are the first defined domains and the first clients, called backend to
  backend by the command node (`nodes/node-domain-clients.ts`: one client per
  link and domain, or per routed call). Their 24 commands were strict
  (`assertOnlyKeys`) and are tolerant now; `steer`, the delivery's
  `requestId`, `nodeParent` and `attachments` on `deliver_node_mail`,
  `sha256` on `begin_node_file_write`, `reset`/`liveIds` on
  `apply_ticket_sync` and `requestId` on `create_node_action_request` are
  critical. Version 1 includes every capability that gated these commands
  before (`NODE_MAIL_FEATURES`, `ticket-sync`), so `supports()` and `syncs`
  answer `true`; version 0 keeps the hello-capability checks for
  pre-contract leaves and refuses a field such a leaf would drop with the
  same typed error a contract node answers. The register rows these served
  are marked mechanical; their counters stay until their conditions are met.
  The four lenient neighbours 1010 left as string commands
  (`prepare_node_mail_attachments`, `place_node_mail_attachments` and
  `send_coordinator_command_node_mail` in `node-mail`, `coordinator_node_ticket`
  in `ticket-sync`) were defined on 2026-11-07
  ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)):
  every key their handlers read is `optionalKey(Unknown)`, so their own
  checks still give the error text; `requestId`, `attachments` and
  `replyToMessageId` on `send_coordinator_command_node_mail` are critical. A
  command node asks a leaf which images it still needs through the client's
  `prepareAttachments` (version 0: `unknown-command` without
  `node-mail-attachments`); the other three are called in process by name.
- **`public-api`**
  ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)):
  `public_action` is defined at version 1 (min 1), `admin`, with every
  wrapper key `optionalKey(Unknown)`, so a malformed wrapper is still
  answered with the dispatcher's own envelope; `node` and `relayedAuthority`
  are critical. The two in-process symbol keys (the Control MCP or schedule
  authority, the node link's controller) are carried past decoding on the
  invocation (`beforeDecode`). The public actions keep their own versioning
  (schema version, `actionVersion`, `capabilities`; [public-cli.md](public-cli.md)),
  so the domain has no client: the CLI, Control MCP, scheduled jobs and a
  command node routing to a leaf call it by name.
- **`native-sessions`** ([7001](../../plans/unified/7001-domain-native-sessions.md)):
  all 87 commands (native agent sessions, terminal sessions and buffers, pane
  layouts, prompt queues, drafts, handoffs and the tab's host actions) are
  defined at version 1 (min 1). Model records are open records (`openRecord`,
  `contract/model-schema.ts`): the listed fields are typed and
  every other key survives a tolerant decode. The four spliced transcript
  reads are `encoded: true`. The client's API is one function per command,
  keyed by name, plus `handoffCapabilities()` and `syncCapabilities()`, which
  version 1 answers without asking (both capability commands are folded into
  the version); version 0 sends today's calls by name without an envelope and
  returns the answer as sent. The web binds it per `lib/backend` client
  (`lib/node-scope/domains/native-sessions.ts`).
- **Terminals, files and Claude tmux**
  ([7002](../../plans/unified/7002-domain-terminals-files-tmux.md)):
  `terminals` (26 commands, the composer's `!` user commands included),
  `files` (28) and `claude-tmux` (28), all at version 1 (min 1), called by
  the renderer through `apps/web/src/lib/node-scope/domains/` over the
  `lib/backend` factory's client. Their clients' API is the command list
  keyed by name (`commandApi`, `contract/domains/command-api.ts`):
  `terminals(client).terminal_write({ sessionId, data })`. Version 1 sends
  the envelope and decodes results; version 0 (`legacyCommandApi`) is
  today's untyped call answered as sent, since none of these commands was
  capability-gated and their callers already normalise older answers.
  Critical keys: `requestId` on `launch_terminal_job`, `expected` on both
  file writes, `digest` on `delete_container_annotation_evidence`, and the
  expected prompt on `claude_tmux_answer_selection_prompt`. The terminal
  WebSocket protocol is separate and unchanged.
- **Environments and Docker**
  ([7003](../../plans/unified/7003-domain-environments-docker.md)):
  `environments` (63 commands: environments, their container lifecycle,
  setup and its approval, recovery copies, resources, network policy,
  portable inputs, logs, extensions and tab teardown) and `docker` (29), both
  at version 1 (min 1). The environment model is one schema set,
  `domains/environments/models.ts` (`ClientEnvironmentSchema`, the detail
  read, the snapshot row, the lifecycle snapshot), field for field with
  `ClientEnvironment` in `models.ts`; other results are in `results.ts` and
  `docker/models.ts`. Optional result fields are `Schema.optional`, because
  handlers return records with fields set to `undefined`. Each client's API
  is one method per command (`environmentsClient`, `dockerClient`); version 1
  sends the envelope and decodes results, version 0 sends today's call and
  answers as sent (`answeredAsSent`). The web calls them through
  `domainApi(client, def)` (`lib/node-scope/domains/domain-api.ts`, the
  web's one domain-client helper since 7010), with
  `machineBackendClient` (`lib/backend/client.ts`) or
  `routedBackendClient` (`lib/portal/routed-backend-client.ts`) for another
  node. Critical
  keys: the launch's `controlRequestId`/`controlRequestFingerprint` and the
  delegation base on `create_environment`; `operationId`/`expectedRevision`
  on start, stop, recovery-copy discard and restore, recreate and
  `provision_environment`; `expectedContainerId` and `keepRecoveryCopy` on
  recreate and restore; `selectionToken` on `docker_cleanup_execute`. The
  register rows these domains serve (`get_environment_snapshot`'s
  fallback, `builtInDefault`, `legacyRuntimes`, `egressFilter`) are
  unaffected: their fields are optional in the schemas and their fallbacks
  read the typed `unknown-command` as before.
- **Hot path.** A definition with `hotPath: true` (terminal input and
  resize, terminal output and history reads, the tmux interactive
  terminal's input and resize) has its result decoded by a domain client
  only when `validateHotPathResults` is not `false`; the renderer passes
  `false` outside development and tests, as the backend validates results
  only there, so the keystroke path gains no per-call result validation.
- **Async handlers.** A defined command decodes its arguments before the
  handler runs and a failure is thrown synchronously. Where the handler is
  `async` and its callers expect a rejection, register it with
  `ASYNC_HANDLER` (`commands-registry-async-decode.ts`, a `beforeDecode`
  option), which delivers the same error as a rejected promise.
  A registrar that must run before decoding (the web annotation rollout
  gate, its payload ceilings and outcome metrics) passes its own
  `beforeDecode(run)` wrapper: it sees the raw arguments, and the version
  check still runs first.
- **Coordinator, agent servers, system and nodes**
  ([7009](../../plans/unified/7009-domain-coordinator-servers-system.md)):
  `coordinator` (102 commands: project coordinators, their conversations and
  worker surfaces, delegation and the controller-facing commands a command
  node's coordinator runs on its nodes, Control MCP settings and credentials,
  native agent jobs), `agent-servers` (77: container and local bridges,
  readiness waits and peeks, host CLI and credential checks, the GitHub CLI
  sign-in, model catalogues, skills and plugins), `system` (50: host
  maintenance, usage, load and diagnostics, scheduled jobs, bug reports, disk
  usage, worktree locations, the resource manifests) and `nodes` (51: the
  registry, controller attachment, client grants, command handover, leaf
  workspaces, portal summaries, layout and event relay, `invoke_on_node`,
  project comparisons and copies, the machine profile), all at version 1
  (min 1). None has a capability command to fold. `access` is `admin` for
  the node's own user's commands that grants and the relay refuse (the node
  registry and handover, Control MCP credentials, host updates, diagnostics
  bundles) and for machine-wide diagnostics no workspace calls, `internal`
  for node-link and coordinator-tool plumbing (`*_controller_*`,
  `*_coordinator_node_*`, the leaf side of grants, env keys and project
  seeds), `workspace` otherwise. Every `assertOnlyKeys` handler is tolerant.
  The per-agent server commands are built by factories because callers
  build their names at runtime (`start_${agent}_server`). Two trusted
  in-process values that travel as symbol keys on the arguments (the
  scheduled-job actor, a coordinator's delegation presentation) are carried
  across decoding on the invocation by a `beforeDecode` wrapper, so only
  in-process callers can still set them. Each client's API is one function
  per command, keyed by name; version 0 is today's call by name. The web
  calls them through `lib/node-scope/domains/{coordinator,agent-servers,
  system,nodes}.ts`; the portal's un-negotiated channel uses
  `nodesApiOver(invoke)` and always takes version 0. Ten commands are
  retired with counters (see the register).
- **Previews, web annotations, transcript artifacts and design**
  ([7004](../../plans/unified/7004-domain-previews-annotations-artifacts-design.md)):
  `previews` (17 commands), `web-annotations` (37), `design` (35) and the
  artifact and media part of `transcripts` (16) are defined at version 1
  (min 1). The web annotation Zod schema map and the design handlers' Zod
  parses are Effect Schema now, tolerant (`.strict()` became strip); a
  declared `provenance` on the eight annotation commands that refused it is
  still refused (an optional `Never` field). The lenient preview and
  artifact handlers keep their own checks, so their checked arguments are
  `optionalKey(Unknown)` and their coded errors (`PreviewError:`, the
  `ArtifactError` JSON) are unchanged; the design v2 handlers decode their
  fields inside the typed envelope, so a bad field is still `{ ok: false,
  failure: invalid-input }`. Critical keys: `operationId` on the three
  preview registry writes, `expectedRevision` on `remove_preview_service`,
  `serviceId` on `revoke_preview_access`, `containerId` on
  `transcript_media_open_stream` and `transcript_media_pin`,
  `expectedResultRevision` on `web_annotation_resolve`, `textOnly` and
  `retargetOf` on `web_annotation_request_prepare`, and `expectedTabId` on
  `design_session_resume`. None of these domains was version-gated, so each
  client's version 1 sends the envelope and decodes results, and version 0
  is today's call by name, answered as sent; the four capability commands
  stay registered and are read on every version because they report runtime
  state (storage, rollout, renderer, surfaces), except what only gated
  support (the web annotation contract version, design's flags), which
  version 1 answers itself. The renderer calls them through
  `lib/node-scope/domains/{previews,transcripts}.ts`,
  `lib/web-annotations/client.ts` and `lib/design-client.ts`.
- **Projects and config**
  ([7005](../../plans/unified/7005-domain-projects-config.md)): `projects`
  (26 commands: the project list and its arrangement, adding, creating and
  removing projects, the GitHub clone browser, the host folder picker and
  icons, project copies between machines, the AGENTS.md proposals) and
  `config` (31: global and repository settings, the four credentials, the
  desktop catalogue, the shared client state and the permission rules), both
  at version 1 (min 1). `Project` (`domains/projects/models.ts`) is the
  single definition `models.ts` and the web types re-export; `AppConfig`, its
  `global`, `RepositoryConfig` and the agent settings tier
  (`domains/config/models.ts`) are field for field with `models.ts`, in the
  stored form and the renderer's redacted form (`GlobalConfigSchema`:
  `*Configured`/`*Source` instead of credentials). The settings records are
  open (`openRecord`): a client decodes them keeping every key, so a
  whole-object save (`save_config`, `update_global_config`) never deletes a
  setting a newer node added. `access` is `admin` for exactly the settings
  writes the old grant deny-list refused, `internal` for
  `request_coordinator_agents_md_update`. Critical keys: `cloneOnly` on
  `add_project`, `requestKey` on `start_project_clone` and
  `open_project_agents_md_pr`, `preserveInheritedSettings` on
  `update_global_config`, `unset` on both patches, `expectedRevision` on
  `save_coordinator_pane_layout`, `expiresInMs` on
  `approve_native_agent_interaction_and_remember`. Each client's API is one
  function per command, keyed by name; `config` version 1 answers
  `clientStateCapabilities()` itself (`CONFIG_CLIENT_STATE_CAPABILITIES`),
  version 0 asks `get_client_state_capabilities`. The web calls them through
  `lib/node-scope/domains/{projects,config}.ts`, and the config layering
  (`lib/portal/command-node-config.ts`) sends every `config` command on both
  of its nodes through the client. The config-echo path
  (`isGlobalConfigEcho`) is unchanged: it is decided from the raw arguments
  before the registry runs.
- **Git, GitHub, pull requests and changes**
  ([7006](../../plans/unified/7006-domain-git-pull-requests.md)): `git` (22
  commands: the changes ledger, diff-stat snapshots, the Files panel's git
  status, the "Compare against" diff base and the build pipeline's worktree
  probes) and `pull-requests` (39: GitHub issues, the pull request viewer,
  and an environment's PR detection, verification, merge, monitor,
  auto-merge, post-turn recheck and review packages), `git` at version 2
  and `pull-requests` at version 3 (both min 1; each bump only removed
  commands, see Retired). GitHub issues are in `pull-requests` (Appendix E's grouping and
  1006's mapping; `DOMAIN_NAMES` has no `github`). The change resources and
  GitHub pull request records are model records (`modelRecord`, and
  `variantRecord` (`contract/model-schema.ts`) for the `kind`-discriminated
  change results): the routed-on fields are typed and every other key passes
  through; the GitHub issue model (`domains/pull-requests/schemas.ts`) is
  field for field, and `github.ts` and the web's `types/github.ts` take their
  types from it. `access` is `admin` for `changes_get_diagnostics` and
  `internal` for `pr_monitor_agent_turn_completed` and
  `pr_monitor_probe_environment`. Critical keys: `pathIds` on
  `changes_prepare_restore`; `expectedHeadSha`, `expectedPrUrl`,
  `autoMergeEnabledAt`, `method` and `deleteBranch` on `merge_environment_pr`
  (`method`, `deleteBranch` on `merge_pr`, `expectedHeadSha`
  on `merge_github_pull_request`); `comments` and `commitId` on
  `submit_github_pull_request_review`; `expectedHead`, `validationPlan` and
  `additionalLimitations` on `generate_review_package`. The 29 formerly
  strict commands drop unknown keys; nested values the handlers check
  strictly (inline review comments, the review package's `preparation`) stay
  strict. `changes_get_capabilities` is only partly folded: version 1 and
  later imply the `change-tracking-v1` protocol and its fixed features
  (`GIT_CHANGE_TRACKING_PROTOCOL`), but `restore`, `strictCheckpoints` and
  `policyVersion` are the backend's policy, so the client still asks for
  them. Each client's API is one function per command (`commandApi`); the
  web calls them through `lib/node-scope/domains/{git,pull-requests}.ts`
  from `lib/backend/{changes,github-pull-requests,files-sessions,config-integrations}.ts`,
  and `lib/federation/node-change-projections.ts` reads another machine's
  change views through the git client over the routed call (version 0). The
  only register rows for these domains are the older-version adapters left
  by the command removals; the conditional snapshot reads
  (`knownGeneration`/`knownRevision`, `knownDigest`) keep answering the
  legacy bare shapes, which the result schemas include.
- **Kanban, agent mail, accounts and MCP**
  ([7008](../../plans/unified/7008-domain-kanban-mail-accounts-mcp.md)):
  `kanban` (33 commands: tickets with their comments, images, labels and
  criterion checks, the project's label catalogue, the merged-PR closure,
  project notes, feature plans and the planning exchange, the Linear
  connection), `agent-mail` (23: mailboxes, inboxes, messages and
  conversations on one node, delivery retries, the agent registry and the
  messaging settings; mail between nodes stays `node-mail`), `accounts` (33:
  agent accounts and sign-in, usage limits, plan usage and history, the
  coordinator account-switch grant, OpenCode provider logins, the Cursor SDK
  login) and `mcp` (13: MCP management and its rollout gate), all at
  version 1 (min 1). Results are model records over the protocol's own types
  (`McpManagementSnapshot` keeps its `protocolVersion`, Appendix F) or open
  structs where the type lives in the backend. Kanban ticket ids are the
  same on every node, so a client keeps results under the node it asked.
  `access` is `workspace`, except `admin` for the MCP rollout gate
  (`get_`/`set_mcp_management_rollout`) and `internal` for
  `close_kanban_task_for_merged_pr`, which the build pipeline calls in
  process. The 29 strict accounts handlers
  (`assertOnlyKeys`) and six strict Kanban and feature-planning handlers drop
  unknown keys; the lenient mail,
  MCP and Linear handlers read every argument as `optionalKey(Unknown)` and
  keep their own messages. Critical keys: `requestId` on `add_kanban_task`,
  `add_kanban_comment` and both mail sends; `markdown`/`sections`/`labels` on
  `add_kanban_task` and `update_kanban_task`; `preserveDoneStatus` on
  `update_kanban_task`; `projectId` on `add_kanban_comment` and
  `set_kanban_task_label`; `operationId` on `start_feature_planning` and both
  login cancels; `reauthenticate` on `start_agent_account_login`; `metadata`
  on `set_opencode_provider_api_key`; `inputs` on
  `start_opencode_provider_login`; `now` on `retry_agent_mail_inject`;
  `strictProjectScope` on `list_agent_mailboxes`. None of these commands was
  capability-gated, so nothing is folded into a version: a node that lacks a
  newer command answers `unknown-command`, which the callers already read.
  Each client is one function per command (`commandApi`); the web calls them
  through `lib/node-scope/domains/{kanban,agent-mail,accounts,mcp}.ts`, the
  per-machine account and MCP functions (`accountsOn`, `mcpOn`) on version 0
  for another machine. No register row is served by these domains: the
  feature-plan build fallback, the self-reminder carrier, the MCP bridge
  report and the usage-limit text rows are renderer or bridge paths and are
  unaffected.
- **Build pipelines, graphs and Multi Review**
  ([7007](../../plans/unified/7007-domain-pipelines-graphs-multi-review.md)):
  `pipelines` (35 commands: build launches, controls, reads, the unread
  badge and the workflow result rollout), `graphs` (39: the template
  library, sharing, describe jobs, launches, runs and mock runs) and
  `multi-review` (30: workflows and review validation runs), all at version 1
  (min 1). Model records are `modelRecord`s typed as the protocol's own
  interfaces. **The graph guards are reused, not duplicated:** a graph
  template's and a run's result schema is refined by `validateGraphTemplate`
  and `validateGraphRun` (`guardedRecord`, `domains/graphs/schemas.ts`),
  read tolerantly: the guards refuse unknown fields and values outside their
  closed lists, so the refinement ignores the `unknown_field` and `enum`
  codes (a newer backend's added field or status still decodes) and fails on
  any other error; the run guard skips its plan digest check, the backend's
  integrity check on load. The build pipeline and Multi Review guards
  (`isBuildPipeline`, `isMultiReviewWorkflow`) are not used in a decode: the
  renderer runs them after rewriting the Rework and Address Findings
  vocabulary (`workflow-vocabulary.ts`), and the stored `snapshot` stays
  `unknown`. Handlers keep their own validators (coded `Graph*Error`s, the
  start-request guards) on `optionalKey(Unknown)` keys, so codes and text are
  unchanged; the graph handlers' `Unknown arguments` refusals are gone
  (tolerant), and the start requests also declare the newer vocabulary's
  keys (`autoAddressFindings`, `addressFindingsModel`) for the handler to
  rewrite. Critical: `requestId` on `create_feature_build`, `graph_run_launch`,
  `graph_run_restart` and `graph_run_rewind_code`; `existingEnvironmentId`
  and `deliveryPolicy` on the build launches (and `deliveryPolicy` on a
  feature build); `expectedRevision` on the graph template and ceiling
  writes; `expectedLastActivityAt` on `set_environment_unread`; the
  "Restart in…" `selection`/`model`; `digest` on `graph_template_duplicate`;
  an edited `value` on `graph_run_answer`. `access` is `workspace` apart from
  the workflow result rollout and `graph_capability_ceiling_set` (`admin`;
  the ceiling write since 7012, which a grant was always refused) and the review validation lifecycle
  the supervisors drive in-process (`internal`). No command was
  capability-gated, so nothing is folded into a version; each client is one
  function per command (`commandApi`), version 0 today's call by name. The
  web calls them through `lib/node-scope/domains/{pipelines,graphs,multi-review}.ts`;
  `lib/backend/workflows.ts` is split into `build-pipelines.ts` and
  `multi-reviews.ts`, which `createWorkflowsApi` and its named exports still
  include. Register rows: the renderer fallbacks for backends without
  `launch_build_pipeline` or `start_feature_plan_build`, the Rework and
  Address Findings vocabulary, the Address session text report and the
  hydration fallback are **unaffected** (a pre-contract node's
  `unknown-command` reaches the caller through version 0, as before); none
  retires.
- **Adapter list.** Every domain client is defined under
  `packages/protocol/src/contract/domains/`, one per domain, and listed in
  `DOMAIN_CLIENTS` (`contract/client-adapters.ts`).
  `packages/protocol/contracts/adapters.json` is its committed form (per
  domain: `current` and `adapters`, highest first), written by
  `mise run contract:adapters`; `mise run contract:adapters:check` fails on
  drift and runs in CI next to `contract:check`. The contract CI job reads it.
- **Usage counters.** Every call through an adapter below its domain's current
  version is counted, names and numbers only. The backend's own clients count
  into the compatibility-path counters as
  `domain-adapter.backend.<domain>.v<version>` (`backendDomainAdapterUsage`);
  a desktop window's renderer counts into a bounded ring
  (`domain-adapter-usage-ring.ts`, next to the error ring) and sends new counts
  with `record_domain_adapter_usage` to its own backend, which adds the listed
  pairs as `domain-adapter.renderer.<domain>.v<version>`. Read them with
  `get_compatibility_path_usage` like any other path.
- **Retirement** (plan item
  [7013](../../plans/unified/7013-retire-legacy-adapters.md)): the adapter for
  version *v* is deleted when the support floor passes (is at or above) the
  first Stable release that advertises the domain at *v + 1* or higher, the
  register's usual rule: 60 days after that release, or a later Stable
  release, is published. The legacy adapter 0 goes when the floor passes the
  first Stable release that advertises the domain, and with it the
  client-side capability gating it packaged. A per-domain capability command
  the backend keeps for pre-contract renderers (`get_client_state_capabilities`,
  `get_native_agent_sync_capabilities`, `get_agent_handoff_capabilities`)
  goes at the same time; the five that report runtime state
  (`changes_get_capabilities`, `design_capabilities`,
  `get_preview_capabilities`, `transcript_artifact_capabilities`,
  `web_annotations_capabilities`) stay, and only leave
  `LEGACY_CAPABILITY_COMMANDS` with their adapter 0.
  `packages/protocol/contracts/retirements.json` (kept by hand) classifies
  every capability command: `retireAtDomainVersion` is the domain version
  whose first Stable release retires it, `null` when it stays, and `why`;
  `retired` (a date) once it is deleted, kept while an in-window release
  still has the command.
  Contract CI fails on the day an adapter or command becomes unreachable, and
  prints the schedule on request (see
  [Retirement schedule](#the-manifest-the-ratchet-and-ci)). **As of
  2026-11-07 nothing can be deleted:** no Stable release advertises
  `domains` yet (v2.36.1 is pre-contract), so every adapter 0 and the three
  kept commands wait for "60 days after the first Stable release that
  advertises `domains`".

### The manifest, the ratchet and CI

- **Manifest.** `packages/protocol/contracts/manifest.json` describes every
  registered command, generated from the real registry by
  `scripts/generate-contract-manifest.ts`. A defined command has `{ domain,
  since, access, read, critical, argsDigest, resultDigest }`, where a digest is
  the SHA-256 of `canonicalJsonSchema(schema)` (`contract/json-schema.ts`:
  object keys and `required` sorted, other arrays in order). A string command
  has `{ domain, untyped: true, read }`, its domain from
  `apps/backend/src/core/contract-domain-map.ts`. `counts` and
  `untypedByDomain` are totals; `domains` holds each defined domain's
  `{ version, min }`.
- **Domain map.** The generator fails when a string command is in neither the
  map nor a definition, when the map names a command that is not registered or
  is registered with its definition, or names one twice.
- **Ratchet.** `packages/protocol/contracts/untyped-baseline.json` holds the
  allowed untyped count per domain. `scripts/contract-check.ts` fails when the
  manifest's `untypedByDomain` exceeds it for any domain (a domain missing
  from the baseline allows none), and when the baseline allows more than the
  manifest has, so each conversion lowers it. It is rewritten only downward:
  `--lower-baseline` writes nothing and fails if any domain rose. Moving an
  untyped command to another domain in the map is the one reason to edit the
  baseline by hand; the total must not change, and review checks it.
- **Commands.** `mise run contract:manifest` regenerates the manifest, then
  lowers the baseline, then stores the argument schemas (below).
  `mise run contract:check` runs the manifest drift check (`--check`, no
  writes) and the ratchet, and every failure names this section. CI runs
  `contract:check` and `contract:ci` in `ci.yml`'s Lint job.
- **Release snapshots** (plan item
  [1007](../../plans/unified/1007-release-snapshots-and-backfill.md),
  `scripts/contract-snapshots.ts`): `release:version` writes
  `packages/protocol/contracts/releases/<version>.json` from the committed
  manifest (after checking it is current). A release file references one
  blob per domain, `contracts/domains/<domain>-<hex16>.json`, named by the
  SHA-256 of the blob's text, so releases with an unchanged domain share its
  blob and storage grows with domain changes, not releases.
  `contracts/releases/index.json` lists each snapshotted release with its
  channel and GitHub publication time (`null` until published), which is all
  the floor needs. `mise run contract:backfill` snapshots any published
  release that has none: a tag that commits a manifest is split from it, and
  a pre-contract release is checked out in a temporary worktree, installed
  with its pinned Bun, and its own registry listed in a sandboxed child; its
  snapshot is marked `preContract`, every command `{ untyped: true }` with
  `read` from its own `isNodeReadCommand` where it has one (from
  v2.26.1-alpha), domains from the current tree, and names the current tree
  no longer has in an `unmapped` blob. `--check` verifies without writing.
- **Contract CI job** (plan item
  [1008](../../plans/unified/1008-contract-ci-job.md), `scripts/contract-ci.ts`,
  `mise run contract:ci`, every PR). It computes the
  [support floor](#the-support-window) from `releases/index.json` and today's
  date (`--now <date>` to try another day): the newest `stable` entry whose
  `publishedAt` is at least 60 days old, otherwise v2.21.0. Every snapshotted
  release at or above it is in the window, including one whose `publishedAt`
  is still `null`, which is never the floor. Stage 1 then fails when:
  - the index and the `releases/*.json` files disagree, or an in-window
    snapshot does not verify;
  - an in-window release speaks a (domain, version) that the domain's client
    in `adapters.json` has no adapter for. A release that does not advertise
    a domain speaks version 0. A domain with no client yet is called by name
    through the untyped invoke, which is version 0 for every peer, so it is
    checked from the day it gets a client; a versioned domain that left
    `DOMAIN_NAMES` always fails;
  - a command of an in-window release is no longer registered and no
    register or Retired row names it (as a code span), or its domain is not
    at a higher version than in that release. The bump is not required when
    the domain is unversioned on both sides, or when the snapshot has no
    domain for the command (pre-contract names the current map does not
    place);
  - a register row's Counter cell is not "None ..." and names no id, or an id
    that is neither in `COMPATIBILITY_PATH_IDS` nor a domain adapter id, or a
    row does not have the six columns;
  - a domain is above the version an in-window release advertises and no
    register row names the old version's adapter counter
    (`domain-adapter.renderer.<domain>.v<old>` or `.backend.`), a register
    row names an adapter `adapters.json` no longer has (move it to Retired),
    or a domain is below an in-window release's version;
  - a defined command's argument schema (current manifest or an in-window
    release) is not in the schema store;
  - an adapter or capability command is due: "adapter `<domain>` v`<n>` is
    unreachable: delete it and move its register rows to Retired" once the
    floor has passed the first Stable release that advertises the domain at
    *n + 1* (the same for a capability command whose `retireAtDomainVersion`
    the floor has passed), or `retirements.json` does not list a
    `LEGACY_CAPABILITY_COMMANDS` command, lists one that is no longer
    registered (without `retired`) or under another domain, marks one
    `retired` that is still registered or whose condition the floor has not
    passed, or retires one no register row names. The job reads every Stable
    snapshot, also below the floor, to date it. A command marked `retired`
    after its condition needs no domain bump in the removed-command check:
    every in-window renderer has the domain and never calls it.

  **Retirement schedule.** `mise run contract:ci -- --retirements` prints,
  without checking, every adapter below its domain's current version and
  every capability command of `retirements.json`, grouped by status: `due`
  (the job fails until it is deleted), `scheduled` (the first qualifying
  Stable release is published; the line gives the earliest date and that
  release), `waiting` (no qualifying Stable release published yet: "60 days
  after the first Stable release that advertises `<domain>`; not yet
  shipped") and `kept`, with the register rows (by line) that move to
  Retired with it. `--json` gives the same as data (`entries[]`: `kind`,
  `domain`, `adapter` or `command`, `domainVersion`, `condition`,
  `firstRelease`, `earliest`, `status`, `counters`, `registerRows`, `why`);
  `--now <date>` shows another day. The first Stable release that advertises
  `domains` turns every `waiting` entry into `scheduled` with its date. The
  usage counters are not read: they are local to each backend, so before
  deleting a due adapter read its `counters`
  (`domain-adapter.<renderer|backend>.<domain>.v<n>`) with
  `get_compatibility_path_usage` on the machines you can reach, as for any
  register row ([Usage counters](#usage-counters)); the kept capability
  commands have no counter (their callers are older renderers), so only the
  floor retires them. Deleting one: remove the adapter from its client and
  its domain's entry from `LEGACY_CAPABILITY_COMMANDS` with adapter 0 (or the
  command from the registry, marking it `"retired": "<date>"` in
  `retirements.json`), run `mise run contract:adapters` (and
  `contract:manifest`), and move its rows to Retired; the job's register
  check fails on a row that still names a deleted adapter.

  **Argument schema store.** Manifests and snapshots keep only digests, so
  `scripts/contract-ci-schemas.ts` (the last step of `contract:manifest`)
  keeps each defined command's canonical argument schema document in
  `contracts/schemas/<hex16>.json`, by digest, and removes only files that no
  registry command, manifest or snapshot references. Commit the new files
  with the manifest.

  **Stage 2** (`CONTRACT_CI_STAGE_2` in the script, on since plan item
  [7001](../../plans/unified/7001-domain-native-sessions.md), the first
  non-pilot domain, 2026-11-07; `--stage2` still forces it). For each defined command of an in-window release whose domain
  has not been bumped since, it fails when the current schema requires a
  field the older one did not (through `properties`, `items` and `$ref`;
  union branches are not compared), and when fixtures generated from the
  older stored schema (`SchemaRepresentation.fromJsonSchemaDocument`, then
  `effect/Arbitrary`, 25 seeded samples, sent as JSON) are refused by
  `decodeCommandArgs` with the definition the real registry registered, in
  a sandboxed child. No handler runs.
- **Mixed-version qualification** (plan item
  [1012](../../plans/unified/1012-mixed-version-qualification.md),
  `scripts/qualify-contract-mixed-versions.ts`,
  `mise run qualify:mixed-versions`; weekly in
  `.github/workflows/mixed-version-qualification.yml`, not per PR). It runs
  this checkout against a real published `orkestrator` npm release in both
  node topologies: this checkout's command node with the release as its
  leaf, and the release as command node with this checkout as its leaf.
  `--old-version floor` (the default) is the floor above; while npm lacks it
  (v2.21.0 and v2.21.1 never reached npm) the oldest published in-window
  release npm carries. The workflow also runs `latest-stable`. Every backend
  has its own temporary data directory, HOME and loopback port, a
  constructed environment (no inherited `ORKESTRATOR_*` or credential
  variable, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`) and the `agent-test`
  runtime, so no agent can start. The runner attaches the leaf (a release
  without command nodes must be refused naming the update), then runs one
  scenario module per domain from `scripts/mixed-version/scenarios/`; the
  module interface and its rules are in `scripts/mixed-version/scenario.ts`.
  A scenario whose commands the release lacks is recorded as not applicable;
  when this checkout is the command node, each module also asserts which
  client adapter its domain took (`domain-adapter.backend.<domain>.v0` for a
  pre-contract peer). Each Phase 7 domain conversion adds its module.
  `--old-version current` runs this checkout on both sides, and
  `--profiles <command>,<leaf>` runs the modules against two running
  `dev:test` profiles.

### How to add a command

1. Pick its domain from `DOMAIN_NAMES`. `contract-domain-map.ts` shows where
   the domain's untyped commands are today.
2. Define it in `packages/protocol/src/contract/domains/<domain>/commands.ts`
   with `defineCommand`, following the schema rules above (the domain itself
   is `<domain>/domain.ts`, its events `events.ts`, its client `client.ts`;
   `node-mail/` is a complete example). `since` is the domain's
   current version: a new command does not bump the domain.
3. Register it in the backend with `register(def, handler)`. The handler gets
   the decoded arguments (`ArgsOf<typeof def>`) and returns `ResultOf<typeof
   def>`; tests validate the result against the schema.
4. Call it through the domain's client adapter for the current version; from
   another backend, `NodeLink.invokeCommand(def, args)`. A node in the window
   that lacks the command answers `unknown-command`, which the adapter or
   caller reads with `incompatibility()`.
5. Run `mise run contract:manifest` and commit `manifest.json`, the new
   `contracts/schemas/` file (and the baseline, if it changed).
   `mise run contract:check` and `mise run contract:ci` must pass.

Converting an existing string command is the same, plus: delete its entry in
`contract-domain-map.ts` (the generator refuses a defined command that is
still mapped), keep the handler tolerant, keep its error text with `message`
annotations, and commit the lower baseline that `contract:manifest` writes.

Changing a defined command: a new optional field needs nothing else. Anything
in the bump list above bumps the domain version, keeps the old version
accepted through `min` where clients in the window still send it, adds a
client adapter for the old version, and adds a register row.
