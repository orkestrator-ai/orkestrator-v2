# Upgrading agent SDKs and binaries

Status: Living — SDK/CLI bump runbook; pins are test-enforced.

This runbook covers the Claude, Codex, OpenCode, Cursor, Grok, and Pi versions
used by Orkestrator. These integrations do not share one upgrade mechanism:

| Agent | SDK integration | CLI integration | Current pins |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` drives native sessions; `@anthropic-ai/sdk` supplies message content types | The Agent SDK is pointed at Orkestrator's separately managed `claude` executable | Agent SDK `0.3.309`, Anthropic SDK `1.2.0`, CLI `2.1.309` (npm `latest`, verified 2026-10-23) |
| Codex | No runtime `@openai/codex-sdk` dependency. The bridge speaks JSON-RPC to `codex app-server` using generated types | The pinned `codex` executable is the app-server and is also used by isolated `codex exec` helpers | CLI and generated protocol `0.164.0` |
| OpenCode | `@opencode-ai/sdk/v2/client` is used only by the backend (native chat and build pipelines) | The pinned `opencode` executable runs `opencode serve` | SDK and CLI `1.19.4` |
| Cursor | `cursor-bridge` drives `@cursor/sdk` in process | No CLI; Cursor is SDK-only | SDK `1.0.40` (npm `latest`, verified 2026-10-23) |
| Grok | The ACP bridge spawns the CLI and speaks ACP over its stdio; `@agentclientprotocol/sdk` supplies the protocol types | The pinned `grok` executable runs `grok … agent stdio` | CLI `1.0.67` (stable channel; verified 2026-10-23), ACP SDK `2.0.1` |
| Pi | `@earendil-works/pi-coding-agent` drives sessions in process; `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` supply types (upstream removed `@earendil-works/pi-server` in 1.2.0) | The pinned `pi` bundle is the same program published a second way, and is what a Pi terminal tab runs | SDK and CLI `1.4.0` |

All versions are exact pins. Do not change them to ranges or `latest`.
Verified against upstream stable releases on 2026-10-13.

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

The `tracksCli` flag in that table is the one piece of real judgement. Pi and
OpenCode publish the SDK and the binary as the same program two ways, so a split
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

Cursor 1.0.40 also has a Bun-export diagnostic seam patch registered in root
`patchedDependencies`. Keep the pin, patch filename, registration, and lockfile
aligned. The appended export references the SDK's minified stall-detector and
execution-controller bindings: simply renaming the patch on upgrade is not
sufficient. Re-identify those bindings and verify the controller still awaits
each response write before advancing its execution iterator. The two classes
are found by their field lists: the stall detector opens with
`timer;advisoryTimer;heartbeatOnlyTimer` and is assigned inside the lazy
initializer that names `@anysphere/agent-client:stall-detector` (which the
export must call first); the controller is the class opening with
`serverStream;clientStream;controlledExecManager`. In 1.0.40 those are `W_0`,
`x01` and `Z_0` (1.0.37: `eR0`, `Er0`, `aR0`; 1.0.36: `aE0`, `Xn0`, `dE0`).
All three live in `dist/bundled/index.js`, and the controller loop is still
`for await (let U of N) await this.clientStream.write(U)`. Run the Cursor
SDK diagnostics tests and version-drift test, then build/vendor the bridge and
verify the packaged Bun import exposes `__orkestratorDiagnosticsV1`. Do not
enable raw SDK logs as a substitute for the bounded observer.

## How binaries reach a running environment

There are four delivery paths. An upgrade is incomplete until every applicable
path has been updated.

### Local desktop environments

`packages/toolchain/src/manifest.ts` is the authoritative artifact
manifest for the five CLI-backed agents — Claude, Codex, OpenCode, Grok, and
Pi. It contains one entry per supported platform and architecture:

- macOS arm64 and x64
- Linux arm64 and x64

Each entry pins the archive URL, allowed hosts, archive size and SHA-256, archive
member to extract, and extracted executable size and SHA-256. The macOS entries
for OpenCode and Pi additionally set `repairInvalidMacSignature`; the manager
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
  PATH is left alone.

### Container environments

`docker/Dockerfile` has one exact build argument per CLI-backed agent —
`CLAUDE_CLI_VERSION`, `CODEX_CLI_VERSION`, `OPENCODE_CLI_VERSION`,
`GROK_BUILD_VERSION`, and `PI_CLI_VERSION`. It installs:

- `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`
- `@openai/codex@${CODEX_CLI_VERSION}`
- OpenCode, Grok Build and Pi as pinned archives, each verified against a
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
mise run download:claude    # or download:codex | :opencode | :grok | :pi
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
   has an additional source of truth described below. OpenCode also has SDK pins that must match its CLI.
3. Refresh all four artifact records with the live verifier:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --emit --tool=<name>
   ```

   `--tool` accepts any of the five manifest names, including `grok` and `pi`.
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
   | OpenCode | `strings "$BIN" \| grep -E 'OPENCODE_DB\|opencode\.db\|snapshot'`, then `scripts/qualify-opencode-seeded-data.sh <dev image>` once the image is built | `OPENCODE_DB` is still a full database path (`OPENCODE_DB_PATH`), sessions live only in that database, and `snapshot/` is still revert history rather than session state. The script must still pass: a turn, diff and revert work with nothing seeded from the host data directory but `auth.json`, and nothing opens a host's `snapshot/` or `account.json` |
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
- OpenCode: the built-in auth plugins under `packages/opencode/src/plugin/` at
  the release tag (`openai/codex.ts`, `github-copilot/copilot.ts`, `xai.ts`),
  and any new plugin `internalPlugins` loads.

