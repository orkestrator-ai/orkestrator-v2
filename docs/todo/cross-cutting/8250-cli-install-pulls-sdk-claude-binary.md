# Installing the published CLI still pulls a Claude binary its bridge never runs

## Task analysis

Analysed 2026-11-16 against `main` at `c1fcc573b`.

### Tasks

1. **Stop the CLI's install from pulling the Claude Agent SDK's platform package**: take `@anthropic-ai/claude-agent-sdk` out of the published package's runtime dependencies so neither `bun add orkestrator` nor the standalone updater's release-runtime install fetches the SDK's 320 MB Claude Code binary. Status: open.

### 1. Stop the CLI's install from pulling the Claude Agent SDK's platform package

**Problem.** To-do 8050 (retired 2026-11-16) found that no host path runs the
Agent SDK's own Claude Code binary: the bridge always passes `CLAUDE_CLI_PATH`
as `pathToClaudeCodeExecutable`, and both backend launch paths always set it.
It dropped the binary from the desktop app (about 320 MB on macOS arm64). The
published `orkestrator` package still declares `@anthropic-ai/claude-agent-sdk`
as a runtime dependency, and that package lists its eight platform packages
(`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, `-musl` on Linux) as optional
dependencies. Every install therefore downloads the host's platform package,
which holds a whole Claude Code binary (321,995,200 bytes for darwin-arm64 at
0.3.319, about 144 MB gzip-compressed). On Linux the image build found both the
glibc and the musl package installed, so a Linux host may get two.

**Context.** The npm tarball itself carries no binary:
`packages/cli/scripts/build.ts` bundles the Claude bridge into
`resources/claude-bridge/dist/index.js` with the SDK left external
(`BUNDLED_BRIDGES` in `packages/cli/scripts/bridges.ts`), so the bridge
resolves the SDK from the installed dependency. Two installs pull it:

- a user's `bun add`/`npm install` of `orkestrator`, through
  `packages/cli/package.json`'s `dependencies`;
- the standalone updater (`packages/protocol/src/node/standalone-service.ts`),
  which installs `resources/release-runtime/` with `--frozen-lockfile
  --production`; `packages/cli/release-runtime/bun.lock` lists all eight
  platform packages.

Neither can opt out per package: `--omit=optional` would also drop `sharp`'s
`@img/*` native packages, and npm `overrides` apply only in the root project,
never to a published dependency.

**Investigation.** Checked on 2026-11-16 against SDK 0.3.319: its `sdk.mjs`
imports only Node built-ins and has no dynamic `import()`, so a bundler can
inline it. It uses `createRequire(import.meta.url)` and resolves its platform
package from `import.meta.url` only when `pathToClaudeCodeExecutable` is unset,
which the bridge never does (`claudeExecutableOptions` in
`bridges/claude-bridge/src/services/session-manager-core.ts`). Bundling would
break one read: `claudeSdkVersions` in
`bridges/claude-bridge/src/services/session-manager-interactions.ts` finds the
SDK version with `import.meta.resolve("@anthropic-ai/claude-agent-sdk")`, which
fails in a bundle; it already falls back to `undefined` with a debug log, so the
reported SDK version would go blank rather than crash. Places that pin the
current shape and change with it: `packages/cli/tests/cli.test.ts` (the derived
runtime dependency list), `packages/cli/scripts/smoke-packed.ts` (resolves the
SDK from the installed and the frozen release), the CLI pin rows in
`tests/unit/version-drift.test.ts`, `packages/cli/release-runtime/` (regenerate
with `bun packages/cli/scripts/lock-bridge-runtimes.ts`) and the "second pin"
paragraph of
[upgrade-agents.md](../../development/upgrade-agents.md) ("Where the SDK is used").
Not checked: a packed install and a standalone update after the change.

**Decisions.**

- **How to drop it?**
  - **Bundle the SDK into the CLI's Claude bridge and remove the dependency
    (recommended).**
    - Pros: no platform package on any install; one fewer pin to bump, since
      the bundle takes the bridge's own SDK version; the tarball grows by
      about 1.3 MB.
    - Cons: the CLI's bridge no longer has the same shape as the desktop's
      (external SDK under `dist/node_modules`); the SDK version read needs a
      build-time value (a `define` from the SDK's `package.json`) to keep
      reporting it; needs `smoke:pack` and a standalone update rerun.
  - **Vendor the SDK under `resources/claude-bridge/dist/node_modules`, as the
    desktop build does.**
    - Pros: same shape as the desktop app and the image; the version read keeps
      working.
    - Cons: package managers leave nested `node_modules` out of a packed
      tarball unless the package is a `bundledDependencies` entry, which brings
      back the optional platform packages; unproven with `bun pm pack`.
  - **Keep the dependency.**
    - Pros: nothing to change.
    - Cons: every CLI install and standalone update keeps downloading a binary
      nothing runs.

## Related

- To-do 8050, the desktop app's copy (retired 2026-11-16; in Git history at
  `git show c1fcc573b:docs/todo/cross-cutting/8050-desktop-package-sdk-claude-binary.md`)
- [upgrade-agents.md: The SDK's own Claude binary is not vendored](../../development/upgrade-agents.md#the-sdks-own-claude-binary-is-not-vendored)
- [Container qualification: Claude bridge without the SDK's platform binary](../../development/container-qualification.md#claude-bridge-without-the-sdks-platform-binary-2026-11-15)
