# Host maintenance from a remote client

Any client of a backend can maintain the computer running that backend:
- the desktop app
- a browser over the gateway
- the iOS shell
- the `orkestrator` CLI

From there it can:
- check for and install an Orkestrator update, now or once the host is idle,
  and cancel it before the restart;
- choose the host's update channel (Stable, Beta or Unstable);
- repair the pinned agent toolchain;
- switch `gh` to its newest release;
- pull the release container image.

Real-release qualification is still open in
[0033-remote-host-upgrades.md](../todo/cross-cutting/0033-remote-host-upgrades.md).
`scripts/qualify-standalone-service.ts` automates the standalone part. Run it
only in a disposable VM, container or user account: it installs real service
units, and it refuses to start when it finds another Orkestrator on the host.

## Who does what

- **The backend owns the record.** `HostMaintenanceService`
  ([`host-maintenance.ts`](../../apps/backend/src/core/host-maintenance.ts))
  keeps one durable document in the `host-maintenance` store. It holds:
  - the current or last update job
  - a pending check request and the last check
  - the latest dependency task of each kind
  - the pins the next release brings
  - the `gh` channel
  - the update channel

  Every change bumps a revision and emits `host-maintenance-updated` with the
  snapshot. Shared types are in
  [`host-maintenance.ts`](../../packages/protocol/src/host-maintenance.ts).
- **A detailed read adds live readings.** `host.status`, and
  `get_host_maintenance { detail: true }`, add:
  - the restart impact: working and waiting agents, unfinished pipelines,
    terminals and host servers. `containerTerminals` counts the terminals
    whose shell runs in a container (`docker exec`): that shell keeps running
    there, but the backend's attachment ends and the tab opens a new shell
    when the backend is back. The rest are host shells, which end. Backends
    before this field send only `terminals`; clients then show one count
  - each tool's pin, its source (`managed`, `path` or `missing`) and its
    managed version
  - the container image, and the environments still on an older one

  Events never carry these readings.
- **The executor applies updates.** It reports progress through
  `HostMaintenanceService.report`, which ignores reports for another job and
  states that cannot follow the current one. There are two executors:

  | Updater | Who it is | How it reports |
  | --- | --- | --- |
  | `desktop` | The Electron main process ([`host-update-executor.ts`](../../apps/desktop/electron/host-update-executor.ts)). Electron starts the backend with `--desktop-updater` when `isAutoUpdateSupported` holds. | `/__orkestrator/host-updater` (GET the snapshot with the restart impact, POST a report). Only the loopback control listener serves it; the browser listener answers 404. |
  | `standalone` | The backend itself ([`host-standalone-updater.ts`](../../apps/backend/src/host-standalone-updater.ts)). The service launcher passes `--standalone-updater <dataDir>/backend`. | In process: it subscribes to the service. |

  Anything else is `none`. It explains why it cannot update, and gives what
  to do instead.
- **Clients use either of two surfaces:**
  - renderer commands: `get_host_maintenance`, `get_host_restart_impact`,
    `request_host_update_check`, `request_host_update`, `cancel_host_update`,
    `start_host_toolchain_repair`, `start_host_image_update`,
    `set_host_gh_channel`, `set_host_update_channel`
  - public actions: `host.status`, `host.update.check`, `host.update.apply`,
    `host.update.cancel`, `host.update.channel`, `host.toolchain.repair`, `host.image.update`,
    `host.gh.update`

  `host.update.apply` requires `confirm: true`. The CLI passes it only with
  `--yes`. `host.gh.update` is in the `always`-confirm class. The `host`
  capability must never be granted to a Control MCP credential.

## The update channel

