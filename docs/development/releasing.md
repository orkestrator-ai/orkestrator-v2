# Releasing the desktop app

Releases are built on maintainer machines, not in CI: the macOS build on a Mac
and the Linux build on a Linux (Arch/Omarchy) machine. Both upload to one GitHub
release on `orkestrator-ai/orkestrator-v2`, which serves the website download
links and the in-app updater.

## Pending release note: gateway port migration

Include this note in the next release containing the gateway port fix:

Only the backend using the platform default data directory now defaults to
port 34121. A service using a custom `--data-dir` without `--port` chooses a free
port on each start. This affects both secondary services and a sole backend on
a remote host when it uses a custom data directory. Existing service arguments
are retained during self-update, so saved direct tailnet addresses such as
`http://100.x.y.z:34121` can stop connecting after the update.

Before updating, arrange host-side access (for example SSH), choose an available
port other than 34121 or 34122, and reinstall the service with the same data
directory and connection flags plus `-- --port PORT`. For example, a direct
tailnet service can run:

```bash
bunx orkestrator service install --data-dir /path/to/data --yes -- --host 100.x.y.z --port 45000 --strict-gateway-port
```

Use the host's actual tailnet address and an available port. Preserve any other
serve flags from the existing unit. Update saved remote connections to the new
address printed by the installer. The default data directory keeps 34121;
explicit port settings remain respected. If updating has already disconnected
the client, perform the same steps on the host.

New secondary Tailscale Serve installs automatically choose a persistent strict
port. Older Serve units also recover an owned stale root across an unclean
restart, using durable ownership or their last instance descriptor; their
tailnet HTTPS URL stays the same. Unknown or foreign Serve targets remain
conflicts and require host-side inspection. Development Electron launches now
use a free browser port and log the bound URL.

## Pending release note: other machines' workspaces open in the window

Include this note in the next release containing plan items 6001 and 6002:

Another machine's workspace now opens directly in the window, in the window's
own tree, on desktop, in a browser and in the iOS app, instead of in a separate
workspace view. Its work keeps running when you switch between machines.

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

`install.sh` on the website runs one stated Stable release rather than an npm
tag, so a bad publish does not reach it until someone moves the pin (step 5
below). It runs that release from the lockfile the release publishes
(`resources/release-runtime/`), the way the standalone service installs an
update, and a host without Bun gets the `mise.toml` Bun checked against stated
SHA-256s; a Bun bump moves those (see
[upgrade-agents.md](upgrade-agents.md)). Beta and Unstable users pick their own
release:

```bash
curl -fsSL https://orkestrator.dev/install.sh | ORKESTRATOR_INSTALL_VERSION=alpha bash
```

`alpha` and `beta` are moving tags, so that command takes the same risk as
`bunx orkestrator@alpha`. A host started on a prerelease defaults to that
prerelease's channel. A host already installed from the pinned release moves
with `orkestrator host update channel unstable` or **Settings → Machines →
Updates → Channel**, then updates as usual.

## Cutting a release

1. Set the version, then merge the change through a pull request. The suffix
   picks the channel (see above):

   ```bash
   mise run release:version -- 2.23.0-beta
   ```

   It first checks that the contract manifest is current (`contract:check`'s
   drift check), then writes every manifest listed in `AGENTS.md`, regenerates
   and verifies both lockfiles with the pinned Bun, runs the version drift
   test, and writes the release's contract snapshot
   (`packages/protocol/contracts/releases/<version>.json` and any new
   `contracts/domains/` blob) with its `releases/index.json` entry. The index
   also picks up the publication times of releases GitHub has published since
   (read-only `gh release list`; without `gh` it warns and leaves them). Commit
   `packages/protocol/contracts/` with the manifests. A published release
   without a snapshot is reported; `mise run contract:backfill` writes it. It
   refuses a suffix no channel ships and versions older than the current one.
   If a lockfile step fails after the manifests are written, rerun the same
   target to repeat the install and verification steps. A same-target retry
   requires every manifest to already match.
2. **On the Mac** (Apple Silicon), check out `main` at the merge commit:

   ```bash
   mise run release:desktop
   ```

