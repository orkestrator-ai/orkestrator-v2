# Refusal counts show only what was true when the Network section opened

From [6102](6102-egress-name-check-residual-channels.md) task 4: the egress gateway's name checks now count refused connections and DNS queries since boot, and the environment settings dialog's Network section shows them. It reads them once.

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, with 6102 task 4 applied on top.

### Tasks

1. **Refresh the counts while the Network section is open**: refusals made after it opened show only when it is reopened. Status: open.

### 1. Refresh the counts while the Network section is open

**Problem.** `EnvironmentNetworkPolicyStatus` fetches the environment's network policy, which carries the counts, in one `useEffect` keyed on the environment id. A user who opens the section, then waits while an agent fails on a host that is not on the allowlist, keeps seeing the counts from when the section opened.

**Context.** The counts live in the gateway (`/run/orkestrator-firewall/egress-refusals.json`) and reach the renderer only through `get_environment_network_policy`, which runs a `docker exec` in the gateway per call. The daemon rewrites the file at most once a second. Nothing pushes a change to the renderer, and the file carries no revision.

**Investigation.** Seen in code while building 6102 task 4; not reported by a user.

**Decisions.**

- **How should the section stay current?**
  - **Re-read the policy on a slow interval (every 10 to 15 s) while the section is mounted and the window is visible (recommended).**
    - Pros: a few lines in the component; the backend command already exists.
    - Cons: one `docker exec` in the gateway per interval while the dialog is open.
  - **A refresh button next to the counts.**
    - Pros: no background work at all.
    - Cons: the user has to know the counts can be stale.
  - **Have the backend watch the counts and publish a change event.**
    - Pros: immediate.
    - Cons: a per-environment watcher across the gateway boundary for a number shown in one dialog.

## Related

- [6102](6102-egress-name-check-residual-channels.md) task 4
- [Container lifecycle, name checks](../../architecture/container-lifecycle.md#name-checks-egress-filter1)
