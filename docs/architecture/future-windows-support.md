# Future Windows support

Status: Reference — not planned. **There are no immediate plans to add
Windows support.** This document records what supporting Windows would take,
so the work can be scoped quickly if that changes. It is not a roadmap, and
nothing here is scheduled. Outstanding work belongs in `docs/todo/` only once
Windows support is actually planned.

Assessed 2026-11-07 against `main` at `df1815e98`, from reading the code. No
Windows machine was used: nothing here has been built, run or tested on
Windows. Line references are from that commit and will drift.

## Summary

Orkestrator supports macOS and Linux only (`README.md:136`). It refuses
Windows in four places:

- the backend, at `apps/backend/src/data-dir.ts:14` (called from `main.ts:59`);
- the PTY, at `apps/backend/src/core/pty.ts:76`;
- the desktop build, at `apps/desktop/scripts/build.ts:8`;
- the CLI package, through its `"os": ["darwin","linux"]` field.

Under those checks, about 300 production sites assume POSIX, spread over
every layer. About 800 test files (22% of the suite) assume POSIX as well.

There are two ways Windows could be supported:

| Route | Estimate | What the user gets |
| --- | --- | --- |
| **WSL2 backend, client-only Windows desktop** (preferred) | About 3–5 engineer-weeks, plus a code-signing certificate | A first-party Windows desktop window connected to the unchanged Linux backend running in WSL2. Every feature works. |
| WSL2 backend, browser client only | About 1–2 engineer-weeks, mostly qualification | The web client in a Windows browser. No desktop window, menus or notifications. |
| **Native Windows host** | About 14–24 engineer-weeks, plus a code-signing certificate | A self-contained Windows app, with some features cut. |

The native version would still ship without:

- the tmux Claude tab;
- SSH routes;
- Grok;
- Cursor on arm64;
- an `enforced` Codex coordinator.

Native support would also add a lasting cost: every new feature would need a
Windows path and a Windows CI shard to keep working.

## The WSL2 route

Inside WSL2 the backend is an ordinary Linux backend, so tmux, SSH, every
agent and the enforced sandboxes keep working. Container environments already
run in a Linux image whichever host starts them. `orkestrator serve` (the
published CLI) or `mise run start:web` serves the built client to an
authenticated browser ([remote-gateway.md](remote-gateway.md)).

### A client-only Windows desktop

The desktop can already run as a client of another machine's backend:

- `startApplication` (`apps/desktop/electron/main.ts:1485-1495`) falls back to
  client-only when the local backend fails to start and at least one remote
  machine is saved. Local becomes `createUnavailableLocalBackend()`, and the
  renderer gets `local-backend-unavailable`.
- `normalizeRemoteAddress` (`connection-records.ts:38-75`) accepts plain
  `http://localhost:<port>` and `127.0.0.1`, which is what WSL2's localhost
  forwarding exposes. Other addresses must be HTTPS.
- Saved tokens go through Electron `safeStorage`, which uses DPAPI on Windows.
- Previews and terminals already travel over the connection, through the
  preview tunnel and the terminal WebSocket.
- The Windows leg of `native-application-menu.yml` already runs the menus on
  Windows CI.

Five gaps would need closing:

1. **Start-up order.** The toolchain step runs before the backend
   (`main.ts:1380-1408`). It would throw, because the toolchain manifest has
   no win32 platform, and the app would quit before reaching client-only
   mode. A client-only build should skip it.
2. **Agent platform picker.** The first-run picker would open even though no
   agent runs locally.
3. **First run.** With no machine saved yet, a failed local start ends
   startup instead of offering "add a machine".
4. **Local in the window.** Local would stay as a machine that is always
   unavailable; it should be hidden.