A new rotating provider needs no change (anything unlisted is access-only). A
new non-rotating one, such as a token exchange like Copilot's, needs adding to
both lists, or its container copy signs out when its short access token
expires. Also check that `expires` is still in milliseconds and the refresh
window (Pi refreshes five minutes early, OpenCode's xAI two) still fits inside
`PROVIDER_AUTH_MIN_VALIDITY_MS`.

On every Codex bump, run `bun scripts/codex-access-only-auth-probe.ts --codex
<pinned binary>`. It hands the pinned Codex the access-only `auth.json` a
coordinator home or container receives, built from a synthetic login against
a local server, and reports every refresh attempt. On 0.164.0: no refresh for
an access token more than five minutes from its `exp`, whatever
`last_refresh` says; inside those five minutes, or after a 401, one attempt
with the blank refresh token that fails and leaves the file untouched. A
change there (a refresh before the window, or a rewritten file) needs
`restrictCodexAuthSnapshot` and `TOKEN_REPLACEMENT_LEAD_MS` re-read.

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
runtime pin for CLI users, not a stale duplicate. Bump it with the bridge's.

`bridges/claude-bridge/src/services/session-manager.ts` is the main compatibility
surface. It uses the Agent SDK's `query()` async iterator, session lifecycle
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
6. Review `session-manager.ts` for option, event, and message-union changes. Pay
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
   `CLAUDE_CLI_PATH` pointing at the managed one. If its `bare` case fails, the
   CLI now unloads launch servers by itself; the restatement is then harmless,
   but update the module's header to say so.

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
7. Rebuild the vendored bridge and verify it:

   ```bash
   mise run build:claude-bridge
   bun run --cwd bridges/claude-bridge typecheck
   bun test bridges/claude-bridge/src/sdk-compatibility.test.ts
   bun test bridges/claude-bridge/src --parallel
   ```

Last verified 2026-10-23 at Agent SDK 0.3.309 (`claudeCodeVersion` 2.1.309, so
the SDK's CLI and the managed one are the same version) with CLI 2.1.309: the
compatibility test including the `canUseTool` proof, `verify:claude:mcp-live`
against both the SDK's CLI and the managed binary, the vendored build, the
typecheck and the full bridge suite. No new SDK message type, `system`
subtype or hook event; `ModelInfo` still has no Ultracode flag. `TaskOutput`
left `WAITING_TOOLS`: 2.1.309 lists it among the names it does not offer.
`claude-host-login-refresh.ts` is still as checked against 2.1.296 (it needs a
container with a fake login).

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
generation; `bridges/codex-bridge/src/session-titles.ts` is another deliberate
hermetic `codex exec` exception.

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

   It expects 0.164.0's behaviour: no item for a refused `apply_patch` or
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
   (`codexRequestUserInputConfig`). The test expects 0.164.0's behaviour: an
   interactive session's call parks as a pausable question, the turn waits for
   the answer, and a `pipeline` session still gets "unavailable in Default
   mode". If the feature is renamed or removed, the first case fails: find the
   new switch, or take `question` back out of the Codex row in
   `nativeAgentCapabilities()`.

   Treat a failure in the "live MCP protocol era" block as a release blocker
   rather than a flaky test. Those two contracts stand in for every third-party
   HTTP MCP server that still speaks the 2025 protocol: the bridge relies on
   `features.mcp_2026_07_28` defaulting to off, and a version that flips that
   default silently breaks those servers in native sessions while they keep
   working in the Codex CLI.

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
8. Search for the old version literal. Runtime comments marked “Verified
   against codex …” need to be revalidated before their version is changed.
   Test fixtures and fake user-agent strings do not all need to track the pin;
   update them only when the assertion is intended to represent the current
   binary.

See `docs/architecture/agent-engines.md` for the architectural and
safety constraints behind this process. Upstream release source:
[OpenAI Codex](https://github.com/openai/codex).

## OpenCode

### Where the SDK is used

OpenCode's SDK and CLI are intentionally kept at the same exact version.
`tests/unit/version-drift.test.ts` enforces agreement across:

- `@opencode-ai/sdk` in `apps/backend/package.json`, the only workspace that
  depends on the SDK
- `PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `packages/toolchain/src/manifest.ts`
- `OPENCODE_CLI_VERSION` in `docker/Dockerfile`

Every import uses `@opencode-ai/sdk/v2/client`; do not change one to the v1
package root. The renderer does not talk to `opencode serve` or normalize
OpenCode messages, and `apps/web` does not depend on the SDK (the drift test
asserts that). `scripts/opencode-live-compatibility-probe.ts` resolves the SDK
through the backend workspace.

- `apps/backend/src/core/opencode-provider.ts` is the only backend file that
  calls `createOpencodeClient`. It uses sessions, async prompts,
  status/messages, event subscriptions, aborts, questions, and permissions, and
  serves both interactive native chat and durable build pipelines.
  `native-agent-provider.ts` selects it for the `opencode` platform, and
  `build-pipeline-provider.ts` re-exports a smaller slice of that contract for
  pipeline code — neither of those two constructs a client itself, so a v2
  signature change lands in `opencode-provider.ts`. The remaining backend
  `opencode-*.ts` files import v2 *types* only.

OpenCode 1.19.1 discontinued session sharing upstream. OpenCode no longer
advertises the `share` capability, the provider never calls
`session.share`/`unshare` or reports a session's old `share.url` (those links
are dead), and Agent Info shows Undo, Redo and Share from
`capabilities.actions` rather than from the platform. A typed `/share` or
`/unshare` is still refused as a terminal-only command so it never reaches the
model as a prompt. If a release brings sharing back, re-add the capability and
the two calls together.

### How to upgrade OpenCode

1. Pick a release for which both the CLI assets and `@opencode-ai/sdk` package
   exist.
2. Set that exact version in the backend manifest and all three CLI mirrors
   listed above.
3. Refresh the root lockfile:

   ```bash
   bun install
   ```

   Rebase the Bun SSE patch against the new upstream package as required by
   `AGENTS.md`. Both `dist/gen/core/serverSentEvents.gen.js` and
   `dist/v2/gen/core/serverSentEvents.gen.js` must catch a rejected
   `reader.cancel()`. Use a fresh isolated temporary package/cache for
   `bun patch` if the workspace uses symlinks: edit the directory Bun prepared,
   not a workspace symlink into its shared cache, and inspect the generated
   patch before copying it back. Update the root `patchedDependencies` key,
   patch path and filename, and `bun.lock` together; remove the old patch.
   Confirm the backend resolution in `bun.lock` uses the intended version and
   inspect the installed client after `bun install`.
4. Refresh and verify all four OpenCode artifact records using the shared
   binary procedure. Preserve the macOS `repairInvalidMacSignature` behavior and
   do not add reproducible installed hashes for a locally re-signed file. Copy
   the two `linux` archive digests into the Dockerfile's `OPENCODE_SHA`
   branches; `version-drift.test.ts` holds them to the manifest.
5. Review the generated v2 types and compile the backend. Flat v2 request
   parameters such as `{ sessionID, parts }` must remain flat; do not migrate to
   the old nested `{ path, body }` API shape.
6. Run:

   ```bash
   bun run --cwd apps/backend typecheck
   bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel
   bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
     src/core/opencode-provider-dispatch.test.ts \
     src/core/opencode-provider-lifecycle.test.ts \
     src/core/opencode-provider-runtime.test.ts \
     src/core/opencode-provider-dispose.test.ts \
     --parallel
   OPENCODE_CLI_PATH=/absolute/path/to/new/opencode \
     mise run verify:opencode:live
   ```

   The live compatibility test
   (`apps/backend/src/core/opencode-live-compatibility.live.test.ts`) runs the
   probe as a clean Bun child process, which starts `opencode serve` with
   isolated XDG directories, verifies that CLI health reports the same version as the SDK
   pin, constructs the real v2 client, and lists sessions. It does not call a
   model or spend credits.

   Then re-prove what MCP apply relies on, also without credentials:

   ```bash
   OPENCODE_CLI_PATH=/absolute/path/to/new/opencode \
     mise run verify:opencode:mcp-live
   ```

   It checks that `instance.dispose` rebuilds a worktree's MCP servers from
   its project file, stops the old server processes, drops runtime-added
   entries and keeps sessions, and that the user files in
   `$XDG_CONFIG_HOME/opencode` stay cached until the server restarts. If the
   second test fails because the user file is reloaded, plan `opencode:user-*`
   sources for the in-place reload too (`apply.ts`); if the first fails, MCP
   apply's OpenCode reload no longer works. See
   [`mcp-management.md`](../architecture/mcp-management.md) ("OpenCode reload").
7. Smoke-test both UI native chat and a build-pipeline OpenCode phase. Exercise
   streaming, question and permission rehydration, abort, resume, and session
   status because those use different portions of the v2 client.
8. Confirm the pinned binary still honours `OPENCODE_DISABLE_AUTOUPDATE`
   (`grep -a -c -F OPENCODE_DISABLE_AUTOUPDATE <binary>`, and the release's
   upstream `cli/upgrade.ts`). Since 1.19 the TUI checks for
   updates and its `/update` dialog installs over the running binary,
   including OpenCode 2 through `opencode upgrade --major`; the container's
   `~/.opencode/bin` reads as a curl install, so the in-place upgrade would
   succeed and break every native session (2.x has no legacy HTTP API). The
   variable is set by `OPENCODE_PINNED_RUNTIME_ENV`
   (`packages/protocol/src/terminal-agent-launch.ts`) on the terminal-tab
   command and the local `opencode serve` spawn, and by an `ENV` in
   `docker/Dockerfile`. It suppresses the check and the notice; `/update`
   stays reachable from the command palette as a deliberate user action.
   1.x now ships from upstream's `v1` branch; see `docs/todo/agent-engines/0008-opencode-v2.md`.

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
  imports (`pi-tui`, `pi-mcp`, `pi-codemode` as of `1.4.0`, and
  `pi-telemetry` through `pi-ai`) is a declared dependency of the package that
  imports it, which is what the vendor step follows — the `0.85.0` failure
  mode was an undeclared import.
- `packages/toolchain/src/manifest.ts` — `PINNED_TOOLCHAIN_VERSIONS.pi`
  and four `bundleIntegrity` records.
- `docker/Dockerfile` — `PI_CLI_VERSION` and the two Linux archive digests.

`tests/unit/version-drift.test.ts` enforces that all three agree, and that the
Dockerfile pins the same archive digests the manifest does.

### Procedure

1. Bump the three SDK dependencies in `bridges/pi-bridge/package.json`, then
   `bun install`.

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
   other level is included unless mapped to `null`.
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
   to mirror — this step is the whole pin.
2. Review the five compatibility files above against the new type definitions.
   Pay particular attention to `InteractionUpdate` variants and tool cases added
   upstream: both degrade silently by design.
3. Rebuild and prove the distributable shape, which a typecheck alone does not:

   ```bash
   bun run --cwd bridges/cursor-bridge typecheck
   mise run build:cursor-bridge
   bun test bridges/cursor-bridge/src --parallel
   ```

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
`@agentclientprotocol/sdk` in `bridges/acp-bridge/package.json` (`2.0.1`). It
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
# Hold stdin open: at EOF it exits 0 at once, which proves nothing. Exit 124
# (killed by the timeout, still alive) is the passing result.
# macOS has no `timeout`. Without one, hold stdin open on a FIFO, start grok
# in the background, and check its own pid is still alive after a few seconds.
(sleep 4 | timeout 6 grok --always-approve agent stdio; echo "exit $?")

# Then prove the handshake and a real `session/new` with the bridge's own params
# (typed `headers` array, `additionalDirectories: []`). 1.0.44, 1.0.46 and
# 1.0.52 answer both; 1.0.67 was checked signed out only (`initialize` answers,
# the liveness probes stay up). Run it signed in (`grok login`): signed out, `session/new` ends
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
(sleep 4 | timeout 6 grok --disable-web-search agent --no-leader stdio; echo "exit $?")
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
anything that needs a session is still as last verified against 1.0.52.

- **Images.** Since 1.0.67 `initialize` answers `promptCapabilities.image:
  true` (re-verified signed out; 1.0.52 answered `false` while reading the
  block, and was credited in `undeclaredPromptCapabilities`, now empty, in
  `bridges/acp-bridge/src/acp-provider-config.ts`). The bridge refuses image
  attachments a provider does not declare, so the declaration now decides.
  That 1.0.67 still describes an inline `image` block sent with no path in the
  text needs a signed-in check. If Grok ever stops reading the block, set
  Grok's `attachments.images` to `false` in `nativeAgentCapabilities`.
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
  `conformance-execution-policy.test.ts` against the real 1.0.67 binary
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
7. Smoke-test an interactive tab, including the inactive-environment path.

The `stable` pointer, not the binary, decides the channel. `grok --version` for
1.0.44 printed `[alpha]` although `…/cli/stable` named it; a build can be promoted
without being rebuilt, so the label is not evidence that the pin is wrong. Compare
against the pointer (and `…/cli/alpha`, which may already be ahead) instead.

## Repository-wide validation

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
  the desktop app), both `oven/bun` base images and version checks in
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
