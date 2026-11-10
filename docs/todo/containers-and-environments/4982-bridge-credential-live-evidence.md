# Live evidence the bridge credential work could not gather here

Carried from security report S2, parts `0040` and `0120`, when that report was closed (2026-11-04). S2's maintainer rule: work that needs live evidence and could not be proven counts as not implemented.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

2. **The real-container suite on other Docker topologies**: it has run on rootful Linux Engine (amd64) and Docker Desktop (arm64); rootless is still open. Status: open.

### 2. The real-container suite on other Docker topologies

**Problem.** `ptrace` and `/proc` behaviour, and root's reach into `/run/orkestrator-bridge`, were only checked on one daemon.

**Context.** Run on 2026-11-04 on beelink: Docker Engine 29.9.2, rootful, x64. The workflow `container-live-qualification.yml` runs the suite on amd64 and arm64 on pull requests that touch its paths; that run has not happened yet. Rootless Docker and Docker Desktop are not in it.

**Investigation.** On 2026-11-06 the suite (then 16 cases, with the `bridge-launch=1` ones from to-do 4980) passed on Docker Desktop, Engine 29.9.2, linux/arm64: 15 passed, the older-image case skipped. That covers Desktop and arm64 on one host; rootless is still open. `prctl(PR_SET_DUMPABLE)` is kernel behaviour with no Docker dependency, and rootless root is still uid 0 in the container, so neither is expected to differ. That is reasoning, not evidence.

**Decisions.**

- **Where should the extra runs happen?**
  - **Add this suite to the existing rootless and Desktop passes in [`0019-container-platform-qualification.md`](0019-container-platform-qualification.md) (recommended).**
    - Pros: no new setup; those passes are scheduled anyway.
    - Cons: waits for the next pass.
  - **A dedicated run now.**
    - Pros: sooner.
    - Cons: needs the same hosts set up for one suite.

## Related

- `3930-bridge-credential-out-of-agent-uid.md` (deleted 2026-11-06)
- `4980-agent-uid-process-control.md` (deleted 2026-11-06); its follow-ups are 7250 (deleted 2026-11-09, done; see [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused)), `7251-pi-project-extensions-in-the-bridge-process.md` (deleted 2026-11-09, done; see [agent-approvals.md](../../architecture/agent-approvals.md#code-a-bridge-loads-itself)) and `7252-opencode-server-loads-agent-writable-code.md` (done and deleted 2026-11-09; its follow-ups, 7550, were done and deleted 2026-11-10; see [agent-approvals.md](../../architecture/agent-approvals.md#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1))
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the billed real-provider approval and denial turns) moved there on 2026-11-10.