`updateChannel` is `stable`, `beta` or `unstable`
([releasing.md](../development/releasing.md#update-channels) has how releases
map to them). A channel also installs every more stable channel's releases.

- **Default.** On its first start, a host records the channel of the release it
  runs, so a beta install that later updates to a stable release stays on Beta.
- **Switching.** `orkestrator host update channel stable|beta|unstable` uses
  `host.update.channel`; `host status` prints the selected channel.
  `set_host_update_channel` is refused with `busy` while an
  update job is active. It drops the last check and the next release's pins.
  When the host can update, it also files a check request, so the executor
  checks the new channel at once.
- **Desktop.** The executor passes the channel from every snapshot to the
  app's updater before it handles that snapshot's check request. Checks and
  downloads are serialized; a channel switch waits for an old operation, then
  queries the new channel and acknowledges only that result. The GitHub
  provider sorts public releases by version before applying channel filters,
  so publication order cannot hide a newer eligible prerelease.
- **Standalone.** A check reads the npm dist-tags of the channel and every
  more stable one (`latest`, `beta`, `alpha`) and takes the newest. Each
  release moves only its own tag, so a stable release newer than the last beta
  still reaches Beta.
- **No downgrades.** Neither executor installs an older version, so moving to
  a more stable channel keeps the running version until that channel
  overtakes it.

## An update

1. A client asks for an update with `drain: now`, or with `when-idle` and a
   `maxWaitSeconds` from 60 to 86,400 (default 3,600). The request is refused:
   - with `busy` while another job is active;
   - with `capability-unavailable`, and a reason, when there is no updater or
     the desktop executor has not reported `ready`.
2. **The executor stages the release:**
   - **Desktop:** `stageForRemote` in
     [`auto-update.ts`](../../apps/desktop/electron/auto-update.ts) reuses a
     downloaded update, or checks and downloads one. It suppresses the
     Restart / Later prompt for that version.
   - **Standalone:**
     1. `installRelease` runs `bun install orkestrator@<version>` into
        `<dataDir>/backend/releases/<version>`. Bun checks the registry's
        integrity hash.
     2. The release's `engines.bun` must accept the service's recorded Bun.
     3. `bin/orkestrator.js --version` must print the version.
     4. The release's `toolchain install` runs before any downtime.

   The job fails, without restarting, in either of these cases:
   - Nothing newer exists.
   - A required version is not the newest release.
3. **Waiting for idle (`when-idle`).** The job reports `waiting-for-idle` and
   polls the restart impact. It goes on when no agent turn or pipeline is
   running (`isHostIdle`), or when `idleDeadline` passes. Unreadable activity or
   pipeline snapshots keep waiting. Unknown agent activity (including terminal
   agents in inactive environments) keeps the host busy; paused pipelines do not.
4. **The countdown.** The job reports `awaiting-restart` with a `restartAt`
   60 seconds ahead.
   - **Desktop:** a dialog offers Restart Now or Postpone. An unanswered dialog
     restarts. Postpone ends the job as `postponed`, and the update installs at
     the next quit. With no window open, a notification replaces the dialog.
   - **Standalone:** nobody is at the host, so the countdown is the window in
     which a client may still cancel.
5. **Cancel.** `cancelUpdate` is allowed in `requested`, `downloading`,
   `waiting-for-idle` and `awaiting-restart`.
   - Both executors stop at their next step, and an open countdown closes.
   - A download already running finishes. The staged update then installs at
     the next ordinary quit, like any background update.
6. **The restart.** The executor reports `restarting`, and installs only after
   the backend has recorded it.
   - **Desktop:**
     1. It writes `remote-update-relaunch.json` in the data directory.
     2. On Linux it first drains the backend (with forced termination after
        20 s), then releases the single-instance lock. AppImage's updater can
        spawn its replacement before the old process exits.
     3. It calls `quitAndInstall(true, true)`, which relaunches on AppImage too.
     4. `registerBackendShutdown` holds `will-quit` until the backend has
        drained and exited, for at most `BACKEND_EXIT_WAIT_MS` (20 s).
   - **Standalone:**
     1. It copies the release's launcher into place.
     2. It moves `previous` to the old release and `current` to the new one.
     3. It writes `restart-requested`.
     4. It shuts the backend down.
7. **Settling.** After publishing readiness, the next backend settles the job from evidence, and
   never resumes it. Standalone settlement requires its instance descriptor,
   which is what the launcher observes:

   - The expected new version is running: `succeeded`.
   - Another version is running: `failed`.
   - The launcher rolled this job's target release back after its request: `failed`, with that reason.
   - The same version is running: `failed`.

   Public job and task outcomes are retained by ID until their operation receipts
   durably settle. The latest displayed record can be replaced without losing an
   earlier receipt's evidence; capacity refuses admission rather than evicting it.

   An update installed by an ordinary quit during the countdown also ends
   `succeeded`.

The public operation of `host.update.apply` stays `running`, with the job's
state as its stage, until the reconciler in
[`actions-host.ts`](../../apps/backend/src/core/public-api/actions-host.ts)
finds the job finished. `postponed` and `failed` settle as failed;
`cancelled` settles as cancelled. `orkestrator host update apply --yes
--wait` follows the operation through the restart. It tolerates connection
failures, the shutdown error and a proxy's non-JSON 502 while the backend is
away.

### Relaunch with nobody watching (desktop)

`remote-update-relaunch.json` ([`remote-relaunch.ts`](../../apps/desktop/electron/remote-relaunch.ts))
is valid for 15 minutes. While it is valid:
- **Toolchain setup** retries ten times, 30 s apart, before it shows its
  Retry / Quit dialog.
- **A Local backend that exits** relaunches the app, at most twice, instead of
  showing a blocking error box.

The backend re-enables the managed web client and Tailscale Serve from config
when it starts, so remote access returns with the backend.

## Standalone service

`orkestrator service install [--release V] [--yes] [-- <serve args>]`
([`service.ts`](../../packages/cli/src/client/commands/service.ts)) sets up
the service:
0. With no serve arguments, an interactive terminal, human output and no
   `--yes`, it asks how clients will connect
   ([`service-setup.ts`](../../packages/cli/src/client/service-setup.ts)):
   - Tailscale Serve (`--tailscale-serve`, optionally `--allowed-origins` for
     orkestrator.dev, and `--tailscale-bin` when the CLI cannot be found)
   - the tailnet address over HTTP (no flags)
   - SSH only (`--loopback-client-port 34125`); the Tailscale choices can add
     it too

   It then prints the equivalent `--yes -- <serve args>` command and asks for
   confirmation. Passing any serve arguments, `--yes` or `--output json`
   skips the questions.
1. It installs the release.
2. It points `current` at the release.
3. It copies `bin/orkestrator-launcher.js` to `<dataDir>/backend/launcher.js`.
4. It records the Bun running the command, and the serve arguments, in
   `service.json`.
5. It writes and loads the service unit:
   - macOS: a launchd LaunchAgent, `ai.orkestrator.backend[-<hash>]`, with
     `KeepAlive`.
   - Linux: a systemd user unit, `orkestrator-backend[-<hash>].service`, with
     `Restart=always`.

   Logs go to `<dataDir>/backend/logs/service.log`. `--dry-run` shows the
   plan; `--skip-start` writes the unit without loading it.
6. It waits (`--timeout`, default 3m; `0` skips it) for a new backend
   generation to publish `backend-instance.json`, then prints the browser
   address and the gateway token. The token appears only in human output on
   this terminal. `--output json` reports `ready`, `browserUrl` and
   `authFile`, never the token, and the backend still logs only the token
   file's path. A backend that is not ready in time does not fail the
   install; the command points at the log instead.

A service for a second data directory on a computer that already runs
Orkestrator gets its own unit, but it still shares the user's HOME and binds
the default Control MCP port (34122) whenever that port is free. See
[0244-second-backend-on-one-host.md](../todo/cross-cutting/0244-second-backend-on-one-host.md).

`service status` reports:
- the unit, and whether it is running
- the current and previous releases
- the last ready version
- the last rollback

`service uninstall [--purge]` removes the unit (and, with `--purge`, the
releases). The layout is in
[`standalone-service.ts`](../../packages/protocol/src/node/standalone-service.ts).

The launcher works like this:
1. It runs the release's `toolchain install`.
2. It starts `serve` with `--data-dir` and `--standalone-updater`.
3. A release is ready when `backend-instance.json` names its process and
   version.
4. A newly activated release that has not become ready gets two boots. After
   that, the launcher points `current` back at `previous` and records the
   rollback in `launcher-state.json`. A child still alive at its boot deadline is
   sent SIGTERM, then SIGKILL after a bounded grace period, before another boot.
5. When the backend exits after `restart-requested`, the launcher starts the
   new `current` at once.
6. SIGTERM and SIGINT are passed to the backend, and the launcher exits with
   the backend's status.

## Dependencies

| Task | What it does | Takes effect |
| --- | --- | --- |
| `toolchain-repair` | Reinstalls missing or corrupt pinned binaries through the shared manager, under its install lock. A desktop-hosted backend leaves `bin/current` alone; a standalone one moves it. | At once when the set is unchanged. `restartRequired` when the enabled platforms changed. |
| `image-update` | Pulls `ghcr.io/orkestrator-ai/orkestrator-v2:<backend version>`, requires `compatible`, and tags it as the configured image. Lists environments whose container runs another image. Also started (or joined) automatically by `ensureEnvironmentImage` when a container create finds the default image missing, before it takes an admission slot; a custom `--docker-image` is never pulled. The Docker dialog's image panel offers the same download. | New environments. Rebuild existing ones from their environment menu. |
| `gh-update` | `latest`: downloads the newest `gh` release, checks it against GitHub's published `gh_<v>_checksums.txt`, probes `--version`, and installs it under `toolchains/gh-latest/<v>`. `pinned`: goes back to the managed pin. Unqualified. | At once (`setManagedGitHubCli`). Re-applied at startup from the stored channel. |

- **One task of each kind runs at a time.** A task that a restart cuts short is
  marked failed at startup.
- **The next release's pins.** After a check finds a newer release, the backend
  fetches that release's `toolchain-pins.json` asset, which
  [`release-desktop.ts`](../../scripts/release-desktop.ts) uploads with every
  build. It shows the asset as `nextRelease`. Newer agent CLIs arrive with that
  release: they are tied to the SDK pins
  ([upgrade-agents.md](../development/upgrade-agents.md)).
- **The managed `claude` stays on its pin.** The managed `claude` the host
  starts (bridge sessions, catalogue refresh, tmux tabs) runs with
  `CLAUDE_PINNED_RUNTIME_ENV`: `DISABLE_AUTOUPDATER=1`, plus
  `FORCE_AUTOUPDATE_PLUGINS=1` so the user's plugins still update. A `claude`
  on PATH is the user's own and is left alone.

## UI

**Settings → Machines** lists every machine; a machine's **Updates** button
turns red when its Orkestrator has an update, an agent tool is missing,
unmanaged or off its pin, or its container image is incompatible
([`machine-list.ts`](../../apps/web/src/components/settings/machines/machine-list.ts)
`maintenanceIssues`). The button opens that machine's updates
([`MachineUpdatesDialog.tsx`](../../apps/web/src/components/settings/machines/MachineUpdatesDialog.tsx),
[`HostUpdatesPanel.tsx`](../../apps/web/src/components/settings/HostUpdatesPanel.tsx),
[`HostDependencySettings.tsx`](../../apps/web/src/components/settings/HostDependencySettings.tsx)),
which shows:
- the running and newest versions, the update channel, and the updater;
- the job, with Cancel;
- the confirmation, with the restart impact and the wait-until-idle choice;
- the tools table, with the next release's pins and Repair;
- the `gh` channel switch;
- the image, with its outdated environments and Pull. Each outdated
  environment has **Rebuild…**, which closes Settings and opens that
  environment's settings on its Container section, on the machine it runs on
  (`openMachineWorkspace` with the `environment-rebuild` dialog). There the
  user runs Rebuild (keep work), which checks preservation and space for that
  environment. There is deliberately no bulk rebuild. A node older than this
  dialog ignores it and only selects the environment.

Commands for the command node go over the portal channel; commands for a
registered node go through it with `invoke_on_node`, so a client can update
any machine the command node controls. `useMachineMaintenance` follows the
command node's own `host-maintenance-updated` events and rehydrates on every
reconnect; another node's events stay on that node, so its snapshot is read
every few seconds while an update or task runs and every 20 seconds
otherwise. Both ignore older revisions and re-read the live readings when a
task finishes. `useHostMaintenance` does the same for the window's own
backend, for the banner.

`HostUpdateBanner` shows a running update on every client, with Cancel. Once
the host is back on the new version (within ten minutes of the update), it
reloads a page served by that backend, once. `BackendVersionReminder` offers
**Update backend** for an older backend whose host can update itself.

## CLI

`orkestrator host` has these commands:
- `status`
- `update check [--wait]`
- `update apply --yes [--release V] [--when-idle [--max-wait D]] [--wait]`
- `update cancel`
- `toolchain repair [--wait]`
- `image update [--wait]`
- `gh latest|pinned [--wait]`

`orkestrator service install|uninstall|status` manages the standalone service.
See [public-cli.md](public-cli.md).
