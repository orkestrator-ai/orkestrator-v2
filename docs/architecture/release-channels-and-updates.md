# Release channels, in-app updates and remote updates

Status: Design, being implemented in phases (see [Delivery](#delivery)).
Outstanding qualification: [release-channels-qualification.md](../todo/release-channels-qualification.md).
Release procedure: [releasing.md](../development/releasing.md).

This document covers how Orkestrator ships on three release channels, how an
installation finds and installs an update, how a client updates a machine it
is connected to, and how a release that needs new permissions is approved
before it is installed.

## Goals and decisions

| Topic | Decision |
| --- | --- |
| Channels | `stable`, `beta`, `unstable`. Each desktop app or headless backend subscribes to one. |
| Builds | Stable (`vX.Y.Z`) and beta (`vX.Y.Z-beta.N`) are tagged and built by hand on maintainer machines. Unstable is a CI build from `main`, nightly and on `workflow_dispatch`. |
| Remote targets | Headless backends (`orkestrator serve`) and remote desktop apps. One **Update remote** action covers both. |
| Permissions | Every release publishes a machine-readable requirements manifest. Before an install, the client diffs it against the running version, and the user approves what is new. |
| Provider binaries | Pins stay in `packages/toolchain/src/manifest.ts`. An update fetches and verifies the target version's pinned binaries **before** the restart. There is no independent toolchain channel. |
| Who may update a remote | Anyone who holds the backend's gateway token, the same trust boundary that already lets them run agents. Every remote update is audited on the remote. |
| Channel switch | Never downgrades on its own, and never downgrades past a storage migration floor. |
| Atomicity | A failure at any step leaves the machine on the old working version, and the failure is reported to the client. |

## Channel model and versioning

```text
stable    2.21.0                              tag v2.21.0
beta      2.22.0-beta.3                       tag v2.22.0-beta.3
unstable  2.22.0-unstable.20261015.412.g3f2a9c1  tag v2.22.0-unstable.20261015.412.g3f2a9c1
```

- A version's channel is read from its prerelease part. No prerelease means
  `stable`; a first identifier of `beta` means `beta`; `unstable` means
  `unstable`. Any other prerelease (`alpha`, `rc`) is not a channel, and the
  release tooling refuses it.
- **Channels nest.** A subscription includes every more conservative channel:
  `beta` subscribers get the newest of stable and beta, and `unstable`
  subscribers get the newest of all three. Nobody is held on an older beta
  after a newer stable ships.
- Ordering is plain semver precedence
  (`packages/protocol/src/release-channels.ts`). `unstable` sorts after `beta`
  for the same `X.Y.Z` because identifiers compare lexically
  (`beta` < `unstable`), and every prerelease of `X.Y.Z` sorts before `X.Y.Z`
  itself.

### Unstable version format

The request was `X.Y.Z-unstable.<yyyymmdd>.<shortsha>`. **This design uses
`X.Y.Z-unstable.<yyyymmdd>.<run>.g<shortsha>`**, where `<run>` is the
workflow's `github.run_number`. The plain form has two defects:

1. Two builds on the same day (the nightly plus a manual dispatch) compare by
   their SHAs, which semver orders lexically. A later build can therefore sort
   *older* and never be offered.
2. A short SHA made only of digits is a numeric identifier. One with a leading
   zero (`0123abc` is fine, `0123456` is not) is **invalid semver**, which
   breaks electron-updater, npm and the container tags.

The run number is monotonic per workflow, so it decides same-day order. The
`g` prefix (as in `git describe`) keeps the SHA alphanumeric. The SHA is that
of the `main` commit that was built.

`X.Y.Z` is derived from `main`'s root `package.json`:

- If it is a prerelease (`2.22.0-beta.3`), the base is `2.22.0`, so unstable
  sorts above that beta and below the `2.22.0` stable.
- If it is stable (`2.21.0`), the base is the next patch, `2.21.1`, so the
  build sorts above the release it contains.

If a beta is cut from a branch with a higher base than `main`, unstable
subscribers receive that beta and then wait until `main`'s version passes it.
That is the "never downgrade" rule working as intended.

### Choosing and switching channels

The channel is stored on the machine that is updated, in `config.json` as
`global.updateChannel` (default `stable`). It is read and written through
`update_set_channel`, and a renderer can set it for a remote machine. Moving
to a broader channel takes effect on the next check.

Moving to a narrower channel never downgrades. If the running version is newer
than anything on the new channel, status reports `waiting-for-channel` (for
example "stable will be offered once it passes 2.22.0-beta.3"), and the
machine stays where it is until the channel catches up. The user can still
pick **Install latest stable now**, which is an explicit downgrade with its own
confirmation. It is refused when the target's
`storage.schemaVersion` is below the database's current `user_version`,
because the older build would refuse to open it (`StorageDatabaseVersionError`).

## Artefacts and feeds

| Artefact | Stable | Beta | Unstable |
| --- | --- | --- | --- |
| GitHub release | `v<version>`, published, marked *latest* | `v<version>`, prerelease, never latest | `v<version>`, prerelease, never latest; CI prunes all but the newest 10 |
| Desktop feeds in the release | `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` | same names | same names |
| Requirements manifest | `release-requirements.json` (+ `.sig` when signing is configured) | same | same |
| Channel index | `channels.json` on the fixed `update-channels` prerelease | ← | ← |
| npm `orkestrator` dist-tag | `latest` | `beta` | `unstable` |
| GHCR image tags | `X.Y.Z`, `X.Y`, `X`, `latest`, `stable`, `sha-<commit>` | `X.Y.Z-beta.N`, `beta`, `sha-…` | `<version>`, `unstable`, `sha-…` |

### Why not electron-updater's own channels

electron-updater's GitHub provider has channel support (`channel`,
`allowPrerelease`, `beta.yml` channel files). It was evaluated against
`electron-updater` 6.8.10's `GitHubProvider` source and rejected as the
**resolver**:

- With `allowPrerelease`, it reads the repository's `releases.atom` feed,
  which lists only the newest ~10 releases. Nightly unstable releases would
  push every beta and stable out of that window, and beta subscribers would
  then get `ERR_UPDATER_NO_PUBLISHED_VERSIONS`.
- Only `alpha` and `beta` are ordered channels. A custom `unstable` channel
  matches only its own tags, so unstable subscribers would never receive a
  stable or beta release.
- With `allowPrerelease` and a stable current version but no explicit
  channel, it takes the first atom entry, whatever channel that is.
- Setting `updater.channel` silently turns `allowDowngrade` on.
- electron-builder never auto-detects a channel when publishing to GitHub. A
  prerelease build already writes `latest-*.yml`, not `beta-*.yml`, so channel
  files would need a custom publish step anyway.

The design keeps electron-updater for what it does well: downloading, SHA-512
verification against the feed, blockmap differentials, Squirrel.Mac's code
signature check, and the AppImage swap. Orkestrator resolves the target
release itself and then points electron-updater at that one release with a
generic provider:

```ts
updater.setFeedURL({
  provider: "generic",
  url: `https://github.com/orkestrator-ai/orkestrator-v2/releases/download/${tag}`,
  channel: "latest",                 // latest-mac.yml / latest-linux(-arm64).yml
  useMultipleRangeRequest: false,    // GitHub's S3 backend has no multi-range
});
updater.allowDowngrade = false;      // reset explicitly; only the downgrade action sets it
updater.autoDownload = false;        // nothing is downloaded before consent
```

After `checkForUpdates()`, the updater's `updateInfo.version` must equal the
resolved version, or the job fails as `feed-mismatch`.

Old clients (2.20.x and earlier) keep working unchanged. They use the GitHub
provider with `allowPrerelease = false`, which follows `/releases/latest`.
Only stable releases are ever marked latest, and `update-channels` is a
prerelease, so it can never become latest.

### Channel index (`channels.json`)

```json
{
  "schema": "orkestrator-release-channels",
  "schemaVersion": 1,
  "repository": "orkestrator-ai/orkestrator-v2",
  "generatedAt": "2026-10-15T03:12:00Z",
  "channels": {
    "stable":   { "version": "2.21.0", "tag": "v2.21.0", "publishedAt": "…", "requirementsSha256": "…" },
    "beta":     { "version": "2.22.0-beta.3", "tag": "v2.22.0-beta.3", "publishedAt": "…", "requirementsSha256": "…" },
    "unstable": { "version": "2.22.0-unstable.20261015.412.g3f2a9c1", "tag": "…", "publishedAt": "…", "requirementsSha256": "…" }
  }
}
```

- Each entry is the newest published release **of that channel only**.
  Clients apply the nesting rule.
- The file is an asset of a fixed prerelease with tag `update-channels`:
  `https://github.com/orkestrator-ai/orkestrator-v2/releases/download/update-channels/channels.json`.
  It is a stable, CDN-served URL with no API rate limit, it needs only the
  `contents: write` permission that releases already use, and it does not
  require committing to a branch or enabling Pages.
