# Pi project extensions run inside the bridge process

Carried from to-do 4980 task 2 when that file was closed (2026-11-06).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Keep repository extensions out of the Pi bridge's own process**: with project resources on (the container default), Pi loads `.pi/` extensions from the agent-writable workspace into the bridge itself, where they see every presented token and can answer approvals without one. Status: open.

### 1. Keep repository extensions out of the Pi bridge's own process

**Problem.** The root-owned launcher (`orkestrator-bridge-launch`, image capability `bridge-launch=1`) stops a login profile, the runtime environment snapshot or `BUN_OPTIONS` running code inside a bridge. It cannot stop code the bridge loads itself. Pi's SDK runs in the bridge process, and when a session's execution policy turns `projectResources` on it discovers project extensions (arbitrary TypeScript) under `/workspace/.pi/` and runs them there, including during session creation. Such code sees every later `Authorization` header and holds the same in-process approval gate the signed routes protect, so it does not need a signature to approve a parked call.

**Context.** `projectResourceDiscoveryOptions` in `bridges/pi-bridge/src/agent-session.ts` sets `noExtensions: !discoverProjectResources`. Container sessions default to `projectResources: true` and to `auto-approve` (`native-agent-execution-policy.ts`), so this matters on a container session whose policy asks. Host sessions default project resources off. Being non-dumpable does not isolate code inside the same process. Pi's built-in extension factories (the inline `orkestrator-mcp` extension among them) are trusted integrations and must keep working.

**Investigation.** Read from code on 2026-11-06. No planted extension has been run against a bridge; that is live evidence to collect with a synthetic credential and no provider turn (an extension's factory runs at session creation, before any model call).

**Decisions.**

- **How should repository extensions be kept from the bridge's credentials?**
  - **Refuse discovered extensions when the session's approvals are `ask`, and say so in the policy note (recommended).** Skills and prompt templates can stay with project resources; only executable extensions are the risk.
    - Pros: small, in one function; the policy note tells the user why their extensions did not load; `auto-approve` and `deny` sessions keep today's behaviour, where an approval has nothing to protect.
    - Cons: a user who wants both `ask` and project extensions loses one of them.
  - **Run discovered extensions in a child process without the bridge's HTTP server or credential.**
    - Pros: keeps every feature.
    - Cons: Pi's extension API is in-process (tool registration, hooks over the session object), so this means a bridge-side RPC shim for an SDK surface that changes between releases.
  - **Document it and leave it.**
    - Pros: no code.
    - Cons: an `ask` Pi session in a container is one planted file away from approving itself.

## Related

- `4980-agent-uid-process-control.md` (deleted 2026-11-06)
- [`docs/architecture/agent-approvals.md`](../../architecture/agent-approvals.md)
- [`bridges/pi-bridge/AGENTS.md`](../../../bridges/pi-bridge/AGENTS.md)
