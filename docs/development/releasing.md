# Releasing the desktop app

Releases are built on maintainer machines, not in CI: the macOS build on a Mac
and the Linux build on a Linux (Arch/Omarchy) machine. Both upload to one GitHub
release on `orkestrator-ai/orkestrator-v2`, which serves the website download
links and the in-app updater.

## Cutting a release

1. Bump the version in every manifest listed in `AGENTS.md`, regenerate the
   lockfiles, and merge the change through a pull request.
2. On `main`, tag the merge commit `v<version>` (it must equal `package.json`'s
   version) and push the tag: `git tag v2.20.0 && git push origin v2.20.0`.
3. **On the Mac** (Apple Silicon), at the tagged commit:

   ```bash
   mise run release:desktop
   ```

4. **On the Linux machine**, at the same tagged commit:

   ```bash
   mise run release:desktop
   ```

5. From either machine, once both have finished:

   ```bash
   mise run release:publish
   ```

Each `release:desktop` run refuses to continue unless the working tree is clean
and `HEAD` is the pushed `v<version>` tag. It installs dependencies, builds, and
uploads to a **draft** release, so nothing is visible until `release:publish`,
which also refuses to publish unless macOS and Linux artifacts are both present.
Tags with a `-suffix` publish as prereleases, which the updater ignores.

To rehearse a build without uploading or needing the tag, run
`mise run release:desktop -- --no-publish`. Artifacts land in `release/`.

## Machine prerequisites

| Machine | Needs |
| --- | --- |
| Mac | Apple Silicon; a Developer ID Application certificate in the login keychain; notarization credentials in the environment (`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE`). |
| Linux | `mise`, `git`, and `bsdtar` (`sudo pacman -S libarchive`). |
| Both | `gh auth login` (or `GH_TOKEN`) with write access to the repository. |

macOS auto-update only works for builds signed with a Developer ID, which is why
the base config's ad-hoc signing (`mise run package:mac`) is local-only.

## Artifacts

| Platform | Download | Updater feed | Self-updates |
| --- | --- | --- | --- |
| macOS arm64 | `orkestrator-v2-mac-arm64.dmg` (and a `.zip` the updater uses) | `latest-mac.yml` | Yes |
| Linux x64 | `orkestrator-v2-linux-x86_64.AppImage` | `latest-linux.yml` | Yes |
| Arch / Omarchy | `orkestrator-v2-linux-x64.pacman` | | No: reinstall to update |

Filenames carry no version so the website can link a stable URL, for example
`https://github.com/orkestrator-ai/orkestrator-v2/releases/latest/download/orkestrator-v2-mac-arm64.dmg`.
electron-builder names the x64 AppImage `x86_64` and the pacman package `x64`.

## How the in-app updater decides to run

`apps/desktop/electron/auto-update.ts` enables `electron-updater` only when all
of these hold: the app is packaged, the runtime flavor is `production`,
`app-update.yml` exists in the app's resources, and (on Linux) the app runs as an
AppImage. `app-update.yml` is only embedded by the release configs, so local
`package:*` installs never update themselves. Set
`ORKESTRATOR_DISABLE_AUTO_UPDATE=1` to opt out.

It checks 30 seconds after launch and every 6 hours, downloads in the
background, then asks the user to restart. "Later" installs on the next quit.
**Orkestrator AI → Check for Updates…** runs a check on demand.

## Linux and Omarchy

- The AppImage is built with electron-builder's static AppImage runtime
  (`toolsets.appimage` in `package.json`, currently a beta toolset), so it does
  not need `libfuse2`, which a stock Arch install lacks.
- Electron 38+ runs natively on Wayland (Hyprland) by default.
- Building on the Omarchy machine also proves the build there; launch the
  AppImage and the installed pacman package before publishing.
- Docker must be installed on the host: Orkestrator uses it for container
  environments.
- Without a Secret Service keyring (gnome-keyring or KWallet), Electron's
  `safeStorage` falls back to `basic_text`; the connection manager already
  handles that case.

## Not yet covered

- macOS Intel (x64): both Mac builds would write `latest-mac.yml` and overwrite
  each other. Add it by building both architectures in one run.
- Linux arm64 and Windows.
- A real update has not been exercised end to end. Before announcing, ship a
  release, install it from the download, ship the next version, and confirm the
  prompt and restart on both platforms. Prereleases do not count: the updater
  ignores them.
