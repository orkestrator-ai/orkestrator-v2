# Remote host upgrades

Checked against `main` at `93018933` (2026-10-26).

Remote clients can now maintain the computer running their backend. They can
update Orkestrator on:
- a desktop-hosted backend: the Mac app, or the Linux AppImage;
- a supervised standalone backend (`orkestrator service install`).

They can install an update now or once the host is idle, and cancel it before
the restart. They can also repair the pinned toolchain, follow the newest
`gh`, and pull the release container image. The living reference is
[host-updates.md](../../architecture/host-updates.md). The two known
limitations (items 4 and 5) were fixed on 2026-10-26. What is left is
evidence from real releases, which must be collected in a disposable VM or
container (see the 2026-10-26 incident below).

## Decisions (settled 2026-10-16)

- **D1. Dependencies.** Agent CLIs stay pinned and arrive with Orkestrator
  releases. Two reasons: their SDK pins move with them, and OpenCode and Pi
  must equal their SDKs. Only `gh` may follow upstream, opt-in and marked
  unqualified.
- **D2. Local veto.** A remote restart shows a 60 s countdown with Postpone on
  the desktop. An unanswered countdown restarts.
- **D3. Authorization.** The operator token only, with `confirm: true` (CLI
  `--yes`). The `host` capability is never granted to an MCP credential.
- **D4. Support.** These are supported:
  - macOS release builds
  - Linux AppImage
  - backends installed with `orkestrator service install`

  These explain why they cannot update, and what to do instead:
  - `bunx orkestrator` in a terminal
  - git checkouts
  - pacman and `package:*` builds

## Outstanding work

### Qualification

Run all of these in a disposable VM, container or user account, never on a
machine someone works on. Each needs real published releases; none can be
simulated here.

1. A remote-initiated desktop update between two signed releases, on macOS
   and on AppImage, with agents running. Cover each of these:
   - Postpone
   - an unanswered countdown
   - cancel during the countdown and during `waiting-for-idle`
   - the relaunch with a toolchain failure retried without a dialog
   - the iOS shell reconnecting and the backend-served page reloading

   Not started. How to collect it: in a macOS VM (or a spare Mac user
   account) and a Linux VM with a desktop session, install the older of two
   consecutive signed releases (for example 2.30.0-beta, then update to
   2.31.0-beta), start one native agent turn in a fixture environment, then
   from a second machine run `orkestrator host update apply --yes --wait`
   (and `--when-idle` for the idle case). Exercise each bullet in turn.
   Record the job states from `orkestrator host status --json` and the
   desktop dialog. For the toolchain retry, make one pinned tool's download
   fail (block its host in the VM firewall) during the relaunch. For iOS, keep
   the iOS shell connected to that backend through the update.
2. The standalone service on macOS launchd and on Linux systemd (with
   linger):
   - `service install` from npm
   - a self-update between two published releases
   - a deliberately broken release rolling back
   - a release whose `engines.bun` the service's Bun does not meet

   Partly observed on 2026-10-26 on omarchy-hp: `bun x
   orkestrator@2.30.0-beta service install` from npm wrote and loaded a
   systemd user unit, and the backend reached ready (without linger). The
   rest was not run (see the incident). How to collect it:
   `scripts/qualify-standalone-service.ts` runs all four checks
   (cancel during the countdown, a `--when-idle` self-update from
   2.30.0-beta to 2.31.0-beta, a broken `2.31.0-beta.990` served by a private
   registry rolling back, and 2.29.0-beta under Bun 1.4.3 refusing
   2.30.0-beta). In a Linux VM with systemd and a user session:
   `loginctl enable-linger $USER`, install mise and this checkout, then run
   `mise run build:cli` and
   `bun scripts/qualify-standalone-service.ts --engines-bun <path to Bun 1.4.3> --report report.json`.
   Log out and back in once to confirm the unit keeps running with linger.
   Repeat on macOS in a VM or spare user account (the launchd path of the
   script has not been run anywhere yet). Attach each `report.json`.
3. `host.image.update` against the GHCR release image, and `host.gh.update`
   `latest` on both platforms (checksums, the zip and tar layouts, the
   `--version` probe).

   Partly observed on 2026-10-26: the GHCR index for
   `ghcr.io/orkestrator-ai/orkestrator-v2:2.31.0-beta` is published for
   linux/amd64 (67 layers, 1.9 GB compressed) and linux/arm64
   (`docker manifest inspect`, no pull). Neither task was run: omarchy-hp's
   disk was 97% full, and pulling the image retags the configured image. How
   to collect it: in a VM with at least 15 GB free, start a headless backend
   on a private data directory with a private image tag (`bun
   apps/backend/src/main.ts --data-dir <dir> --docker-image
   orkestrator-v2:qualify-0033 --host 127.0.0.1 --allow-non-tailscale-bind
   --port <port> --runtime-flavor agent-test`, with
   `ORKESTRATOR_CONTROL_MCP_DISABLED=1`). Then with the CLI:
   `host image update --wait`, then `host status --json` (image compatible,
   tag moved), `host gh latest --wait` (the tool row shows the newest `gh`
   under `toolchains/gh-latest/<version>`), and `host gh pinned --wait`. On
   macOS the same run covers the zip layout.

### Known limitations (done)

