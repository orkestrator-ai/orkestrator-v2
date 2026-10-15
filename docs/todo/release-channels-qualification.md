# Release channels and updates: qualification

Checked against the `release-channels/04-remote-update` stack (#1003, #1004,
#1005, #1007) on 2026-10-15, after its review fixes; not yet on `main`.

Release channels, in-app updates and remote updates are implemented and unit
tested with fakes plus loopback integration tests for electron-updater, Bun
registry staging and real backend process restarts
([release-channels-and-updates.md](../architecture/release-channels-and-updates.md)).
None of it has run against a real release, a signed build, or a real remote.
Every item below needs evidence from a real run before the feature is
announced. Until then, treat in-app updates as unqualified even though they
are on by default for packaged production builds.

## Current state

- **Release tooling.**
  - `release:desktop`, `release:publish`, `publish:cli` and
    `scripts/release-channel-index.ts` are channel-aware and unit tested
    against fake `gh`/`git`/`curl` runtimes.
  - `.github/workflows/release-unstable.yml` and the `workflow_call` path of
    `publish-container.yml` pass `actionlint` but have never run.
  - The one-time setup in `releasing.md` (the `update-channels` prerelease,
    the secrets, tag permissions) has not been done.
- **Desktop updates.**
  - The update host pins electron-updater to the resolved release with a
    generic feed.
  - A loopback generic-feed test uses the installed electron-updater to verify,
    cache, arm, swap and restore a disposable AppImage. Squirrel.Mac staging,
    signed release artifacts and `quitAndInstall(true, true)` still need real
    packaged qualification. The `install-failed` report for an updater error
    after acknowledgement has fake-updater regression coverage.
  - The rollback copy (`ditto` of the `.app`, or a copy of the AppImage)
    and the restore-after-failed-start path have been tested only on a
    temporary directory.
- **Headless supervisor.** A loopback npm registry test stages fixture versions
  with real `bun add`, runs the bundled backend, fails replacement health and
  checks child exit before restoring SQLite, the current package and toolchain
  pointers. It also covers concurrent lock ownership in separate processes.
  Public npm artifacts and the generated systemd/launchd units still need real
  release qualification.
- **Remote updates.** `connections.invokeUpdate`, the `/status` handshake
  and the audit origin have been tested only in process (gateway tests,
  connection-manager tests with fake fetch). No update has been driven over
  Tailscale. `Tailscale-User-Login` has never been observed through a real
  `tailscale serve`.
- **Container image.** The pull, verify and retag path has been tested only
  with a fake Docker runtime.
- **Signing.** The active and standby keys were generated on 2026-10-16 and
  are embedded, so every release must be signed. No release has been signed
  with them yet.

## Review regression validation (2026-10-15)

- `mise run test`, format checking, lint, typechecking, CLI scenarios and
  `actionlint` passed. Focused regression checks also cover command-level armed
  job recovery, persistence failures, overlapping requests, concurrent index
  writers and signed/unsigned channel mixtures.
- `mise run test:agent:electron` did not pass: four UI cases failed, one passed,
  one platform case skipped and six dependent cases did not run. All three
  owning files were rerun individually and still failed. The isolated profiles
  show the **GitHub CLI Not Found** setup dialog, hiding the expected settings
  and project controls; the terminal case also encounters an intercepting overlay.
  These are repeatable fixture/setup failures, not classified as flakes. No
  assertions were skipped or relaxed. Compressed evidence is in
  `/tmp/orkestrator-test-run.tB41l4`, `/tmp/orkestrator-test-run.tP8JiS`,
  `/tmp/orkestrator-test-run.9iTYEp` and `/tmp/orkestrator-test-run.KMkoWO`.
- Browser-renderer, Docker and iOS scenario suites were omitted because this
  change does not edit those areas. Signed macOS/Squirrel, public release and
  remote-machine qualification below remains outstanding. The tests' disposable
  backend processes and profiles were cleaned up by their owning harnesses.

## Outstanding work

### Setup

- **Store the manifest signing keys.** Both were generated and embedded on
  2026-10-16 (#1003). Before #1003 merges, add the active key as the
  `ORKESTRATOR_RELEASE_SIGNING_KEY` Actions secret, put both PEMs in the
  password manager and the standby in an offline backup, then delete the
  local files ([releasing.md](../development/releasing.md#manifest-signing-keys)).
  Without the secret, every release fails at `release:desktop`.

### Qualification

1. **First unstable run.**
   - Do the one-time setup.
   - Dispatch `release-unstable.yml`, then confirm all of these:
     - the release commit and tag;
     - the signed and notarized macOS build (`spctl -a -vv`, `stapler validate`);
     - both Linux builds, including arm64 `fpm`;
     - the prerelease that is never marked latest;
     - `channels.json`;
     - npm `orkestrator@unstable`;
     - the GHCR `unstable` tag without `latest` moving.
   - Re-run it to see the skip on an unchanged `main`.
   - Then fail a build on purpose and confirm the draft and tag are cleaned
     up.
2. **End-to-end desktop update, macOS and Linux AppImage.**
   - Install release N from the download, subscribe to unstable, publish
     N+1, and check:
     - the toast;
     - the indicator;
     - the consent dialog, with a manifest change seeded so it has a
       consent item;
     - download progress, restart, `succeeded` and the notice.
   - Repeat with **Install when I quit**. On macOS, check that arming it
     stages the update (Cancel is then refused) and that quitting installs
     it. On the AppImage, check that quitting swaps the file, and that
     cancelling an armed install means quitting no longer does.
   - Break the install after the host acknowledged it (an update whose
     signature Squirrel.Mac rejects at staging) and check the job ends
     `rolled-back` with `install-failed` while the old version keeps running.
   - Check a stable install of 2.20.x still follows `/releases/latest` and
     ignores the prereleases.
3. **Desktop rollback.**
   - Publish an unstable build whose backend fails to start (for example,
     a migration that throws).
   - Check that the app restores the database snapshot, puts N back,
     relaunches, and reports `rolled-back`.
   - Check the rollback copy is deleted once the new version has started.
   - Check Gatekeeper accepts the restored bundle.
   - Check the new backend has exited before the database is restored, and
     that an AppImage relaunches the restored file.
   - Start the broken version a second time by hand and check it does not
     roll back again (only the first launch after an update may).
4. **Headless supervisor on Linux (systemd) and macOS (launchd).**
   - Run `orkestrator service install -- --tailscale-serve` and start the
     unit.
   - Update from N to N+1 from another machine and check all of these:
     - `bun add` staging and the package-manifest check;
     - the toolchain `current` swap;
     - the health check;
     - pruning;
     - the outcome reported to the new backend.
   - Repeat with a broken N+1 and check the rollback: the database snapshot,
     the toolchain and `current` restored, and the outcome on N.
   - Kill the supervisor mid-cutover and check its recovery.
   - Stop the service mid-cutover and check no backend is left running.
   - Make staging fail at install (remove `versions/<target>` after prepare,
     with the registry unreachable) and check the old backend keeps running.
   - Start from a `bunx` bootstrap and check a rollback restores the staged
     copy of the bootstrap version.
5. **Remote update from the desktop app over Tailscale**, for both a headless
   supervisor and a remote desktop app.
   - Check the Connections row (version, channel, host kind, available
     update).
   - Check the consent dialog's remote wording.
   - Check the client floor: a client below `minClientVersion` is refused.
   - Check progress across the restart.
   - Check the remote's audit entry has the right `tailscaleUser`.
   - Check that a remote desktop app shows who asked for the update, and
     that a headless backend logs it.
6. **macOS permission added by an update.**
   - Ship a build that probes a new permission.
   - Update a remote Mac from another machine.
   - Confirm the action-needed notice on the client, the "New in" label in
     the remote's own permissions screen, and the TCC prompt there.
7. **Published-image machine.**
   - Update a machine running the GHCR image to a release that raises a
     required image capability.
   - Check the pull, the manifest check, the retag at install, and the
     retag back on rollback and on a cancelled install on quit.
8. **Mixed versions.**
   - Drive an older (2.20.x) remote from a new client: version unknown,
     with manual instructions.
   - Drive a new remote from a 2.20.x client: no update UI, nothing breaks.

### Code

9. Clear an `action-needed-on-host` notice automatically once the desktop
   permission probe shows the grant. Today it clears only when acknowledged.
10. Report a crash-loop rollback by the supervisor (a freshly installed
    version that keeps failing after it passed its health check) as a
    notice. Today it is only logged.
11. Give `bun publish` npm provenance once Bun supports it, or publish the
    CLI with npm from CI.

## Constraints and rationale

- Nothing is downloaded before consent, and consent is bound to the
  manifest's bytes (`requirementsSha256`).
- The update job's state and audit log are files, not SQLite, so a
  rollback's database restore cannot erase them.
- Installer commands (`update_host_*`) are accepted only on the loopback
  control listener, and Electron main never forwards them, or the
  `update-host-request` events, from or to a window.
- A failure before `installing` changes nothing. From `installing` on, every
  failure must end in `rolled-back`, or in `failed` with `rollbackFailed`.

## Decisions

The open questions were decided on 2026-10-15; see "Decisions" in the
[design doc](../architecture/release-channels-and-updates.md#decisions). Only
storing the signing keys remains (see Setup).

## Related

- [release-channels-and-updates.md](../architecture/release-channels-and-updates.md)
- [releasing.md](../development/releasing.md)
- [mixed-version-compatibility.md](mixed-version-compatibility.md): the
  `/status` handshake answers its renderer–backend skew question.
- [dependency-upgrades.md](dependency-upgrades.md): electron-builder 27 and
  the update-manifest key.
