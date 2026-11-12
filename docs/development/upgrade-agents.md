# Upgrading agent SDKs and binaries

Status: Living — SDK/CLI bump runbook; pins are test-enforced.

This runbook covers the Claude, Codex, OpenCode, Cursor, Grok, and Pi versions
used by Orkestrator. These integrations do not share one upgrade mechanism:

| Agent | SDK integration | CLI integration | Current pins |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` drives native sessions; `@anthropic-ai/sdk` supplies message content types | The Agent SDK is pointed at Orkestrator's separately managed `claude` executable | Agent SDK `0.3.319`, Anthropic SDK `1.6.0`, CLI `2.1.319` (npm `latest`, verified 2026-11-06) |
| Codex | No runtime `@openai/codex-sdk` dependency. The bridge speaks JSON-RPC to `codex app-server` using generated types | The pinned `codex` executable is the app-server and is also used by isolated `codex exec` helpers | CLI and generated protocol `0.167.0` |
| OpenCode | No SDK: the backend's own 2.x client (`apps/backend/src/core/opencode2/`) | The pinned `opencode2` executable (OpenCode 2.x) runs `opencode serve` | CLI `2.2.6` (`opencode2`; OpenCode 1.x is retired) |
| Cursor | `cursor-bridge` drives `@cursor/sdk` in process | No CLI; Cursor is SDK-only | SDK `1.3.1` (npm `latest`, verified 2026-11-06) |
| Grok | The ACP bridge spawns the CLI and speaks ACP over its stdio; `@agentclientprotocol/sdk` supplies the protocol types | The pinned `grok` executable runs `grok … agent stdio` | CLI `1.0.77` (stable channel; verified 2026-11-06), ACP SDK `2.4.0` |
| Pi | `@earendil-works/pi-coding-agent` drives sessions in process; `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` supply types (upstream removed `@earendil-works/pi-server` in 1.2.0) | The pinned `pi` bundle is the same program published a second way, and is what a Pi terminal tab runs | SDK and CLI `1.5.0` |

All versions are exact pins. Do not change them to ranges or `latest`.
Verified against upstream stable releases on 2026-11-06.

## What is enforced, and what is not

`packages/toolchain/src/manifest.ts` (the `@orkestrator/toolchain` workspace
package, which also holds the installer the desktop app, the CLI and the mise
tasks share) is the single source of truth for
every agent. Two things read it directly and therefore cannot drift from it:
`scripts/download-agent.ts` and `scripts/verify-toolchain-artifacts.ts`.

Two things cannot read it, and are a second copy held in step by tests:

- **`docker/Dockerfile`** — an image build has no access to the manifest, so
  each CLI's version is an `ARG` literal and OpenCode's, Grok's and Pi's
  archive digests are `sha256sum` literals.
- **SDK pins in `package.json`** — resolved by bun, not by the manifest.

`every shipped agent, uniformly` in `tests/unit/version-drift.test.ts` is what
holds those copies together. It is table-driven over `AGENT_PINS`, and one of
its cases asserts that table names every agent in `PINNED_TOOLCHAIN_VERSIONS`,
so another managed CLI cannot be added with less coverage. Per
agent it checks the Dockerfile `ARG`, all four artifact records, every declared
SDK pin is exact rather than a range, and — for the agents the image fetches as
pinned archives — that the Dockerfile's digests are the manifest's digests.

That last check did not exist for Grok until recently: only Pi's digests were
bound, so a hand-edited `GROK_SHA` would have shipped a container running a
different build from the local worktree, silently. The SDK-only Cursor pin has
its own exact-pin assertion.

The `tracksCli` flag in that table is the one piece of real judgement. Pi
publishes the SDK and the binary as the same program two ways, so a split
gives the user two different agents behind one platform name and the test
demands they match. Claude's Agent SDK has its own release train and deliberately
does **not** track its CLI.

Still not enforced anywhere, by nature:

- **CLI argument vectors** for Grok ACP (`--always-approve agent stdio`).
  Nothing in CI can check a flag an upstream binary might rename. See
  [Grok (ACP)](#grok-acp).
- **Whether a new SDK event or tool variant is rendered.** Every bridge degrades
  an unknown one to a plain card or drops it, which is safe but silent.
- **Where a new version keeps its session state.** A test forces the
  [re-trace](#re-trace-preserved-provider-state) on every bump, but only a
  person can do it.

Cursor's only agent pin is `@cursor/sdk`; see
[Cursor (SDK bridge)](#cursor-sdk-bridge).

Cursor 1.3.1 also has a Bun-export diagnostic seam patch registered in root
`patchedDependencies`. Keep the pin, patch filename, registration, and lockfile
aligned. The appended export references the SDK's minified stall-detector and
execution-controller bindings: simply renaming the patch on upgrade is not
sufficient. Re-identify those bindings and verify the controller still awaits
each response write before advancing its execution iterator. The two classes
are found by their field lists: the stall detector opens with
`timer;advisoryTimer;heartbeatOnlyTimer` and is assigned inside the lazy
initializer that names `@anysphere/agent-client:stall-detector` (which the
export must call first); the controller is the class opening with
`serverStream;clientStream;controlledExecManager`. In 1.3.1 those are `rg0`,
`HZ1` and `cg0` (1.3.0: `Pg0`, `m91`, `Dg0`; 1.2.0: `Vm0`, `N71`, `Qm0`;
1.0.40: `W_0`, `x01`, `Z_0`; 1.0.37: `eR0`, `Er0`, `aR0`; 1.0.36: `aE0`,
`Xn0`, `dE0`). All three live in `dist/bundled/index.js`, and
the controller loop is still
`for await (let D of N) await this.clientStream.write(D)`. Run the Cursor
SDK diagnostics tests and version-drift test, then build/vendor the bridge and
verify the packaged Bun import exposes `__orkestratorDiagnosticsV1`. Do not
enable raw SDK logs as a substitute for the bounded observer.

## How binaries reach a running environment

There are four delivery paths. An upgrade is incomplete until every applicable
path has been updated.

### Local desktop environments

`packages/toolchain/src/manifest.ts` is the authoritative artifact
manifest for the five CLI-backed agents — Claude, Codex, OpenCode, Grok, and
Pi. OpenCode's binary is OpenCode 2.x under the toolchain name `opencode2`
(see [OpenCode 2.x](#opencode-2x-opencode2)); the 1.x `opencode` pin is
retired. Enabling a platform installs every tool `agentPlatformForToolchain`
assigns to it, so `opencode` brings `opencode2`. Every pinned tool contains one entry per supported
platform and architecture:

- macOS arm64 and x64
- Linux arm64 and x64

Each entry pins the archive URL, allowed hosts, archive size and SHA-256, archive
member to extract, and extracted executable size and SHA-256. The macOS entries
for Pi additionally set `repairInvalidMacSignature`; the manager
retains the verified upstream bytes and creates a locally ad-hoc-signed
executable.

An entry may also declare `companions`: further executables the primary one
spawns from its own directory. They are installed into the same version
directory and symlinked into the same generated `bin` directory, and the whole
set is validated together, so a cache predating a new companion is repaired
rather than trusted. Codex's `codex-code-mode-host` is the only one today.
Companions are not probed with `--version`: they are helper processes with their
own protocols, not CLIs.

Repair is incremental. When the primary executable still verifies and only a
companion is absent — the shape every existing install has the first time a
companion is added to an already-pinned version — the manager downloads just
that companion and renames it into the existing version directory. The primary
archive is not fetched again, and the version directory is never removed, so a
concurrently running older build keeps the exact executable its activation
symlink resolves to. Only a primary executable that fails verification triggers
the full download-and-replace path.

A companion file name must be a plain file name, and it must not collide with
any other pinned tool or companion: every one of them is linked into a single
shared activation directory, where a collision would silently replace another
tool's symlink. Both rules are enforced before anything is downloaded.

At application startup:

1. `apps/desktop/electron/main.ts` calls `preparePinnedToolchains()`.
2. `apps/desktop/electron/toolchain-startup.ts` presents retry/quit UI around
   installation.
3. `packages/toolchain/src/manager.ts` downloads through Electron's
   network stack, enforces HTTPS and the host allowlist, verifies sizes and
   hashes, extracts under an install lock, probes each executable, and activates
   a complete version set through a generated `bin` directory.
4. The cache lives under the application's data directory in `toolchains/`.
   Old versions are pruned only when they have no live lease.
   `toolchains/.verified-stamps.json` records, per installed file, the device,
   inode, size, nanosecond mtime and ctime it had when its SHA-256 was last
   computed (`packages/toolchain/src/file-stamps.ts`). A launch hashes only
   files whose metadata no longer matches, plus every file on a full check:
   once a week, when the stamp file is missing or unreadable, and on an
   explicit toolchain repair. Downloads go to `toolchains/.downloads/` and
   resume with `Range:` after an interruption (`download.ts`); they fail only
   after 60 seconds without data, not after a total deadline.
5. `apps/desktop/electron/backend-process.ts` passes the activation directory to
   the backend as `--toolchain-bin-dir`.
6. `apps/backend/src/core/commands.ts` prefers those executables for local
   OpenCode servers, Claude/Codex bridges, extension discovery, and helper
   commands. It passes `CLAUDE_CLI_PATH` to the Claude bridge and `CODEX_PATH` to
   the Codex bridge. `apps/backend/src/core/tmux.ts` also uses the managed Claude
   binary for local tmux sessions.

The managed toolchain is downloaded on first startup; agent executables are not
currently embedded in the Electron package. The root `package` script downloads
only Bun, and `build.extraResources` includes only `binaries/bun` from the
`binaries/` directory.

### Support tools

The toolchain also pins host tools that are not agents.
`PINNED_SUPPORT_TOOL_VERSIONS` in the manifest holds them, beside the agents'
`PINNED_TOOLCHAIN_VERSIONS`. Today that is only the GitHub CLI.

- Every profile with at least one enabled platform gets the support tools,
  even a Cursor-only one (`pinnedArtifactsForPlatforms`). The headless
  installer adds them to every selection.
- They have no Dockerfile pin. The image installs `gh` from its distribution,
  so the `AGENT_PINS` table and the Dockerfile checks do not cover them.
- The backend runs the managed `gh` for PR detection, reviews, cloning and the
  in-app GitHub sign-in (`apps/backend/src/core/github-cli-binary.ts`), and
  falls back to `gh` on `PATH`. Terminals and agents find it first on `PATH`
  as well. Every copy shares gh's configuration and stored login.

To bump `gh`:

1. Set `PINNED_SUPPORT_TOOL_VERSIONS.gh` to the latest `cli/cli` release.
2. Download the four `gh_<version>_{macOS,linux}_{arm64,amd64}` archives and
   check them against the release's `gh_<version>_checksums.txt`.
3. Record each archive's size and SHA-256 and each `bin/gh`'s size and
   SHA-256 in the `ghArtifact(...)` entries. The macOS binary is signed and
   notarized by GitHub, so it is pinned unmodified.
4. Run
   `RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts --tool=gh`.

### Backend-only hosts

A backend that runs without the desktop app (`orkestrator serve`, a server, a
service manager) has no startup step of its own: nothing fetches the pinned
binaries for it, and without one it silently uses whatever `claude`, `codex` or
`opencode` is on `PATH`. Its step is explicit, and it is the desktop's installer
run headlessly, so it has the same guarantees (HTTPS and host allowlists, size
and digest checks, an install lock, an executable probe, activation only after
the whole set verified):

```bash
orkestrator toolchain install            # published CLI
mise run toolchain:install               # from a checkout, no build needed
mise run toolchain:install --dry-run     # show what would be fetched
orkestrator toolchain install --data-dir /srv/orkestrator --tool claude --tool codex
```

Both run the same code: `packages/toolchain/src/install.ts`, driven by
`packages/cli/src/client/commands/toolchain.ts`. After an upgrade, re-run it on
every backend-only host, then restart the service.

- **What is installed** follows the data directory's own configuration — the
  `enabledAgentPlatforms` in `config.json`, read by the same
  `loadAgentPlatformSelection` the desktop uses — so a host that enabled two
  platforms does not download five. A directory nobody has configured yet gets
  every pinned tool, and platforms with no binary (Cursor) drop out. `--tool`
  overrides this, and the installed set then becomes *exactly* that list: tools
  left out stop being found after a restart, and the command warns when that
  happens.
- **Where it goes.** The manager activates each verified set in a directory named
  by a digest of its contents, so a running build keeps the layout it started
  with. The command then points `<data-dir>/toolchains/bin/current` at it, and a
  backend uses that as its default `--toolchain-bin-dir` when it exists (falling
  back to the plain `toolchains/bin` a hand-filled directory uses).
  `ORKESTRATOR_TOOLCHAIN_BIN` or `--toolchain-bin-dir` still win, and
  `orkestrator toolchain install --output id` prints the path.
- **It is idempotent and self-repairing.** Verified installs are reused (a repeat
  run takes about two seconds), and a binary that no longer matches its digest is
  fetched again.
- **A running backend does not notice.** The default is chosen at startup, and
  bridges already launched keep the executable they resolved, so restart after
  installing.
- **A service runs it for you.** A backend installed with `orkestrator service
  install` runs it before every start of a release, and its self-update runs the
  new release's installer before it restarts. Any other backend-only host does
  not update its toolchain on its own. A release that changes a pin needs the
  command run again: wire it into the host's deploy or service-start step
  (`ExecStartPre=` under systemd works). Remote clients can also repair the
  pinned set with `host.toolchain.repair`
  ([host-updates.md](../architecture/host-updates.md)).
- **The managed `claude` does not update itself.** Host processes running it get
  `CLAUDE_PINNED_RUNTIME_ENV` (`DISABLE_AUTOUPDATER=1`, with
  `FORCE_AUTOUPDATE_PLUGINS=1` so the user's plugins still update). A `claude` on
  PATH is left alone. The container image sets the same two variables
  (`docker/Dockerfile`), so container Claude stays on `CLAUDE_CLI_VERSION`.

#### Bridges a backend-only host installs on demand

The published package ships every bridge, but not every bridge's SDK. Claude,
Codex and ACP (Grok) are bundled complete. Cursor's SDK loads code-split chunks
at runtime and carries a per-platform native package, and Pi's closure is about
175 MB, so the package ships those two bridges' own bundles plus a pinned
manifest, lockfile and any repository patch under
`resources/<bridge>/runtime/` (`packages/cli/scripts/bridges.ts`).

The first time a Cursor or Pi bridge starts — a session, a model-catalogue
probe (which a backend runs at startup for every enabled platform), Cursor
sign-in — the backend runs `bun install --frozen-lockfile` into
`<data-dir>/bridge-runtimes/<bridge>/<digest>/`
(`apps/backend/src/core/bridge-runtime-install.ts`). That needs the npm registry
(or bun's cache) once per release; the digest covers the bundle and its inputs,
so an upgrade installs beside the previous runtime and then removes it. A
failed install fails that start with `Could not install Cursor support: …`.

The committed inputs live in `packages/cli/bridge-runtimes/<bridge>/`.
Regenerate them after changing an on-demand bridge's SDK pin or a patch that
targets its closure, and commit the result:

```bash
bun packages/cli/scripts/lock-bridge-runtimes.ts
```

`packages/cli/tests/cli.test.ts` fails when they drift from the bridge's
`package.json` or the root `patchedDependencies`, and `mise run smoke:cli`
installs them from the registry before a publish.

### Container environments

`docker/Dockerfile` has one exact build argument per pinned agent binary —
`CLAUDE_CLI_VERSION`, `CODEX_CLI_VERSION`, `OPENCODE2_CLI_VERSION`,
`GROK_BUILD_VERSION`, and `PI_CLI_VERSION`. It installs:

- `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`
- `@openai/codex@${CODEX_CLI_VERSION}`
- OpenCode 2.x (root-owned `/opt/opencode/bin/opencode2`, reached as
  `/home/node/.opencode/bin/opencode2`, `OPENCODE2_CLI_PATH`; a terminal's
  `opencode` is the wrapper `docker/opencode-cli.sh` around it), Grok Build
  and Pi as pinned archives, each verified against a
  literal SHA-256 in the same `RUN` block. Those digests are a **second,
  independent** set from the manifest's — the image does not read the manifest —
  so a version bumped in only one place fails the build rather than shipping an
  unverified binary.

The image also builds and installs every bridge tree: `claude-bridge`,
`codex-bridge`, `acp-bridge`, `pi-bridge`, and `cursor-bridge`. The Claude
bridge vendors the Agent SDK and its platform packages, then the Docker build
removes the musl variants so glibc resolves the correct native package; the Pi
and Cursor SDK bridges vendor their own SDKs the same way, for the reasons in
their sections below. Container bridge startup uses the commands on the image's
`PATH`; the Codex bridge records the selected command in `CODEX_PATH`.

A bridge that builds must also be listed in the root `package.json`'s
`build.extraResources`, or it works in containers and fails only when a user
selects it in a packaged desktop build.
`tests/unit/bridge-packaging.test.ts` enumerates them.

### Developer download scripts

`scripts/download-agent.ts` downloads the current host's artifact into
`binaries/`, verifies it against the manifest's pinned digests, makes it
executable, probes `--version`, and ad-hoc signs it on macOS. It covers all
five CLI-backed agents and handles every artifact shape they ship: a plain tar entry, a
zip entry, a bare `raw` binary, a bundle whose whole tree is kept intact, and
Codex's companion helper.

```bash
mise run download:claude    # or download:codex | :opencode (fetches opencode2) | :grok | :pi
mise run download:agent grok --dir /tmp/probe
```

There is **no version literal to update here.** The manifest is the only input,
so a bump changes nothing in this file. This replaced three hand-written shell
scripts that each re-derived the manifest's URL, version and platform mapping in
bash — a duplication that needed its own drift tests, covered only three of the
agents, and installed whatever the URL returned without checking a digest.

## Shared binary upgrade procedure

Use this procedure for every CLI bump, then follow the provider-specific steps
below.

1. Choose an exact stable version and read its upstream release notes. Confirm
   that all four repository targets are published before changing pins.
2. Change the provider's version in
   `packages/toolchain/src/manifest.ts` and `docker/Dockerfile`.
   The shared downloader reads the manifest and has no version mirror. Codex
   has an additional source of truth described below.
3. Refresh all four artifact records with the live verifier:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --emit --tool=<name>
   ```

   `--tool` accepts any manifest name, including `grok`, `pi` and `opencode2`.
   Their artifact records are refreshed by exactly this command.

   Paste the emitted archive and executable sizes and SHA-256 values into the
   matching platform/architecture entries in
   `packages/toolchain/src/manifest.ts`. Do not copy the previous
   version's hashes and do not verify only the development machine's target.
   During iteration, `--platform=darwin|linux` and `--arch=arm64|x64` can narrow
   the download.
