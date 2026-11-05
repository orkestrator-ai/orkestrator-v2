# Process usage popover stays on "Loading processes…" on a command node

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`. Re-checked 2026-11-05 against
`main` at `41f9eb638`: none of the files changed, so the findings still held when
task 2 was acted on.

### Tasks

1. **Find why the usage reads never return on a command node**: the process list and the CPU, RAM, GPU and disk tiles all stay "–". Status: open; what the code shows about the route is recorded below.
2. **Show a failed read as a failure**: the panel says "Loading processes…" whatever happened to the read. Status: done (2026-11-05); see Assumptions and decisions.

### 1. Find why the usage reads never return on a command node

**Problem.** Connected to a command node that runs on the same machine, the title-bar Process usage popover shows "Loading processes…" indefinitely. Its four tiles (CPU, RAM, GPU, disk) also stay "–", so no environment detail is visible.

**Context.** The panel reads `get_environment_process_usage` and the tiles read `get_system_usage`, both through `invoke` in `apps/web/src/lib/native/backend.ts`, which calls `window.orkestrator.invoke`. Both commands are registered in `apps/backend/src/core/commands-registry-system.ts`. `AppShell.tsx` mounts `SystemUsageIndicator` for the window's own node and `RealmSystemUsageMeters` when a remote workspace is shown.

**Investigation.** Not run live. Because both tiles and process list are empty, the likeliest cause is that every usage read from this window fails or hangs, not something in the process command. Unconfirmed: whether the read errors, hangs, or reaches a backend that lacks the command (for example an older command-node backend), and where a window connected to a command node sends `invoke`. Needs the console and backend output while the popover is open, whether the window is the desktop app or a browser, how it reaches the command node, and both backend versions.

What the code shows about where `invoke` goes (read 2026-11-05, nothing run against a node):

- **Desktop window.** `window.orkestrator.invoke` crosses IPC to `orkestrator:invoke` (`apps/desktop/electron/ipc.ts:303`), then `ConnectionManager.invoke` picks the connection for the window's scope (`connection-manager.ts:944`): the local backend, or `remote.client.invoke` for a remote one. `invokeRemote` first waits for any route handover in progress, and the request itself (`backend-process.ts:544`) sets no timeout.
- **Browser window.** The gateway client POSTs to `/__orkestrator/invoke` (`apps/web/src/lib/native/web-gateway.ts:1396`) on the backend serving the page.
- **A window showing another node's workspace.** `setDesktopWorkspaceTarget` retargets the window's scope to that workspace's binding. `AppShell.tsx` then shows `RealmSystemUsageMeters`, whose tiles are reported by the realm page's own `useSystemUsage`, and the popover's process list is read there too. So in that case the reads belong to the node, not to the window.
- **Not refused by name.** `apps/backend/src/core/nodes/workspace-grant-scope.ts` names neither command.

The code leaves three explanations that fit tiles and list being empty together: the backend's event loop was blocked, so nothing answered ([0998](0998-system-usage-read-has-no-timeout.md) records how a stalled disk does that); the hung `statfs` of 0998 for the tiles with a separate failure for the list; or a backend without the commands, which the renderer treats as `unsupported` and never retries. The route alone cannot separate them. The failure message from task 2 now tells a failed read from a slow one, so the next report narrows this, but only logs on the node can name the cause.

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

## Assumptions and decisions

### Task 2: the message

The panel shows "Couldn't read processes" when there is no sample and `failed` is set, as recommended, with no error text. Polling continues and the next successful read replaces the message. A retained sample stays on screen across failures with no failure message, and "Data unavailable" still marks it once it is old. `failed` itself changed so that a hung retry and an unsupported command also show the message; see [0998](0998-system-usage-read-has-no-timeout.md), task 2.

### Task 2: narrow width

The Process usage popover is not part of the phone layout: below 768 px `AppShell` mounts `MobileAppShellLayout`, which has no `SystemUsageIndicator`. The narrow check was therefore at 768 px, the narrowest width with this popover. That was already so; it is not changed here.

## Current state

Task 2 is done, with tests in `SystemUsageIndicator.test.tsx`. Browser check on an isolated `dev:test` profile, with only the process usage request intercepted in the page: at 1440 px and 768 px the failure message shows; a read held open showed "Loading processes…" and then the message after about 10.2 s; the message stayed through a further retry; the list appeared by itself once reads answered; a retained list survived failures; and a reload after recovery showed a real read. The lists were a fixture response, as the test project had no running environment.

## Outstanding work

Task 1 only. It needs the affected command node or a two-node setup.

## Related

- [0996-second-backend-takes-default-gateway-port.md](0996-second-backend-takes-default-gateway-port.md)
- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md)