5. **Packaging.** A Windows NSIS installer, signing and an update feed (see
   [Packaging, release, CI and tests](#packaging-release-ci-and-tests)). A
   client-only build does not need to bundle Bun, the backend or the bridges.

Because the backend stays Linux, none of the native work below on host
paths, process trees, file safety, toolchains or bridges applies. Of the
renderer work, only the window chrome and the Mac-only shortcuts remain.

### Finding the WSL backend

There are two ways the desktop could reach the WSL backend:

- **First version (preferred).** The user runs `orkestrator serve` in WSL,
  then adds `http://localhost:<port>` and its token as a machine. This uses
  the existing add-machine flow, but it is a manual step and the user has to
  keep the WSL service running.
- **Later.** A "WSL" connection type, where the desktop starts the backend
  itself (`wsl.exe -d <distro> -- orkestrator serve`) and reads the token
  from the backend's auth file through `wsl.exe`, never printing it. That
  would feel like Local does on macOS. It is about one more week, and it has
  to handle WSL being shut down and choosing a distro.

### Trade-offs

- Projects must live in the WSL filesystem. `/mnt/c` checkouts are slow and
  miss file-change events.
- Agent credentials live in the WSL home, not the Windows one.

### Qualifying it

These steps have never been run. On a Windows 11 machine or VM:

1. Install WSL2 (Ubuntu 24.04) and Docker Desktop with WSL integration.
2. Install the CLI in the distro, then run `orkestrator serve` on a throwaway
   data directory.
3. Open the printed URL in Edge on Windows and sign in.
4. Create a local worktree environment for a repository in the WSL
   filesystem, and a container environment. Run a Claude and a Codex turn in
   each.
5. Check terminals, previews, the external browser forward, agent sign-in
   (which browser opens) and the Claude read-only coordinator tier.
6. Connect a Windows desktop build to that backend as a saved machine.

## The native route

Effort by area, before overlap is removed:

| Area | Estimate | Mostly |
| --- | --- | --- |
| Backend start-up, terminals, process trees | 2–4 weeks | Design |
| File safety, permissions, secrets | 1–2 weeks | Design |
| Toolchains and Bun for Windows | 1–2 weeks | Design and mechanical |
| Bridges and coordinator tiers | 4–6 weeks | Design |
| Renderer and protocol paths, shortcuts, window chrome | 1.5–2 weeks | Mechanical |
| Packaging, signing, release, Electron main | 2–3 weeks + certificate | Mechanical |
| Test suite porting and a Windows CI shard | 3–6 weeks | Mechanical, wide |

### Backend start-up

- `defaultDataDir` has no Windows branch (`data-dir.ts:20-27`); it should
  return `%APPDATA%\orkestrator-v2`.
- `packages/protocol/src/backend-instance.ts:147` rejects any `authFile` or
  `dataDir` that does not start with `/`.
- `runtime-profile-status.ts:113` throws for dev profiles.
- Shutdown relies on `SIGTERM` and `SIGINT` (`main.ts:283`). On Windows,
  Electron's `SIGTERM` is an immediate TerminateProcess
  (`apps/desktop/electron/backend-process.ts:1379`), so the backend never
  drains.
- The desktop's environment allowlist for agent-test profiles drops
  `USERPROFILE`, `APPDATA`, `SystemRoot`, `ComSpec` and `PATHEXT`
  (`backend-process.ts:111-161`).

**Preferred approach.** Stop the backend over the existing loopback control
channel. It works the same on every OS and can be tested, but a hung backend
still needs a forced kill. Windows console control events are unreliable for
a process with no console.

### Terminals and process trees

Windows has no PTY path, no way to kill a process tree and no orphan reaper.
Every existing `win32` branch quietly does nothing, so on Windows shells,
builds, bridges and agent CLIs would outlive whatever stopped them.

- **PTY.** `spawnPty` (`pty.ts:89`) wraps `Bun.spawn({ terminal })`. Bun
  1.4's documentation says `Bun.Terminal` uses ConPTY on Windows, so the
  README's reason for refusing Windows may be out of date. The documented
  differences are:
  - no termios;
  - re-encoded VT output;
  - `\r` is not translated;
  - no `SIGWINCH` unless the child reads stdin in raw mode;
  - a slow `close()` before Windows 11 24H2.

  If ConPTY behaves, the PTY work stays inside `pty.ts`, but nobody has run
  that on Windows.
- **Process groups.** There are 10 group kills with `process.kill(-pid)`, for
  example `process-tree.ts:76,184`, `command-capture.ts:401`,
  `exec-worker.ts:36` and `preview-browser-harness.ts:207`. About 11 spawns
  use `detached: true` to create process groups.
- **Windows branches that do nothing:**
  - `process-tree.ts:59,75,207`;
  - `command-capture.ts:399-415`;
  - `local-server-reaper.ts:379`;
  - `shell.ts:79`;
  - `bridges/codex-bridge/src/app-server/process-supervisor.ts:960,1512`.
- **Process identity** relies on `ps`, `/proc` and `lsof`:
  - `process-identity.ts`;
  - `shell-process-state.ts:113`;
  - `environment-process-usage.ts:262`;
  - `preview-listener-ownership.ts:253`.

  The orphan reaper's safety checks (`ppid == 1`, `pgid == pid`) have no
  Windows equivalent.
- **Shell.** `resolveLocalShellPath` (`commands-terminal.ts:225`) falls back
  to `/bin/zsh`, and user commands run as `<shell> -lc`.
- **tmux.** About 8,400 lines in `tmux-*.ts`. They back only the opt-in
  claude-tmux tab; the default is `claudeNativeBackend: "sdk"`
  (`app-config-defaults.ts:64`).

**Preferred approaches.**

- **Process trees.** A Job Object per spawned tree, with kill-on-close.
  - It kills the whole tree, grandchildren included, and survives a parent
    crash.
  - It needs native code (FFI to kernel32, or a small helper binary). Bun's
    spawn does not expose Job Objects, so each process has to be put in its
    job straight after spawn.
  - The alternative, `taskkill /T /F /PID`, misses re-parented children, has
    no grace period and launches a process per kill.
- **Shell.** PowerShell 7 if it is installed, otherwise Windows PowerShell,
  with a setting for Git Bash.
  - PowerShell is always present and matches Windows Terminal.
  - User commands written for `sh -lc` need their own invocation.
  - Requiring Git Bash would keep POSIX command strings working, at the cost
    of an extra dependency and MSYS path translation surprises.
- **tmux.** Hide the claude-tmux tab and skip tmux reaping and mail on
  Windows, about 5–10 files of gating.

### Confined file operations and secrets

- Safe workspace moves, mkdirs and writes call libc through `bun:ffi`
  (`openat`, `renameat2`, `renameatx_np`, `mkdirat`). They throw on other
  platforms (`path-safety.ts:85,258`, which has 18 importers).
- `change-tracking/confined-read.ts:42` and `design/export-directory.ts:7`
  fail closed.
- Owner-only secrets rely on `0o600` and `0o700` (about 200 sites), which
  give no protection on Windows.
- Several checks reject the `0o666` mode Windows reports:
  - `mcp-management/service.ts:646,758`;
  - `packages/cli/src/client/config.ts:78,144`;
  - `targets.ts:139`.
- The toolchain integrity check expects mode `0o500`.
- `O_NOFOLLOW` (27 files) is undefined on Windows, so the open-time symlink
  guards quietly disappear.
- Change tracking derives `100755` from `mode & 0o111`
  (`change-tracking/capture.ts:366,383,488`, `restore.ts:118`), so every
  Windows file would be recorded as `100644`.

**Preferred approaches.**

- **Confined operations.** A Windows implementation over handle-relative NT
  calls: `NtCreateFile` with a root directory handle, plus reparse-point
  checks.
  - This keeps the same guarantee against symlink and junction races, but it
    is new FFI surface that needs a careful review.
  - Plain path checks with `lstat` and `realpath` would add a time-of-check
    race the POSIX path does not have, which weakens an isolation boundary.
- **Secret files.** Lock each file's ACL to the current user, or encrypt it
  with DPAPI, and drop the mode-bit checks on Windows.
- **Executable bit.** Read it from the git index rather than from the file
  mode (about 4 sites).

### Toolchains

- `ToolchainPlatform` is `"darwin" | "linux"`
  (`packages/toolchain/src/manifest.ts:44`). There are no win32 artifacts for
  claude, codex, opencode, grok, pi or gh.
- `selectPinnedToolchainArtifacts` (`:758`) requires every pinned tool for
  the platform.
- Activation of the current set uses symlinks (`install.ts:209`,
  `manager.ts:1601`).
- Binary names have no `.exe` (`manager.ts:174`,
  `commands-agent-support.ts:334,694`).
- `scripts/download-bun.sh` is bash, and it pins SHAs only for darwin and
  linux.
- `host-maintenance-tasks.ts:254` throws for gh on win32.
- The lockfiles already contain `@anthropic-ai/claude-agent-sdk-win32-{x64,arm64}`
  and `@cursor/sdk-win32-x64`, with no win32 arm64 build for Cursor.

**Preferred approaches.**

- **Activation.** A versioned directory plus a small JSON pointer to the
  current set, read by the resolver.
  - No symlinks and no Developer Mode, and switching sets is atomic through a
    rename. Every resolver has to read the pointer.
  - Directory junctions would be the smallest change, but they rename and
    delete differently from symlinks, and the integrity checks would need
    rework anyway.
- **Missing tools.** Make the completeness check per platform, and report a
  missing tool as "unavailable on this OS" in the platform picker.

### Bridges and coordinator tiers

- **Codex read-only tier.** It is `enforced` with no input from the host
  (`packages/protocol/src/graphs/capability-enforcement.ts:170`). The bridge
  never calls `windowsSandbox/readiness` or `setupStart`, and it ignores
  `windowsSandbox/setupCompleted` (`app-server/event-reducer.ts:115`). On
  Windows the tier would claim a boundary nothing is holding.
- **Claude read boundary.** On Windows the shell allowlist is the whole
  boundary, but `globRoot` (`read-only-path-boundary.ts:51`) treats only `/`,
  `~` and `..` as rooted. Drive-letter, UNC and Git Bash `/c/...` patterns get
  past it.
- **Codex orphans.** Orphan matching uses `/proc` and `ps -E`, and returns
  false on other systems (`process-supervisor.ts:1406-1506`).
- **Already handled.** `coordinator-providers.ts:80-89` already gives Claude
  `claudeSandbox: false` on win32, which is the `provider-configured` tier.
  Cursor's persistence already copes with Windows fsync semantics
  (`cursor-bridge/src/persistence.ts:73-114`).
- **Pi.** Its only gap is `scripts/vendor.ts:179,204,243`, which creates
  `symlink(…, "dir")`.
- **Atomic writes.** Rename-over writes in every bridge need a retry for
  transient `EPERM` and `EBUSY` from antivirus software.

| Bridge | Effort |
| --- | --- |
| Codex | 2–3 weeks |
| Claude | 1–2 weeks |
| Cursor | 3–5 days |
| Pi | 2–4 days |
| Grok | Turn off (no Windows build in the toolchain) |

**Preferred approaches.**

- **Codex coordinator.** Make the tier depend on the host: `enforced` only
  when app-server reports `windowsSandbox/readiness` as `ready`, otherwise a
  lower tier with the reason. This never overstates the boundary
  ([coordinator.md](coordinator.md#changing-qualification)), but the
  readiness and setup flow, which may need elevation, has to be built.
  Turning Codex coordinators off on Windows would cost nothing but lose the
  strongest coordinator platform there.
- **Claude read boundary.** Normalise drive-letter, UNC and `/c/` forms
  before checking roots, with tests for each. This is required before any
  native Windows release.

### Renderer and protocol

- Host-path validators require a leading `/`:
  - `GlobalSettings.tsx:180,197`;
  - `RepositorySettings.tsx:365,385`;
  - `ProjectCopyDialog.tsx:205`;
  - `EnvironmentMoveSection.tsx:26`.
- `permission-rules.ts:435-450` rejects `\`.
- About 25 sites take a path's last part by splitting on `/` only, for
  example `NativeMessage.basic-parts.tsx:256` and `DraggableTabBar.tsx:243`.
- 13 shortcuts are defined only for the Mac, and their handlers check
  `metaKey`, so on Windows they fire on the Win key. Examples are
  `useActionBarController.ts:1501` and `OpenFileDialog.tsx:79`. Linux has the
  same gap (to-do 0325, retired; see
  [keyboard-shortcuts.md](keyboard-shortcuts.md#packaged-native-qualification)).
- Windows gets both the native caption bar and the 37px drag bar
  (`title-bar-inset.ts:10`, `AppShell.tsx:238`).
- **Already Windows-aware:**
  - `workspace-file-path.ts`;
  - `file-url.ts`;
  - `inline-file-reference.ts`;
  - the `separator` prop on `truncated-path.tsx`;
  - `ShortcutPlatform = "mac" | "other"`.

**Preferred approaches.**

- **Host paths.** One shared `isAbsoluteHostPath`, `hostBasename` and
  `hostDirname` helper, plus a stated rule that permission rules apply only
  to container and workspace-relative paths.
- **Window chrome.** `titleBarStyle: "hidden"` with `titleBarOverlay`, leaving
  room for the caption buttons. Mock it up before building it.
- **Shortcuts.** Choose Ctrl+Shift equivalents for Windows and Linux
  together.

### Packaging, release, CI and tests

- **Packaging.** There is no `win` electron-builder target, and the
  extraResources filter `["bun"]` misses `bun.exe`.
- **Release.** `scripts/release-desktop.ts:403-491` knows only darwin and
  linux assets and feeds, and publishing refuses unless both are present.
  `auto-update.ts` and `main.ts:876` have no NSIS path. Releases are built by
  hand on each host, and there is no Windows release machine.
- **mise tasks.** 15 of the 116 use POSIX shell syntax (`VAR="$(…)" cmd`,
  `env -u`, `uname`, heredocs).
- **Dev launcher.** `apps/desktop/scripts/dev/*` uses group kills and
  `ps -o lstart=`.
- **Line endings.** There is no `.gitattributes`, so autocrlf would break
  `docker/**/*.sh` in images built from Windows.
- **Tests.** About 800 test files assume POSIX: fake `#!/bin/sh` CLIs,
  `chmod`, `/tmp`, signals, tmux. `tests/private-tmpdir.ts:35` hard-codes
  `/private/tmp`.
- **CI.** Two Windows jobs already exist: `claude-hook-only-windows`
  (`ci.yml:208`) and the Windows leg of `native-application-menu.yml`.

**Preferred approaches.**

- **Installer.** NSIS, signed with Azure Trusted Signing. electron-updater
  supports NSIS and no hardware token is needed, but it needs an Azure
  account and identity validation. That is the maintainer's call and an
  outward-facing action. MSIX installs cleanly, but electron-updater cannot
  update it.
- **Tests.** Start with a Windows unit shard for protocol, web and desktop,
  with an explicit list of POSIX-only test files, and grow it as the native
  work lands. Porting every test before a first release would roughly double
  the packaging and CI estimate.

## Already Windows-aware

Windows is refused at startup and by every build target, but some code
already handles it:

- Docker Desktop endpoints (`npipe://`, `host.docker.internal`);
- some renderer path helpers;
- the `CmdOrCtrl` menus and the `ShortcutPlatform` abstraction;
- `explorer.exe` reveal;
- `where` lookups;
- Cursor's fsync;
- `GIT_CONFIG_GLOBAL=NUL`;
- the two CI jobs above.

## Constraints

- Coordinator tiers must never claim a boundary the platform does not hold
  ([coordinator.md](coordinator.md#changing-qualification)). Native Windows
  cannot ship without the Codex and Claude changes above.
- Background work must outlive the UI, and stops must be explicit (root
  `AGENTS.md`, invariants 2 and 15). A Windows process layer that leaks child
  processes breaks both.
- Signing certificates, Azure accounts and new release channels are
  outward-facing and need the maintainer's approval.

## Unverified

- `Bun.Terminal` under ConPTY on Bun 1.4.4. This comes from the Bun 1.4.2
  documentation; it has not been run.
- Upstream Windows builds for Codex, OpenCode, Claude Code, Grok and gh. Not
  checked against their release pages.
- Git for Windows accepting `core.hooksPath=/dev/null`, the `!f(){…}`
  credential helper, and `core.longpaths` for deep worktrees.
- Bubblewrap and the Claude sandbox under the WSL2 kernel
  ([0145](../todo/agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md)).
- How reliable WSL2's localhost forwarding (NAT or mirrored mode) is for the
  gateway's HTTP, WebSocket and preview-tunnel traffic over long sessions.
- Whether Windows on arm64 would be in scope. Cursor ships no win32 arm64 SDK.

## Related

- [remote-gateway.md](remote-gateway.md): the standalone backend the WSL2
  route relies on.
- [federation.md](federation.md): saved machines and how the window shows
  them.
- [coordinator.md](coordinator.md): coordinator tier rules.