4. ~~Environments on an older image are listed in Settings → Machines →
   Updates, not rebuilt.~~ Done 2026-10-26. Each listed environment now has
   **Rebuild…**, which closes Settings and opens that environment's settings
   on its Container section, on the machine it runs on. There the user runs
   Rebuild (keep work) with its own preservation and capacity checks. This
   follows the item's own constraint: no bulk rebuild, one review per
   environment. Code:
   - `HostDependencySettings` gets `onRebuildEnvironment`, and
     `MachineUpdatesDialog` wires it to `openMachineWorkspace`.
   - The realm dialog `environment-rebuild` (`workspace-realm.ts`) becomes
     `openDialog` → `useAppDialogStore` `{ kind: "environment-settings",
     section: "container" }`.
   - `AppDialogHost` passes `initialSection` to `EnvironmentSettingsDialog`,
     which passes it on as `defaultSection`.

   Tests:
   - `HostDependencySettings.test.tsx`: buttons, and the fallback text without
     a handler.
   - `MachinesSettings.test.tsx`: a registered node's rebuild closes Settings
     and opens that node's realm with `environment-rebuild`.
   - `open-workspace.test.ts`: local and remote.
   - `workspace-realm.test.ts`: parsing needs an environment.
   - `AppDialogHost.test.tsx` and `EnvironmentSettingsDialog.test.tsx`: the
     section reaches the layout.
5. ~~The restart impact counts every backend-owned terminal, including
   container terminals.~~ Done 2026-10-26.
   - `HostRestartImpact.containerTerminals` (optional, a subset of
     `terminals`) counts terminals whose shell runs in a container
     (`TerminalRuntime.containerProcessCount`).
   - The confirmation reads "1 host terminal · 2 container terminals (their
     shells keep running)". An older backend without the field still shows
     "3 open terminals".
   - `orkestrator host status` prints "3 terminals (2 in containers)".

   The claim that a container shell survives was checked on 2026-10-26 with
   Docker on Linux. A `docker exec -it` shell in a throwaway busybox
   container, with a child `sleep`, was still running in `docker top` after
   the client's PTY was closed and the client killed. Tests:
   - `host-maintenance-readers.test.ts`: counts.
   - `HostUpdatesPanel.test.tsx`: wording, old and new.
   - `packages/cli/tests/host-command.test.ts`: CLI line, old and new.

## Incident, 2026-10-26

The standalone-service qualification ran on omarchy-hp beside the live
AppImage install. It is the probable cause of an outage there.

- A test unit (`orkestrator-backend-cc7cd67b`, data directory under `/tmp`)
  booted at 00:58:57.05, and the live backend's event stream closed at
  00:58:57.948.
- The test backend then held the default Control MCP port 34122 until it was
  removed at 09:10:16.
- The live app ran without a backend until it crashed (SIGTRAP) at 09:05:47.
  After it relaunched at 09:07, its Control MCP could not bind.
- At 09:11:12 its NetworkService crashed with SIGBUS. No link to the test
  unit's removal was found.

Every unit, process, temporary directory and Docker resource the test
created was removed; no live data was touched. The bug and the full evidence
are in [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md).
The qualification script now refuses to run beside another Orkestrator, and
gives its units a private HOME and no Control MCP. No further live runs were
made on that host.

## Assumptions and decisions

- **Restart impact shape (item 5).**
  - Options: (a) change `terminals` to mean host terminals only; (b) add an
    optional `containerTerminals` that is a subset of `terminals`; (c)
    replace it with two new fields.
  - Chose (b). Old clients keep a correct total; new clients split it, and
    fall back to the old wording when an old backend leaves the field out.
  - Pros: no mixed-version misreport in either direction. Cons: clients
    subtract to get host terminals, and clamp a bad value.
- **Rebuilding outdated environments (item 4).**
  - Options: (a) keep the list and the instruction text; (b) a bulk
    "rebuild outdated" with one confirmation; (c) a per-environment Rebuild…
    that opens the existing Rebuild (keep work) review.
  - Chose (c). The item itself says each rebuild needs its own preservation
    and capacity review, and (c) reuses that dialog unchanged.
  - Pros: no new destructive path; works for the command node and
    registered nodes. Cons: still one environment at a time; the user
    reopens Updates for the next one.
- **Opening the Container section across machines.**
  - Options: (a) a new realm dialog value `environment-rebuild`; (b) a
    `section` field on realm messages and the URL.
  - Chose (a): a node that predates it drops the unknown dialog and just
    selects the environment, and the parser already validates dialog values.
  - Pros: one validated enum, graceful on old nodes. Cons: the dialog name
    encodes a section; another section would need another value.
- **Live evidence.**
  - Options: (a) manual commands; (b) a repeatable script; (c) leave
    everything open.
  - Chose (b): `scripts/qualify-standalone-service.ts` drives real npm
    releases, a private registry for the broken release, and a second Bun
    for `engines.bun`.
  - After the incident it is safe by default: it refuses a host with another
    Orkestrator unless `--allow-shared-host`, installs with `--skip-start`,
    and boots the unit with a private HOME and Bun cache and
    `ORKESTRATOR_CONTROL_MCP_DISABLED=1`.
  - Pros: the same run on Linux and macOS VMs; evidence as JSON. Cons: never
    completed anywhere yet; the launchd branch is unexercised.
- **The broken release.**
  - Options: (a) publish a broken version to npm; (b) a private registry
    that proxies npm and adds `<to>.990`: the `<to>` tarball with its
    version changed and `serve` exiting at once.
  - Chose (b): nothing is published, and only the test unit's environment
    points at the registry.
  - Pros: exercises the real install, smoke check, restart and launcher
    rollback. Cons: the breakage is synthetic.
- **No image pull on omarchy-hp.** The disk was 97% full and the pull retags
  the configured image, so it was left for a VM with a private
  `--docker-image` tag.

## Related

- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md):
  the Control MCP port and backend exit found by this qualification.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  the batching index for live platform runs.
