# Releasing the desktop app

Releases are built on maintainer machines, not in CI: the macOS build on a Mac
and the Linux build on a Linux (Arch/Omarchy) machine. Both upload to one GitHub
release on `orkestrator-ai/orkestrator-v2`, which serves the website download
links and the in-app updater.

## Update channels

Each host chooses the releases it updates to in **Settings → Machines →
Updates → Channel**. The version's suffix decides which channel a release ships to:

| Channel | Version | Example | Installed by |
| --- | --- | --- | --- |
| Stable | no suffix | `2.23.0` | everyone |
| Beta | `-beta` | `2.23.0-beta` | Beta and Unstable hosts |
| Unstable | `-alpha` | `2.24.0-alpha` | Unstable hosts |

A numbered suffix (`-beta.2`) works too. It is only needed for a second
prerelease of the same version, because a published version can never be
reused. Any other suffix, such as `-rc.1`, is refused by every release command.

Each suffix also names the release's updater feed (`latest-mac.yml`,
`beta-mac.yml`, `alpha-mac.yml`) and its npm dist-tag (`latest`, `beta`,
`alpha`). A prerelease is published as a GitHub prerelease and never marked
"Latest", so the website's download links keep serving the stable release.
`bunx orkestrator` likewise only installs `latest`; try a prerelease with
`bunx orkestrator@beta`.

## Cutting a release

1. Set the version, then merge the change through a pull request. The suffix
   picks the channel (see above):

   ```bash
   mise run release:version -- 2.23.0-beta
   ```

   It writes every manifest listed in `AGENTS.md`, regenerates and verifies
   both lockfiles with the pinned Bun, and runs the version drift test. It
   refuses a suffix no channel ships and versions older than the current one.
   If a lockfile step fails after the manifests are written, rerun the same
   target to repeat the install and verification steps. A same-target retry
   requires every manifest to already match.
2. **On the Mac** (Apple Silicon), check out `main` at the merge commit:

   ```bash
   mise run release:desktop
   ```

3. **On the Linux machine**, at the same commit:

   ```bash
   mise run release:desktop
   ```

4. From either machine, once both have finished:

   ```bash
   mise run release:publish
   ```

Every command first prints the channel it releases to, for example
`Releasing v2.23.0-beta to the Beta channel: Beta and Unstable users.`

The first `release:desktop` run creates the `v<version>` tag on `HEAD` and
pushes it. It refuses unless the working tree is clean and `HEAD` is already on
`origin/main`. The second machine finds the tag and only checks that it points
at its `HEAD`. Either run refuses when the tag already names another commit,
locally or on origin. Pushing the tag also starts the container image workflow.

