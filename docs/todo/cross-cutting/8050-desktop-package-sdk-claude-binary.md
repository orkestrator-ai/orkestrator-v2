# The desktop and CLI packages may ship a Claude binary host bridges never run

## Task analysis

Analysed 2026-11-15 against `main` at `a8b89f154`.

### Tasks

1. **Find out whether any host path runs the SDK's platform binary**: trace every way a packaged desktop app, the published `orkestrator` CLI and a backend-only host start the Claude bridge or call the Agent SDK, and record whether each passes `pathToClaudeCodeExecutable`. Status: open.
2. **Drop the SDK's platform binary from the packages that never run it**: only if task 1 finds no path that runs it. Status: open (depends on 1).

### 1. Find out whether any host path runs the SDK's platform binary

**Problem.** The container image shipped the Claude Code native binary twice
until to-do 6780 (retired 2026-11-15) dropped the Claude Agent SDK's platform
package from it. That to-do left open whether the packaged desktop app, which
vendors the same SDK platform packages through
`bridges/claude-bridge/scripts/vendor.ts`, carries the same dead copy: about
300 MB per platform package in every download.

**Context.** The root `package.json`'s `build.extraResources` packs
`bridges/claude-bridge/dist/**`, which includes `dist/node_modules` with every
installed `@anthropic-ai/claude-agent-sdk-<platform>` package. The backend
starts a host Claude bridge with `CLAUDE_CLI_PATH = resolveClaudeBinary()`
(`apps/backend/src/core/commands-servers.ts`), which is the managed toolchain
binary or, outside agent-test profiles, the bare name `claude` for a PATH
lookup (`resolvePathFallbackAgentBinary` in
`apps/backend/src/core/commands-agent-support.ts`). The bridge passes that
value as `pathToClaudeCodeExecutable` on every SDK call
(`claudeExecutableOptions` in
`bridges/claude-bridge/src/services/session-manager-core.ts`), and the SDK
(0.3.319) looks for its own binary only when that option is unset. The
published CLI pins the SDK a second time (`packages/cli/package.json`;
`packages/cli/release-runtime/bun.lock`), see
[upgrade-agents.md](../../development/upgrade-agents.md).

**Investigation.** Not started beyond the facts above. Unchecked: whether any
host path starts the bridge without `CLAUDE_CLI_PATH` (a backend-only host's
on-demand bridge install, the CLI's release runtime, live probes and dev
scripts are the candidates); what a bare `claude` that is not on PATH does
today (the SDK is given a path, so it would fail rather than fall back); and
how many platform packages each desktop build actually contains.

**Decisions.**

- **How to establish it?**
  - **Read every launch path and confirm with one packaged build's
    `dist/node_modules` listing (recommended).**
    - Pros: cheap; gives the size per build and the list of callers.
    - Cons: a static trace can miss a dynamic caller; task 2 still needs a
      packaged-app turn to prove it.
  - **Delete the package from a local packaged build and run every host
    flow.**
    - Pros: direct evidence.
    - Cons: needs a packaged build per platform and a live Claude session on
      each; far more work before knowing whether it pays.

### 2. Drop the SDK's platform binary from the packages that never run it

**Problem.** If task 1 finds no path that runs it, the copy is dead weight in
every desktop download.

**Context.** The image does it in its `bridge-build` stage (`docker/Dockerfile`)
and its qualification is in
[container-qualification.md](../../development/container-qualification.md#claude-bridge-without-the-sdks-platform-binary-2026-11-15).
On a host, unlike in the image, `CLAUDE_CLI_PATH` can name a bare `claude`
that is not installed, so the SDK's copy may be the only engine some users
have ever run, even if by accident.

**Investigation.** Not started.

**Decisions.**

- **Where to drop it?**
  - **In `vendor.ts`, behind an option the desktop and CLI builds pass
    (recommended if task 1 finds no caller).**
    - Pros: one place; the image's `rm -rf` could then become the same option.
    - Cons: the bridge's own development runs (`bun run build` in a checkout)
      must keep the platform package if any probe relies on it, which task 1
      has to confirm.
  - **In the electron-builder filter (`build.extraResources`).**
    - Pros: no build-script change.
    - Cons: the CLI's release runtime needs its own exclusion; two places to
      keep in step.

## Related

- To-do 6780, the image's second Claude binary (retired 2026-11-15; in Git
  history at `git show a8b89f154:docs/todo/containers-and-environments/6780-second-claude-binary-in-the-image.md`)
- [Container qualification: Claude bridge without the SDK's platform binary](../../development/container-qualification.md#claude-bridge-without-the-sdks-platform-binary-2026-11-15)
- [`upgrade-agents.md`](../../development/upgrade-agents.md)
