# Concurrent agent-test profiles need a free agent tools port chosen for them

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, on beelink, while doing
[7080](7080-linux-host-firewall-blocks-profile-signals.md) task 2.

### Tasks

1. **Choose a free port from the documented range automatically**: an explicit `--agent-tools-port <n>` refuses a busy port, so concurrent agent-test profiles (one-shot runners started by parallel agents above all) have to coordinate their numbers to stay inside the one firewall rule. Status: open.

### 1. Choose a free port from the documented range automatically

**Problem.** `dev:test --agent-tools-port <n>` (7080 task 2) gives a profile
an exact agent tools port, so one host firewall rule for 31500–31509 admits
it. The flag refuses a port already in use rather than falling back, which is
right for a fixed number but leaves the choice to the caller. Agents that each
start a one-shot runner on the same host cannot see one another's choices, so
two of them passing the same number makes the second fail to start.

**Context.** The one-shot browser runner (`isolatedProfileArguments` in
`apps/desktop/scripts/dev/isolated-browser.ts`) forwards
`--agent-tools-port <n>` since 7080 task 2. Each one-shot profile is
disposable and reset afterwards, so a recorded port does not outlive it.
The coordinator and goals live runners go through the same runner but fix
their own `profileArgs` (credential source and platform), so they cannot be
given a port.

**Investigation.** Read the runners' argument builders and the launcher's
check (`assertAgentToolsPortFree` in `apps/desktop/scripts/dev/profile-io.ts`).
Not started beyond that.

**Decisions.**

- **How should a one-shot runner get its port?**
  - **An `auto` value that takes the first free port in the documented range, used by the runners (recommended).**
    - Pros: concurrent runs on one host each get an admitted port with no caller coordination; the range stays the single firewall rule.
    - Cons: a check-then-bind race between two launchers choosing at once (the loser fails to start and can be retried); a new flag value to document.
  - **Forward an explicit `--agent-tools-port <n>` through each runner.**
    - Pros: no new behaviour in `dev:test`.
    - Cons: every caller has to pick distinct ports itself, which concurrent agents on one host cannot do safely.

## Related

- [7080-linux-host-firewall-blocks-profile-signals.md](7080-linux-host-firewall-blocks-profile-signals.md) (the flag, the range and the firewall rule).
- [agent-testing.md](../../development/agent-testing.md#containers-behind-a-host-firewall---agent-tools-port).