3. **From the same Mac**, at the same commit, start the Linux build on the
   Linux builder (it can run alongside step 2):

   ```bash
   mise run release:linux -- build
   ```

   It runs `release:desktop` on the builder over SSH; see
   [Linux build from the Mac](#linux-build-from-the-mac). An agent cutting a
   release runs this itself rather than asking the maintainer to.

4. From either machine, once both have finished:

   ```bash
   mise run release:publish
   ```

   With an npm token stored (see [npm authentication](#npm-authentication))
   this needs no one at the keyboard. Without one it needs a single browser
   approval, and a desktop notification says when.

5. After a **Stable** release only, pin the installer to it and merge the change
   through a pull request:

   ```bash
   mise run release:pin-installer
   ```

   It stamps the version from `package.json` into
   `apps/web-public/public/install.sh`. It refuses a prerelease, a version older
   than the current pin, and one npm does not have, because a pin to an
   unpublished version would break every install. Do not move the pin in the
   version bump: the hosted site follows `main`, so that merge would go live
   before the release exists on npm. Until this merge reaches the site, the
   installer keeps running the previous Stable release, and hosts update
   themselves from there. Confirm the deploy with
   `curl -fsSL https://orkestrator.dev/install.sh | grep PINNED_RELEASE`.

Every command first prints the channel it releases to, for example
`Releasing v2.23.0-beta to the Beta channel: Beta and Unstable users.`

The first `release:desktop` run creates the `v<version>` tag on `HEAD` and
pushes it. It refuses unless the working tree is clean and `HEAD` is already on
`origin/main`. The second machine finds the tag and only checks that it points
at its `HEAD`. Either run refuses when the tag already names another commit,
locally or on origin. Pushing the tag also starts the container image workflow.

The preview worker needs no release step: packaged builds ship its build
context, and each install builds the worker image locally when it is first
prepared. See
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

The package carries the lockfile standalone services install its dependencies
from (`packages/cli/release-runtime/`, copied to
`resources/release-runtime/`). It only changes when someone regenerates it, so
the versions a release ships are in the diff that changed them, and
`mise run smoke:cli` installs and runs them before each publish. Regenerate it
with `bun packages/cli/scripts/lock-bridge-runtimes.ts` after changing a
dependency of `packages/cli`, or to take a transitive security fix;
`packages/cli/tests/cli.test.ts` fails when it no longer matches the package.

### npm authentication

`publish:cli` (`scripts/publish-cli.ts`) authenticates in one of two ways.

**A stored token (no browser step).** Create a granular access token on
npmjs.com with read and write access to the `orkestrator` package only and
"Bypass two-factor authentication" ticked, then store it on the machine that
runs `release:publish`:

```bash
mkdir -p ~/.config/orkestrator-release
# Paste the token, then Ctrl-D. Nothing else may be in the file.
cat > ~/.config/orkestrator-release/npm-token
chmod 600 ~/.config/orkestrator-release/npm-token
```

The script passes it to `bun publish` as `NPM_CONFIG_TOKEN` and prints only the
file's path. It refuses a file that other users can read. An exported
`NPM_CONFIG_TOKEN` (or `BUN_CONFIG_TOKEN`) takes precedence, and
`ORKESTRATOR_NPM_TOKEN_FILE` moves the file. npm caps a write token's lifetime,
so renew it when it expires. When npm rejects the stored token (a 401, or a 403
naming the token, two-factor authentication or a missing permission), the
script says so and publishes once more without it, through the browser approval
below; any other failure, such as republishing an existing version, is not
retried. An exported token npm rejects is only reported. A stored token is a long-lived publish credential on a
workstation, the risk to-do
[5021](../todo/cross-cutting/5021-publish-npm-from-ci-with-provenance.md)
proposes removing by publishing from CI; keep it scoped to this one package.

**Browser approval (no token).** `bun publish` then asks for npm web
authentication on every publish, even when `npm whoami` succeeds. It prints an
`https://www.npmjs.com/auth/cli/...` URL and polls until someone approves it in
a browser; after about five minutes it fails with
`404 Not Found: .../-/v1/done` and nothing is published. The script watches for
that URL and, the moment it appears:

- shows a desktop notification ("npm publish is waiting for you"), through
  `osascript` on macOS or `notify-send` on Linux, and rings the terminal bell;
- prints the URL in a banner;
- on macOS, opens it in the default browser, so approving is one click.
  `ORKESTRATOR_RELEASE_OPEN_APPROVAL=0` keeps the browser closed; `=1` opens it
  on Linux too.

If the link expires unapproved, the script asks again with a fresh link and a
new notification, up to `ORKESTRATOR_NPM_AUTH_ATTEMPTS` attempts (default 3).
An expired sign-in publishes nothing, so a retry cannot publish twice. Any
other failure is not retried.

An agent running `release:publish` without a token should:

- start `mise run release:publish 2>&1; echo "EXIT=$?"` as a background task;
- wait for the auth URL with a bounded poll of the output, for example
  `for i in $(seq 1 80); do grep -qE 'npmjs.com/auth|EXIT=' "$F" && break; sleep 3; done`;
- give the URL to the user straight away (the desktop notification has already
  fired on the publishing machine), and wait for `EXIT=` with another bounded
  poll or by ending the turn. A worker under an Orkestrator coordinator sends
  the URL to the coordinator and ends its turn at once, because mail sent
  mid-turn is held until the turn ends. A retried attempt prints a new URL;
  pass that on too.

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

## Website release summaries

The public website's Releases page (`/releases`, `apps/web-public`) shows the
five most recent published releases in plain language. It renders the
committed file `apps/web-public/src/releases-data.ts` and never calls the
GitHub API, so the page only changes when that file does. After publishing a
release:

1. Read the notes with `gh release list --limit 6` and `gh release view <tag>`.
   When they are empty or thin, use `git log --oneline <previous-tag>..<tag>`
   and `gh pr view <number>` for the changes users would notice.
2. Add the release at the top of `RELEASES` and remove the oldest entry, so
   exactly five remain, newest first.
3. Sort each change into `new`, `improved` or `fixed` (an empty group is not
   shown), merge related changes, and write for users: no pull request numbers,
   to-do or flake ids, file paths or test-only work. `date` is the GitHub
   publish date (UTC); `channel` is `stable` for a Latest release, `beta` for a
   `-beta` tag and `unstable` for an `-alpha` tag.
4. Run `bun test src/ReleasesPage.test.tsx` from `apps/web-public`. It checks
   the count, the order, the release-notes links and the wording rules.

The comment at the top of the data file repeats these steps.

## Build commit

`list_nodes` reports the commit each backend was built from
([coordinator.md](../architecture/coordinator.md#multiple-machines)), which is
what answers "does this machine have that fix?" when many merges share one
version. The commit is embedded when the backend is bundled:

1. `scripts/build-commit.ts` prints `HEAD`, or nothing when no commit describes
   the tree exactly (any modified or untracked file, or no repository).
2. The build task exports that as `ORKESTRATOR_BUILD_COMMIT`. A build task sets
   it rather than a build script reading Git, because Turbo restores `dist/**` on
   a cache hit without running the script. The variable is in the `env` of
   `@orkestrator/backend#build` (`turbo.json`) and of the CLI's `build`
   (`packages/cli/turbo.json`), so it is part of both cache keys, and of the
   desktop's through its dependency on the backend. These builds miss the cache
   once per commit.
3. Both `Bun.build` calls for `main.ts` embed it with `define`
   (`buildCommitDefine`), and the backend reads it as `BUILD_COMMIT`. It is never
   read from the environment at runtime.

What each build path reports:

| Path | Reports |
| --- | --- |
| `build`, `build:desktop`, `build:electron`, `build:backend`, `build:cli`, `build:all` | The commit |
| `package:mac`, `package:linux`, `package:linux:unpacked`, `package:release` (through `build:all`) | The commit |
| `release:desktop` (`scripts/release-desktop.ts`, through `build:all`) | The commit |
| `publish:cli` and `release:publish` (`bun publish` rebuilds in `prepack`; `scripts/publish-cli.ts` sets the variable) | The commit |
| `pack:cli` | The commit |
| `.github/workflows/validate-bun-runtime.yml` (`build:all`) | The checked-out commit; on a pull request, its merge commit |
| Any path above from a modified tree, or with no Git repository | `null` |
| `dev`, `dev:web`, `dev:test`, and the qualification scripts that start `apps/backend/src/main.ts` | `null`: they run from source |
| `mise run test` and its variants, and `build:cli:test`, `build:all:test` and the tasks that use them (`test:agent:browser`, `test:agent:browser:isolated`, `test:cli:scenarios`, `package:linux:unpacked:test`, `test:package:security`) | `null`, and they keep one cache entry across commits |
| `smoke:cli`, a package's build script run directly, a bare `bunx turbo run build`, `scripts/qualify-preview-worker-upgrade.ts` | `null`: nothing sets the variable |
| `start:web`, `start:web-public` | `null`: they pass `ORKESTRATOR_*` on to the running backend, and so to what it starts, where a stale commit would stamp later builds |

`build:renderer`, `build:web-public`, the bridge builds and `setup` do not build
the backend. The container image holds no backend; its own `sourceRevision`
(`docker/image-manifest.ts`) is separate.

## Machine prerequisites

| Machine | Needs |
| --- | --- |
| Mac | Apple Silicon; a Developer ID Application certificate in the login keychain; notarization credentials. By default `release:desktop` uses the `orkestrator-notary` keychain profile (`xcrun notarytool store-credentials orkestrator-notary --apple-id <id> --team-id <team>`); setting `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE` overrides it. |
| Linux | `mise`, `git`, `gh` signed in, `bsdtar` (`sudo pacman -S libarchive`), and a checkout of the repository. `mise run release:linux -- check` verifies all of these from the Mac. |
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

## Linux build from the Mac

The Linux builder is **`omarchy-hp`** (Omarchy, x86_64), reached over
Tailscale as `ssh omarchy-hp`; the Mac's `~/.ssh/config` supplies the account.
Its checkout is `~/project/apps/orkestrator-v2`. Other machines on the tailnet
are not release builders: do not try them in turn.

```bash
mise run release:linux -- check              # reach the builder and check its tools
mise run release:linux -- build              # build and upload, following the log
mise run release:linux -- build --no-publish # rehearse without the tag or GitHub
mise run release:linux -- attach             # follow a running build again
```

`build` (`scripts/release-linux-remote.ts`, which sends
`scripts/release-linux-remote.sh` to the builder) refuses a dirty builder
checkout, fetches, checks out this Mac's `HEAD` detached, and starts
`release-desktop.ts build` there under `nohup`. The build's output goes to
`~/.cache/orkestrator-release/<checkout>/release-desktop-<version>.log` on the
builder (`<checkout>` is the checkout's resolved path with every `/` turned
into `_`) and streams back over SSH; if the connection drops the build carries
on, and `attach` picks the log up again. The command exits with the build's
exit status. The checkout is left detached at the release commit. A linked Git
worktree is a valid `--checkout`.

One build at a time per checkout: `build` takes a lock (a `lock` symlink in
that state directory naming its holder) before it touches the checkout, and
the detached build holds it until its result is written. A second `build`,
for any version, is refused without changing the checkout or the running
build's log; follow the first with `attach`. A lock whose holder has died is
taken over. A start the builder refuses (dirty checkout, unknown commit, a
fetch failure) first clears that version's earlier log and result, so `attach`
then reports no build rather than replaying an older one, and the Mac side
says nothing is running instead of suggesting `attach`.

How it reaches things, so no one has to work them out again:

- **SSH.** Tailscale SSH may ask for a browser check (a
  `https://login.tailscale.com/a/...` link) the first time in a while. The
  script raises the same desktop notification as npm's sign-in and keeps
  waiting; approve it and the build continues. ssh exits 255 both when it
  cannot connect and when an established session dies (Tailscale dropping,
  or three minutes without a keep-alive answer). Once the builder has printed
  `started the Linux release build`, a 255 means the connection dropped and
  the build carries on: run `attach`. Before that, check the host.
- **Git.** An SSH session from the Mac carries no GitHub SSH key, so the
  builder's `origin` (`git@github.com:...`) cannot be fetched as is. The
  script rewrites GitHub to HTTPS and authenticates through the builder's
  signed-in `gh` (`gh auth git-credential`), using `GIT_CONFIG_*` environment
  variables for that one process tree only; the builder's Git config is never
  changed. `check` proves both without the network: it expands a
  `git@github.com:` URL (`git ls-remote --get-url`) and asks Git's credential
  helper for a GitHub credential, printing neither. `release-desktop.ts` pushes the tag the same way when Linux runs
  first.
- **Another builder.** Set `ORKESTRATOR_RELEASE_LINUX_HOST` (an SSH host,
  `user@host` allowed) and `ORKESTRATOR_RELEASE_LINUX_CHECKOUT`, or pass
  `--host`/`--checkout`.

Both machines may build at once: the tag push and the draft release are
claimed so that concurrent runs agree (see
[Cutting a release](#cutting-a-release)).

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