4. Assert the completed manifest against fresh upstream downloads:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --tool=<name>
   ```

5. Exercise the current-host downloader, which verifies the bytes it fetches
   against the records you just pasted:

   ```bash
   mise run download:<claude|codex|opencode|grok|pi>
   ```

6. Build the container after the provider-specific checks:

   ```bash
   mise run docker:build
   ```

7. [Re-trace preserved provider state](#re-trace-preserved-provider-state) for
   the new version.

The live verifier downloads large artifacts and requires network access. The
ordinary unit tests validate manifest structure and downloader behavior without
trusting the network.

## Re-trace preserved provider state

A preserving container rebuild keeps `/workspace` and only the provider paths
listed in `PROVIDER_STATE_LAYOUT`
(`apps/backend/src/core/container-state-layout.ts`). Everything else in a
provider home is dropped with the old runtime. An upgrade that moves session
state to a new file or database makes a rebuild lose it, and no ordinary test
notices. So every agent bump re-checks the layout against the new version.

`apps/backend/tests/container-state-layout.test.ts` enforces that this step
happened: it fails until `PROVIDER_STATE_TRACED_VERSIONS` names every CLI pin
in the manifest and the `@cursor/sdk` pin. It cannot check the trace itself.
Update the traced version only after doing the steps below.

1. List what the new version reads and writes in its home. This needs no
   Docker and no sign-in. `mise run download:<tool>` puts the binary under the
   app's toolchain directory (`~/Library/Application
   Support/orkestrator-v2/toolchains/<tool>/<version>/` on macOS). Its path
   strings match the Linux build's. Diff the result against the previous
   version beside it.

   | Provider | Where to look | What must still hold |
   | --- | --- | --- |
   | Claude | The "Application data" table in the Claude Code docs (`claude-directory`); `strings` on the binary for the directory names | Transcripts are under `~/.claude/projects` and rewind snapshots under `~/.claude/file-history`. Anything new the docs list as needed for "resume, continue, and rewind" must be preserved |
   | Codex | `strings "$BIN" \| grep -E '_[0-9]+\.sqlite\|session_index\|archived_sessions\|CODEX_SQLITE_HOME'` | Rollouts are under `sessions/` and `archived_sessions/`. `CODEX_SQLITE_HOME` is still honoured, and every runtime database it relocates matches the `.codex/*.sqlite*` selection in `replacementCopyPlan`. Note any new versioned database name; `thread_history_1` and `goals_1` are examples |
   | OpenCode | `strings "$BIN" \| grep -E 'OPENCODE_DB\|opencode\.db\|snapshot'` on the `opencode2` binary | `OPENCODE_DB` is still a full database path (`OPENCODE2_DB_PATH`), sessions live only in that database, and `snapshot/` is still revert history rather than session state. (The 1.x seeded-data qualifier was retired with 1.x: `git show 5f4e27b1c:scripts/qualify-opencode-seeded-data.sh`.) |
   | Pi | The pinned bundle's own docs: `sessions.md` and `environment-variables.md` under its `docs` directory | Sessions default to `~/.pi/agent/sessions`. The bridge passes `PI_SESSION_DIR` to `SessionManager` itself |
   | Cursor | `JsonlLocalAgentStore` and `getDefaultSdkStateRoot` in the bundled SDK | The store writes only under the root `cursor-bridge/src/sdk-runtime.ts` passes it, which sits under `CURSOR_BRIDGE_STATE_DIR` |
   | Grok | The help docs the CLI writes to `~/.grok/docs` (sessions and storage chapters), `CHANGELOG.md`, and `strings` for `GROK_HOME` | `session/load` needs only `~/.grok/sessions/<cwd>/<id>/` (`updates.jsonl` is authoritative). `active_sessions.json` lists live processes only and `worktrees.db` tracks only Grok's own worktrees |

2. Classify every location the new version writes as one of:
   - **Preserve**: needed to resume, rewind or fork a session, or a bridge
     journal or map without which the host's session id cannot be resolved.
   - **Accept losing**: visible to the user but not needed to resume. Name it
     in the provider's `PROVIDER_PRESERVATION` limitation text, which the
     rebuild preview shows. A provider with any such path is `partial`.
   - **Drop**: credentials, configuration, caches, logs, process registries,
     and anything the entrypoint re-seeds from the host on every start.
3. If a preserved path moved or a new one appeared, change these together:
   - the `PROVIDER_STATE_LAYOUT` entry, plus any relocation variable
     (`persistentStateExports`);
   - the legacy-migration selection in `replacementCopyPlan`;
   - the provider's row in the "Provider state" table in
     [container-lifecycle.md](../architecture/container-lifecycle.md);
   - a populate line and expectation in the C14 live test
     (`apps/backend/tests/container-live-replacement.test.ts`).

   Never mount a whole provider home, and never symlink a state path; see the
   [design constraints](../architecture/container-lifecycle.md#design-constraints).
4. Set the provider's entry in `PROVIDER_STATE_TRACED_VERSIONS` to the new
   version and update the "Traced against" line under "Provider state".

## Re-check OAuth refresh-token rotation

Containers get Claude, Codex, Grok, OpenCode and Pi logins access-only, because a copy
that refreshed with the host's refresh token would spend it and sign the host
out (`packages/protocol/src/login-snapshots.ts`). OpenCode and Pi hold one
login per model provider, and `NON_ROTATING_OAUTH_PROVIDERS` there lists the
OAuth providers whose refresh token is reused rather than rotated, so a
container may keep it whole. `restrict_imported_login` in
`docker/entrypoint.sh` repeats the same list (a unit test keeps them equal).
On every OpenCode or Pi bump, re-read each OAuth provider's refresh function:

- Pi: `dist/auth/oauth/*.js` in `@earendil-works/pi-ai`. A provider whose
  refresh returns the token it was given (`refresh: refreshToken`) is
  non-rotating; one that stores the response's `refresh_token` rotates.
- OpenCode 1.x: the built-in auth plugins under `packages/opencode/src/plugin/`
  at the release tag (`openai/codex.ts`, `github-copilot/copilot.ts`, `xai.ts`),
  any new plugin `internalPlugins` loads, and the npm auth plugins pinned in
  the `package.json` of OpenCode's `packages/opencode/` (`opencode-gitlab-auth`,
  `opencode-poe-auth`).
- OpenCode 2.x: the provider plugins under `packages/core/src/plugin/provider/`
  at the release tag. A container's 2.x server is handed the same restricted
  1.x entries (`openCode2ContainerCredentialPayload`), so one list serves both.

A new rotating provider needs no change (anything unlisted is access-only). A
new non-rotating one, such as a token exchange like Copilot's, needs adding to
both lists, or its container copy signs out when its short access token
expires. Also check that `expires` is still in milliseconds and the refresh
window (Pi and OpenCode 2.x refresh five minutes early, OpenCode 1.x's xAI
two) still fits inside `PROVIDER_AUTH_MIN_VALIDITY_MS`.

Last checked 2026-11-11 (to-do 0018 (retired) task 8) against Pi 1.5.0 (`pi-ai` 1.5.0),
OpenCode 1.19.5 and OpenCode 2.2.6, by diffing against the versions the list
was first made from (Pi 1.2.0, OpenCode 1.19.0):

- Pi: the same nine OAuth providers in 1.2.0 and 1.5.0 (Anthropic, OpenAI
  `openai` and `openai-codex`, GitHub Copilot, OpenRouter, Kimi, Meta, xAI,
  Radius). The refresh code changed only in URL validation of device-code and
  discovery responses. Copilot keeps its GitHub token (`refresh:
  refreshToken`), Meta re-mints from its identity token, OpenRouter stores an
  empty `refresh` that never expires; every other one stores the response's
  `refresh_token` (xAI keeps the old one only when the response omits it).
- OpenCode 1.19.0 to 1.19.5: no change under `src/plugin/`, and the same
  `opencode-gitlab-auth` 2.1.0 and `opencode-poe-auth` 0.0.1. GitLab stores
  the new refresh token on every refresh, so it rotates. Poe's OAuth login
  stores its API key as both `access` and `refresh` and never refreshes, so
  blanking `refresh` changes nothing. The built-in Snowflake Cortex plugin
  stores the response's refresh token and keeps the old one only when the
  response omits it, so it is treated as rotating.
- OpenCode 2.2.6: GitHub Copilot still stores `refresh: access` with
  `expires` 0 and registers no refresh; OpenAI, ChatGPT, GitLab and
  OpenCode's own login store the response's refresh token, and xAI and
  Snowflake Cortex keep the old one only when the response omits it. Poe now
  stores an empty `refresh`. It refreshes a login with five minutes or less
  left (`integration.ts` in OpenCode's `packages/core/src/`).

No provider moved between the two lists, so `NON_ROTATING_OAUTH_PROVIDERS`
was left as it was.

On every Claude Code bump, run `bun scripts/claude-host-refresh-trigger-probe.ts
--claude <pinned binary>`, ideally inside a network namespace with only
loopback (`unshare -rn sh -c 'ip link set lo up && bun …'`). It gives the
pinned CLI fake logins in a temporary `CLAUDE_CONFIG_DIR` and `HOME`, runs the
exact command `refreshHostClaudeLogin` runs (`CLAUDE_HOST_REFRESH_ARGS`)
through a proxy that records and refuses every connection, and checks the nine
cases the keeper relies on: a refreshable login inside its last five minutes,
or expired, contacts the token host before any API request; one with two
hours left does not unless the API answers 401; an access-only login never
does; with the API answering, the run sends a `POST /v1/messages` carrying the
fake login's access token and exits 1; and the credential file is never
rewritten. A run that could not start or died on a signal counts as a
mismatch, and an unknown or empty `--cases` selection is refused before
anything runs. It exits non-zero on any mismatch, which means
`refreshHostClaudeLogin` and `TOKEN_REPLACEMENT_LEAD_MS` need re-reading.

On every Codex bump, run `bun scripts/codex-access-only-auth-probe.ts --codex
<pinned binary>`. It hands the pinned Codex the access-only `auth.json` a
coordinator home or container receives, built from a synthetic login against
a local server, and reports every refresh attempt. On 0.164.0, 0.166.0 and 0.167.0
alike: no refresh for an access token more than five minutes from its `exp`,
whatever `last_refresh` says; inside those five minutes a few attempts (four
in the probe's run) and after a 401 one, each with the blank refresh token,
each failing and leaving the file untouched. A
change there (a refresh before the window, or a rewritten file) needs
`restrictCodexAuthSnapshot` and `TOKEN_REPLACEMENT_LEAD_MS` re-read.

## Re-check capacity retries

Each provider's retry rests on facts read from its pinned release
([1010](../todo/agent-engines/1010-model-capacity-backoff-retry.md)). None of
them breaks a build when it changes, so check them on a bump:

- **Codex:** `CodexErrorInfo` for a new capacity code, and the two messages in
  `sessions/capacity-retry.ts`.
- **Claude:** `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` and `..._MAX_DELAY_MS`
  still apply to overloads only and accept the values in `runtime-env.ts`.
- **OpenCode:** a turn still ends with an `APIError` carrying `statusCode` once
  OpenCode's own retries run out (`isOpenCodeCapacityError`).
- **Grok:** the two overload sentences in `acp-prompt.ts`.
- **Cursor:** whether the SDK now names a capacity error (task 4 is waiting on
  this).

## Re-check coordinator tier decisions

Some coordinator tiers rest on facts read from one pinned version
([coordinator-read-only-decisions.md](../architecture/coordinator-read-only-decisions.md)).
None of them breaks a build when it changes, so check them on a bump:

- **Claude (Assumptions):** the pinned CLI keeps its Windows sandbox behind a
  vendor feature flag that is off by default (`tengu_nankeen_kestrel` in the
  2.1.309 binary). Search the new binary for that flag name. If it is gone or
  on by default, Windows Claude coordinators may now get the sandbox
  (`unavailable` already asks for it); the tier stays `provider-configured`
  until the Windows live run on the manual-test checklist passes.
- **Codex (D9):** if `live-network-lock.test.ts` fails, or a coordinator's
  first turn is refused by `assertHostedNetworkLock`, fix the lock first, then
  decide whether a `NativeAgentReadiness` state is now worth adding.
- **Codex (D4):** when the live coordinator suite runs on the new version,
  check the `async` and `family` summaries for a Codex coordinator running
  `sleep`; if one does, add an argv0 deny to the coordinator permission profile.
- **Cursor (D6):** read `LocalAgentOptions` in the new `@cursor/sdk` typings
  for an approval or tool-call callback. If one exists, Cursor's
  `provider-configured` tier can be reconsidered (a conformance test change
  and a live run).
- **Grok (D8):** if `grok --help` documents a fetch-only switch, or a way to
  remove the hosted search's `open_page` actions, run the `no-open-page` and
  `flag-search` variants of `scripts/coordinator-probes/grok-web-tools-probe.mjs`
  signed in (billed turns). Only if it shows search without fetch can Grok
  coordinators get web search. The `data-dir-reads` variant answers whether
  Grok's own reading tools ask permission
  ([7401](../todo/coordinator-and-multi-review/7401-grok-coordinator-data-dir-reads.md)).

## Claude

### Where the SDK is used

`bridges/claude-bridge/package.json` exact-pins both Claude dependencies:

- `@anthropic-ai/claude-agent-sdk` is the runtime integration.
- `@anthropic-ai/sdk` is imported only for `ImageBlockParam`, `TextBlockParam`,
  and `ContentBlockParam` message types.

`packages/cli/package.json` pins `@anthropic-ai/claude-agent-sdk` a **second
time**, and it is easy to miss. That package is the standalone `orkestrator`
backend published to npm, and its `dependencies` list is deliberately only the
modules `packages/cli/scripts/build.ts` leaves unbundled — so the Agent SDK
there is a real
runtime pin for CLI users, not a stale duplicate. Bump it with the bridge's, then
regenerate the lockfile standalone services install from, and commit
`packages/cli/release-runtime/` (`packages/cli/tests/cli.test.ts` fails until it
matches). The script also re-resolves the on-demand bridge lockfiles; keep only
the changes this bump needs:

```bash
bun packages/cli/scripts/lock-bridge-runtimes.ts
```

`bridges/claude-bridge/src/services/session-manager.ts` is only a barrel. The
compatibility surface is `services/session-manager-prompt-handlers/*` (one
handler per SDK frame type), `services/session-manager-messages.ts`, the
SDK-facing types in `types/index.ts`, `services/session-manager-prompt-launch.ts`
(where `query()` is called) and `sdk-compatibility.test.ts`. Together they use the Agent SDK's `query()` async iterator, session lifecycle
helpers, supported models and agents, file rewind, background-task controls,
partial messages, structured output, checkpoints, permission/input callbacks,
settings, plugins, MCP configuration, and SDK message unions. It passes
`CLAUDE_CLI_PATH` as `pathToClaudeCodeExecutable`, so the exact managed CLI—not
the SDK's fallback executable—is used in packaged local environments. The same
CLI is used for session-title generation.

`bridges/claude-bridge/scripts/vendor.ts` copies the Agent SDK and all installed
platform-specific optional packages into `dist/node_modules`. The bridge build
keeps the Agent SDK external and runs this vendor step, so successful TypeScript
compilation alone does not prove the distributable bridge is complete.

`bridges/claude-bridge/src/sdk-compatibility.test.ts` loads the real installed
SDK in isolated processes and guards the feature-detected APIs that could
otherwise disappear silently. It also checks the `AskUserQuestion` contract used
under `bypassPermissions`, and that every tool the read-only policy names
(`READ_ONLY_TOOLS`, `WAITING_TOOLS` in `read-only-policy.ts`) is in the SDK's
`BUILTIN_TOOL_NAMES` or `LEGACY_TOOL_NAME_ALIASES`: a rule naming a tool the CLI
no longer has matches nothing.

`CLAUDE_CONTEXT_CATEGORY_IDS` (`session-manager-core.ts`) maps the CLI's
context-usage row ids onto the shared `NATIVE_AGENT_CONTEXT_CATEGORY_IDS`
(`packages/protocol/src/native-agent.ts`). It is a `Record` over the SDK's id
union, so a bump that adds a row id fails the typecheck until it is placed.

### How to upgrade Claude

1. Update the two exact dependencies in
   `bridges/claude-bridge/package.json`. Upgrade the Agent SDK and Anthropic SDK
   independently based on their compatibility requirements; their semver trains
   are not the Claude CLI's semver train.
2. Update both committed lockfiles. The root one is straightforward:

   ```bash
   bun install
   ```

   `bridges/claude-bridge/bun.lock` is the awkward one. Running `bun install`
   inside the package does **not** regenerate it — bun walks up, finds the
   workspace root, and installs there instead, reporting "no changes" while the
   nested file stays on the old version. Since
   `tests/unit/version-drift.test.ts` asserts that every nested lockfile agrees
   with the `package.json` beside it, a bump that skips this fails that test.
   Regenerate it outside the workspace, from a copy with the `workspace:*`
   dependency stripped (bun omits those from a nested lockfile anyway):

   ```bash
   mkdir -p /tmp/cb-lock && cd /tmp/cb-lock
   python3 -c "
   import json
   p = json.load(open('$OLDPWD/bridges/claude-bridge/package.json'))
   p['dependencies'] = {k: v for k, v in p['dependencies'].items()
                        if not v.startswith('workspace:')}
   json.dump(p, open('package.json', 'w'), indent=2)
   "
   bun install --lockfile-only
   cp bun.lock "$OLDPWD/bridges/claude-bridge/bun.lock"
   ```

   Expect a small diff — only the bumped packages and their digests. Confirm
   that the root `bun.lock` and `bridges/claude-bridge/bun.lock` resolve the
   intended Agent SDK, Anthropic SDK, and platform-specific Agent SDK
   packages.
3. Inspect the installed Agent SDK's `package.json` field
   `claudeCodeVersion`. It records the CLI version bundled/tested by that SDK.
   Orkestrator deliberately supplies its own CLI, so this field is a
   compatibility signal rather than the repository's source of truth. If the
   separately chosen CLI differs, test that combination explicitly.
4. Update the CLI in all three mirrors:

   - `PINNED_TOOLCHAIN_VERSIONS.claude` in
     `packages/toolchain/src/manifest.ts`
   - `CLAUDE_CLI_VERSION` in `docker/Dockerfile`

   Nothing else mirrors the CLI version. `scripts/download-agent.ts` reads the
   manifest, so it needs no edit.

5. Refresh and verify the four Claude artifact records using the shared binary
   procedure.
6. Review the compatibility surface above (`session-manager-prompt-handlers/*`,
   `session-manager-messages.ts`, `session-manager-prompt-launch.ts` and
   `types/index.ts`) for option, event, and message-union changes. Pay
   particular attention to the version-pinned `canUseTool` comment in
   `session-manager-prompt-query.ts` and re-prove that `AskUserQuestion` remains parked
   until the callback resolves. The `routes AskUserQuestion through canUseTool
   under bypassPermissions` case in `sdk-compatibility.test.ts` is that proof —
   it drives the real installed SDK — so move the comment's version only once it
   has passed against the new one, and leave it alone if it has not. Review
   session adoption (`listSessions` options), background task controls,
   checkpoint/rewind behavior, partial messages, structured output, and model
   catalog calls.

   Re-check Ultracode against the new CLI too. It reaches the bridge as the
   `ultracode` reasoning level (`claudeModelReasoningIds()` in
   `packages/protocol/src/claude-model-catalog.ts`), which
   `resolveUltracodeEffort()` turns into `high` effort plus an internal
   `ultracode` flag, and
   `bridges/claude-bridge/src/services/ultracode.ts` owns three CLI rules that
   no type captures: it is a flag-layer setting each turn's query must be
   started with; since 2.1.284 an `applyFlagSettings` effort change without an
   `ultracode` key turns it off; and the runtime truth is `getSettings()`'s
   `applied.ultracode` / `ultracodeRequested` / `ultracodeAvailable`, which the
   SDK does not declare. `sdk-compatibility.test.ts` probes that
   `getSettings` still exists; if `ModelInfo` ever gains an Ultracode flag,
   gate the toggle on it instead of on `xhigh` support.

   Check whether `SlashCommand` in the new `sdk.d.ts` has gained a marker for
   terminal-only commands (at 0.3.322 it is still
   `{ name, description, argumentHint, aliases?, builtin? }`, and only the
   init frame's `terminal_slash_commands` names them). If it has, read it from
   the probe's rows and delete the per-CLI-version list in
   `bridges/claude-bridge/src/services/claude-terminal-commands.ts`, which
   closes the first-tab gap described under Claude in
   [native-agent-commands.md](../architecture/native-agent-commands.md#provider-notes).

   Re-prove how a running CLI handles MCP updates. The bridge relies on
   `setMcpServers` unloading only servers an earlier call gave it, and on an
   unchanged restatement not reconnecting a server
   (`session-manager-prompt-mcp-sync.ts`). This runs the real CLI in a
   temporary home, with no credentials. Inventory checks make no model call;
   a deterministic loopback model exercises root and background-subagent
   stale-tool denial. The test also runs in the default suite and CI:

   ```bash
   mise run verify:claude:mcp-live
   ```

   It runs the SDK's own platform CLI unless `CLAUDE_CLI_PATH` names another;
   when the managed CLI differs from the SDK's (step 3), run it again with
   `CLAUDE_CLI_PATH` pointing at the managed one, installed into a throwaway
   data directory (`mise run toolchain:install --data-dir <throwaway dir>
   --tool claude`). The live Claude MCP probes refuse a `CLAUDE_CLI_PATH`
   inside the real data directory (`live-cli-guard.ts`), which an agent shell
   started by the app inherits; `ORKESTRATOR_LIVE_ALLOW_REAL_DATA_DIR_CLI=1`
   is the operator's deliberate opt-in. If its `bare` case fails, the
   CLI now unloads launch servers by itself; the restatement is then harmless,
   but update the module's header to say so.

   After a Claude or Codex bump, also run automatic switching's resend across a
   real bridge replacement. It uses the pinned CLIs against scripted provider
   servers, so no turn is billed. If a refusal no longer ends the turn, the CLI
   changed how it retries or words a refused 429:

   ```bash
   mise run verify:accounts:resend-live
   ```

   Re-prove the MCP editor's Claude plugin rules (`enabledPlugins` for the
   `@inline` plugins the bridge passes, the bridge passing an install only
   when its `<name>@<marketplace>` id is `true`, Claude Code's own installed
   copy, `.mcp.json` before the manifest's `mcpServers`, the
   `plugin:<plugin>:<server>` names and the live panel's plugin layer). This
   starts the real CLI six times in a temporary home, with no credentials and
   no prompt:

   ```bash
   mise run verify:claude:plugin-mcp-live
   ```

   A failure means the CLI changed one of the rules recorded under "Claude
   plugins" in `docs/architecture/mcp-management.md`; re-derive it from the
   binary and update `packages/protocol/src/node/claude-plugin-set.ts`.

   Re-prove how an MCP tool's safety hints reach a Claude approval card
   (`claude-mcp-tool-hints.ts`): the call name `canUseTool` reports, the bare
   tool name and annotation keys in `mcpServerStatus()`, and that the status
   read answers while the CLI waits on `canUseTool`. This runs the real CLI in
   a temporary home with a local MCP server and a loopback model, with no
   credentials; every call is denied. It also runs in the slow tier:

   ```bash
   bun test --cwd bridges/claude-bridge ./src/services/claude-mcp-tool-hints.live.test.ts --preload ../../tests/setup-node.ts --parallel=1
   ```

   A failure means the CLI changed how it names MCP calls or reports
   annotations; update the module's header and its matching, never the card.

   Re-prove what a parked spare does and refuses, which is why the bridge does
   not use `prewarm()`: no model call while parked, a `sessionId` kept, a
   `resume` refused, a slow MCP server not connected ahead of the claim. This
   runs the real CLI and bridge in a temporary home, with no credentials and a
   scripted model:

   ```bash
   mise run verify:claude:first-turn-live
   ```

   A failure means that decision in
   `docs/todo/agent-engines/0005-mid-turn-steer-and-interrupt.md` is worth
   reopening, not that the bridge is broken.

   On macOS, and on a Linux host whose bubblewrap can nest the CLI's user
   namespace (elsewhere the check skips with the probe's reason), re-prove
   that the CLI enforces the provider sandbox
   `claudeExecutionSandbox` sets: a command cannot write outside the
   workspace or reach an unlisted host under auto-approve, even when it asks
   to run unsandboxed, and neither raises an approval card. Under `ask`, an
   escape request must raise a Bash approval card: the file is absent while
   pending, acceptance allows the outside write, and decline prevents it.
   This runs the real bridge and CLI in
   a temporary home, with no credentials and a scripted model:

   ```bash
   mise run verify:claude:sandbox-live
   ```

   Its controls also pin what the sandbox proxy does without
   `strictAllowlist` (an unlisted host is granted unseen, or asked about in a
   second card); if one of them starts failing, the CLI changed its network
   model and `claude-execution-sandbox.ts` needs another look. What differs
   between the two systems (the shell's refusal text, and whether full
   network reaches loopback directly: on Linux it does not) is in
   `PLATFORM_SANDBOX_EXPECTATIONS` in `claude-provider-sandbox.live-probe.ts`.

   Re-check the Linux command sandbox on a Linux host. The probe in
   `packages/protocol/src/node/claude-linux-sandbox.ts` models how the CLI
   runs a command (bubblewrap, then its `apply-seccomp` helper nesting a user
   namespace); see "Claude's sandbox on Linux" in
   `docs/architecture/coordinator.md`. Run
   `bun test --cwd bridges/claude-bridge ./src/conformance-coordinator-sandbox-live.test.ts --preload ../../tests/setup-node.ts --parallel=1`
   there, and look in the binary for the bubblewrap arguments and the
   `apply-seccomp:` messages. If the CLI stops nesting a namespace, or gains a
   setting that avoids it without weakening isolation (2.1.309's
   `allowNestedUserNamespaces` removes code-execution isolation, so it is not
   one), update the probe.

   Re-check the coordinator's skills ("Skills" in
   `docs/architecture/coordinator.md`): run
   `CLAUDE_CLI_PATH=<managed claude> bun src/services/coordinator-skills.live-probe.ts`
   from `bridges/claude-bridge` (one billed Haiku turn per scenario on your
   own login). Every marker must stay `false`, the mirrored skill must load
   and the raw one be refused. Also look in the binary for new skill
   frontmatter keys or tools that write, run a shell or reach the network;
   such a tool belongs in the capability translation in `read-only-policy.ts`.
   The other platforms' coordinator skills have their own checks: on a Codex
   bump run `live-coordinator-skills.test.ts` with `RUN_LIVE_CODEX_APP_SERVER=1`
   (no credits); a Pi or Cursor SDK bump re-runs that bridge's
   `coordinator-skills.test.ts`, and a Grok bump re-checks whether `GROK_CONFIG`
   now accepts a `skills` section.
7. Rebuild the vendored bridge and verify it:

   ```bash
   mise run build:claude-bridge
   bun run --cwd bridges/claude-bridge typecheck
   bun test bridges/claude-bridge/src/sdk-compatibility.test.ts
   bun run --cwd bridges/claude-bridge test:bridge
   ```

   Run the suite through `test:bridge`, which preloads `tests/setup-node.ts`.
   A bare `bun test bridges/claude-bridge/src` from the root picks up the
   root DOM preload instead, whose `AbortSignal` is not Node's: since 0.3.314
   the SDK passes the query's signal to `events.setMaxListeners`, which throws
   on it, so every test that starts a real SDK query fails there.

Last verified 2026-10-30 at Agent SDK 0.3.314 (`claudeCodeVersion` 2.1.314, so
the SDK's CLI and the managed one are the same version) with CLI 2.1.314: the
compatibility test including the `canUseTool` proof, `verify:claude:mcp-live`
against both the SDK's CLI and the managed binary, `verify:claude:plugin-mcp-live`,
the coordinator sandbox live test (macOS only), the vendored build, the
typecheck and the full bridge suite. The only SDK union change was a new
`SDKStartupFailureReason`, `sandbox_required_unavailable`, now mapped in
`claudeStartupFailureMessage`. Not rerun at 2.1.314: the Linux sandbox probe
(needs a Linux host) and the billed coordinator-skills probe.
`claude-host-login-refresh.ts`'s trigger was re-checked with a fake login in
a container on 2.1.314 on 2026-11-06 (0018 (retired) task 5): still refreshes in the
last five minutes, still exits 1 on the API's error, but the CLI now sends
the unknown model to the API instead of refusing it itself.

Last verified 2026-11-06 at Agent SDK 0.3.319 (`claudeCodeVersion` 2.1.319)
with CLI 2.1.319 on Linux: the compatibility test including the `canUseTool`
proof, `verify:claude:mcp-live` against both the SDK's CLI and the managed
binary, `verify:claude:plugin-mcp-live`, `verify:claude:first-turn-live`,
`verify:accounts:resend-live`, the vendored build, the typecheck and the full
bridge suite. The union changes were a new `system` subtype,
`session_writes_lost` (a health notice, and since task 14 of
[1031](../todo/agent-engines/1031-provider-upgrade-2026-11-06.md) also the
shared lost-write advisory in the transcript when `transcript_session_ids`
names the session), and two `SDKStartupFailureReason`
members, `initialize_not_first` and `config_file_invalid`, now mapped in
`claudeStartupFailureMessage`. A startup failure now also carries the CLI's own
`errors` text after the guidance (`withStartupFailureDetail`), because
`config_file_invalid` and `worktree_resume_refused` put the specifics there.
Not rerun at 2.1.319: the macOS sandbox live test, the Linux sandbox probe
and the billed coordinator-skills probe. `claude-host-login-refresh.ts`'s
trigger was re-checked on 2.1.319 on 2026-11-11 with
`scripts/claude-host-refresh-trigger-probe.ts`, on Linux in a network
namespace with only loopback (`unshare -rn`), the nine cases run together:
all nine matched 2.1.314. The token host is still `platform.claude.com`;
with a fake Messages API the run exited 1 in 2.1-2.3 s (3.2 s after a 401),
and with the API unreachable it was still retrying when the refresher's 60 s
budget ran out, the refresh having been attempted in its first second. With `ANTHROPIC_BASE_URL` set, the CLI
also asked `api.anthropic.com` for the OAuth profile (refused by the probe's
proxy).

The compatibility test's deterministic CLI fixture does not authenticate or
spend credits, but it is not a full real-CLI smoke test. Before release, start a
local and a container Claude native session with the new managed CLI and verify
streaming, questions, abort, resume, model discovery, and a background task.

Upstream references: [Claude Code](https://github.com/anthropics/claude-code)
and [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript).
Upstream now recommends its native installer for ordinary user installs, but
Orkestrator intentionally uses exact versioned artifacts and must not switch to
an unpinned installer in this workflow.

## Codex

### Where the SDK and protocol are used

The Codex bridge does **not** use `@openai/codex-sdk`. Its
`bridges/codex-bridge/package.json` has no Codex dependency, and
`tests/unit/version-drift.test.ts` asserts that it stays absent. The bridge owns
local item types in `bridges/codex-bridge/src/codex-item-types.ts` and supervises
one persistent `codex app-server --stdio` process per environment.

The bridge used to carry its own nested `bun.lock` that still resolved
`@openai/codex-sdk` and its six platform binaries. That file has been
removed: the root `bun.lock` is authoritative for every workspace member, and the
nested copy shipped into the image (`.dockerignore` does not exclude `bun.lock`,
and the build `mv`s the bridge to `/opt/codex-bridge`, leaving a lockfile with no
workspace root above it) where a `bun install` would have resurrected the removed
execution path. `tests/unit/version-drift.test.ts` now asserts that no lockfile
resolves the SDK and that any nested lockfile agrees with its own `package.json`,
so a regenerated lockfile cannot quietly reintroduce it.

Other textual references are intentional history or guards: `AGENTS.md` and
`codex-item-types.ts` explain the SDK's removal, while
`tests/unit/version-drift.test.ts` enforces it.

`config/codex-version.json` is the Codex source of truth. Its `version` and
`appServerProtocol.generatedFrom` fields must match. The generated lockfile-like
protocol surface lives under
`bridges/codex-bridge/src/app-server/generated/` and is produced by
`scripts/generate-codex-app-server-protocol.ts` from the exact pinned binary.

The main consumers of generated requests, notifications, server requests, and
thread items are:

- `bridges/codex-bridge/src/engine/app-server-engine.ts`
- `bridges/codex-bridge/src/app-server/server-request-router.ts`
- `bridges/codex-bridge/src/app-server/event-reducer.ts`
- `bridges/codex-bridge/src/app-server/item-adapter.ts`
- `bridges/codex-bridge/src/app-server-runtime.ts`

`bridges/codex-bridge/src/app-server/process-supervisor.ts` launches the binary
selected by `CODEX_PATH`. `apps/backend/src/core/commands.ts` also uses the
managed Codex binary for isolated `codex exec` helpers such as environment-name
generation; `apps/backend/src/core/session-title-runners.ts` is another
deliberate hermetic `codex exec` exception (session titles), and its test runs
the pinned binary's parser over the production argument shape.

### How to upgrade Codex

1. Change both `version` and `appServerProtocol.generatedFrom` in
   `config/codex-version.json`.
2. Mirror that exact value into:

   - `PINNED_TOOLCHAIN_VERSIONS.codex` in
     `packages/toolchain/src/manifest.ts`
   - `CODEX_CLI_VERSION` in `docker/Dockerfile`

3. Refresh and verify all four Codex artifact records using the shared binary
   procedure. Each of them also pins a `codex-code-mode-host` companion, whose
   archive and executable digests move independently of `codex`'s; the emitter
   prints them as a separate `<target> codex-code-mode-host` block. Codex spawns
   that helper from its own directory for every code-mode turn, so omitting it
   breaks every model that defaults to code mode with
   `failed to spawn code-mode host …: No such file or directory`.
4. Generate bindings from a new binary whose `--version` reports the new pin:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     mise run codex:protocol
   ```

   An explicit `CODEX_PROTOCOL_BINARY` is an assertion and does not fall back.
   Without it, the generator searches the managed cache for the pinned version,
   then `CODEX_PATH`, then `codex` on `PATH`, rejecting candidates with the wrong
   version.
5. Review, rather than blindly accept, the generated diff:

   ```bash
   git diff --stat -- bridges/codex-bridge/src/app-server/generated
   git diff -- bridges/codex-bridge/src/app-server/generated/protocol-manifest.json
   ```

   At minimum, inspect new server requests, removed or renamed client methods,
   new notifications and `ThreadItem` variants, status enum changes, and thread
   source kinds. Stop the upgrade if `turn/start.clientUserMessageId` or
   `userMessage.clientId` disappears: ambiguous-dispatch reconciliation and
   at-most-once prompt execution depend on them.
6. Run the offline and real-binary gates:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     mise run verify:codex:protocol
   bun test tests/unit/codex-app-server-protocol.test.ts
   bun run --cwd bridges/codex-bridge typecheck
   bun test bridges/codex-bridge/src --parallel
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
   ```

   The default live contract tests do not call a model or spend credits. They
   verify initialization order, method errors, model pagination/order, thread
   listing and reads, thread naming, MCP configuration acceptance, MCP
   protocol-era negotiation, project-trust behavior, and clean process shutdown.

   Also run the hosted network lock against the new binary. It points Codex at
   a loopback Responses endpoint and reads the tool list out of the first model
   request, so it spends no credits:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-network-lock.test.ts
   ```

   Treat a failure as a release blocker. The control case proves an ordinary
   thread is still offered web search (`web__run` in code mode); the others
   prove `web_search = "disabled"` removes it from coordinator and
   network-denied threads, that a researching coordinator reads back as
   `cached`, and that `config/read` still reports the mode the bridge checks
   before every coordinator thread. If the switch is renamed, update
   `codexNetworkDeniedConfig` and `codexHostedNetworkLockGaps` together;
   until then coordinator threads are refused, which is the intended failure.

   Then run the project-resources canaries, which also spend no credits:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-project-trust.test.ts
   ```

   A trusted checkout carries a config layer, AGENTS.md, two skills, an MCP
   server and two command hooks (which the throwaway user config trusts by
   hash). The control case must see every one; with project resources off
   none may reach the model or run, after a reload and in a linked worktree
   too. AGENTS.md still reaches such a thread once, through the bridge's own
   copy in the developer instructions. A failure means the untrusted pin no
   longer covers something the checkout can declare: treat it as a release
   blocker and report the resource as on until it is closed.

   Since 0.164.0 a turn opens with a `generate: false` prewarm frame, which
   the fakes skip. `features.incremental_tools`, on by default since 0.164.0,
   writes each turn's tool declarations into the thread history, so a resumed
   thread's request kept the build turn's `web__run` after a read-only reload
   dropped it from the turn's own tools. Thread config cannot turn the
   feature off, so every bridge launches app-server with
   `features.incremental_tools=false`: each request then declares only the
   current turn's tools and nothing is written to the history. The engine
   fails closed around it. It reads the setting back through `config/read`
   before a search-denied thread, and refuses a search-denied resume or fork
   whose rollout, or any fork ancestor, still holds an `additional_tools`
   record (a thread written while the feature was on). The read-only case
   asserts that a resumed read-only request declares `web__run` nowhere, and
   a second case proves the refusal on a history written with the feature
   on. If a release renames the switch or starts writing declarations with it
   off, these refuse search-denied sessions rather than leak search.

   The request looks the same in `cached` and `live` mode, so also run the
   canary, which copies the local auth file and spends three short turns. It
   proves `live` opens a page no index holds, `cached` does not, and a
   coordinator can call its Context7 research server:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 RUN_LIVE_CODEX_WEB_SEARCH_CANARY=1 \
     bun test bridges/codex-bridge/src/app-server/live-network-lock.test.ts
   ```

   If `cached` ever opens the fresh page, research coordinators must go back
   to `disabled` until a mode without live fetches exists.

   Then check how a sandbox refusal reaches the bridge, also on a loopback
   endpoint and without credits:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-refused-calls.test.ts
   ```

   It expects 0.164.0's behaviour, unchanged in 0.166.0: no item for a refused `apply_patch` or
   refused command, the cell and its refusal kept in the rollout, and the
   bridge showing each refused cell as a failed `exec` row in the order it
   ran. It also pins the exception: a cell an interrupt stops (below) records
   "aborted by user after …" with no item either, and gets no row. If the refusals now arrive as items, `RefusedCellTail` can go. If
   app-server stops reporting `thread.path`, or the rollout stops recording
   the cell, the rows disappear again. If the refusal wording changes,
   update `STRONG_REFUSAL_MARKERS` in
   `bridges/codex-bridge/src/sessions/refused-cell-tail.ts` and
   `SANDBOX_REFUSALS` in `apps/desktop/scripts/dev/coordinator-live.ts`, or
   the live coordinator suite fails Codex on create, edit and shell.

   Then check that a watched session's question still reaches the card, on
   the same kind of loopback endpoint and without credits:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-request-user-input.test.ts
   ```

   Every Orkestrator turn runs in Codex's Default collaboration mode, which
   refuses `request_user_input` unless the thread turns on the
   under-development `default_mode_request_user_input` feature
   (`codexRequestUserInputConfig`). The test expects 0.164.0's behaviour, unchanged in 0.166.0: an
   interactive session's call parks as a pausable question, the turn waits for
   the answer, and a `pipeline` session still gets "unavailable in Default
   mode". If the feature is renamed or removed, the first case fails: find the
   new switch, or take `question` back out of the Codex row in
   `nativeAgentCapabilities()`.

   The bridge publishes every parked question as blocking because 0.164.0's
   core awaits the answer whatever `isBlocking` says
   (`core/src/tools/handlers/request_user_input.rs` sets
   `is_blocking: mode == ModeKind::Plan`; only the TUI auto-resolves). On a
   bump, read that handler and `Session::request_user_input` again: if Codex
   starts resolving a non-blocking question itself, publish its limit as the
   question's `providerLimitAt` instead. To prove a paused question outlives
   the default deadline and Codex's own auto-resolution, run the same test
   once more with `RUN_LIVE_CODEX_QUESTION_DEADLINES=1` and
   `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=750000` through `test:logged`
   (a fixed 10.5-minute hold plus an unheld five-minute control; the command
   is in [agent-testing.md](agent-testing.md)). If the new binary starts
   sending `autoResolutionMs` or a different `isBlocking`, update the fake
   app-server's `question` script (`fake-codex-app-server.mjs`) so
   `fake-question-deadline.test.ts` keeps matching what Codex sends.

   Check that a read-only turn without Codex's command sandbox still reads
   through the bridge's own rules file (`orkestrator-read-only.rules`) and
   nothing else, on a loopback endpoint and without credits. It expects a
   chained `cat | head` to run without asking only when the rules are in
   place, and a redirection and `sed` to ask (and be declined) either way. A
   release that rejects the rules file fails every thread start, so a failure
   here blocks the bump:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-read-only-exec-rules.test.ts
   ```

   Then check that approving a command still saves no rule, on the same kind
   of loopback endpoint and without credits:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts
   ```

   Orkestrator never offers or sends Codex's exec-policy and network-policy
   amendments (see `bridges/codex-bridge/AGENTS.md`): accepting one writes a
   rule into the Codex home that Orkestrator can show but not revoke. The test expects 0.164.0's (and 0.166.0's)
   behaviour: an `untrusted` command approval carries
   `proposedExecpolicyAmendment`, **Approve** leaves `CODEX_HOME/rules/`
   empty, and the identical command asks again in the next turn. Its control
   answers with the amendment itself and finds `rules/default.rules`, then
   removes the rule and expects only a new thread to ask again. If a release
   adds an app-server method that lists and removes saved rules, add a
   list-and-revoke surface before offering the amendments again.

   Then run the same checks for a host, which also shows whether network rules
   are still where Settings → Permissions reads them. It needs Docker, downloads
   the pinned Linux binary inside a disposable container, and spends no credits:

   ```bash
   mise run verify:codex:network-approval
   ```

   Treat a failure in the "live MCP protocol era" block as a release blocker
   rather than a flaky test. Those two contracts stand in for every third-party
   HTTP MCP server that still speaks the 2025 protocol: the bridge relies on
   `features.mcp_2026_07_28` defaulting to off, and a version that flips that
   default silently breaks those servers in native sessions while they keep
   working in the Codex CLI.

   Check the blocks Codex writes into a thread as user messages of its own.
   A reload from the rollout drops a user message only when every segment is
   one of them (`CODEX_CONTEXT_FRAGMENTS` and the AGENTS.md heading checks in
   `bridges/codex-bridge/src/history/rollout.ts`); a new one would show as a
   **You** row after a resume that the live tab never showed. On 0.164.0
   they are `environment_context`, `skill`, `turn_aborted`,
   `subagent_notification` and `user_shell_command` (0.164.0 writes
   `turn_aborted` as a developer message; older releases wrote it as a user
   one). A loopback test runs a plain, a skill and an interrupted turn on the
   new binary, without credits, and checks the reload shows only the
   prompts. Its second test sends the bridge's rewritten prompts (plan-mode
   preamble, `$name`, a template expansion, a recovered transcript) and
   checks the reload still shows them as typed, which depends on Codex
   persisting the sent text item verbatim (`sessions/typed-prompts.ts`):

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-resume-context.test.ts
   ```

   It cannot see a block a turn it does not run would add, so also list how
   each user segment opens in rollouts the new binary wrote, and add any new
   Codex block to the list:

   ```bash
   find ~/.codex/sessions -name '*.jsonl' -mtime -2 -exec jq -r \
     'select(.type == "response_item" and .payload.type == "message" and .payload.role == "user")
      | .payload.content[] | (.text // "")[0:40] | gsub("\n"; " ")' {} + \
     | grep -E '^ *(<[a-z_]+>|# AGENTS)' | sed -E 's/^ *(<[a-z_]+>|# AGENTS[a-z. ]*).*/\1/' \
     | sort | uniq -c
   ```

   Run the separately gated approval canary when an upgrade could affect MCP
   tool approval semantics; it copies the local auth file and spends one short
   model turn:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     RUN_LIVE_CODEX_MCP_APPROVAL_CANARY=1 \
     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
   ```

   Any canary that runs a model turn needs `codex-code-mode-host` beside the
   binary `CODEX_PROTOCOL_BINARY` names (step 3's companion). Without it code
   mode fails closed, no tool is ever dispatched, and the approval canary
   fails for a reason unrelated to approvals.

   Codex 0.162 turned `features.instant_interrupt` on by default: `turn/steer`
   cuts the in-flight answer off instead of waiting for it. The cut-off agent
   message gets `item/started` and deltas but never `item/completed`, and
   `thread/read` omits it. `TurnAccumulator` settles it as `interrupted` (kept
   visible, never a structured-output candidate) when the next agent message
   starts or the turn ends, so the fragment is shown live but is absent after a
   re-attach rehydrates from history. A separately gated canary pins that
   shape; it spends one short model turn:

   ```bash
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     RUN_LIVE_CODEX_STEER_CANARY=1 \
     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
   ```

   Codex 0.164.0 made `features.code_mode_interrupt` and
   `features.incremental_tools` stable and on by default. An interrupt now
   stops a running code-mode cell: the rollout records `aborted by user after
   1.5s` as the cell's output and no item. That is not a sandbox refusal, so
   `RefusedCellTail` never reports it and a reload drops the cell's row (or,
   when it recorded other work, keeps the row without claiming success).
   `live-refused-calls.test.ts` pins it, interrupting through the engine
   rather than the runtime, whose own stop closes the tail first.

   Also new in 0.164.0, all handled without a canary:

   - A resume that names no model keeps the thread's saved model instead of
     the global default. The bridge still states a configured model on every
     resume and turn, and otherwise binds the model app-server reports, so a
     row's label matches what runs.
   - `thread/readState/changed` (Codex's unread marker) is ignored;
     Orkestrator keeps its own read state.
   - `imageGeneration` items carry the image as `fileId` (an attachment-store
     identity) or inline `result`, plus optional `inputImages` paths. The
     bridge reads only `savedPath` and the input paths; a generation without
     `savedPath` renders as its caption.
   - Usage no longer double-counts reasoning tokens. The bridge passes the
     counts through, so totals for comparable 0.164 turns read lower than
     0.162's; nothing compensated for the old count.

   Codex 0.166.0 changed four things the bridge relies on, all handled:

   - `review/start` lost detached delivery (`ReviewDelivery` is `"inline"`
     only); `startReview` takes the generated type.
   - Every `ThreadItem` may carry `startedAtMs` / `completedAtMs`; the
     generated union is now an intersection, which the protocol test still
     reads.
   - `CodexErrorInfo` gained `modelNotFound` (0.165, never retried) and
     `policyCapacityUnavailable` (retried like `serverOverloaded`, see
     `sessions/capacity-retry.ts`); both pass through `codexErrorInfoToCode`.
   - Idle threads with no subscriber unload after 60 s instead of 1800 s
     (`thread_unload_delay_secs`), so a thread the bridge has idle-detached is
     freed a minute later and its next attach is a cold resume from the
     rollout, which is what idle detach already assumes.

   Every `features.*` the bridge depends on kept its 0.164.0 stage and
   default (`codex features list` in a temporary `CODEX_HOME`).

   Codex 0.167.0 changed nothing the bridge relies on. The stable protocol
   gained one notification, `thread/section/changed` (ignored: thread sections
   are decided out), the `humanCommand` command-approval kind and
   `InitializeCapabilities.requiredHumanApproval` (both need `experimentalApi`,
   which the bridge does not send), and audio `fileId` inputs the bridge never
   sends. `features.deferred_tool_world_state` became stable and on: deferred
   MCP namespaces are now described in the world-state developer context
   checkpointed into history, much as `incremental_tools` did. The
   project-trust (including after a reload), network-lock and resume-context
   loopback tests pass with it on, so the bridge does not turn it off. Every
   other `features.*` the bridge depends on kept its 0.166.0 stage and default.

   On Linux, Codex's bubblewrap sandbox (0.166.0 and 0.167.0) masks each
   denied directory with a read-only tmpfs, shallowest first and after the
   read grants. So a coordinator's `":tmpdir" = "deny"` inside its
   `":slash_tmp" = "deny"` (any `TMPDIR` under `/tmp`, such as
   `/tmp/user/<uid>` or a test process's `/tmp/ork-test-tmp-*`) fails every
   sandboxed call with `bwrap: Can't create file <TMPDIR>: Read-only file
   system`, AGENTS.md loading at `thread/start` included. A checkout under a
   denied directory is also unreadable (`Permission denied`). The bridge
   leaves out exactly the Linux denials that would do either
   (`codexCoordinatorTmpDenials`); `":root" = "deny"` still hides both
   directories, because Linux's `:minimal` binds only system directories.
   After a Codex bump, re-check that `:minimal` list
   (`LINUX_PLATFORM_DEFAULT_READ_ROOTS` in `linux-sandbox/src/bwrap.rs`) and
   run `live-contract.test.ts`, `live-refused-calls.test.ts` and
   `live-coordinator-skills.test.ts` on Linux (no credits); the last also
   proves a file beside the grants stays unreadable. Their coordinator
   fixtures launch Codex as the backend does, with the canonical executable's
   directory as the readable runtime root: on Linux, Codex re-executes
   itself inside bubblewrap for every command. The refused-write assertions
   expect each platform's own errno text: `Read-only file system` (EROFS)
   on Linux, `Operation not permitted` (EPERM) on macOS.

   Codex 0.153.3 defaults new durable threads to paginated history and eagerly
   writes their rollout header, but `thread/read(includeTurns=true)` returns
   `list_turns is not supported yet` until the first user message indexes the
   thread. The bridge accepts that as an empty thread only after a metadata read
   confirms the untouched, idle start snapshot; keep that live assertion when
   reviewing later versions because it protects at-most-once dispatch recovery.
7. Replay committed notification recordings:

   ```bash
   bun test bridges/codex-bridge/src/app-server/notification-replay.test.ts
   ```

   Unknown methods or unsupported item types require an adapter decision. Do
   not update a snapshot until the rendering change is understood. If recording
   new fixtures, remember that raw recordings can contain prompts, file contents,
   absolute paths, credentials, and tokens; run
   `scripts/scrub-codex-recording.ts`, use `--strip-content` when appropriate,
   and inspect the diff before committing.
8. Re-prove the MCP editor's Codex rules on the new binary, without
   credentials:

   ```bash
   CODEX_CLI_PATH=/absolute/path/to/new/codex mise run verify:codex:mcp-live
   ```

   It compares `codex mcp list --json` in throwaway homes with the catalogue:
   project trust (`codexProjectTrust` in `native-policy.ts`: exact
   `[projects."<path>"]` keys, worktree then main checkout), field-by-field
   merging of same-name entries (`codexMergedStatus` in `catalog.ts`), and
   which files are sources. A failure means the editor's Codex rows no longer
   match what Codex loads; fix the mirror and the table in
   [`mcp-management.md`](../architecture/mcp-management.md) before bumping.
9. Search for the old version literal. Runtime comments marked “Verified
   against codex …” need to be revalidated before their version is changed.
   Test fixtures and fake user-agent strings do not all need to track the pin;
   update them only when the assertion is intended to represent the current
   binary.

See `docs/architecture/agent-engines.md` for the architectural and
safety constraints behind this process. Upstream release source:
[OpenAI Codex](https://github.com/openai/codex).

## OpenCode

OpenCode is 2.x only: its one pin is the toolchain's `opencode2`, upgraded as
described below. The OpenCode 1.x pin (`PINNED_TOOLCHAIN_VERSIONS.opencode`,
`OPENCODE_CLI_VERSION`), its `@opencode-ai/sdk` mirror and their upgrade steps
were retired with 1.x; the last version of this section is in
`git show 5f4e27b1c:docs/development/upgrade-agents.md`.

### OpenCode 2.x (`opencode2`)

OpenCode 2.x is the `opencode` platform's only binary, pinned under the
toolchain name `opencode2`, the name it had while it was pinned beside 1.x
(`docs/todo/agent-engines/0008-opencode-v2.md`), so installed toolchain
directories stay where they are.

- `PINNED_TOOLCHAIN_VERSIONS.opencode2` in `packages/toolchain/src/manifest.ts`
  and `OPENCODE2_CLI_VERSION` in `docker/Dockerfile`. There is no SDK pin: the
  2.x client is the backend's own (`apps/backend/src/core/opencode2/`), not
  `@opencode/client`.
- Artifacts are the per-platform npm packages `@opencode/cli-<target>`
  (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`; the optional
  dependencies of `@opencode/cli`), fetched from `registry.npmjs.org`. The
  executable is `package/bin/opencode` in each tarball and is installed as
  `opencode2`, never as `opencode`: that name on `PATH` is the user's own
  install. Use the glibc builds; the `-musl` and `-baseline`
  variants are not used. The darwin binaries are published validly signed, so
  `repairInvalidMacSignature` is not set and the installed bytes are the
  upstream bytes.
- The container installs it root-owned at `/opt/opencode/bin/opencode2`,
  reached as `/home/node/.opencode/bin/opencode2` (`OPENCODE2_CLI_PATH`),
  checks it with `--version` at build time and records it as
  `agents.opencode2` in the image manifest. A terminal's `opencode` is the
  wrapper `docker/opencode-cli.sh`, which defaults `OPENCODE_DB` to the
  server's database; the build checks it reports the same version.
  `OPENCODE_DISABLE_AUTOUPDATE=1` is set image-wide.
- The 2.x provider (`apps/backend/src/core/opencode2/`) launches it for every
  OpenCode session, local and in containers, so a bump also reruns the 2.x
  live set (step 8).

To bump it:

1. Confirm all four `@opencode/cli-<target>@<version>` packages are published
   (`npm view @opencode/cli-linux-x64@<version> version`, and so on).
2. Set the version in `PINNED_TOOLCHAIN_VERSIONS.opencode2` and
   `ARG OPENCODE2_CLI_VERSION`.
3. Record each target's archive and executable size and SHA-256. The live
   verifier downloads the tarballs the manifest's URLs name and prints them:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --emit --tool=opencode2
   ```

   To cross-check by hand, in an empty directory per target:
   `npm pack @opencode/cli-<target>@<version>` (archive: `stat` and
   `shasum -a 256` of the `.tgz`), then `tar -xzf` it without running any
   install script and hash `package/bin/opencode` the same way (executable).
   The two must agree with the verifier's output.
4. Paste the values into the four `openCode2Artifact(...)` calls, and copy the
   two `linux` archive digests into the Dockerfile's `OPENCODE2_SHA` branches
   (`amd64` is `linux-x64`, `arm64` is `linux-arm64`); `version-drift.test.ts`
   holds them to the manifest.
5. Assert the manifest against fresh downloads (the same command without
   `--emit`). On macOS, check the darwin binary still verifies
   (`codesign -v <extracted binary>`); if it does not, set
   `repairInvalidMacSignature` on the darwin entries and drop nothing else.
6. Prove the install path end to end with a temporary data directory, never the
   app's own (`mise run toolchain:install` repoints the real app's toolchain):
   call `installPinnedToolchains({ dataDir: <temp>, tools: ["opencode2"] })`
   from `packages/toolchain/src/install.ts` with `HOME` and `XDG_*` pointed
   into the same temporary directory. It downloads, verifies, probes
   `--version` (2.2.6 prints `opencode v2.2.6`) and activates. 2.x's
   `--version` creates its XDG directories and a log file but no database.
7. Run `bun test ./tests/unit/version-drift.test.ts ./tests/unit/download-agent.test.ts --parallel=2`.
8. Run the 2.x live set against the new binary. Every test starts its own
   `opencode serve` under a temporary `HOME`/`XDG_*`/`OPENCODE_DB` with a
   scripted local model, so it needs no credentials and makes no billed turn:

   ```bash
   OPENCODE2_CLI_PATH=/absolute/path/to/extracted/package/bin/opencode \
     mise run verify:opencode2:live
   ```

   It covers launch and health, the provider (dispatch, steer, activity,
   interrupt, close), interactions, transcript and features, MCP, workflow
   connections, the user's configuration, coordinators, routing, the container
   plugins and package cache, the event-stream silence watchdog, and the
   qualification checks (an exact input retry, a turn nobody reads, a server
   restart under a live provider, archive and restore). Also follow the
   "Qualification" list in `0008-opencode-v2.md`; its real-stack half is the
   idle-observation spec's OpenCode cases on fake models ([agent-testing.md](agent-testing.md)), run against a
   disposable profile by
   `ORKESTRATOR_AGENT_TEST_PROFILE=<profile> mise run verify:opencode2:real-stack`
   (the profile started with `--fixture --no-agent-credentials
   --agent-platforms opencode --headless`). If
   `opencode2-silence.live.test.ts` fails, the server's `: heartbeat` interval
   (15 s at 2.2.6) has changed: measure it again and set
   `OPENCODE2_EVENT_STREAM_SILENCE_MS` (`opencode2/stream-silence.ts`) to about
   three missed heartbeats plus 5 s.

Upstream references: [OpenCode releases](https://github.com/anomalyco/opencode/releases)
and [OpenCode SDK documentation](https://opencode.ai/docs/sdk/).

## Pi

### Where the contract lives

Pi is pinned in three places that must move together, because the SDK the
bridge drives and the `pi` binary a terminal tab runs are the same program
published two ways:

- `bridges/pi-bridge/package.json` — `@earendil-works/pi-coding-agent` and the
  two packages it exposes types from (`@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core`). `@earendil-works/pi-server`, which the
  `0.85.0` entry point imported without declaring, is no longer pinned or
  vendored: no published SDK file had imported it since `0.85.1`, and Pi
  `1.2.0` removed the experimental server stack and stopped publishing it.
  Check on each bump that every `@earendil-works/*` package an SDK file
  imports (`pi-tui`, `pi-mcp`, `pi-codemode` as of `1.4.0`,
  `pi-telemetry` through `pi-ai`, and `pi-schema` through `pi-ai` and
  `pi-agent-core` since `1.5.0`, which replaced their TypeBox dependency) is a
  declared dependency of the package that
  imports it, which is what the vendor step follows — the `0.85.0` failure
  mode was an undeclared import.
- `packages/toolchain/src/manifest.ts` — `PINNED_TOOLCHAIN_VERSIONS.pi`
  and four `bundleIntegrity` records.
- `docker/Dockerfile` — `PI_CLI_VERSION` and the two Linux archive digests.

`tests/unit/version-drift.test.ts` enforces that all three agree, and that the
Dockerfile pins the same archive digests the manifest does.

### Procedure

1. Bump the three SDK dependencies in `bridges/pi-bridge/package.json`, then
   `bun install`, then regenerate the standalone package's Pi runtime (see
   [Bridges a backend-only host installs on demand](#bridges-a-backend-only-host-installs-on-demand)):

   ```bash
   bun packages/cli/scripts/lock-bridge-runtimes.ts
   ```

   Pin all three SDK packages at the **CLI's** version even when npm has a newer
   patch for some of them: `pi-ai` and `pi-agent-core` sometimes publish an
   extra patch (0.99.1) with no matching `pi-coding-agent` or `pi` release, and
   `pi-coding-agent` depended on them by `^` range. Since `1.3.0` Pi pins its
   own packages exactly, so that reason is historical; keep the exact pins
   anyway, so the SDK and the shipped binary stay on the set the release was
   tested with and a bump that misses one of the three fails to install.
2. Bump `PINNED_TOOLCHAIN_VERSIONS.pi` and `ARG PI_CLI_VERSION` to the same
   version.
3. Refresh the four artifact records. Unlike the single-file agents, Pi ships a
   bundle — the launcher reads its themes, docs, examples and a native helper
   module from beside itself — so each record carries a `bundleIntegrity` digest
   over the whole extracted tree as well as the archive and executable digests.
   `--emit` prints all of them:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts --emit --tool=pi
   ```

   Paste the values in, then assert them:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts --tool=pi
   ```

4. Copy the two `linux` archive digests into the Dockerfile's `PI_SHA` branches.
   They are verified by `sha256sum -c -` during the image build, so a version
   bumped without them fails `mise run docker:build` rather than shipping an
   unverified binary.
5. Review `bridges/pi-bridge/src/translate.ts` against the SDK's
   `AgentSessionEvent` union. This is the compatibility surface: a new event
   type degrades to "not rendered", which is safe but silent, so a bump that
   adds one is a bump that may quietly stop showing something. Since Pi 1.1 the
   bridge also reads three provider measurements here, so check they still
   exist: `agent_settled.aborted` (a run anyone aborted — the bridge, an
   extension's `ctx.abort()`, Pi itself — ends the turn cancelled, with a
   retryable `interrupted` structured result, instead of completed),
   `tool_execution_end.durationMs` (the card's `toolDurationMs`, nested
   `ctx.executeTool()` calls included) and `AssistantMessage.durationMs`
   (summed per turn into the usage row's `apiDurationMs`). Since 1.3 a call
   whose arguments were not a JSON object (`ToolCall.argumentsError`) fails in
   validation, before any `tool_call` hook, so the approval gate never parks
   it; it arrives as a `tool_execution_end` error with `{}` input and no
   `durationMs`, and the shared `toolError` carries Pi's text, received
   arguments included. `summarization_retry_*` (a compaction's summary
   request retried) render as the shared retry row, settled by
   `compaction_end`. `src/sdk-session.test.ts` drives a real SDK session over a
   scripted model stream for the behaviours a fake session cannot show.
6. Review `src/models.ts` against `Model` and `ThinkingLevel`. A new thinking
   level that is not in `THINKING_LEVELS` is simply never offered. Remember the
   rule is asymmetric: `xhigh` and `max` need an *explicit* mapping, while every
   other level is included unless mapped to `null`. Also recheck the ChatGPT
   login fallback (`chatGptLoginModelIds`): it reads the `openai-codex`
   provider's built-in catalogue as the list a ChatGPT login runs, newest id
   last, and relies on `ModelRuntime.isUsingSubscription`. The "ChatGPT login
   fallback against the pinned SDK" tests in `src/models.test.ts` fail if the
   catalogue stops starting on `openai/gpt-4`, stops covering the backend's
   ids, or the pick moves off `gpt-6.1-sol`; a moved pick is fine only if
   Pi's own `defaultModelPerProvider["openai-codex"]` moved with it.
   At 1.5.0 the newest backend model became `gpt-6.1-terra` while Pi's own
   default for both ChatGPT providers stayed `gpt-6.1-sol`, so
   `chatGptLoginModelIds` now puts `PI_CHATGPT_DEFAULT_MODEL` first, and
   `models.test.ts` reads Pi's (unexported) `defaultModelPerProvider` table
   from `dist/core/model-resolver.js` and fails when a bump moves it. The
   `openai` catalogue now starts on `chat-latest` rather than `gpt-4`.

   1.5.0 also stopped a package that fails to install from failing the
   session: it is reported in `LoadExtensionsResult.warnings` instead, which
   `recordExtensionLoadDiagnostics` turns into a warning notice. A resumed
   session now runs in the working directory it recorded, not the caller's;
   the bridge's worktree and container paths are stable, so nothing moved.

7. Re-verify the three SDK behaviours the bridge depends on, in
   `dist/core/agent-session.js`, rather than trusting the version in a comment:

   - **Preflight.** `prompt()` reports an accepted prompt through
     `preflightResult(disposition)` with `started`, `queued` or `handled` (0.99;
     0.87 passed a boolean and also called it with `false` before rethrowing). It
     is never called for a refusal, so refusal is only the rejected promise.
     `prompt.ts` treats any disposition as accepted. Since 1.2, `started` is
     reported from inside `_startRun`, after `_prepareRun` (auto-compaction,
     `before_agent_start`): the session already counts as busy there, an
     `abort()` in that window sets `_agentRunAbortRequested`, pre-empts the run
     at `agent_start` and waits for it to settle, while an `abort()` earlier in
     preflight (input handlers, auth) reaches nothing and is erased when
     `_startRun` resets the flag. That is why the bridge aborts both at once and
     on acceptance, and never awaits the startup abort.
   - **Steer and follow-up.** `steer()` and `followUp()` resolve to
     `queued` or `handled`. `handled` means an extension's `input` handler
     consumed the instruction, so no delivery event will follow; `handleSteer`
     removes its FIFO entry rather than let the next delivery be credited to it.
   - **Nested tool calls.** A call another tool made through `ctx.executeTool()`
     (how `codemode` scripts call tools) carries `parentToolCallId`, which
     `translate.ts` stamps as the shared `parentTaskUseId`. A resume has only
     the calling result's `nestedCalls` record (ids `<caller>/<n>`, no
     results), from which `replayNestedToolCalls` rebuilds the children.
   - **Resumed tool loadout.** Since 1.3 a resume restores the active tools
     the transcript recorded and activates extension tools it never
     mentioned, which is how an MCP server added after a session was saved
     reaches it on reattach.

   The `mcp.json` the bridge reads is Pi's own file, so `src/mcp-config.ts` must
   follow Pi's documented format (the `mcp.md` guide shipped inside the SDK package): `enabled: false`, `$NAME` /
   `${NAME}` values, `~/` and `cwd`. `resolveConfigValue` is not a public SDK
   export, so the bridge re-implements the variable rules and deliberately does
   **not** run `!command` values: an entry that needs one is skipped, as Pi skips
   an entry it cannot resolve. The merge follows Pi 1.0's loader
   (`dist/extensions/mcp/config.js`): an entry Pi's validator
   (`validateMcpServerConfig` in `dist/core/mcp-servers.js`) rejects hides
   nothing, a project override (no `command`, `url` or `type`) flips only the
   user server's `enabled`, names that differ only in `-`/`_` clash, and
   `auth: { provider }` on an HTTP server is refused in a project file and, in
   the user file, not launched (the bridge holds no Pi provider token).
   Since 1.4.0 the loader strips one leading UTF-8 BOM before parsing
   (`stripBom`); the bridge does the same, and the backend already does
   because its `TextDecoder` drops the BOM on decode, so an editor save writes
   the file back without one, as Pi's own editor does. A fixture needing bytes
   `JSON.stringify` cannot produce is a `RawMcpConfigText`.
   Re-read that loader on each bump, then run both parity tests over the
   shared fixtures in `src/testing/mcp-config-fixtures.ts`:
   `src/mcp-config-upstream.test.ts` loads the pinned package's own
   `loadMcpConfig` and fails when Pi's rules move (if the loader file itself
   moves, find it again), and
   `apps/backend/src/core/mcp-management/pi-mcp-parity.test.ts` holds the
   backend MCP catalogue (`markPiLoadRules` in `catalog.ts`, `piEntryShape`
   and `piLaunchBlock` in `codecs.ts`) to the bridge. A rule change goes into
   the bridge, the backend mirror and a fixture together; a deliberate
   difference from Pi gets a fixture with its `pi` reason. Pi's built-in
   `mcp`, `codemode` and `tool-search` extensions are loaded only by its CLI
   (`main.js`), never by an SDK session, so they do not collide with the
   bridge's own `orkestrator-mcp` extension; a Pi terminal tab does load them,
   which is why the MCP editor's Pi terminal guidance describes Pi's own
   loader. Confirm
   that with `rg builtInExtensions node_modules/@earendil-works/pi-coding-agent/dist`
   on each bump.
8. Rebuild the vendored bridge and run its suite. Like the Claude and Cursor SDK
   bridges, the build keeps the SDK external and a `vendor` step copies it into
   `dist/node_modules` — the SDK compiles extension TypeScript with jiti and
   reads themes and templates from files inside its own package, neither of
   which a bundler can follow. A successful typecheck does not prove the
   distributable bridge is complete:

   ```bash
   bun run --cwd bridges/pi-bridge typecheck
   mise run build:pi-bridge
   bun test bridges/pi-bridge/src --parallel
   ```

9. Smoke-test one interactive Pi tab and one terminal tab, including a model
   switch, a compaction, and the inactive-environment path. Because Pi fronts
   the user's own providers, also confirm that the per-provider sign-in status
   still reports correctly for at least one signed-in and one signed-out
   provider.

Upstream references: [Pi releases](https://github.com/earendil-works/pi/releases)
and [Pi SDK documentation](https://pi.dev/docs/latest/sdk).

## Cursor (SDK bridge)

`bridges/cursor-bridge` is the only engine for Cursor sessions. It drives
Cursor's TypeScript SDK in process and does not require a Cursor CLI.

### Where the SDK is used

`bridges/cursor-bridge/package.json` exact-pins `@cursor/sdk`.
`tests/unit/version-drift.test.ts` verifies that the pin is exact and that no
Cursor CLI artifact or Dockerfile version argument is reintroduced.

The compatibility surface is five files:

- `src/agent-session.ts` — `Agent` and `SDKAgent`. Constructs the agent, sends a
  turn, and owns cancellation.
- `src/translate.ts` — the `InteractionUpdate` union. This is the main surface:
  an update variant the SDK adds is simply not rendered, which is safe but
  silent, so a bump that adds one is a bump that may quietly stop showing
  something.
- `src/tool-rendering.ts` — the typed tool vocabulary, mapped onto the
  provider-neutral tool card. A new tool variant must degrade to a plain card,
  never throw; these branches run mid-turn on the SDK's own callback.
- `src/models.ts` — `ModelListItem` and `ModelSelection`. Only the `effort` and
  `fast` model *parameters* map onto shared composer controls; the pre-combined
  variants are deliberately ignored. A newly meaningful parameter is a decision,
  not an automatic mapping.
- `src/credentials.ts` — `Cursor`, `FileCredentialStore`, and
  `SdkCredentialStore`, plus the login flow `src/login-cli.ts` runs as a
  short-lived `--login` child.

### Why the build keeps the SDK external

`bridges/cursor-bridge/scripts/vendor.ts` stages `@cursor/sdk` and its whole
runtime closure into `dist/node_modules`, and the build passes
`--external @cursor/sdk`. Both halves are load-bearing and neither is visible to
a typecheck:

- The SDK's ESM build code-splits into numbered chunks it loads with dynamic
  `import()`. A bundler inlines the static graph but cannot follow those, so a
  bundled bridge starts, serves routes and mints a login URL — then dies with
  `Cannot find module './401.js'` the first time a lazy path runs.
- The flat build that bun's `bun` export condition selects imports its
  dependencies by bare specifier, and finds its native platform package
  (ripgrep, the sandbox helper, the tree-sitter grammars) by walking up from the
  entry script for `node_modules/@cursor/sdk-<platform>/`.

The closure is walked rather than hard-coded, so a new transitive dependency is
staged automatically — but a new *platform* package name is not.
`bridges/cursor-bridge/src/build-output.test.ts` checks the built bundle's shape,
and skips itself when `dist/` is absent. There is no CI job that builds this
package, so on a clean checkout those assertions do not run at all. Build before
trusting a green result.

### How to upgrade the Cursor SDK

1. Set the exact version of `@cursor/sdk` in
   `bridges/cursor-bridge/package.json`, then refresh the root lockfile:

   ```bash
   bun install
   ```

   Confirm `bun.lock` resolves the intended version and note which
   `@cursor/sdk-<platform>` optional packages it brought in. There is no CLI
   pin, no `scripts/download-*.sh`, no manifest entry, and no Dockerfile `ARG`
   to mirror. The diagnostic seam patch does have to move with it: `bun install`
   only warns that the old patch no longer applies, so regenerate it with
   `bun patch` against the new bundle, using the
   [bindings described above](#what-is-enforced-and-what-is-not). The
   version-drift and `sdk-diagnostics` tests fail until it is done.
   The standalone package carries its own copy of the pin and the
   patch registration; regenerate it once the patch for the new version is in
   place (see
   [Bridges a backend-only host installs on demand](#bridges-a-backend-only-host-installs-on-demand)):

   ```bash
   bun packages/cli/scripts/lock-bridge-runtimes.ts
   ```
2. Review the five compatibility files above against the new type definitions.
   Pay particular attention to `InteractionUpdate` variants and tool cases added
   upstream: both degrade silently by design.
3. Rebuild and prove the distributable shape, which a typecheck alone does not:

   ```bash
   bun run --cwd bridges/cursor-bridge typecheck
   mise run build:cursor-bridge
   bun run --cwd bridges/cursor-bridge test:bridge
   ```

   Run the suite through `test:bridge`, which preloads `tests/setup-node.ts`.
   A bare `bun test bridges/cursor-bridge/src` from the root picks up the root
   DOM preload, whose `Response` is not the one Hono returns, so the HTTP route
   tests fail there (seen 2026-11-06 at 1.3.1).
   Run the build *before* the test. `build-output.test.ts` skips its bundle
   assertions when `dist/` is absent, so the reverse order reports success
   without checking anything.
4. Confirm the vendored tree still contains the SDK, its platform package, and
   the bare-specifier closure:

   ```bash
   ls bridges/cursor-bridge/dist/node_modules/@cursor
   ```

   A missing platform package does not fail the build; it fails at the first
   transport call in a live session. Since 1.0.40 `zod` is a *peer*
   dependency the flat build still imports (`zod`, `zod/v3`, `zod/v4`,
   `zod/v4-mini`); `bridges/cursor-bridge/scripts/vendor.ts` stages required peers, so
   `dist/node_modules/zod` must be present too. Workspace `node_modules` can
   mask a missing one on a dev host, so prove it from an isolated copy:

   ```bash
   cp -R bridges/cursor-bridge/dist /tmp/cursor-dist-check
   bun -e 'await import("/tmp/cursor-dist-check/node_modules/@cursor/sdk/dist/bundled/index.js")'
   ```
5. Rebuild the container, which builds this bridge from the same lockfile:

   ```bash
   mise run docker:build
   ```

6. Smoke-test sign-in through the bridge's `--login` child, run a turn with tool
   calls and a diff, switch model and effort, cancel mid-turn, and check the
   inactive-environment path.
   `src/login-no-open-browser.test.ts` runs the pinned SDK's login with a fake
   system opener and fails if `NO_OPEN_BROWSER` no longer stops the launch: a
   sign-in started from another machine's Settings relies on it (checked on
   1.0.40).
7. [Re-trace preserved provider state](#re-trace-preserved-provider-state):
   confirm the SDK's local agent store still writes only under the root
   `cursorSdkStateDirectoryPath()` hands it. (1.0.40 added an OS-temp
   `cursor-transcripts-*` fallback for agent transcripts when the home
   directory is not writable; those are not resume state.)
8. Check how the SDK decides Max mode. Since 1.0.40 a send runs in Max mode
   (premium billing) when every catalogue variant consistent with its
   parameters is `isMaxMode`. `selectionIsMaxMode` in `src/models.ts` mirrors
   that rule to publish the shared composer's `selectionPricing`, and the run's
   reported `model.maxMode` becomes the turn's `pricingTier`; re-check both if
   the SDK changes the rule.

Sub-agent cards are the one behaviour to re-check by hand on every bump. The SDK
reports children only through nested updates on the parent run, so a child is
reported as detached when its parent ends rather than as completed. If a bump
adds a channel that outlives the parent run, that workaround should shrink
rather than be widened.

Upstream reference: [`@cursor/sdk` on npm](https://www.npmjs.com/package/@cursor/sdk).

## Grok (ACP)

### Where the CLI contract lives

This section covers the `grok` CLI the ACP bridge spawns. It is pinned in
`packages/toolchain/src/manifest.ts` and `docker/Dockerfile`. There is no
Grok SDK: the ACP bridge speaks ACP with the CLI over stdio. That makes its
**command-line flags a versioned contract**, and it is the part of an upgrade
nothing in CI can check. See
`docs/architecture/agent-engines.md` for the bridge architecture.

The bridge does pin the protocol's own package,
`@agentclientprotocol/sdk` in `bridges/acp-bridge/package.json` (`2.4.0`). It
supplies the wire types and `PROTOCOL_VERSION`, not a client: every request is
still hand-written over the bridge's own JSON-RPC loop.
`tests/unit/version-drift.test.ts` lists it as Grok's SDK pin with
`tracksCli: false`, because it versions the protocol, not Grok. When bumping
it, diff `dist/v1/schema/types.gen.d.ts` (stable ACP v1) and
`dist/v1/unstable/schema/types.gen.d.ts` against the previous release for
changed session capabilities, `session/*` request shapes, prompt capabilities,
stop reasons and session-update variants, then run the bridge typecheck and
suite. 1.5.1 → 1.8.0 changed only unstable surface the bridge does not use (MCP
over ACP was reshaped; `subagent_update`, `session_message` and state updates
were added); `session/close`, `session/resume`, `session/list`,
`promptCapabilities` and `StopReason` are unchanged.

1.8.0 → 2.0.1 split the package by stability. The default import is now stable
ACP v1 only, and `PROTOCOL_VERSION` there is still `1`; unstable types moved to
`@agentclientprotocol/sdk/unstable` and ACP v2 to `…/experimental/v2`. Moved
off the default import: `PromptResponse.usage` and `Usage`, the `acp` variant
of `McpServer`, and the `plan_update`, `subagent_update` and `session_message`
updates. The bridge's three imports (`acp-prompt.ts`, `acp-context.ts`,
`acp-client-methods.ts`) are all still on the default export. It reads usage
and every session update untyped, so moved types change nothing at runtime,
and it builds only `http` MCP servers. Import from `/unstable` only for a
surface the bridge really implements; never mix the v2 types into the v1 wire.

2.0.1 → 2.1.0 changed no stable v1 type the bridge reads (`PROTOCOL_VERSION`
is still `1`; `StopReason`, the session-update variants, `sessionCapabilities`
and `promptCapabilities` are unchanged). It added `RequestError.sessionNotFound`
(`-32002`, an agent-side helper), unstable MCP-over-ACP behind
`./experimental/mcp-http` and `./experimental/mcp-server`, and an optional peer
`@modelcontextprotocol/server` that only those entries import.

2.1.0 → 2.4.0 (schema 1.28 → 1.29.1) changed only doc comments in the stable
v1 types; all fourteen types the bridge imports are identical and
`PROTOCOL_VERSION` is still `1`. `Cost.currency` may now be a non-money unit
such as `"credits"`, which `parseUsdCost` already ignores. The unstable surface
gained `session/archive`, `auth/status`, `session/set_title` and
`session/status`, none of which Grok 1.0.77 advertises, and dropped JSON-RPC
batch types the bridge never used.

The bridge launches Grok with `--always-approve agent stdio`. Grok 1.0.52 still
asks over ACP for every edit, command, fetch and MCP call (MCP calls arrive as
its `use_tool` wrapper), and the bridge answers them itself under the
`auto-approve` policy (`autoApprovedPermissionOption` and
`orkestratorToolPermissionOption` in `acp-session.ts`). After a bump, check
that a live Grok edit still completes without an approval card, and that an
Orkestrator tool called through `use_tool` is still matched.

`bridges/acp-bridge/src/acp-server.test.ts` asserts these vectors against
`bridges/acp-bridge/src/testing/fake-agent.ts`, which records its own argv and
accepts anything. A
renamed or removed upstream flag therefore leaves the suite green and breaks
every ACP session at runtime. After bumping the pin, confirm the real CLI
still accepts the flags:

```bash
# The flag must still be listed as a global option, not a subcommand option.
grok --help | rg -- '--always-approve'

# It must start and wait for JSON-RPC rather than exiting on an argv error.
# Hold stdin open for longer than the timeout: at EOF it exits 0 at once, which
# proves nothing (1.0.77 exits about 0.1 s after EOF, 1.0.70 took about 2 s, so
# a `sleep 4` feeding a `timeout 6` now reports exit 0 on a healthy binary).
# Exit 124 (killed by the timeout, still alive) is the passing result; a bogus
# flag exits 2.
# macOS has no `timeout`. Without one, hold stdin open on a FIFO, start grok
# in the background, and check its own pid is still alive after a few seconds.
(sleep 10 | timeout 6 grok --always-approve agent stdio; echo "exit $?")

# Then prove the handshake and a real `session/new` with the bridge's own params
# (typed `headers` array, `additionalDirectories: []`). 1.0.44, 1.0.46 and
# 1.0.52 answer both; 1.0.67 and 1.0.70 were checked signed out only
# (`initialize` answers, identically on both, and the liveness probes stay up). Run it signed in (`grok login`): signed out, `session/new` ends
# in `Authentication required`, and once signed in `authMethods[0]` (the id the
# bridge authenticates with) is `cached_token` rather than `grok.com`.
```

A session whose policy denies `network` (every coordinator and read-only
session) is launched as `grok --disable-web-search [--always-approve] agent
--no-leader … stdio`. Grok searches without asking permission, so the flag is
the only thing that removes web search and web fetch, and it removes both, so
a coordinator's research setting is not honoured on Grok. The binary also
mentions `GROK_DISABLE_WEB_FETCH`; if a bump documents it as a fetch-only
switch, it could give Grok coordinators search without fetch. After a bump,
confirm the flag is still a global option and still covers both tools:

```bash
grok --help | rg -- '--disable-web-search'
(sleep 10 | timeout 6 grok --disable-web-search agent --no-leader stdio; echo "exit $?")
```

Run these against the pinned version, not whatever is on `PATH` — compare
`grok --version` against `PINNED_TOOLCHAIN_VERSIONS.grok` and
`GROK_BUILD_VERSION` first. `--always-approve` is deliberate: an ACP tab is an
interactive session and matches the Claude bridge's local bypass-permissions
default.

### What Grok declares versus what it does

Re-check these against the real binary on a bump; the fake agents in the suite
encode them and cannot notice a change. Each bullet says what was re-verified
against 1.0.67 signed out (`initialize`, `--help`, `strings`, the changelog);
anything that needs a session is still as last verified against 1.0.52. At
1.0.70 the same signed-out checks found nothing changed: the `initialize`
answer is identical, every flag and `x.ai/*` name below is still present, and
the 1.0.68–1.0.70 changelogs touch only the TUI, dashboard, worktree copies,
experiments and the updater.

- **Images.** Since 1.0.67 `initialize` answers `promptCapabilities.image:
  true` (re-verified signed out; 1.0.52 answered `false` while reading the
  block, and was credited in `undeclaredPromptCapabilities`, now empty, in
  `bridges/acp-bridge/src/acp-provider-config.ts`). The bridge refuses image
  attachments a provider does not declare, so the declaration now decides.
  That 1.0.67 still describes an inline `image` block sent with no path in the
  text needs a signed-in check. If Grok ever stops reading the block, set
  Grok's `attachments.images` to `false` in `nativeAgentCapabilities`.
- **Files.** 1.0.67 and 1.0.70 answer `promptCapabilities.embeddedContext:
  true`, so Grok's capability row offers file attachments
  (`attachments.files`). The bridge sends a text file as an ACP `resource`
  block with its contents inline, refuses binary content, and refuses any file
  when the agent stops advertising `embeddedContext`. Proved signed in on 1.0.67
  (2026-10-31), including a block whose `uri` named a file that does not exist,
  so Grok answers from the block itself. If a release stops reading it, set
  Grok's `attachments.files` back to `false`.
- **MCP elicitation.** Grok tells its MCP servers it supports `elicitation` and
  forwards each request as the extension request `_x.ai/mcp/elicit`
  (`toolCallId`, `serverName`, `message`, `mode`, then `requestedSchema` or
  `url` and `elicitationId`), including over `agent stdio`. The answer is tagged
  by `outcome`: `{outcome:"accept",content}`, `{outcome:"decline"}` or
  `{outcome:"cancel"}`. Grok reads anything else as malformed and cancels without
  saying so, so an `action` key from MCP's own shape silently fails. It sends
  `_x.ai/session_notification` with `interaction_resolved` when a request ends.
  Proved signed in on 1.0.67 through the bridge (2026-10-31); `strings` show the
  same types in 1.0.70.
- **Session fork.** `_x.ai/session/fork` takes `sourceSessionId`, `sourceCwd`
  (required) and `newCwd`, and optionally `targetPromptIndex`; it answers
  `newSessionId`, and the fork loads with `session/load`, in the same or a fresh
  process. Grok does not advertise ACP's own unstable `session/fork`. The index
  keeps whole turns up to and including that prompt, and an index past the end
  silently copies everything. `_x.ai/rewind/points` lists `prompt_index` and
  `prompt_preview`, and `/compact` takes no index of its own. A fork at a point
  before a compaction still holds what followed it, as summary, because
  compaction squashes the history it copies. Proved signed in on 1.0.67
  (2026-10-31); both methods are in 1.0.70's `strings`.
- **Main-checkout approvals.** 1.0.67 lets a git worktree use its main
  checkout's saved "always allow" answers by default
  (`[features] worktree_inherits_main_approvals`), which would let a tool run
  in an Orkestrator worktree without the permission request the bridge
  answers from the execution policy. Every Grok child gets
  `GROK_WORKTREE_INHERITS_MAIN_APPROVALS=false` (`POLICY_ENV` in
  `acp-provider-config.ts`). The variable is in the 1.0.67 binary and its
  bundled docs (absent from 1.0.52); the main checkout's "never allow" answers
  still apply. A `requirements.toml` pin of the feature would override it.
- **Session titles.** Grok's binary carries standard ACP
  `session_info_update` (`title`, `updatedAt`). The bridge handles it
  generically: the title, folded to one line of at most 512 bytes, is kept on
  the session, persisted, and reported on `/status`, `/session/:id` and the
  transcript summary, where the backend reads every bridge's title; `null`
  clears it. Whether 1.0.67 actually sends it, and when, needs a signed-in turn.
- **`/compact`.** Grok offers `/compact` in its command inventory, so its
  capability row sets `actions.compact`: the bridge serves
  `POST /session/:id/compact` by running that command through the prompt
  route as a selected command (journaled, revalidated, never sent as text), and
  answers 422 `command-unavailable` when the live inventory lacks it. That the
  command really compacts over ACP (rather than being a TUI-only builtin)
  needs a signed-in check. The binary also carries an
  `x.ai/compact_conversation` extension request, unused.
- **Background tasks.** Grok sends `x.ai/task_backgrounded` and
  `x.ai/task_completed` (`task_id`, `exit_code`, `signal`, `tool_call_id`);
  the bridge drops both. Mapping them needs a signed-in payload capture.
- **Trust and hooks.** 1.0.64 runs only managed hooks in an untrusted folder,
  and 1.0.59 lets a hook's `continue: false` stop the turn. A stop with no
  policy refusal during the attempt is never continued, so neither changes
  what the bridge sends (how a hook stop is reported over ACP is unverified).
  Project trust is still `GROK_FOLDER_TRUST=0`, re-verified by
  `conformance-execution-policy.test.ts` against the real 1.0.70 binary
  (`ORKESTRATOR_POLICY_GROK_PATH`).
- **`session/close`.** Advertised in `sessionCapabilities` (re-verified signed
  out, with `list` and `resume`). It answers
  `_meta["x.ai/closeOutcome"]: "closed"` (`"notResident"` for an unknown id)
  and emits `_x.ai/sessions/changed` with the id under `removed`, but the
  conversation stays in `session/list` and `session/load` restores its
  history, including from a fresh process. Tab close sends it, bounded and
  best effort, before terminating the child (`acp-session-close.ts`). If a
  release ever makes it delete history, stop sending it: closing a tab must
  never delete a conversation.
- **`session/resume`.** Works and keeps model context, but measured no faster
  than `session/load` (about 70 ms either way), and `session/load` is still
  needed to hydrate an empty transcript from Grok's replay, so the bridge
  keeps one path.
- **`_x.ai/mcp/server_status`.** One report per server after the
  `servers_updated` listing: `status` `ready` or `unavailable`, a `reason`
  code (`initialized`, `handshake_failed`, `auth_required`, …) and free-text
  `detail`. The bridge maps it onto the process-level MCP inventory
  (`connected`, `needs-auth`, `failed`) and never copies `detail`, which can
  name hosts and URLs.
- **`_x.ai/interject` (steer).** Since 1.0.52 it rejects an unknown session
  (`-32602 session not found`) instead of accepting it, but it still answers
  `queued` on an idle session. It cannot be pinned to a run, so a steer racing
  the end of a turn would land in the next one; `actions.steer` stays off.

At 1.0.77 the signed-out checks (2026-11-06) found the same: the
`initialize` answer is byte-identical to 1.0.70 apart from the agent's id,
instance, version and working directory, every flag and `x.ai/*` name the
bridge uses is still present, and `--disable-web-search` is still the only
switch for search and fetch. `PromptResponse._meta` also carries a
`cancelTrigger` beside `cancellationCategory` (binary strings; unverified
signed in).

**Session writeback.** 1.0.77 can sync session history to code.grok.com
("writeback"). Checked signed out on 2026-11-06 with throwaway `HOME` and
`GROK_HOME`: `--storage-mode` is a hidden global option ("Session storage
mode: local or writeback"; any string parses, and `agent --storage-mode` is
an argv error), and the bundled config reference names `GROK_STORAGE_MODE`
beside it under the requirements-only `features.writeback` pin. `agent stdio`
reads the variable, not the flag: with `GROK_STORAGE_MODE=writeback` it logs
"Writeback is disabled: requires auth with grok.com" at startup, with
`--storage-mode writeback` it logs nothing. `local` behaves exactly as unset:
`session/new` logs "Creating new session in JSONL" and writes
`$GROK_HOME/sessions/<encoded-cwd>/<id>/` before refusing for authentication,
the layout `session/load` reads. Every Grok child therefore gets
`GROK_STORAGE_MODE=local` (`POLICY_ENV` in `acp-provider-config.ts`), and
with it set `--always-approve agent stdio` and `--disable-web-search agent
--no-leader stdio` still stay up (exit 124 under the `sleep 10 | timeout 6`
probe; a bogus flag exits 2). Not verified, because it needs a signed-in
account: the default for a signed-in child, and whether `local` outranks
remote settings, which can switch writeback on ("storage mode upgraded from
remote settings"; the remote field is `writeback_enabled`). Only a
`requirements.toml` `features.writeback = false` is documented to override
the flag, the variable and remote settings alike. On a bump, re-run the
`strings` and `--debug-file` checks above for those messages.

### How to upgrade Grok

1. Set the exact version in `PINNED_TOOLCHAIN_VERSIONS.grok` in
   `packages/toolchain/src/manifest.ts`. Grok has no release page;
   the installer reads a channel pointer, so take the version from
   `curl -fsSL https://storage.googleapis.com/grok-build-public-artifacts/cli/stable`.
   The same bucket also publishes `alpha` builds under identical URLs, so a
   version whose artifacts exist is not thereby stable.
2. Mirror it into `GROK_BUILD_VERSION` in `docker/Dockerfile`.
3. Update the `GROK_SHA` literal for each architecture in the same Dockerfile
   block.
4. Refresh and verify the desktop artifact records using the shared binary
   procedure above. Grok's entries are `format: "raw"`, so archive and
   executable digests are the same value.
5. Confirm the argv contract by hand using the checks above. This is the
   step nothing else covers.
6. Re-check [what Grok declares versus what it does](#what-grok-declares-versus-what-it-does).
7. Re-prove the MCP editor's Grok rules on the new binary, without
   credentials:

   ```bash
   GROK_CLI_PATH=/absolute/path/to/new/grok mise run verify:grok:mcp-live
   ```

   It compares `grok inspect --json`, `grok mcp doctor --json` and `grok mcp
   list --json` in throwaway homes with the catalogue: folder trust
   (`grokFolderTrust`), which project-bound sources an untrusted folder holds
   back, the precedence of every file Grok reads (`grokSources` in
   `providers.ts`), the `[compat.*] mcps` switches (`grokCompat`) and saved
   enable. Also diff the guide Grok unpacks into `$GROK_HOME/docs/user-guide`
   (`07-mcp-servers.md`, `05-configuration.md`, `09-plugins.md`) against the
   previous version's for new sources or policy keys the guard does not cover.
8. Smoke-test an interactive tab, including the inactive-environment path.

The `stable` pointer, not the binary, decides the channel. `grok --version` for
1.0.44 printed `[alpha]` although `…/cli/stable` named it; a build can be promoted
without being rebuilt, so the label is not evidence that the pin is wrong. Compare
against the pointer (and `…/cli/alpha`, which may already be ahead) instead.

## Repository-wide validation

A pin change can add a native goal command or tool, or move a turn edge the goal
loop relies on, so re-run `mise run test:agent:goals --credential-source <platform>`
for the changed provider ([goals.md](../architecture/goals.md)). It makes real
model calls and is never part of the default tier.

Run the cheap drift, downloader, and manager checks before live downloads:

```bash
bun test tests/unit/version-drift.test.ts \
  tests/unit/download-agent.test.ts \
  tests/unit/verify-toolchain-artifacts.test.ts \
  packages/toolchain/src/manager.test.ts \
  tests/unit/bridge-packaging.test.ts --parallel
bun test --cwd apps/backend tests/container-state-layout.test.ts
```

For a repository-wide agent upgrade, verify every pinned URL, archive digest,
and extracted executable digest rather than only the current host target:

```bash
mise run verify:toolchains:live
```

`verify:toolchains:live` covers only what the manifest pins. Verify
`@cursor/sdk` by building the Cursor SDK bridge and running its suite, as
described in its section.

Then run provider-specific typechecks and tests above, build the Docker image,
and finish with the full suite:

```bash
mise run test
```

Finally verify the inactive-environment path for each provider: start a turn,
switch to another environment while it runs or waits for input, return after it
finishes, and confirm that messages, status, questions/approvals, and controls
rehydrate from authoritative backend state.

Re-qualify slash commands for every provider whose pin moved, before the
upgrade merges: the qualified rows in
[`native-agent-commands.md`](../architecture/native-agent-commands.md#provider-support)
name the versions they were proved on, and a pin they no longer match is an
unproven claim. The scripted probes in `scripts/slash-probes/` need no
Orkestrator profile and cost seconds (`codex-disabled-skills-probe.mjs` needs no
sign-in; `pi-commands-probe.mjs` uses the host's Pi login by path and runs a few
short model turns). For a Codex or Claude upgrade also run
`e2e/agent-testing/slash-command-inactive.spec.ts` (see
[`agent-testing.md`](agent-testing.md#live-slash-commands-in-an-inactive-environment)).
Then update the pins in that section, or list what changed as unavailable with
a reason.

Before committing, search for both the old SDK and CLI version literals:

```bash
rg -n '<old-version>' --hidden --glob '!node_modules' --glob '!.git' .
```

Classify every result as an authoritative pin, generated artifact, lockfile,
compatibility comment, or intentionally independent test fixture. This avoids
both stale production pins and meaningless mechanical fixture churn.

## Rollback

An agent upgrade should be one reviewable change per provider.
Revert the SDK manifests/lockfiles, CLI pins, artifact hashes, Docker pin,
and—only for Codex—the generated protocol as one unit. After reverting, reinstall with Bun,
rerun the provider's drift/contract tests, and rebuild the container. Cached
newer toolchains and provider-created session data are not themselves rolled
back; verify that a session created by the newer release can still be resumed if
downgrade compatibility matters.

## Other dependencies

Everything that is not an agent SDK or CLI (renderer and backend libraries,
Electron, Bun, Docker image tools, CI actions) follows the same lockfile rules
(AGENTS.md, *Updating Bun and lockfiles*) plus these. Outstanding upgrades are
tracked in [`docs/todo/cross-cutting/0032-dependency-upgrades.md`](../todo/cross-cutting/0032-dependency-upgrades.md).

Finding what is outdated: `mise exec -- bun outdated --filter='*'` and
`mise exec -- bun audit` (both read-only), then `npm view <pkg> dist-tags`.
`bun outdated` follows the `latest` tag only, so it misses a release
published under a line tag (electron-builder 26 publishes under `v26`).

- **Bun alone.** Bump Bun in its own change, never inside a dependency batch:
  every later change regenerates lockfiles with the Bun `mise.toml` pins. Bun is
  pinned in `mise.toml`, root `packageManager`, `packages/cli` `engines`,
  `scripts/download-bun.sh` (version and four SHA-256s; this Bun ships inside
  the desktop app), the site's `apps/web-public/public/install.sh`
  (`PINNED_BUN` and nine SHA-256s from the release's `SHASUMS256.txt`: the
  four above plus the `-baseline` and `-musl` archives; this Bun is what a new
  standalone host gets, and the change deploys with the site), both `oven/bun` base images and version checks in
  `docker/Dockerfile`, and the `@types/bun` ranges. `version-drift.test.ts`
  enforces them, `mise run docker:check-base` resolves the new base digest,
  and `.github/workflows/validate-bun-runtime.yml` runs on the change.
- **Pins that move together.** The `@tiptap/*` exact pins; the
  `@modelcontextprotocol/client` pins in backend, cursor-bridge and pi-bridge
  (and `node`/`server`, which peer on each other); `@playwright/test`,
  `playwright`, both `playwright-core` pins and Dockerfile `PLAYWRIGHT_VERSION`
  (drift-tested); `sharp` in backend and CLI; every `@radix-ui/react-*`
  (they must dedupe to one copy of their shared layers); `vite` with
  `@vitejs/plugin-react`; mise in `config/mise-version.json` and the
  Dockerfile (drift-tested, with SHA-256s).
- **`@types/node` follows the runtime.** Bridges, backend, toolchain and root
  tests run under Bun, so they use the Node major Bun reports. `apps/desktop`
  runs on Electron's Node and matches the `@types/node` Electron depends on.
- **Intentional holds.** `test-fixtures/preview-vite` stands in for a user's app
  and stays on its pinned Vite. `marked` stays on the major `@tiptap/markdown`
  depends on, so the lexer in `components/markdown/tiptap-extensions.ts` and
  Tiptap's parser share one copy.
- **Overrides and patches.** `patches/` holds only agent-SDK patches. Root
  `overrides.dompurify` lifts the copy `monaco-editor` declares; Monaco bundles
  its own DOMPurify, so the override only affects `bun audit`.

Validation beyond `format:check`, `lint`, `typecheck` and `test` (one suite per
`test:logged` command):

| Change touches | Also run |
| --- | --- |
| Lockfiles | Both frozen installs and `bun test tests/unit/version-drift.test.ts` |
| Renderer behaviour (Radix, Monaco, Tiptap, icons, Vite) | `test:browser`, `test:agent:browser:isolated`; design canvas: `test:agent:design:isolated` |
| Electron, electron-builder | `build:electron`, `test:agent:electron`, `package:linux` / `package:mac`, `verify:packaged-backend`; see [releasing.md](releasing.md) for the macOS floor |
| Native or bundled backend deps (`sharp`, `playwright-core`) | `verify:packaged-backend`, `smoke:cli`, `test:cli:scenarios` |
| Dockerfile (Bun, mise, delta, Playwright) | `docker:check-base`, `docker:build`, `test:agent:docker` |
