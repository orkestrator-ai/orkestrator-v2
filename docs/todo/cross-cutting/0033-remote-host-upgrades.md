# Remote host upgrades

Checked against `main` at `93018933` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Remote desktop update between two signed releases**: macOS and AppImage, with agents running; Postpone, unanswered countdown, cancel, toolchain retry, iOS reconnect. Status: open (not started; needs a macOS VM or spare account and a Linux desktop VM).
2. **Standalone service on launchd and systemd**: install from npm, self-update, broken-release rollback, `engines.bun` refusal, linger. Status: partly done (a systemd install from npm reached ready on 2026-10-26; the rest, and all of launchd, not run).
3. **Image and `gh` updates**: `host.image.update` against GHCR and `host.gh.update` `latest` and `pinned` on both platforms. Status: open (the GHCR index was inspected; neither task run).

Items 4 and 5 (per-environment Rebuild… and container terminals in the restart impact) are done and need no analysis beyond task 1 exercising their UI on a real release.

### 1. Remote desktop update between two signed releases

**Problem.** Remote host maintenance ships, but no remote-initiated desktop update has been observed between real signed releases, so the countdown, cancel and relaunch paths are unproven for users who rely on them.

**Context.** D2 (60 s countdown with Postpone; unanswered restarts) and D3 (operator token with `confirm: true`) define the behaviour. The living reference is `docs/architecture/host-updates.md`. Runs must not happen on a machine someone works on, after the [0244](0244-second-backend-on-one-host.md) incident.

**Investigation.** Published releases now run to `v2.33.0-beta` (2026-10-26), each with `alpha-mac.yml`, `beta-mac.yml`, `beta-linux.yml`, the arm64 DMG and zip, and the x86_64 AppImage (`gh release view v2.33.0-beta`). The file's example pair (2.30.0-beta to 2.31.0-beta) predates two relevant fixes: `0a2ea7e3` (#1301), first in `v2.32.0-beta`, made Restart relaunch an AppImage from `$APPIMAGE` rather than the vanished mount (`apps/desktop/electron/relaunch.ts`; the 2026-10-26 SIGTRAP) and replaced the blocking `dialog.showErrorBox` with `restart-prompt.ts`; `77b76c3c` (#1302, items 4 and 5) is also first in `v2.32.0-beta`. The CLI side exists: `--when-idle` maps to `drain` in `packages/cli/src/client/commands/host.ts:321`.

**Decisions.**

- **Which release pair?**
  - **Install `v2.32.0-beta` and update to `v2.33.0-beta`, or the next consecutive pair after that (recommended).**
    - Pros: the starting release already has the AppImage relaunch fix and items 4 and 5, so the run tests the code users now have.
    - Cons: the pair is only one release apart in content; a later pair may be needed once Stable ships.
  - **Use 2.30.0-beta to 2.31.0-beta, as the file suggests.**
    - Pros: matches the documented procedure.
    - Cons: the old release's relaunch path is the one that crashed on 2026-10-26; a failure there would say nothing about current code.
- **Where to run the macOS half?**
  - **A spare user account on a maintainer Mac (recommended).**
    - Pros: real Developer ID signature checks by Squirrel.Mac; no nested virtualisation.
    - Cons: shares the host with the maintainer's own install; a second account has its own data directory, but a second backend on the same host can still take the Control MCP port (0244), so quit the main app first.
  - **A macOS VM.**
    - Pros: fully disposable.
    - Cons: Apple Silicon VMs are limited in number and slow to provision; code-signing behaviour in VMs can differ.

### 2. Standalone service on launchd and systemd

**Problem.** The supervised standalone backend's self-update and rollback have never completed on real releases, and the launchd branch has not run at all.

**Context.** `scripts/qualify-standalone-service.ts` drives all four checks and writes a JSON report; it refuses a host with another Orkestrator unless `--allow-shared-host`, installs with `--skip-start`, and boots with a private HOME and `ORKESTRATOR_CONTROL_MCP_DISABLED=1`.

**Investigation.** The script exists (996 lines) with the options described: `--from` and `--to` defaults 2.30.0-beta and 2.31.0-beta (`scripts/qualify-standalone-service.ts:116`-`:117`), `--broken` default `<to>.990` (`:118`), `--engines-bun` (`:119`), `--engines-to` default 2.30.0-beta (`:121`), `--report` (`:125`), `--allow-shared-host` (`:127`); it branches on `systemd` or `launchd` (`:300`). Unit tests are in `tests/unit/qualify-standalone-service.test.ts`. `mise run build:cli` exists. Its safety guards are first in `v2.32.0-beta`, but the script runs from the checkout, so the release under test does not matter for them.

**Decisions.**

- **Keep the script's default release pair?**
  - **Pass `--from v2.32.0-beta --to v2.33.0-beta` (without the `v`) for the first full run, and update the defaults in the same change that records the evidence (recommended).**
    - Pros: tests the current updater and launcher; the private-registry `.990` broken release works for any prerelease `--to`.
    - Cons: `--engines-to` must still name a release whose `engines.bun` the old Bun fails, which needs checking for the new pair.
  - **Keep 2.30.0-beta to 2.31.0-beta.**
    - Pros: the script's defaults, already reasoned through.
    - Cons: older releases than users now run.
- **What counts as a pass for linger?**
  - **The unit is still active after logging out and in once, recorded in the report (recommended).**
    - Pros: the case users with headless hosts depend on.
    - Cons: a manual step outside the script.
  - **Skip linger and rely on `enable-linger` being set.**
    - Pros: fully scripted.
    - Cons: proves nothing about session teardown.

### 3. Image and `gh` updates

**Problem.** `host.image.update` and `host.gh.update` have not run against real artefacts, so checksum, archive-layout and version-probe handling are unproven.

**Context.** The 2026-10-26 attempt was skipped because the host's disk was 97% full and pulling retags the configured image. The file gives a headless-backend command with a private `--docker-image` tag and the Control MCP disabled.

**Investigation.** The suggested backend command uses `--runtime-flavor agent-test`, which since `0a2ea7e3` also defaults the Control MCP to an ephemeral port (`controlMcpPortOverride`, `apps/backend/src/core/control-mcp-server.ts:103`), so the explicit `ORKESTRATOR_CONTROL_MCP_DISABLED=1` is now belt and braces rather than required. The image is published for linux/amd64 and linux/arm64. macOS covers the `gh` zip layout; Linux the tar layout.

**Decisions.**

- **Run it in the same VMs as tasks 1 and 2, or separately?**
  - **In the Linux VM of task 2, after the service run, and in the macOS account of task 1 for the zip layout (recommended).**
    - Pros: one VM provisioning; each platform's archive layout covered once.
    - Cons: needs at least 15 GB free in the Linux VM on top of the service run.
  - **A separate minimal VM per platform.**
    - Pros: cleaner isolation from the service run.
    - Cons: twice the setup for a short run.
- **Pass condition for `gh latest`?**
  - **`host status --json` shows the newest upstream `gh` under `toolchains/gh-latest/<version>`, marked unqualified, and `host gh pinned --wait` restores the pin (recommended).**
    - Pros: covers both directions and D1's "opt-in and marked unqualified".
    - Cons: depends on a `gh` release existing that differs from the pin on the day.
  - **Only that `gh latest` succeeds.**
    - Pros: quicker.
    - Cons: does not prove the return to the pinned version.

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
