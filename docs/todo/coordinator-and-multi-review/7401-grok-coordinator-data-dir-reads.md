# Grok coordinator: keep its reading tools out of the data directory

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from
[6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3, which closed
the data directory on Pi and OpenCode but could not on Grok.

### Tasks

1. **Find whether Grok's reads ask permission**: extend the Grok probe so one signed-in run answers it (Grok's read, search and list tools under the read-only profile). Running the probe needs a Grok login and moved to the manual-test checklist. Status: open.
2. **Refuse data-directory reads where Grok asks**: add the path check to the bridge's permission answer for read calls, if task 1's probe run shows Grok asks. Status: blocked (waits on 7568: 7401 task 1 probe run).

### 1. Find whether Grok's reads ask permission

**Problem.** A read-only Grok coordinator can read Orkestrator's data directory
(`control-mcp.json`, `config.json`, the database, every login). Its private
profile (`acp-readonly-profile.ts`) removes the writing and shell tools but
leaves Grok's reading tools, and the bridge has no path check on them.

**Context.** The ACP bridge's own `fs/read_text_file` is already confined to the
workspace (`secureExistingFile` in `acp-client-methods.ts`), so a read Grok
routes through the client cannot reach the data directory. The gap is Grok's
built-in reading tools, which run in the Grok process. The launcher names the
data directory in `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`; the shared
check is `@orkestrator/protocol/node/coordinator-read-boundary`.

**Investigation.** Grok 1.0.52 was observed not to ask before shell commands
(the reason for the profile); whether its reads ask is unobserved. Grok is
signed out on the qualifying hosts
([0024](0024-coordinator-live-conformance.md) task 1), so no probe was run.
`scripts/coordinator-probes/grok-web-tools-probe.mjs coordinator` is the
existing probe to extend. Extending it is agent work; running it signed in is on
the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

**Decisions.**

- **How to find out?**
  - **Extend the Grok probe to read a fixture data directory and record every `session/request_permission` and `fs/read_text_file` it sends (recommended).**
    - Pros: one run answers both whether reads ask and which path they name.
    - Cons: needs a Grok login, and each run is a billed turn.
  - **Assume reads never ask, and record the gap only.**
    - Pros: no login needed.
    - Cons: leaves a check that may be possible unbuilt.

### 2. Refuse data-directory reads where Grok asks

**Problem.** If Grok asks before a read, the bridge can refuse one that reaches
the data directory, the way it already refuses MCP calls with `reject_once`.

**Context.** Permission answers are built in `acp-session.ts`; a refusal ends
Grok's turn, which `POLICY_DENIAL_CONTINUATION` (`acp-prompt.ts`) resumes.

**Investigation.** Depends on task 1's probe run (on the manual-test checklist).

**Decisions.**

- **What to do if reads never ask?**
  - **Leave Grok at the advisory tier and say in its note that it can read the data directory (recommended).**
    - Pros: honest; Grok is already advisory for the same reason on shell.
    - Cons: the gap stays.
  - **Route Grok's reads through `fs/read_text_file` only, if Grok offers a switch.**
    - Pros: the bridge's existing confinement would apply.
    - Cons: no such switch is known on 1.0.70.

## Related

- [6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3
- [0024](0024-coordinator-live-conformance.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: running the Grok probe signed in) moved there on 2026-11-10.
