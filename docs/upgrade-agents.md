# Upgrading agent SDKs and binaries

This runbook covers the Claude, Codex, OpenCode, Cursor, Grok, and Pi versions
used by Orkestrator. These integrations do not share one upgrade mechanism:

| Agent | SDK integration | CLI integration | Current pins |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` drives native sessions; `@anthropic-ai/sdk` supplies message content types | The Agent SDK is pointed at Orkestrator's separately managed `claude` executable | Agent SDK `0.3.245`, Anthropic SDK `0.120.0`, CLI `2.1.245` |
| Codex | No runtime `@openai/codex-sdk` dependency. The bridge speaks JSON-RPC to `codex app-server` using generated types | The pinned `codex` executable is the app-server and is also used by isolated `codex exec` helpers | CLI and generated protocol `0.149.1` |
| OpenCode | `@opencode-ai/sdk/v2/client` is used by the renderer and backend build pipeline | The pinned `opencode` executable runs `opencode serve` | SDK and CLI `1.18.23` |
| Cursor | `cursor-bridge` drives `@cursor/sdk` in process | No CLI; Cursor is SDK-only | SDK `1.0.28` |
| Grok | No SDK. The ACP bridge spawns the CLI and speaks ACP over its stdio | The pinned `grok` executable runs `grok … agent stdio` | CLI `1.0.10` |
| Pi | `@earendil-works/pi-coding-agent` drives sessions in process; `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` supply types | The pinned `pi` bundle is the same program published a second way, and is what a Pi terminal tab runs | SDK and CLI `0.84.3` |

All versions are exact pins. Do not change them to ranges or `latest`.

## What is enforced, and what is not

`apps/desktop/electron/toolchain-manifest.ts` is the single source of truth for
every agent. Two things read it directly and therefore cannot drift from it:
`scripts/download-agent.ts` and `scripts/verify-toolchain-artifacts.ts`.

Two things cannot read it, and are a second copy held in step by tests:

- **`docker/Dockerfile`** — an image build has no access to the manifest, so
  each CLI's version is an `ARG` literal and Grok's and Pi's archive
  digests are `sha256sum` literals.
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

Cursor's only agent pin is `@cursor/sdk`; see
[Cursor (SDK bridge)](#cursor-sdk-bridge).

## How binaries reach a running environment

There are three delivery paths. An upgrade is incomplete until every applicable
path has been updated.

### Local desktop environments

`apps/desktop/electron/toolchain-manifest.ts` is the authoritative artifact
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
3. `apps/desktop/electron/toolchain-manager.ts` downloads through Electron's
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

### Container environments

`docker/Dockerfile` has one exact build argument per CLI-backed agent —
`CLAUDE_CLI_VERSION`, `CODEX_CLI_VERSION`, `OPENCODE_CLI_VERSION`,
`GROK_BUILD_VERSION`, and `PI_CLI_VERSION`. It installs:

- `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`
- `@openai/codex@${CODEX_CLI_VERSION}`
- OpenCode's installer with `--version "${OPENCODE_CLI_VERSION}"`
- Grok Build and Pi as pinned archives, each verified against a
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
bun run download:claude    # or download:codex | :opencode | :grok | :pi
bun run download:agent -- grok --dir /tmp/probe
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
   `apps/desktop/electron/toolchain-manifest.ts`, its `scripts/download-*.sh`
   file, and `docker/Dockerfile`. Codex has an additional source of truth
   described below. OpenCode also has SDK pins that must match its CLI.
3. Refresh all four artifact records with the live verifier:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --emit --tool=<name>
   ```

   `--tool` accepts any of the five manifest names, including `grok` and `pi`.
   Their artifact records are refreshed by exactly this command.

   Paste the emitted archive and executable sizes and SHA-256 values into the
   matching platform/architecture entries in
   `apps/desktop/electron/toolchain-manifest.ts`. Do not copy the previous
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
   bun run download:<claude|codex|opencode|grok|pi>
   ```

6. Build the container after the provider-specific checks:

   ```bash
   bun run docker:build
   ```

The live verifier downloads large artifacts and requires network access. The
ordinary unit tests validate manifest structure and downloader behavior without
trusting the network.

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
under `bypassPermissions`.

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
     `apps/desktop/electron/toolchain-manifest.ts`
   - `CLAUDE_CLI_VERSION` in `docker/Dockerfile`

   Nothing else mirrors the CLI version. `scripts/download-agent.ts` reads the
   manifest, so it needs no edit.

5. Refresh and verify the four Claude artifact records using the shared binary
   procedure.
6. Review `session-manager.ts` for option, event, and message-union changes. Pay
   particular attention to the version-pinned `canUseTool` comment in
   `session-manager-prompt.ts` and re-prove that `AskUserQuestion` remains parked
   until the callback resolves. The `routes AskUserQuestion through canUseTool
   under bypassPermissions` case in `sdk-compatibility.test.ts` is that proof —
   it drives the real installed SDK — so move the comment's version only once it
   has passed against the new one, and leave it alone if it has not. Review
   session adoption (`listSessions` options), background task controls,
   checkpoint/rewind behavior, partial messages, structured output, and model
   catalog calls.
7. Rebuild the vendored bridge and verify it:

   ```bash
   bun run build:claude-bridge
   bun run --cwd bridges/claude-bridge typecheck
   bun test bridges/claude-bridge/src/sdk-compatibility.test.ts
   bun test bridges/claude-bridge/src --parallel
   ```

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
     `apps/desktop/electron/toolchain-manifest.ts`
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
     bun run codex:protocol
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
     bun run verify:codex:protocol
   bun test tests/unit/codex-app-server-protocol.test.ts
   bun run --cwd bridges/codex-bridge typecheck
   bun test bridges/codex-bridge/src --parallel
   CODEX_PROTOCOL_BINARY=/absolute/path/to/new/codex \
     RUN_LIVE_CODEX_APP_SERVER=1 \
     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
   ```

   The live contract tests do not call a model or spend credits. They verify
   initialization order, method errors, model pagination/order, thread listing
   and reads, thread naming, project-trust behavior, and clean process shutdown.
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