- It is **derived, never edited**. `scripts/release-channel-index.ts` lists
  the published releases, keeps those with a channel version, checks that each
  has its `release-requirements.json`, and rebuilds the whole file. Concurrent
  writers (a maintainer's `release:publish` and the nightly) therefore
  converge, because each one recomputes from the same source of truth.
- `--clobber` replaces the asset, which leaves a short window when it does not
  exist. Clients treat a 404 or a parse failure as a failed check (retried
  next time), never as "no update".
- **No fallback.** If the index is unavailable, every channel reports
  `channel-index-unavailable` and checks again later. A fallback to GitHub's
  `/releases/latest` redirect was considered and dropped: it would offer a
  manifest with no published checksum to verify it against. Pre-channel
  clients keep using that redirect through their own updater.
- `ORKESTRATOR_UPDATE_FEED_URL` (environment only; never configurable by a
  remote client) points the backend and desktop at another base URL for
  qualification against a staging repository or a local server.

The index is only a pointer. Integrity comes from the manifest checksum
(below), electron-updater's feed SHA-512 and Squirrel.Mac's signature check
for the app, npm's `dist.integrity` for the backend package, and the
toolchain's pinned SHA-256s. A tampered index can only point at another real
published release, and that release must still pass the downgrade guard and
every artefact check.

### npm dist-tags (headless backend)

`mise run publish:cli` becomes channel-aware (`scripts/release-cli.ts`). It
derives the channel from the version and runs
`bun publish --cwd packages/cli --access public --tag <latest|beta|unstable>`.
It always passes `--tag`, because publishing a prerelease without one would
otherwise move `latest`. The unstable CI workflow publishes with
`NPM_CONFIG_TOKEN`. `bun publish` cannot yet produce npm provenance; this is
recorded as a follow-up.

A headless backend still resolves its target from `channels.json`, so desktop
and headless agree on what "newest on beta" means. It installs that exact
version from npm. `release:publish` refuses to publish the index until the npm
version exists (`npm view`-equivalent registry fetch), so the index never
points at a version that `bun add` cannot install.

### GHCR tags

`publish-container.yml` computes its tags with
`scripts/release-channel.ts container-tags` rather than relying on
`docker/metadata-action`'s `latest=auto`. That way the rule is unit-tested
and cannot depend on which event triggered the run. The workflow keeps its tag
trigger for hand-pushed stable and beta tags. It gains `workflow_call`,
because a tag pushed by CI with `GITHUB_TOKEN` does not trigger other
workflows, so the unstable workflow calls it directly. Only a stable version
emits `latest`, `X.Y` and `X`.

The app never pulls an image on its own today (it runs the local
`orkestrator-v2:latest`). See [Container image](#container-image) for what an
update does.

## Release requirements manifest

`release-requirements.json` is generated deterministically from the tagged
tree by `scripts/release-requirements.ts`. Generation never reads timestamps
or host data, so the macOS and Linux build machines produce byte-identical
files. It is shipped in three places:

1. as a GitHub release asset, which is what a client fetches for consent;
2. inside the desktop app at `resources/release-requirements.json`, so a
   running app can diff against its **own** requirements;
3. inside the npm package at `resources/release-requirements.json`, which is
   used for the same diff and to bind the installed package to the approved
   manifest.

Schema (version 1, `packages/protocol/src/release-requirements.ts`):

```jsonc
{
  "schema": "orkestrator-release-requirements",
  "schemaVersion": 1,
  "version": "2.22.0-beta.3",
  "channel": "beta",
  "commit": "3f2a9c1…",                       // tagged commit
  "compatibility": {
    "updateProtocol": 1,                      // update_* commands + /status shape
    "minClientVersion": "2.20.0",             // oldest renderer/desktop that may drive this backend
    "minBackendVersion": "2.20.0"             // oldest backend this version's client supports
  },
  "storage": {
    "schemaVersion": 3,                       // highest STORAGE_MIGRATIONS version
    "migrations": [{ "version": 3, "name": "record-shape-upgrade", "reversible": false }]
  },
  "permissions": {
    "macos": [
      { "id": "desktop", "kind": "files-and-folders", "infoPlistKey": "NSDesktopFolderUsageDescription",
        "usage": "Orkestrator searches project directories …", "requirement": "required",
        "grantedAtMachine": true }
    ]
  },
  "network": {
    "egressHosts": [                          // machine traffic and container firewall defaults
      { "host": "registry.npmjs.org", "purposes": ["container-default", "toolchain", "updates"] },
      { "host": "github.com", "purposes": ["container-default", "toolchain", "updates"] }
    ]
  },
  "toolchain": {
    "versions": { "claude": "2.1.296", "codex": "0.162.1", "gh": "2.102.0", "…": "…" },
    "artifacts": [ /* PINNED_TOOLCHAIN_ARTIFACTS, verbatim */ ]
  },
  "container": {
    "image": "ghcr.io/orkestrator-ai/orkestrator-v2",
    "tag": "2.22.0-beta.3",
    "requiredImageCapabilities": { "workspace-prepare": 1 },   // BACKEND_REQUIRED_IMAGE_CAPABILITIES
    "imageCapabilities": { "workspace-prepare": 1, "network-policy": 2, "…": 1 }
  }
}
```

Every section comes from the source that already owns the fact, so the
manifest cannot drift from the code:

| Section | Source |
| --- | --- |
| `storage` | `STORAGE_MIGRATIONS` (`storage-stores.ts`) |
| `permissions.macos` | `build.mac.extendInfo` usage strings in the root `package.json`, joined with `MACOS_PERMISSION_IDS` and the requirement level from `packages/protocol/src/macos-permissions.ts` |
| `network.egressHosts` | toolchain `allowedHosts` (`toolchain`), `DEFAULT_ALLOWED_DOMAINS` (`container-default`), and `config/release-requirements.json` (hand-declared app endpoints such as the update feed) |
| `toolchain` | `PINNED_TOOL_VERSIONS`, `PINNED_TOOLCHAIN_ARTIFACTS` |
| `container` | `BACKEND_REQUIRED_IMAGE_CAPABILITIES`, and the capability markers in the contract scripts (`docker/image-manifest.ts`) |
| `compatibility` | `config/release-requirements.json`, raised by hand in the change that breaks compatibility; `version-drift.test.ts` checks it is ≤ the version |

### Integrity

- **Checksum (always).** The manifest's SHA-256 is recorded in
  `channels.json`, and the client verifies the downloaded bytes against it. At
  publish time, `release:publish` also verifies the uploaded asset against a
  fresh generation from the tag. This protects against a mismatched, truncated
  or swapped manifest. The trust root is the same as the Linux app feed: HTTPS
  from GitHub plus write access to the repository.
- **Binding to what is installed.**
  - Headless: after `bun add`, the installed package's own
    `resources/release-requirements.json` must hash-equal the approved
    manifest, or the job fails as `package-manifest-mismatch`. This proves the
    npm artefact npm just verified is the release the user approved.
  - Desktop: the feed's `version` must equal the manifest's, and the
    Squirrel.Mac signature check binds the app to the Developer ID.
- **Signature (decided: an active CI key plus an offline standby).** An
  Ed25519 detached signature, `release-requirements.json.sig`, made with the
  active release key, which is the CI secret `ORKESTRATOR_RELEASE_SIGNING_KEY`
  and a maintainer copy. It is verified against public keys compiled into the
  app (`packages/protocol/src/release-signing-keys.ts`): the active key and a
  standby key that is kept offline and signs nothing until a rotation.
  - When the build embeds at least one key, a valid signature is **required**.
    Accepting an unsigned manifest would let anyone who can strip the file
    bypass the check.
  - Until the keys are generated and listed, the list is empty, which means
    checksum-only mode. Turning signing on is a one-way door: from then on
    every release must be signed, and `release:desktop` refuses to publish
    without the key.
  - Generation, custody, rotation and loss recovery are in
    [releasing.md](../development/releasing.md#manifest-signing-keys).
    electron-builder 27's mandatory signed update manifests
    ([dependency-upgrades.md](../todo/dependency-upgrades.md)) should follow
    the same policy.

### Diff and consent

`diffReleaseRequirements(current, target)` returns items of the form
`{ id, category, change, title, detail, consent, actionOnHost }`. The `id` is
stable (`category:key`, for example `macos-permission:downloads`).

| Category | Change | Consent | Action on host |
| --- | --- | --- | --- |
| `macos-permission` | new id, a level raised to `required`, or a changed usage string | yes | **yes**: the TCC prompt must be answered at that machine |
| `network-egress` | new host | yes | no |
| `provider-binary` | new tool | yes | no |
| `provider-binary` | version change | informational | no |
| `storage-migration` | `schemaVersion` raised | yes (one-way; rollback restores the pre-update snapshot) | no |
| `container-capability` | required image capability the local image lacks | yes | when the image is locally built (rebuild needed) |
| `compatibility` | requester older than `minClientVersion` | **blocking** (update this client first) | — |

If the running version has no embedded manifest (2.20.x and earlier), the
current side is `null`. The dialog then lists everything the target requires
under "This version needs", and every consent-category item needs approval.

Consent is bound to bytes:

1. `update_start` carries the manifest's `requirementsSha256` and the
   `approvedConsentIds` the user saw.
2. The backend recomputes the diff from the manifest it fetched and verified.
3. It refuses (`consent-mismatch`) unless the hash matches and the approved
   set covers every item with `consent: true`.

A client therefore cannot approve one manifest and have another installed.

## Update service

The backend owns the update **workflow** on every kind of machine, in
`apps/backend/src/core/updates/`. It does not do the platform-specific install.
It delegates that to the process that **hosts** it:

| Host kind | Who | Installs by | Detected by |
| --- | --- | --- | --- |
| `desktop` | the Electron main process that spawned the backend | electron-updater (Squirrel.Mac / AppImage) | the host registers over the control listener |
| `supervisor` | `orkestrator serve --supervised` | `bun add orkestrator@<version>` into a versioned directory, then a health-gated cutover | the host registers over the control listener |
| `none` | plain `orkestrator serve`, dev runs, agent-test profiles | — (checks only; status gives manual instructions) | nobody registered |

Why the backend and not each host: one implementation of channel resolution,
manifest verification, consent, the state machine, audit and progress events
serves the local renderer, a remote renderer, the hosted web client and the
CLI alike. The hosts stay small, and a remote client drives a desktop-hosted
backend and a headless one through the same commands.

### State machine

```text
             check                     approve (consent ok)
  idle ──────────────▶ available ─────────────────────────▶ approved
   ▲   (no newer)                                               │
   │                                                            ▼
   │                                              fetching-dependencies   (toolchain + image prefetch, verify)
   │                                                            │
   │                                                            ▼
   │                                                      downloading     (host: app or npm package, verify)
   │                                                            │
   │                                                            ▼
   │      install (now, or "Later" = on quit for desktop)    ready         (verified, staged, rollback copy kept)
   │                                                            │
   │                                                            ▼
   │                                                       installing      (host: snapshot, stop, swap)
   │                                                            │
   │                                                            ▼
   │                                                       restarting
   │                                                            │
   │                                                            ▼
   │                                                        verifying      (new version: ready + /status + version)
   │                                                     ┌──────┴───────┐
   │                                                     ▼              ▼
   └──────────────── (new check) ─────────────── succeeded       rolled-back ── or ── failed
```

- Any error **before** `installing` ends the job as `failed`, with the step
  that failed. Nothing on the machine has changed: downloads stay in a cache
  and prefetched toolchains are additive.
- `cancelled` is reachable from `approved`, `fetching-dependencies`,
  `downloading` and `ready`.
- A failure **from** `installing` onwards goes through rollback, ending in
  `rolled-back`. If even the old version cannot be restored, it ends in
  `failed` with `rollbackFailed: true`, the one state that needs a human.
- The transition function is pure (`update-job.ts`): `transition(job, event)`
  either returns the next job or throws `InvalidUpdateTransition`. Unit tests
  enumerate the allowed edges.

Persistence (files, not SQLite, on purpose: a rollback restores the database,
and the record of the failed update must survive that):

- `<dataDir>/updates/state.json` holds the current or last job and the last
  check. The backend is its only writer, and writes it atomically (temp file,
  then rename).
- `<dataDir>/updates/audit.jsonl` is append-only. Each entry is at most 4 KiB.
  The file rotates at 1 MiB and keeps one older file.
- The desktop host keeps `<userData>/updates/pending-install.json`, and the
  supervisor keeps `<dataDir>/runtime/supervisor-state.json`. Each host is the
  only writer of its own file and reports outcomes back through the host
  protocol, so no file has two writers.

Checks run 30 s after start and then every 6 h. A manual **Check now** joins
an in-flight check. Checks are off under `ORKESTRATOR_DISABLE_AUTO_UPDATE=1`,
which also disables installs (the managed-install opt-out), and in `dev` and
`agent-test` runtime flavours.

### Backend commands (client-facing)

Registered in `commands-registry-updates.ts`. They are reachable from the
local renderer over IPC, from any remote client over `/__orkestrator/invoke`,
and from the CLI.

| Command | Purpose |
| --- | --- |
| `update_get_status` | `UpdateStatusSnapshot` (revision, current version/channel/host kind/capabilities, last check, `available` + diff, job, notices) |
| `update_check` `{ force? }` | Run or join a check; returns the snapshot |
| `update_set_channel` `{ channel }` | Persist the channel; returns the snapshot (with `waiting-for-channel` when narrower) |
| `update_start` `{ targetVersion, requirementsSha256, approvedConsentIds, restartPolicy, allowDowngrade?, requester }` | Admit a job (refused unless consent, compatibility, host and floor checks pass) |
| `update_install_now` `{ jobId }` | For a `ready` job with `restartPolicy: "manual"` |
| `update_cancel` `{ jobId }` | Cancel a job that has not reached `installing` |
| `update_acknowledge_notice` `{ noticeId }` | Dismiss a post-update notice |
| `update_get_audit` `{ limit ≤ 200 }` | Recent audit entries |

The `update-status` event carries `{ revision, snapshot }` and is pushed on
every change. Following the transport invariants, the event is only an
incremental update over `update_get_status`. A client rehydrates on mount and
on every event-stream reconnect, and a revision gap triggers a re-read. That
reconnect path is how a client watching a remote restart sees the final
outcome.

### Host protocol (backend ↔ Electron main / supervisor)

Hosts already hold an authenticated client to their backend's **control
listener**: Electron main through `BackendHttpClient`, and the supervisor by
parsing the backend's `orkestrator-backend-ready` line exactly as Electron
does. The host protocol reuses that client, with no new socket or IPC:

- `update_host_register { hostKind, protocolVersion: 1, hostVersion, platform, arch, installKind, capabilities }`
  returns `{ hostSessionId, pending }`. The host registers after every backend
  start and after every event-stream reconnect.
- The backend pushes `update-host-request { hostSessionId, request }`, where
  the request is `prepare`, `install` or `cancel`, with `requestId` and
  `jobId`. `update_host_pending` returns the same list for reconciliation, so
  a missed event is never fatal.
- `update_host_report { hostSessionId, requestId, jobId, status, progress?, error?, result? }`
  covers progress, success and failure. After a restart the **new** (or
  rolled-back) host reports the outcome of the restart through the same
  command.

The `update_host_*` commands are accepted **only on the control listener**
(loopback). The gateway already distinguishes it (`listenerKind`, as used for
`web-client-access`). A remote client therefore cannot impersonate a host or
fake an install outcome.

### Remote protocol

Detecting the remote kind. The authenticated `/__orkestrator/status` route
(today `{ ok: true }`) becomes:

```json
{ "ok": true, "appVersion": "2.21.0", "updateProtocol": 1,
  "host": { "kind": "desktop", "installKind": "dmg-app", "canInstall": true },
  "updates": { "channel": "stable", "available": "2.22.0", "jobPhase": null } }
```

It is authenticated, so disclosing the version does not leak it to anonymous
callers. That is the handshake `mixed-version-compatibility.md` proposed. An
older backend still answers `{ ok: true }`, and the client then shows
"version unknown — update this machine by hand".

The desktop `ConnectionManager.probe()` keeps this payload in the connection
summary (`ConnectionSummary.remote`). The Connections settings page can then
show every saved remote's version, channel and update state without switching
to it.

**Driving a remote.** The renderer calls the same `update_*` commands on a
chosen connection through a new connection-scoped IPC,
`connections.invokeUpdate(connectionId, command, args)`. Main allowlists the
`update_*` client commands and sends the call through that connection's
`BackendHttpClient` with its token. The remote backend picks its own host
adapter, so **Update remote** is one action for both kinds:

- For a desktop host, the remote backend sends `prepare` and then `install`
  to its Electron main, which runs electron-updater and `quitAndInstall`.
- For a supervisor host, the supervisor stages the npm package and performs
  the health-gated cutover.
- With no host, the action is disabled and the panel shows the manual command
  (`bunx orkestrator@<dist-tag> serve`, or restart the service).

Remote updates default to `restartPolicy: "immediate"`, because nobody may be
at the remote to click Restart. The consent dialog shows the remote's running
agent sessions, which the restart will interrupt.

**Progress.** The remote backend emits `update-status` on its own event
stream, which the client already subscribes to for the active connection. For
a connection that is not active, the panel polls `update_get_status` every 2 s
while a job is running. The poll is bounded and stops at a terminal phase.
While the remote restarts, the poll fails. The panel shows "restarting…" and
keeps polling with backoff for up to 10 minutes, then reads the outcome from
the new (or rolled-back) backend.

**Audit.** Every `update_start`, cancel, install, outcome and channel change
appends an entry on the **remote**:

```json
{ "at": "…", "action": "start", "jobId": "…", "from": "2.21.0", "to": "2.22.0",
  "channel": "stable", "approvedConsentIds": ["network-egress:api.example.com"],
  "requirementsSha256": "…",
  "requester": { "listener": "browser", "remoteAddress": "100.101.102.103",
    "tailscaleUser": "alice@example.com", "identitySource": "tailscale-serve",
    "client": { "kind": "desktop", "version": "2.21.0", "name": "alice-mbp" } } }
```

- The gateway passes a trusted invocation origin (listener, socket address)
  to update commands. It never takes an origin from the request body.
- `tailscaleUser` is recorded only when the request arrived through the
  managed `tailscale serve` on loopback, where Tailscale sets
  `Tailscale-User-Login` and a client cannot forge it.
- The client-declared fields are labelled as declared.
- Entries carry no token, prompt or path.

### Mixed-version rules and sequencing

The `update_*` commands and the `/status` shape are the **update protocol**
(`updateProtocol: 1`). They are append-only and outlive every other
compatibility window, so a client can always update an older backend. That
is what guarantees nobody gets stranded.

- **Client first.** Before `update_start` on a remote, the client checks
  `clientVersion ≥ target.compatibility.minClientVersion`. If the check
  fails, it offers "Update this app first", and the backend enforces the same
  rule (`client-too-old`). Updating the client first always works: a newer
  client keeps talking to an older backend through the 404/405 rules in
  `mixed-version-compatibility.md`, and through the update protocol in
  particular.
- **Client update impact.** When the local desktop app updates, its consent
  dialog lists saved remotes whose version is below the new
  `minBackendVersion`. Those remotes are offered **Update remote** after the
  restart. This never blocks the client update.
- **Desktop local.** The bundled backend and renderer update together, so
  there is no skew to manage.
- `BackendVersionReminder` gains an **Update backend** action when the
  backend is older and reports `host.canInstall`.

## Dependencies: provider binaries and the container image

### Provider binaries (pre-fetch before restart)

The target manifest's `toolchain.artifacts` is exactly the target version's
`PINNED_TOOLCHAIN_ARTIFACTS`. In `fetching-dependencies`, the backend:

1. Selects the target artefacts for this host's platform and architecture,
   restricted to the enabled agent platforms plus `gh`. This is the same rule
   as `pinnedArtifactsForPlatforms` and `resolveToolchainSelection`, applied
   to the target's tool names.
2. Validates them strictly (`validateToolchainArtifacts`): every field the
   installer reads, lowercase 64-hex SHA-256s, HTTPS URLs whose host is in the
   artefact's `allowedHosts`, and tool names matching `^[a-z][a-z0-9-]{0,31}$`.
   A target may add a tool the running build does not know. Trust comes from
   the verified manifest, and the pinned SHA-256 still decides every byte.
3. Calls `ensurePinnedToolchains({ artifacts, prune: false })`. It downloads
   into the versioned layout `toolchains/<name>/<version>/<os>-<arch>/` with
   the existing size, host, SHA-256, bundle-integrity and macOS signature
   checks, and activates `bin/<hash>` for the target set. Versions coexist,
   the running set is untouched, and `prune: false` stops an update check from
   deleting anything.
4. Reports the target `bin/<hash>` directory in the job.

At restart, the desktop runs its normal `preparePinnedToolchains`, which finds
everything already installed. The supervisor repoints `toolchains/bin/current`
at the target set during cutover, and points it back on rollback.

### Container image

The app runs the local tag `orkestrator-v2:latest` and decides compatibility
by image capabilities, not versions. During `fetching-dependencies` the
backend reads the local image's manifest:

- **Satisfied.** If the image already implements the target's
  `requiredImageCapabilities`, nothing happens.
- **Published image.** If the image is missing a required capability and the
  local image came from GHCR (`RepoDigests` names
  `ghcr.io/orkestrator-ai/orkestrator-v2`), the backend pulls
  `ghcr.io/orkestrator-ai/orkestrator-v2:<target version>`. Docker verifies
  the content addresses. The backend then checks that the pulled image's own
  manifest reports the target `appVersion` and the capabilities, and records
  the new and old image ids. The old backend retags `orkestrator-v2:latest`
  just before handing over to the host, and a rollback retags it back.
- **Locally built image.** If the image was built locally, the backend never
  replaces it. The diff gets a `container-capability` item with an
  action-needed notice (`mise run docker:build`).

## Headless supervisor

Decision: **a built-in supervisor (`orkestrator serve --supervised`), plus
generated systemd and launchd units that run it.**

Justification:

- systemd and launchd alone can restart a process, but they cannot stage an
  install, run a health check before committing, or roll back.
- Neither exists inside containers, on every Linux, or for a user who runs
  `bunx orkestrator serve` in tmux.
- A small supervisor in the same package does the version logic identically
  on macOS and Linux, and its tests can use fakes.
- The units only keep the supervisor alive across reboots and supervisor
  crashes.
- Plain `orkestrator serve` keeps its current in-process behaviour, so nobody
  is changed without opting in. Its status reports host kind `none` and the
  command to switch.

Layout under `<dataDir>/runtime/`:

```text
versions/<version>/        package.json + node_modules/orkestrator (bun add, integrity-checked)
current  -> versions/<v>   symlink, swapped atomically (rename of a temp link)
previous -> versions/<v>   last known good
supervisor-state.json      in-flight cutover (survives a supervisor crash)
supervisor.lock            one supervisor per data directory
```

Normal operation:

1. Run the backend from `current` if it exists and is at least the
   supervisor's own version. Otherwise run the supervisor's own package (the
   bootstrap).
2. Spawn `bun <root>/bin/orkestrator.js serve <user flags> --control-host 127.0.0.1 --control-port 0`
   as a child, with `ORKESTRATOR_UPDATE_HOST=supervisor`.
3. Parse the readiness line, then register as host.
4. Restart on unexpected exit with exponential backoff (1 s to 60 s).
5. On SIGTERM or SIGINT, forward the signal to the child, wait up to 60 s,
   escalate to SIGKILL, and exit. The backend's reparent watchdog still
   drains if the supervisor dies.

`prepare(target)`:

1. `bun add --exact orkestrator@<version>` into
   `versions/.staging-<version>-<rand>`. Bun verifies every tarball against
   the registry's SHA-512 integrity.
2. Check that the installed `package.json` version equals the target, and
   that `resources/release-requirements.json` hash-equals the approved
   manifest.
3. Rename the staging directory into `versions/<version>`.

`install()`, the health-gated cutover:

1. Record `previous` = the realpath of the running root, the realpath of
   `toolchains/bin/current`, and the database's `PRAGMA user_version`, all in
   `supervisor-state.json`.
2. SIGTERM the old backend and wait for it (60 s, then SIGKILL).
3. Point `toolchains/bin/current` at the prefetched target set, and `current`
   at `versions/<target>`.
4. Start the new backend. Health means: the readiness line within 120 s;
   `GET /__orkestrator/status` → `ok` and `appVersion === target`; no exit
   during a 20 s stability window; and a successful `update_host_register`.
5. **Healthy:** set `previous` to the old root, report `succeeded`, and prune
   versions other than `current` and `previous`.
6. **Unhealthy:** kill the new backend. If `user_version` moved, restore the
   database from the `backups/pre-migration-v<old>-*.sqlite` snapshot the new
   backend took during this cutover (newer than the recorded start), and
   delete `-wal` and `-shm`. Repoint both symlinks back, start the old version
   with the same health check, and report `rolled-back` with the reason. If
   the old version is also unhealthy, keep retrying it with backoff and report
   `failed` (`rollbackFailed`).
7. **Crash-loop guard.** If a version installed less than 30 minutes ago
   crashes 3 times in 10 minutes, roll back automatically.

The supervisor's own code is the version that launched it. A newer backend
works with an older supervisor through `protocolVersion`. The supervisor
picks up its own update the next time the service restarts, because the
units run it from `current`.

`orkestrator service install [--systemd|--launchd] [serve flags]` writes a
user unit, `~/.config/systemd/user/orkestrator.service` or
`~/Library/LaunchAgents/dev.orkestrator.backend.plist`, whose command runs
`<bun> <dataDir>/runtime/current/node_modules/orkestrator/bin/orkestrator.js serve --supervised …`.
It seeds `versions/<own version>` and `current` first. It prints the
`systemctl --user enable --now` or `launchctl bootstrap` command rather than
running it. `orkestrator service print` writes the unit to stdout.

## Desktop host

`apps/desktop/electron/update-host.ts` replaces the native-dialog controller.
Eligibility is unchanged (`isAutoUpdateSupported`: packaged, production
flavour, `app-update.yml`, AppImage on Linux,
`ORKESTRATOR_DISABLE_AUTO_UPDATE`).

- **`prepare`.**
  1. Pin the generic feed to the tag, `checkForUpdates()`, and require
     `updateInfo.version === target`.
  2. `downloadUpdate()` with progress reports. electron-updater verifies the
     SHA-512, and Squirrel.Mac verifies the signature during staging.
  3. Keep a **rollback copy** of the running app, which needs disk space
     (several hundred MB on macOS):
     - macOS: `ditto` the `.app` bundle into `<userData>/updates/rollback/<version>/`.
     - AppImage: copy `$APPIMAGE` there.

     If the copy fails, the job fails before install (atomicity).
- **`install`.** Write `pending-install.json` (`{ jobId, from, to, rollbackPath, startedAt }`),
  then `quitAndInstall(true, true)`. Choosing **Later** sets
  `autoInstallOnAppQuit`, and the marker is written at the same point.
  Nothing is installed before consent: `autoDownload` is off, so a download
  only ever starts from an approved job.
- **After the restart** (early in `startApplication`):
  - If `app.getVersion() === to`: once the backend is ready and the first
    window has loaded, register and report `succeeded`. Delete the rollback
    copy after the next successful start.
  - If `app.getVersion() === from`, the install did not apply: report
    `failed`, with code `install-not-applied`.
  - If the backend fails to start under the new version: restore the database
    snapshot if `user_version` moved, then swap the bundle back. On macOS,
    rename the running bundle aside and `ditto` the copy into place; on Linux,
    copy the AppImage back. Then `app.relaunch()` the old version, which
    reports `rolled-back`.
  - If the new Electron main cannot run at all, nothing can roll back. That
    case is unqualified, and the bundle was signed and notarized, so it is
    expected to be rare.

The application menu's **Check for Updates…** runs `update_check` and opens
the renderer's update panel. The native dialog remains only as a fallback
when no window exists.

## UI surfaces

| Surface | Where | Behaviour |
| --- | --- | --- |
| Update indicator | Title-bar slot (`AppShell.tsx`, beside `AgentMailButton`) | Pill shows **Update**, a progress ring while a job runs, **Restart to update** when ready, or a failure dot. It opens the update panel. |
| Toast | sonner, once per version | "Orkestrator X is available", with an **Update** action |
| Consent dialog | `UpdateConsentDialog` (`AlertDialog`) | Target version and channel; **Needs your approval** (consent items), **Also changes** (informational), **Blocking** (with the fix); remote context: machine name, running sessions, **Action needed on the remote after updating**. The buttons are **Update and restart** / **Download now, restart later** for local, and **Update remote** for remote. |
| Settings → Updates | New `GLOBAL_SETTINGS_SECTIONS` entry | Channel select with descriptions, current version/channel, last check, **Check now**, job progress and errors, recent audit entries, and **Install latest stable now** when waiting for a narrower channel (disabled with the floor reason) |
| Connections settings | `ConnectionsSettings.tsx` rows | Version/channel pill and host kind per remote; **Update available** and **Update remote**; job progress; post-update notices; "update by hand" for host `none` or old backends |
| Version reminder | `BackendVersionReminder` | Adds an **Update backend** action when the backend can install |
| Post-update notices | Update panel; per-connection rows; the macOS permissions blocker on the machine itself | `action-needed-on-host` items (for example "grant Downloads folder access at that Mac"). On the machine itself, the existing blocker in `App.tsx` already probes the new version's `MACOS_PERMISSION_IDS`, and now labels the ones the update added. A notice clears when acknowledged, or when the desktop host's next probe shows the grant. |

## Failure and rollback semantics

| Step | Failure | Result |
| --- | --- | --- |
| Check | network, 404 index, bad schema, checksum or signature | Check fails; the previous `available` is kept; retried at the next interval |
| Consent | hash mismatch, missing approval, blocker | `update_start` refused; no job |
| Dependencies | download, size, host, SHA-256, signature, image pull, capability mismatch | `failed (dependencies)`; prefetched files are harmless and are not activated as `current` |
| Download | network, SHA-512, feed version mismatch, npm integrity, package manifest mismatch | `failed (download)`; staging removed |
| Rollback copy | disk full | `failed (download)` before install |
| Install / restart | Squirrel did not apply; process exit; migration error | Rollback; `rolled-back` with reason |
| Health | no readiness line, `/status` not ok, wrong version, crash within the window | Rollback: database snapshot restore if migrated, symlinks or bundle restored, image retagged back, toolchain `current` restored |
| Rollback | old version also unhealthy | `failed (rollbackFailed)`; the supervisor keeps retrying the old version; the desktop shows the startup error |

The only data loss on rollback is a migration rollback. Writes the new version
made between its migration and the failed health check are discarded with the
snapshot restore. That window is at most the health timeout, and the consent
item for `storage-migration` says so.

## Delivery

| Phase | PR | Scope |
| --- | --- | --- |
| 1 | Channel model and release tooling | `release-channels.ts`, `release-requirements.ts` (schema, diff, signature verify), manifest generator, channel index builder, channel-aware `release:desktop` / `release:publish` / `publish:cli`, GHCR channel tags, `release-unstable.yml`, drift tests, this document |
| 2 | Local in-app update | Backend update service, state machine, files, commands, host protocol; desktop update host; renderer indicator, consent dialog, Settings → Updates; channel setting |
| 3 | Dependency pre-fetch | Toolchain installer accepts a validated target artefact set without pruning; container capability check and GHCR pull; job step before restart |
| 4 | Remote update | `/status` handshake, connection summaries, connection-scoped update IPC, invocation origin and audit, supervisor and service units, desktop post-restart rollback, Connections UI, mixed-version checks |
| 5 | Docs | `releasing.md`, the qualification todo, `00-index.md` lines |

## Secrets and one-time setup

The workflow only references these names. None are created by this change.

| Secret | Used for |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD` | Developer ID Application certificate (electron-builder `CSC_LINK` / `CSC_KEY_PASSWORD`) |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarization (App Store Connect API key; the workflow writes the key to a temp file for `APPLE_API_KEY`) |
| `NPM_TOKEN` | `bun publish --tag unstable` (granular token limited to `orkestrator`) |
| `ORKESTRATOR_RELEASE_SIGNING_KEY` (optional) | Ed25519 manifest signature, once signing is decided |

One-time steps (documented in `releasing.md`):

1. Create the `update-channels` prerelease (`gh release create update-channels --prerelease --title "Update channels" --notes "…"`).
2. Allow GitHub Actions to push `v*-unstable.*` tags if a tag ruleset protects `v*`.
3. Add the secrets above.
4. Enable the workflow's schedule.

## Open decisions

1. **Manifest signing key** (security, one-way door). Recommendation: one
   Ed25519 release key in CI secrets and maintainer custody, with two embedded
   public keys (active + standby) for rotation, decided together with
   electron-builder 27's update-manifest key. Until then the system runs in
   checksum-only mode.
2. **Extra confirmation on the remote.** Recommendation: none beyond the
   consent dialog, because connecting already grants agent execution. The
   remote's own UI shows a "restarting for an update requested by …" notice. A
   grace period with a local veto is a possible follow-up.
3. **Unstable version format.** Uses `.<run>.g<sha>` instead of `.<sha>`
   ([why](#unstable-version-format)).
4. **Rollback copy size on desktop.** Keeping one previous bundle costs
   several hundred MB. Recommendation: keep it; atomicity was a requirement.
