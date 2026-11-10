# Headless dev profiles leave Electron core dumps in the checkout

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`, found while qualifying
fleet ticket sync over two `dev:test` profiles (to-do 3800 task 1, now
retired into
[agent-testing.md](../../development/agent-testing.md#live-fleet-ticket-sync-two-profiles)).

### Tasks

1. **Stop a headless profile without an Electron core dump in the checkout**: open.

### 1. Stop a headless profile without an Electron core dump in the checkout

**Problem.** Each `mise run dev:stop` of a profile started with
`dev:test --headless` on Linux left a core file of about 1 GB
(`core.<pid>`) in the root of the worktree that ran it: five in one session
(about 5 GB), each written within a second of a `dev:stop`. They are
untracked, so a `git add -A` would stage them, and a session that stops
profiles often fills the disk.

**Context.** `file -P bytes=100000 core.<pid>` named the executable as the
worktree's own Electron
(`node_modules/.bun/electron@45.2.3/node_modules/electron/dist/electron`).
The host's `kernel.core_pattern` writes a plain `core.<pid>` into the
crashing process's working directory, which for a dev profile's Electron is
the checkout. `coredumpctl` on the same host listed Playwright Chromium
aborts separately, so the Electron dumps did not go through
systemd-coredump. The dumps were deleted after they were identified; nothing
else was inspected.

**Investigation.** Not yet done. Unknown: which signal ended Electron (the
dump was not opened), whether `dev:stop`'s shutdown order (backend, Vite,
Electron) makes headless Electron abort, and whether a windowed run or macOS
does the same.

Steps:

1. Start a throwaway headless profile
   (`env -u DISPLAY -u WAYLAND_DISPLAY mise run dev:test --profile <p> --fixture --headless --no-agent-credentials`),
   wait for `ready`, then `mise run dev:stop --profile <p>`.
2. Look for `core.*` in the checkout; open one with
   `gdb -batch -ex bt <electron> core.<pid>` for the signal and frame. Delete
   it afterwards.
3. Read `apps/desktop/scripts/dev-stop.ts` and the Electron main's shutdown
   handling for the order and signals used.

**Decisions.**

- **How to stop the dumps?**
  - **Fix the abort at its cause (recommended).**
    - Pros: no crash on every stop; nothing to clean up.
    - Cons: needs the investigation above first.
  - **Start dev Electron with a working directory outside the checkout, or with `RLIMIT_CORE` 0.**
    - Pros: small change; the checkout stays clean whatever the cause.
    - Cons: hides a real crash; a lower core limit also hides crashes worth a dump.
  - **Add `core.*` to `.gitignore`.**
    - Pros: one line; nothing gets committed.
    - Cons: the disk still fills.

## Related

- [agent-testing.md](../../development/agent-testing.md#headless-electron)
- [0248](../containers-and-environments/0248-playwright-profile-dir-leaks.md)
