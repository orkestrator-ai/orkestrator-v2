# Antigravity live qualification

## Task analysis

Analysed 2026-11-22 against `main` at `eb6343f3a`. Follows the Antigravity
integration (pinned `agy` 1.5.12 on the ACP bridge;
[agent-engines.md](../../architecture/agent-engines.md#antigravity)), which was
built and tested without a signed-in Antigravity account.

### Tasks

1. **Qualify an interactive session on a signed-in host**: prompt, native edit, question, Stop, reload, resume, inactive environment. Status: open (depends on 7568).
2. **Record the signed-in session shapes the bridge has not seen**: `configOptions`, model and thinking IDs, mode IDs, tool-call metadata, usage. Status: open (depends on 1).
3. **Prove HTTP MCP tool delivery with `--process-per-session`**, per tab and per provider. Status: open (depends on 1).
4. **Decide a container route for Antigravity**. Status: open (depends on 1).
5. **Qualify steering, elicitation and workflow results**, then lift the matching gates. Status: open (depends on 2 and 3).

### 1. Qualify an interactive session on a signed-in host

**Problem.** Every Antigravity path was proved against a fake ACP agent and
the real binary's signed-out `initialize`, never against a signed-in agy.

**Context.** The bridge assumes a stored login (`agy acp --login`) serves
session requests without an ACP `authenticate` call, because agy's
`authenticate` starts an interactive browser sign-in. A wrong assumption
shows as every session reporting sign-in required on a signed-in machine.

**Investigation.** Observed on 1.5.12 with a throwaway `HOME`: `session/new`
answers `-32000 Authentication required` at once without a login;
`authenticate` with `oauth-personal` waits for a browser (or answers
`-32603 No browser is available`). The login itself is in the OS keyring.

**Decisions.**

- **How readiness learns of a login.**
  - **From agy's answer to a session request, re-asked after a minute (recommended).**
    - Pros: no keyring access, no browser opened, works for every auth method.
    - Cons: a just-completed sign-in shows as signed out for up to a minute.
  - **Read the OS keyring entry (`gemini` / `antigravity`) as T3 does.**
    - Pros: immediate and file-free.
    - Cons: a native keyring dependency in the backend, a platform-specific secret read, and a second interpretation of agy's storage to keep current.

### 2. Record the signed-in session shapes the bridge has not seen

**Problem.** Mode filtering, model and thinking options and the question form
are built from T3's source and agy's documentation, not from recorded agy
traffic.

**Context.** `session-config.ts` keeps unknown mode IDs; Antigravity's
approval-policy modes (`auto`, `accept-edits`) are filtered by name in
`antigravity-acp.ts`.

**Investigation.** Not started: needs task 1's signed-in run, with
`ACP_BRIDGE_RECORD_*` replay recording if the bridge's recorder is used.

**Decisions.**

- **Where the observed shapes are kept.**
  - **A scrubbed replay fixture beside the existing ACP corpus (recommended).**
    - Pros: replayed by the conformance tests on every change.
    - Cons: needs the scrubber run and a careful diff before committing.
  - **Prose in upgrade-agents.md only.**
    - Pros: no fixture review.
    - Cons: nothing fails when a shape changes.

### 3. Prove HTTP MCP tool delivery with `--process-per-session`

**Problem.** agy advertises `mcpCapabilities.http` only with
`--process-per-session`; whether Orkestrator's tools then reach the model,
under the right tab's grant, is unproved.

**Context.** The bridge passes `configuredAcpMcpServers(state.agentMcp)` on
`session/new` and `session/resume`, as for Grok.

**Investigation.** Not started.

**Decisions.**

- **What to do if HTTP MCP does not deliver.**
  - **Report it as a runtime notice and keep the session usable without Orkestrator tools (recommended).**
    - Pros: honest, and ordinary chat still works.
    - Cons: mail and workflow tools stay unavailable.
  - **Build a stdio MCP relay as T3 does.**
    - Pros: tools work regardless.
    - Cons: a new process to own, bound and secure.

### 4. Decide a container route for Antigravity

**Problem.** `start_antigravity_server` refuses: the host login is in the OS
keyring and cannot be copied into a container.

**Context.** The image already installs the pinned `agy`, so only the
credential route is missing.

**Investigation.** Not started.

**Decisions.**

- **Container credential route.**
  - **A container-local `agy acp --login` into retained container state (recommended).**
    - Pros: no host secret leaves the host keyring.
    - Cons: one sign-in per container, and a new retained path to trace.
  - **Copy the keyring-less token file from a host that has one.**
    - Pros: no second sign-in.
    - Cons: most hosts have a keyring, and the token has no OAuth client to refresh it.

### 5. Qualify steering, elicitation and workflow results

**Problem.** Steer, standard `elicitation/create`, pipelines, Multi Review,
coordinators, goals, suborks, mail and public-CLI completion are gated off
for Antigravity until proved.

**Context.** The gates are `PIPELINE_UNQUALIFIED_AGENTS`,
`QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS`, `UNQUALIFIED_COORDINATOR_PLATFORMS`,
`GOAL_QUALIFIED_PLATFORMS`, `agentMailCapabilities`, `PROVIDER_COMPLETION`
and `nativeAgentCapabilities`.

**Investigation.** Not started.

**Decisions.**

- **Order of lifting gates.**
  - **Workflow results first, then pipelines and Multi Review, then mail and suborks (recommended).**
    - Pros: each depends on the one before it.
    - Cons: coordinators stay unavailable longest.
  - **All at once after one live sweep.**
    - Pros: one qualification run.
    - Cons: one failure blocks every surface.

## Constraints and rationale

- Never claim a boundary or capability the bridge has not been seen to hold;
  an unqualified surface stays explicitly unavailable.
- Never start agy on the host while presenting it as a container's agent.

## Related

- [Agent engines: Antigravity](../../architecture/agent-engines.md#antigravity)
- [Upgrading Antigravity](../../development/upgrade-agents.md#antigravity-acp)
- [Manual test checklist](../manual-test/7568-manual-test-checklist.md)
