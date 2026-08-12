# Upgrading agent SDKs and binaries

This runbook covers the Claude, Codex, and OpenCode versions used by
Orkestrator. These integrations do not share one upgrade mechanism:

| Agent | SDK integration | CLI integration | Current pins |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` drives native sessions; `@anthropic-ai/sdk` supplies message content types | The Agent SDK is pointed at Orkestrator's separately managed `claude` executable | Agent SDK `0.3.228`, Anthropic SDK `0.116.0`, CLI `2.1.228` |
| Codex | No runtime `@openai/codex-sdk` dependency. The bridge speaks JSON-RPC to `codex app-server` using generated types | The pinned `codex` executable is the app-server and is also used by isolated `codex exec` helpers | CLI and generated protocol `0.147.0` |
| OpenCode | `@opencode-ai/sdk/v2/client` is used by the renderer and backend build pipeline | The pinned `opencode` executable runs `opencode serve` | SDK and CLI `1.18.16` |

All versions are exact pins. Do not change them to ranges or `latest`.

## How binaries reach a running environment

There are three delivery paths. An upgrade is incomplete until every applicable
path has been updated.

### Local desktop environments

`apps/desktop/electron/toolchain-manifest.ts` is the authoritative artifact
manifest for Claude, Codex, and OpenCode. It contains one entry per supported
platform and architecture:

- macOS arm64 and x64
- Linux arm64 and x64

Each entry pins the archive URL, allowed hosts, archive size and SHA-256, archive
member to extract, and extracted executable size and SHA-256. OpenCode's macOS
entries additionally set `repairInvalidMacSignature`; the manager retains the
verified upstream bytes and creates a locally ad-hoc-signed executable.

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

`docker/Dockerfile` has exact `CLAUDE_CLI_VERSION`, `CODEX_CLI_VERSION`, and
`OPENCODE_CLI_VERSION` build arguments. It installs:

- `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`
- `@openai/codex@${CODEX_CLI_VERSION}`
- OpenCode's installer with `--version "${OPENCODE_CLI_VERSION}"`

The image also builds and installs both bridge trees. The Claude bridge vendors
the Agent SDK and its platform packages, then the Docker build removes the musl
variants so glibc resolves the correct native package. Container bridge startup
uses the commands on the image's `PATH`; the Codex bridge records the selected
command in `CODEX_PATH`.

### Developer download scripts

The following scripts download the current host's artifact into `binaries/`,
make it executable, probe `--version`, and ad-hoc sign it on macOS:

- `scripts/download-claude.sh`
- `scripts/download-codex.sh`
- `scripts/download-opencode.sh`

They are exposed as `bun run download:claude`, `download:codex`, and
`download:opencode`. Their version pins and URL shapes are tested, so they must
remain synchronized even though the current release package does not embed
their output.

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
     bun scripts/verify-toolchain-artifacts.ts --emit --tool=<claude|codex|opencode>
   ```

   Paste the emitted archive and executable sizes and SHA-256 values into the
   matching platform/architecture entries in
   `apps/desktop/electron/toolchain-manifest.ts`. Do not copy the previous
   version's hashes and do not verify only the development machine's target.
   During iteration, `--platform=darwin|linux` and `--arch=arm64|x64` can narrow
   the download.
4. Assert the completed manifest against fresh upstream downloads:

   ```bash
   RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 \
     bun scripts/verify-toolchain-artifacts.ts --tool=<claude|codex|opencode>
   ```

5. Exercise the current-host convenience downloader:

   ```bash
   bun run download:<claude|codex|opencode>
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
2. Update both committed lockfiles:

   ```bash
   bun install
   (cd bridges/claude-bridge && bun install)
   ```

   Confirm that the root `bun.lock` and `bridges/claude-bridge/bun.lock` resolve
   the intended Agent SDK, Anthropic SDK, and platform-specific Agent SDK
   packages.
3. Inspect the installed Agent SDK's `package.json` field
   `claudeCodeVersion`. It records the CLI version bundled/tested by that SDK.
   Orkestrator deliberately supplies its own CLI, so this field is a
   compatibility signal rather than the repository's source of truth. If the
   separately chosen CLI differs, test that combination explicitly.
4. Update the CLI in all three mirrors:

   - `PINNED_TOOLCHAIN_VERSIONS.claude` in
     `apps/desktop/electron/toolchain-manifest.ts`
   - `CLAUDE_VERSION` in `scripts/download-claude.sh`
   - `CLAUDE_CLI_VERSION` in `docker/Dockerfile`

5. Refresh and verify the four Claude artifact records using the shared binary
   procedure.
6. Review `session-manager.ts` for option, event, and message-union changes. Pay
   particular attention to the version-pinned `canUseTool` comment and re-prove
   that `AskUserQuestion` remains parked until the callback resolves. Review
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

   - `CODEX_VERSION` in `scripts/download-codex.sh`
   - `PINNED_TOOLCHAIN_VERSIONS.codex` in
     `apps/desktop/electron/toolchain-manifest.ts`
   - `CODEX_CLI_VERSION` in `docker/Dockerfile`

3. Refresh and verify all four Codex artifact records using the shared binary
   procedure.
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

See `docs/adr/0001-codex-app-server-engine.md` for the architectural and safety
constraints behind this process. Upstream release source:
[OpenAI Codex](https://github.com/openai/codex).

## OpenCode

### Where the SDK is used

OpenCode's SDK and CLI are intentionally kept at the same exact version.
`tests/unit/version-drift.test.ts` enforces agreement across:

- `@opencode-ai/sdk` in `apps/web/package.json`
- `@opencode-ai/sdk` in `apps/backend/package.json`
- `OPENCODE_VERSION` in `scripts/download-opencode.sh`
- `PINNED_TOOLCHAIN_VERSIONS.opencode` in
  `apps/desktop/electron/toolchain-manifest.ts`
- `OPENCODE_CLI_VERSION` in `docker/Dockerfile`

Both code paths import `@opencode-ai/sdk/v2/client`; do not change them to the v1
package root:

- `apps/web/src/lib/opencode-client.ts` is the renderer wrapper. It normalizes
  OpenCode messages and exposes session, event, model/provider, command, agent,
  skill, question, permission, MCP, formatter, and LSP operations.
- `apps/backend/src/core/build-pipeline-provider.ts` creates a v2 client for
  durable build pipelines and uses sessions, async prompts, status/messages,
  event subscriptions, aborts, questions, and permissions.

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
   bun test apps/web/src/lib/opencode-client.test.ts --parallel
   bun test apps/backend/src/core/build-pipeline-provider.test.ts --parallel
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

## Repository-wide validation

Run the cheap drift, downloader, and manager checks before live downloads:

```bash
bun test tests/unit/version-drift.test.ts \
  tests/unit/download-scripts.test.ts \
  tests/unit/verify-toolchain-artifacts.test.ts \
  tests/unit/electron/toolchain-manager.test.ts --parallel
```

For a repository-wide agent upgrade, verify every pinned URL, archive digest,
and extracted executable digest rather than only the current host target:

```bash
bun run verify:toolchains:live
```

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

An agent upgrade should be one reviewable change per provider. Revert the SDK
manifests/lockfiles, CLI pins, artifact hashes, Docker pin, and—only for
Codex—the generated protocol as one unit. After reverting, reinstall with Bun,
rerun the provider's drift/contract tests, and rebuild the container. Cached
newer toolchains and provider-created session data are not themselves rolled
back; verify that a session created by the newer release can still be resumed if
downgrade compatibility matters.
