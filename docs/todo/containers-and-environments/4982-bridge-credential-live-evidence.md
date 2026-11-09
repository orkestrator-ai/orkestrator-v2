# Live evidence the bridge credential work could not gather here

Carried from security report S2, parts `0040` and `0120`, when that report was closed (2026-11-04). S2's maintainer rule: work that needs live evidence and could not be proven counts as not implemented.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **A user's approval on a real provider turn**: the routes are proven on real bridges in a real container, but no provider turn raised an approval there. Status: open.
2. **The real-container suite on other Docker topologies**: it has run only on rootful Linux Engine, amd64. Status: open.

### 1. A user's approval on a real provider turn

**Problem.** S2 forbade real logins and billed turns, so no real agent raised an approval against a bridge holding only a verifier.

**Context.** `apps/backend/tests/bridge-credential-docker.test.ts` proves on all five real bridges that the answer routes refuse what the agent can read and pass the backend's token through to the route. `bridges/acp-bridge/src/acp-approval-verifier.test.ts` answers a real parked request on the real router. The non-dumpable flag is the one thing the provider SDKs have not run under in a real turn: `@cursor/sdk` and Pi run in the bridge process, and a process cannot open its own `/proc/self/environ` once non-dumpable (checked on 2026-11-04).

**Investigation.** Nothing in the bridges' own code or their SDK imports reads a process's own `/proc/self/environ`, by search. Native helpers inside the SDK were not read. OpenCode has this evidence short of a real provider: on 2026-11-05 a fake model in a real container made a real `bash` call that parked, the agent's answer was refused and the user's approval and denial both worked, all with the server non-dumpable.

**Decisions.**

- **How should this be run?**
  - **Once by hand on a throwaway profile with one prompt per provider, on an `ask` environment (recommended).** Approve one command and deny one, on a `bridge-credential=1` image.
    - Pros: cheap; the failure it looks for would show in the first turn.
    - Cons: billed, and needs a real login per provider.
  - **Add it to the real-stack agent suites.**
    - Pros: repeats on each run.
    - Cons: those suites run for many minutes on live agents and are on demand already.

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
- `4980-agent-uid-process-control.md` (deleted 2026-11-06); its follow-ups are [7250](7250-bridge-replaced-by-an-agent-process.md), [7251](7251-pi-project-extensions-in-the-bridge-process.md) and `7252-opencode-server-loads-agent-writable-code.md` (done and deleted 2026-11-09; its follow-ups are [7548](7548-opencode-launch-follow-ups.md))
