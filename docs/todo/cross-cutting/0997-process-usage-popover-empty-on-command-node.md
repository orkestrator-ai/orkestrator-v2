# Process usage popover stays on "Loading processes…" on a command node

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`.

### Tasks

1. **Find why the usage reads never return on a command node**: the process list and the CPU, RAM, GPU and disk tiles all stay "–". Status: open (routing ruled out on a healthy two-node stack; the cause on the affected node needs that node).
2. **Show a failed read as a failure**: the panel says "Loading processes…" whatever happened to the read. Status: done (2026-11-05).

### 1. Find why the usage reads never return on a command node

**Problem.** Connected to a command node that runs on the same machine, the title-bar Process usage popover shows "Loading processes…" indefinitely. Its four tiles (CPU, RAM, GPU, disk) also stay "–", so no environment detail is visible.

**Context.** The panel reads `get_environment_process_usage` and the tiles read `get_system_usage`, both through `invoke` in `apps/web/src/lib/native/backend.ts`, which calls `window.orkestrator.invoke`. Both commands are registered in `apps/backend/src/core/commands-registry-system.ts`. `AppShell.tsx` mounts `SystemUsageIndicator` for the window's own node and `RealmSystemUsageMeters` when a remote workspace is shown.

**Investigation.** Run live on 2026-11-05 at `41f9eb638`, in a browser, with a command node and a leaf as two isolated backends on one host (temporary data directories, loopback, ephemeral ports). The fault did not reproduce. In the command node's own workspace, `invoke` goes to the command node; in a leaf's realm, to the leaf. Every usage read answered 200 within about 220 ms, the tiles filled and the process list appeared. `workspace-grant-scope.ts` and `node-routing.ts` do not refuse either command. So a window on a command node does not fail these reads by design.

Two causes reach exactly the reported state, and both were silent until now:

- **A backend without the command.** `classifyReadError` maps `Unknown backend command` to `unsupported`, which stops polling and left `failed` false, so the panel said "Loading processes…" for good. Injected at the network, this now shows the failure.
- **A stalled source on that node.** See [0998](0998-system-usage-read-has-no-timeout.md), confirmed against a stalled mount.

Not tested: the desktop window (only its transport differs, and it was not changed), a real install, a real older backend, and the affected node itself. When it next happens, the panel now separates the cases: "Couldn't read processes" with "Data unavailable" on the tiles means the reads themselves fail, so look at the console and network; tiles with only disk or GPU missing mean a stalled source, and the backend log has `[host] usage.source-stalled` with `scope=disk` or `scope=gpu-sysfs`.

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

Task 1 only: find out what the affected node does, using the signals above.

## Needs verification

The desktop window on a real command node. The browser check of task 2 is done: the failed state at 1440 px and 800 px (below 768 px the phone layout has no such popover), recovery with the panel open, a reload after recovery, and the same failure in a leaf's realm.

## Assumptions and decisions

### Task 2: which reads count as failed

`failed` is now `failures > 0` or status `unsupported`, not status `error`. Status `error` turns back into `loading` during every retry, so the message would have flickered, and it never covered `unsupported`. The alternative, adding a separate flag for `unsupported`, would give the panel two signals for one message.

### Task 2: what the message says

"Couldn't read processes", without the error text, as recommended above: errors can name hosts or paths. The tiles use the existing "Data unavailable" label for a failed read with no sample, in both the process popover and the agent information panel, because they were just as misleading as the list.

## Related

- [7370-tailscale-serve-second-backend-live.md](7370-tailscale-serve-second-backend-live.md) (replaces 0996)
- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md)