Packaged builds ship the preview worker pin checked in at
`docker/artifact-preview-worker/published-image.json`. If the
`publish-preview-worker` workflow has an open pin pull request, merge it
before step 2; otherwise the backend build prints `Preview worker: no
published image for build context …` and installs of this release build the
worker image locally instead of pulling it (safe, only slower). See
[Preview worker](../architecture/transcript-artifacts-runtime.md#preview-worker).

Each run installs dependencies, builds, and uploads to a **draft** release, so
nothing is visible until `release:publish`. Publishing refuses unless the macOS
and Linux artifacts and their channel's updater feeds are present: for a beta,
`beta-mac.yml` and `beta-linux.yml` (x64) or `beta-linux-arm64.yml` (arm64).
macOS builds replace every generated macOS channel feed in the draft with a
Darwin 22 minimum; publication downloads those feeds and verifies the floor
before making the draft public.

Every build also uploads `toolchain-pins.json`, with the agent CLI and `gh`
pins of the release. A running Orkestrator reads it after a check to show what
an update would change. Before it makes a release public, `release:publish`
runs `mise run publish:cli`. That publishes the `orkestrator` npm package at
the same version under the channel's dist-tag, so standalone services and
desktop apps update to the same release. The step is skipped when the version
is already on npm. Pass `mise run release:publish -- --skip-npm` to leave npm
alone.

`bun publish` asks for npm web authentication on every publish, even when
`npm whoami` succeeds. It prints an `https://www.npmjs.com/auth/cli/...` URL
and polls until someone approves it in a browser. It does not need a TTY. If
nobody approves within about five minutes, it fails with
`404 Not Found: .../-/v1/done` and nothing is published. An agent should:

- start `mise run release:publish 2>&1; echo "EXIT=$?"` as a background task;
- wait for the auth URL with a bounded poll of the output, for example
  `for i in $(seq 1 80); do grep -qE 'npmjs.com/auth|EXIT=' "$F" && break; sleep 3; done`;
- give the URL to the user straight away, and wait for `EXIT=` with another
  bounded poll or by ending the turn. A worker under an Orkestrator coordinator
  sends the URL to the coordinator and ends its turn at once, because mail sent
  mid-turn is held until the turn ends.

Do not pipe input into the command (such as `sleep 900 | mise run
release:publish`). The pipeline outlives the publish, so `EXIT=` is not written
until the input command ends. An unbounded foreground `until grep ...` loop
then blocks the agent's turn until the tool timeout.

After publishing a Stable release, check the register in
[version-compatibility.md](../architecture/version-compatibility.md#register)
for compatibility paths whose removal condition the moving floor has now met,
and tell their owners.

To rehearse a build without uploading or needing the tag, run
`mise run release:desktop -- --no-publish`. Artifacts land in `release/`.
The local signed `package:release` task also sets `--publish never`, including
when a GitHub token is available.

## Machine prerequisites

| Machine | Needs |
| --- | --- |
| Mac | Apple Silicon; a Developer ID Application certificate in the login keychain; notarization credentials. By default `release:desktop` uses the `orkestrator-notary` keychain profile (`xcrun notarytool store-credentials orkestrator-notary --apple-id <id> --team-id <team>`); setting `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE` overrides it. |
| Linux | `mise`, `git`, and `bsdtar` (`sudo pacman -S libarchive`). |
| Both | `gh auth login` (or `GH_TOKEN`) with write access to the repository. |

macOS auto-update only works for builds signed with a Developer ID, which is why
the base config's ad-hoc signing (`mise run package:mac`) is local-only.

## Artifacts

| Platform | Download | Updater feed | Self-updates |
| --- | --- | --- | --- |
| macOS arm64 | `orkestrator-v2-mac-arm64.dmg` (and a `.zip` the updater uses) | `<channel>-mac.yml` | Yes |
| Linux x64 | `orkestrator-v2-linux-x86_64.AppImage` | `<channel>-linux.yml` | Yes |
| Linux arm64 | `orkestrator-v2-linux-arm64.AppImage` | `<channel>-linux-arm64.yml` | Yes |
| Arch / Omarchy | `orkestrator-v2-linux-x64.pacman` | | No: reinstall to update |

`<channel>` is `latest`, `beta` or `alpha`.

Filenames carry no version so the website can link a stable URL, for example
`https://github.com/orkestrator-ai/orkestrator-v2/releases/latest/download/orkestrator-v2-mac-arm64.dmg`.
electron-builder names the x64 AppImage `x86_64` and the pacman package `x64`.
On arm64 it names the AppImage `arm64` and the pacman package `aarch64`.
The Linux release config provides pacman's maintainer and project homepage
metadata without changing the local packaging configuration.

## How the in-app updater decides to run

`apps/desktop/electron/auto-update.ts` enables `electron-updater` only when all
of these hold: the app is packaged, the runtime flavor is `production`,
`app-update.yml` exists in the app's resources, and (on Linux) the app runs as an
AppImage. `app-update.yml` is only embedded by the release configs, so local
`package:*` installs never update themselves. Set
`ORKESTRATOR_DISABLE_AUTO_UPDATE=1` to opt out.

It checks 30 seconds after launch and every 6 hours, downloads in the
background, then asks the user to restart. "Later" installs on the next quit.
**Orkestrator AI → Check for Updates…** (**Help → Check for Updates…** on
Windows and Linux) runs a check on demand.

The updater follows the host's update channel, which the Local backend records.
Stable reads GitHub's "Latest" release. Beta and Unstable scan the releases
feed: Beta takes the newest stable or beta release, and Unstable the newest of
any. A stable release has only `latest-*.yml`, which electron-updater falls
back to from any channel. Downgrades are never allowed, so a host moved to a
more stable channel stays on its version until that channel overtakes it. An
update already downloaded from the previous channel still installs on quit.

GitHub's releases feed lists only the most recent releases (about ten), and Beta
skips alphas, so a run of alphas could push every release Beta accepts off the
feed. To prevent that, `release:publish` for an alpha turns every older
published alpha back into a draft, so only one alpha is ever public. A hidden
alpha keeps its tag, assets, npm version and container image; publish its
draft again to bring it back. If hiding fails, the new alpha is still public
and the command only warns; make the older alphas drafts on GitHub by hand.

Remote clients can also check and install through **Settings → Machines →
Updates**,
`orkestrator host update`, or the `host.*` public actions. The app then shows a
60-second countdown instead of the Restart / Later prompt. See
[host-updates.md](../architecture/host-updates.md).

## Minimum macOS version

Electron 44 dropped macOS 12 (Monterey) and Electron 45 keeps that floor, so
the app requires macOS 13 (Ventura) or later.
`build.mac.minimumSystemVersion` (`13.0`) writes `LSMinimumSystemVersion` into
the app's `Info.plist`, so macOS refuses to open it on Monterey with its
standard "can't use this version" message instead of the app crashing at
launch. Raise it when an Electron upgrade raises the floor.

electron-builder 26 does not copy this floor into `latest-mac.yml`.
`scripts/mac-update-feed.ts` adds `minimumSystemVersion: '22.0.0'` (the Darwin
kernel version for macOS 13) to all generated macOS channel feeds after the
draft build. `release:desktop` uploads these replacements, and `release:publish`
validates the actual uploaded feeds before publication, refusing an ungated
draft left by an old or interrupted build. Existing Electron 42 clients on
Darwin 21 therefore skip the update and keep their working app; Darwin 22 may
accept it. Update both the plist floor and feed floor when support changes.

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

- macOS Intel (x64): both Mac builds would write the channel's `-mac.yml` feed
  and overwrite each other. Add it by building both architectures in one run.
- Linux arm64 packaging has been validated with a no-publish build producing
  both targets; launching those packages and applying a real update remain
  unverified. Windows releases are not yet covered.
- A real update has not been exercised end to end. Before announcing, ship a
  release, install it from the download, ship the next version, and confirm the
  prompt and restart on both platforms. A Stable host ignores prereleases, so
  test those from a Beta or Unstable host.
