# Control MCP confirmation, operator token and self-reminder soft spots

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Keep the operator token away from coordinators**: the sandbox denies writes, not reads, of the data directory. Status: open.
2. **Say what a confirm token does and does not prove**: an agent can complete the flow itself. Status: open.
3. **Frame self-reminders as the agent's own**: they read as an authenticated system notice. Status: open.

### 1. Keep the operator token away from coordinators

**Problem.** A read-only coordinator runs as the user, so a command it is allowed can read `<dataDir>/control-mcp.json`, which holds credentials with wider authority than its own.

**Context.** Plaintext at mode 0600 is a settled decision, so that Copy setup works at any time ([todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2, and `docs/architecture/control-mcp.md:65`). That decision rules out encrypting the file, not hiding it from a sandbox.

**Investigation.** `writeControlMcpDescriptor` writes the file (`apps/backend/src/core/control-mcp-credentials.ts:331-346`). `claudeReadOnlySandbox` returns `filesystem: { denyWrite: ... }` and no read rule (`bridges/claude-bridge/src/services/read-only-policy.ts:583`, typed at `:553`). `denyRead` appears nowhere in `bridges/claude-bridge/src` or `apps/backend/src/core`. `READ_ONLY_TOOLS` also includes `Read` and `Grep` (`:60-63`).

**Decisions.**

- **How to deny the read?**
  - **Add `denyRead` for the data directory to the Claude read-only sandbox, and refuse the path in the `Read` and `Grep` hook (recommended).**
    - Pros: the report's fix; small; holds for commands and tools.
    - Cons: depends on the sandbox being active, and a host where the probe reports it unavailable relies on the hook alone; other providers' read-only turns need their own check.
  - **Move the credentials out of the data directory.**
    - Pros: none over the above: same uid, same reach.
    - Cons: breaks the documented location.

### 2. Say what a confirm token does and does not prove

**Problem.** The first call returns a token and the second succeeds, so the same agent can complete it alone. It is an idempotency and intent check, not human approval.

**Context.** The HMAC design is deliberate and is documented (`apps/backend/src/core/control-mcp-confirm.ts:6-14`, `docs/architecture/control-mcp.md:175-205`). On a voice client a person hears the description. That document does not say that it gives no assurance against an agent.

**Investigation.** Nothing binds a token to a human action. The class of each action is in `PUBLIC_ACTION_INPUTS` (`docs/architecture/control-mcp.md:177-178`).

**Decisions.**

- **What should change?**
  - **State in `control-mcp.md` that confirmation is not a human-approval boundary (recommended).**
    - Pros: costs nothing; destructive actions on coordinators already go through user-approved requests.
    - Cons: an agent with an operator credential can still run `always` actions.
  - **Route `always` actions through a user approval when the caller is an agent.**
    - Pros: a real control.
    - Cons: the backend cannot tell an agent from a person on one MCP credential, and it breaks unattended voice and automation use.

### 3. Frame self-reminders as the agent's own

**Problem.** A reminder an agent set for itself arrives as "an authenticated Orkestrator workflow status notification". Text chosen by an injected agent therefore comes back with higher standing than it started with.

**Context.** `docs/architecture/scheduled-jobs.md:185-191` explains that no tab may mail itself, so a reminder is a backend notice. It can only reach its owner, which limits the damage to a later turn of the same session.

**Investigation.** `apps/backend/src/core/scheduled-jobs/executor.ts:781-787` sends a `system` sender with `source: "workflow"` and adds "(Scheduled by you: ...)" to the body. The sender's framing is at `packages/protocol/src/agent-mail.ts:948`, and does not distinguish a reminder.

**Decisions.**

- **How to distinguish it?**
  - **A distinct `source` value with framing that says this is the session's own note, not from Orkestrator or the user (recommended).**
    - Pros: honest framing; `source` is already a typed field.
    - Cons: a protocol change; older bridges or clients must tolerate the new value (`docs/architecture/version-compatibility.md`).
  - **Keep the sender and rely on the "Scheduled by you" line.**
    - Pros: no change.
    - Cons: the authenticated framing around it still speaks first.

## Current state

Done, so not in Tasks: the report's fourth point, Cursor and Pi accepting policy fields from the body, closed with the narrow-only routes (`bridges/cursor-bridge/src/http.ts:216`, `bridges/pi-bridge/src/http.ts:284`; commits `2d4528dc5`, `a2bba9d80`). `readOnly` from the body remains, in [0040](0040-h4-bridge-credential-remainder.md).

## Needs verification

- Whether a `denyRead` rule in the Claude SDK sandbox blocks reads on both Seatbelt and bubblewrap: nothing was run.
- Whether anything outside `read-only-policy.ts` confines the paths that reading commands take. No path check was found in that file, and the read itself was not attempted.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L16)
- [Todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2
