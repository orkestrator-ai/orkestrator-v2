# Remote host upgrades

Checked against `main` at `eeeca4b3` (2026-10-17).

Remote clients can now maintain the computer running their backend. They can
update Orkestrator on:
- a desktop-hosted backend: the Mac app, or the Linux AppImage;
- a supervised standalone backend (`orkestrator service install`).

They can install an update now or once the host is idle, and cancel it before
the restart. They can also repair the pinned toolchain, follow the newest
`gh`, and pull the release container image. The living reference is
[host-updates.md](../../architecture/host-updates.md). What is left is evidence
from real releases, plus two known limitations.

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

1. A remote-initiated desktop update between two signed releases, on macOS
   and on AppImage, with agents running. Cover each of these:
   - Postpone
   - an unanswered countdown
   - cancel during the countdown and during `waiting-for-idle`
   - the relaunch with a toolchain failure retried without a dialog
   - the iOS shell reconnecting and the backend-served page reloading
2. The standalone service on macOS launchd and on Linux systemd (with
   linger):
   - `service install` from npm
   - a self-update between two published releases
   - a deliberately broken release rolling back
   - a release whose `engines.bun` the service's Bun does not meet
3. `host.image.update` against the GHCR release image, and `host.gh.update`
   `latest` on both platforms (checksums, the zip and tar layouts, the
   `--version` probe).

### Known limitations

4. Environments on an older image are listed in Settings → Machines → Updates,
   not rebuilt. Each still needs
   its own Rebuild (keep work) from its environment menu, because that dialog
   carries the preservation and capacity checks. A bulk "rebuild outdated"
   would need the same review per environment.
5. The restart impact counts every backend-owned terminal, including
   container terminals, which survive in their containers but lose the
   backend's attachment. It does not yet separate the two.