See `docs/technical-architecture/agent-engines.md` for the architectural and
safety constraints behind this process. Upstream release source:
[OpenAI Codex](https://github.com/openai/codex).

## OpenCode

### Where the SDK is used

OpenCode's SDK and CLI are intentionally kept at the same exact version.
`tests/unit/version-drift.test.ts` enforces agreement across:

- `@opencode-ai/sdk` in `apps/web/package.json`
- `@opencode-ai/sdk` in `apps/backend/package.json`
- `PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `apps/desktop/electron/toolchain-manifest.ts`
- `OPENCODE_CLI_VERSION` in `docker/Dockerfile`

Both code paths import `@opencode-ai/sdk/v2/client`; do not change them to the v1
package root:

- `apps/web/src/lib/opencode-client.ts` is the renderer wrapper. It normalizes
  OpenCode messages and exposes session, event, model/provider, command, agent,
  skill, question, permission, MCP, formatter, and LSP operations.
- `apps/backend/src/core/opencode-provider.ts` is the only backend file that
  calls `createOpencodeClient`. It uses sessions, async prompts,
  status/messages, event subscriptions, aborts, questions, and permissions, and
  serves both interactive native chat and durable build pipelines.
  `native-agent-provider.ts` selects it for the `opencode` platform, and
  `build-pipeline-provider.ts` re-exports a smaller slice of that contract for
  pipeline code — neither of those two constructs a client itself, so a v2
  signature change lands in `opencode-provider.ts`. The remaining backend
  `opencode-*.ts` files import v2 *types* only.

The backend imports the SDK at runtime, so updating only the web workspace can
leave native chat apparently healthy while build pipelines remain on the old
contract.

### How to upgrade OpenCode

1. Pick a release for which both the CLI assets and `@opencode-ai/sdk` package
   exist.
2. Set that exact version in both package manifests and all three CLI mirrors
   listed above.
3. Refresh the root lockfile:

   ```bash
   bun install
   ```

   Confirm both workspace resolutions in `bun.lock` use the intended version.
4. Refresh and verify all four OpenCode artifact records using the shared
   binary procedure. Preserve the macOS `repairInvalidMacSignature` behavior and
   do not add reproducible installed hashes for a locally re-signed file.
5. Review the generated v2 types and compile both consumers. Flat v2 request
   parameters such as `{ sessionID, parts }` must remain flat; do not migrate to
   the old nested `{ path, body }` API shape.
6. Run:

   ```bash
   bun run --cwd apps/web typecheck
   bun run --cwd apps/backend typecheck
   bun test --cwd apps/web 'src/lib/opencode-*.test.ts' --parallel
   bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
     src/core/opencode-provider-dispatch.test.ts \
     src/core/opencode-provider-lifecycle.test.ts \
     src/core/opencode-provider-runtime.test.ts \
     --parallel
   OPENCODE_CLI_PATH=/absolute/path/to/new/opencode \
     bun run verify:opencode:live
   ```

   The live compatibility test starts a clean Bun child process outside the web
   test's browser preload, then starts `opencode serve` with isolated XDG
   directories, verifies that CLI health reports the same version as the SDK
   pin, constructs the real v2 client, and lists sessions. It does not call a
   model or spend credits.
7. Smoke-test both UI native chat and a build-pipeline OpenCode phase. Exercise
   streaming, question and permission rehydration, abort, resume, and session
   status because those use different portions of the v2 client.

Upstream references: [OpenCode releases](https://github.com/anomalyco/opencode/releases)
and [OpenCode SDK documentation](https://opencode.ai/docs/sdk/).

## Pi

### Where the contract lives

Pi is pinned in three places that must move together, because the SDK the
bridge drives and the `pi` binary a terminal tab runs are the same program
published two ways:

- `bridges/pi-bridge/package.json` — `@earendil-works/pi-coding-agent` and the
  two packages it exposes types from, `@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core`, all pinned exactly.
- `apps/desktop/electron/toolchain-manifest.ts` — `PINNED_TOOLCHAIN_VERSIONS.pi`
  and four `bundleIntegrity` records.
- `docker/Dockerfile` — `PI_CLI_VERSION` and the two Linux archive digests.

`tests/unit/version-drift.test.ts` enforces that all three agree, and that the
Dockerfile pins the same archive digests the manifest does.

### Procedure

1. Bump the three SDK dependencies in `bridges/pi-bridge/package.json`, then
   `bun install`.
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
   bumped without them fails `bun run docker:build` rather than shipping an
   unverified binary.
5. Review `bridges/pi-bridge/src/translate.ts` against the SDK's
   `AgentSessionEvent` union. This is the compatibility surface: a new event
   type degrades to "not rendered", which is safe but silent, so a bump that
   adds one is a bump that may quietly stop showing something.
6. Review `src/models.ts` against `Model` and `ThinkingLevel`. A new thinking
   level that is not in `THINKING_LEVELS` is simply never offered. Remember the
   rule is asymmetric: `xhigh` and `max` need an *explicit* mapping, while every
   other level is included unless mapped to `null`.
7. Rebuild the vendored bridge and run its suite. Like the Claude and Cursor SDK
   bridges, the build keeps the SDK external and a `vendor` step copies it into
   `dist/node_modules` — the SDK compiles extension TypeScript with jiti and
   reads themes and templates from files inside its own package, neither of
   which a bundler can follow. A successful typecheck does not prove the
   distributable bridge is complete:

   ```bash
   bun run --cwd bridges/pi-bridge typecheck
   bun run build:pi-bridge
   bun test bridges/pi-bridge/src --parallel
   ```

8. Smoke-test one interactive Pi tab and one terminal tab, including a model
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
   bun run build:cursor-bridge
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
   transport call in a live session.
5. Rebuild the container, which builds this bridge from the same lockfile:

   ```bash
   bun run docker:build
   ```

6. Smoke-test sign-in through the bridge's `--login` child, run a turn with tool
   calls and a diff, switch model and effort, cancel mid-turn, and check the
   inactive-environment path.

Sub-agent cards are the one behaviour to re-check by hand on every bump. The SDK
reports children only through nested updates on the parent run, so a child is
reported as detached when its parent ends rather than as completed. If a bump
adds a channel that outlives the parent run, that workaround should shrink
rather than be widened.

Upstream reference: [`@cursor/sdk` on npm](https://www.npmjs.com/package/@cursor/sdk).

## Grok (ACP)

### Where the CLI contract lives

This section covers the `grok` CLI the ACP bridge spawns. It is pinned in
`apps/desktop/electron/toolchain-manifest.ts` and `docker/Dockerfile` and has no
SDK: the ACP bridge speaks ACP with the CLI over stdio. That makes its
**command-line flags a versioned contract**, and it is the part of an upgrade
nothing in CI can check. See
`docs/technical-architecture/agent-engines.md` for the bridge architecture.

The bridge launches Grok with `--always-approve agent stdio`.

`bridges/acp-bridge/src/acp-server.test.ts` asserts these vectors against
`bridges/acp-bridge/src/testing/fake-agent.ts`, which records its own argv and
accepts anything. A
renamed or removed upstream flag therefore leaves the suite green and breaks
every ACP session at runtime. After bumping the pin, confirm the real CLI
still accepts the flags:

```bash
# The flag must still be listed as a global option, not a subcommand option.
grok --help | rg -- '--always-approve'

# Each must start and wait for JSON-RPC rather than exiting on an argv error.
# No output plus a process that stays alive is the passing result.
grok --always-approve agent stdio </dev/null
```

Run these against the pinned version, not whatever is on `PATH` — compare
`grok --version` against `PINNED_TOOLCHAIN_VERSIONS.grok` and
`GROK_BUILD_VERSION` first. `--always-approve` is deliberate: an ACP tab is an
interactive session and matches the Claude bridge's local bypass-permissions
default.

### How to upgrade Grok

1. Set the exact version in `PINNED_TOOLCHAIN_VERSIONS.grok` in
   `apps/desktop/electron/toolchain-manifest.ts`.
2. Mirror it into `GROK_BUILD_VERSION` in `docker/Dockerfile`.
3. Update the `GROK_SHA` literal for each architecture in the same Dockerfile
   block.
4. Refresh and verify the desktop artifact records using the shared binary
   procedure above. Grok's entries are `format: "raw"`, so archive and
   executable digests are the same value.
5. Confirm the argv contract by hand using the checks above. This is the
   step nothing else covers.
6. Smoke-test an interactive tab, including the inactive-environment path.

## Repository-wide validation

Run the cheap drift, downloader, and manager checks before live downloads:

```bash
bun test tests/unit/version-drift.test.ts \
  tests/unit/download-agent.test.ts \
  tests/unit/verify-toolchain-artifacts.test.ts \
  tests/unit/electron/toolchain-manager.test.ts \
  tests/unit/bridge-packaging.test.ts --parallel
```

For a repository-wide agent upgrade, verify every pinned URL, archive digest,
and extracted executable digest rather than only the current host target:

```bash
bun run verify:toolchains:live
```

`verify:toolchains:live` covers only what the manifest pins. Verify
`@cursor/sdk` by building the Cursor SDK bridge and running its suite, as
described in its section.

Then run provider-specific typechecks and tests above, build the Docker image,
and finish with the full suite:

```bash
bun run test
```

Finally verify the inactive-environment path for each provider: start a turn,
switch to another environment while it runs or waits for input, return after it
finishes, and confirm that messages, status, questions/approvals, and controls
rehydrate from authoritative backend state.

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
