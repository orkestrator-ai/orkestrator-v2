# Process usage popover stays on "Loading processes…" on a command node

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`.

### Tasks

1. **Find why the usage reads never return on a command node**: the process list and the CPU, RAM, GPU and disk tiles all stay "–". Status: open.
2. **Show a failed read as a failure**: the panel says "Loading processes…" whatever happened to the read. Status: open.

### 1. Find why the usage reads never return on a command node

**Problem.** Connected to a command node that runs on the same machine, the title-bar Process usage popover shows "Loading processes…" indefinitely. Its four tiles (CPU, RAM, GPU, disk) also stay "–", so no environment detail is visible.

**Context.** The panel reads `get_environment_process_usage` and the tiles read `get_system_usage`, both through `invoke` in `apps/web/src/lib/native/backend.ts`, which calls `window.orkestrator.invoke`. Both commands are registered in `apps/backend/src/core/commands-registry-system.ts`. `AppShell.tsx` mounts `SystemUsageIndicator` for the window's own node and `RealmSystemUsageMeters` when a remote workspace is shown.

**Investigation.** Not run live. Because both tiles and process list are empty, the likeliest cause is that every usage read from this window fails or hangs, not something in the process command. Unconfirmed: whether the read errors, hangs, or reaches a backend that lacks the command (for example an older command-node backend), and where a window connected to a command node sends `invoke`. Needs the console and backend output while the popover is open, whether the window is the desktop app or a browser, how it reaches the command node, and both backend versions.

**Decisions.**

- **How to find the cause?**
  - **Reproduce on an isolated `dev:test` profile joined to a command node, with the console open (recommended).**
    - Pros: shows the actual error and the request's destination; safe for the real data directory.
    - Cons: needs a two-node setup.
  - **Reason from code only.**
    - Pros: no setup.
    - Cons: the routing for a window on a command node is not visible from the files read so far.

### 2. Show a failed read as a failure

**Problem.** A failed read looks the same as a slow one, so the user cannot tell the panel is broken.

**Context.** `EnvironmentProcessPanel` in `apps/web/src/components/layout/SystemUsageIndicator.tsx:431` returns "Loading processes…" whenever `snapshot === null`. `useEnvironmentProcessUsage` already reports `failed` (`apps/web/src/hooks/useSystemUsage.ts`), and the panel ignores it.

**Investigation.** `useUsageRead` sets `failed` when the coordinator's status is `error`, and retains an earlier sample across failures. With no earlier sample, `failed` is the only signal, and it is unused.

**Decisions.**

- **What to show when there is no sample and the read failed?**
  - **A message such as "Couldn't read processes" while polling continues (recommended).**
    - Pros: small change; recovers by itself when a read succeeds; uses the existing `failed` flag.
    - Cons: the message carries no cause.
  - **Also show the error text.**
    - Pros: easier diagnosis.
    - Cons: errors can name hosts or paths; needs checking against the logging rules before display.

## Outstanding work

Both tasks above are open. Task 2 can be done without task 1.

## Needs verification

A browser check at desktop and narrow widths of the failed state, and a reload after the read recovers.

## Related

- [0996-second-backend-takes-default-gateway-port.md](0996-second-backend-takes-default-gateway-port.md)
- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md)
