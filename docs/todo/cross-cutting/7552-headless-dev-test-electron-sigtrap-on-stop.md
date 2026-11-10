# A headless `dev:test` Electron dumps core with SIGTRAP when its profile stops

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12`. Found while qualifying
[4720](../coordinator-and-multi-review/4720-coordinator-send-fast-forward-slow-remote.md)
on beelink; not caused by that work, which changed no app code.

### Tasks

1. **Find why a headless profile's Electron traps on stop**: get a symbolised backtrace of the SIGTRAP and decide whether the stop path or Electron is at fault. Status: open.
2. **Keep core files out of the worktree**: stop a launcher-owned Electron's core dump from landing as an untracked ~1 GB file in the checkout. Status: open (depends on 1).

### 1. Find why a headless profile's Electron traps on stop

**Problem.** On 2026-11-10, two of three headless `dev:test` profiles stopped
on beelink left an Electron core dump: one stopped with `mise run dev:stop`
(profile started with `dev:test --fixture --headless --no-agent-credentials
--agent-platforms pi`), and one stopped by the one-shot
`mise run test:agent:coordinator-slow-remote` runner. `gdb` on each core
reported `Program terminated with signal SIGTRAP`, from the worktree's own
`node_modules/.bun/electron@45.2.3/.../electron --ozone-platform=headless`.
The test runs before the stop had passed.

**Context.** [`process-crashes-and-kills.md`](../../debugging/process-crashes-and-kills.md)
lists a SIGTRAP only for a packaged app relaunched from a vanished AppImage
mount, which does not apply to a development Electron. Chromium raises
SIGTRAP for a failed `CHECK` or `NOTREACHED`, so this is most likely an
assertion during shutdown.

**Investigation.** The backtrace is unsymbolised (`?? ()` frames only), and
`strings` found no `Check failed` text in the core. Nothing else was looked
at: which shutdown step was running, whether a windowed (non-headless)
profile does the same, and whether it happens on macOS.

**Decisions.**

- **How to get a usable stack?**
  - **Electron's published debug symbols for 45.2.3 with `gdb`, on a kept
    core (recommended).**
    - Pros: names the failing check without changing the app.
    - Cons: a large symbol download; the core must be kept until then.
  - **Enable crashpad minidumps for `dev:test` Electron.**
    - Pros: small dumps, symbolised later.
    - Cons: changes the launcher for one diagnosis.

### 2. Keep core files out of the worktree

**Problem.** beelink's `kernel.core_pattern` was `core` at the time, so each
dump was written as `core.<pid>` (about 1 GB) in the worktree root, where it is
untracked and not ignored: a broad `git add` would stage it.

**Context.** The host's core pattern is not the repository's to change.

**Investigation.** Not started.

**Decisions.**

- **What to change?**
  - **Fix the cause found by task 1 (recommended).**
    - Pros: no dump at all.
    - Cons: waits on task 1.
  - **Ignore `core.[0-9]*` in `.gitignore`.**
    - Pros: one line; nothing gets committed.
    - Cons: the gigabyte still lands in every worktree.
