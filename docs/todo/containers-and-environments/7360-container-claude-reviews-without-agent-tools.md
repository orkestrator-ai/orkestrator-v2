# Container Claude reviews when the agent tools port is unreachable

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, on beelink (Arch Linux,
kernel 7.1.8, rootful Docker Engine 29.9.2, ufw with a default-deny input
policy), while running
[0190](../agent-engines/0190-claude-read-only-turns-without-working-sandbox.md)
task 3's container half.

### Tasks

1. **A Claude review fails at its second turn when MCP is unreachable**: a container's Claude bridge runs a session's first turn without the required Orkestrator MCP server and refuses every later turn with 409. Status: open.
2. **Automate the container read-only reviewer run**: turn 0190 task 3's manual recipe (fake Messages API, agent-tools relay) into an opt-in spec. Status: open.
3. **A failed Multi Review cannot be deleted without cancelling it first**: observed once while re-running the review. Status: open.

### 1. A Claude review fails at its second turn when MCP is unreachable

**Problem.** In a container whose agent tools port the host firewall drops,
a Multi Review with Claude on the shared preparation and consolidation
session fails. Preparation's first turn runs, but its correction turn (and
consolidation, which reuses the session) is refused by the bridge with
`claude prompt dispatch is temporarily unavailable (HTTP 409): Claude
required MCP server is not connected; retry the prompt`. The review moves to
`failed`. This happened with the structured-output transport too, which
does not need MCP to submit a result.

**Context.** The required server is the injected Orkestrator agent MCP
(`ORKESTRATOR_AGENT_MCP_URL`, `http://host.docker.internal:<port>/mcp`).
`syncClaudeRuntimeMcp` (`session-manager-prompt-mcp-sync.ts`) checks the
required servers' status when a turn joins a running CLI
(`session-manager-prompt-launch.ts`) and throws the 409 when one is not
`connected`. A turn that launches a new CLI does not go through it, so the
first turn goes ahead. On
beelink the profile's port is unreachable from containers
([7080](7080-linux-host-firewall-blocks-profile-signals.md)); the backend
does show "Agents in Docker containers can't reach Orkestrator, so container
review and pipeline stages can't report results." when its reachability
check runs.

**Investigation.** Seen twice on 2026-11-06 in profile `r0190c` (workflows
started with `start_multi_review`, Claude `haiku` for every step), each time
on preparation's schema-correction turn. Each bridge start logged
`probe.result trigger=bridge-start … outcome=timeout` for the agent tools
URL. With the port relayed (0190 A14) the same reviews completed, so the
refusal is the only blocker. Not checked: what a user sees on the
renderer's Retry, and whether a reviewer session (one turn) ever reaches the
check.

**Decisions.**

- **What should a turn do when its required MCP server cannot connect?**
  - **Refuse up front, on the first turn too, with an error that names the unreachable agent tools URL and points at the reachability notice (recommended).**
    - Pros: one consistent answer; the user learns the cause instead of "retry"; no half-finished preparation.
    - Cons: a review that would have worked on the structured-output transport now fails earlier.
  - **Let structured-output turns run without the server and refuse only tool-transport turns.**
    - Pros: reviews keep working on hosts like beelink when the rollout uses structured output.
    - Cons: the default transport is tools, so most users still fail; widens a rule the bridge applies uniformly today.
  - **Keep today's behaviour.**
    - Pros: no change.
    - Cons: the first turn succeeds and the second fails with a message that suggests retrying, which cannot help.

### 2. Automate the container read-only reviewer run

**Problem.** 0190 task 3's container evidence came from a manual run. Each
part works, but nothing repeats it.

**Context.** The pieces are committed: the scripted Multi Review turn in
`e2e/agent-testing/container-fake-claude-api.ts` (with `GET /fixture/stats`
counting each tool result's `is_error`), and
`e2e/agent-testing/container-agent-tools-relay.ts`. The manual recipe was:
copy the fake into the container and start it; append
`ANTHROPIC_BASE_URL`, a fixture `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to
`/tmp/orkestrator-ai/runtime-env.sh` (read-only turns load no user
settings, so `~/.claude/settings.json` `env` does not reach them); start the
relay; add a DNAT rule for the alias address and the agent tools port, plus a
matching `OUTPUT` accept, in the egress gateway's namespace; `stop_claude_server`;
then `start_multi_review` and poll `get_multi_review_workflow`.

**Investigation.** Not started.

**Decisions.**

- **Where should it live?**
  - **A new opt-in spec beside `container-claude-terminal-signal.spec.ts`, behind `ORKESTRATOR_AGENT_TEST_DOCKER=1` and `ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_API=1`, asserting phase `ready`, `commandSandboxOff` on the reviewer and consolidation, and the fake's read/write results (recommended).**
    - Pros: the same opt-ins as the existing fake-API spec; content-free assertions.
    - Cons: needs the relay only on firewalled hosts, so the spec must detect reachability first.
  - **Keep it a documented manual recipe.**
    - Pros: no harness code.
    - Cons: regressions in the container read-only path go unnoticed until someone repeats it.

### 3. A failed Multi Review cannot be deleted without cancelling it first

**Problem.** With a workflow in phase `failed`, `delete_multi_review_workflow`
answered "Cancel or finish the running Multi Review before deleting it", and
`start_multi_review` answered "Finish, cancel, or delete the existing Multi
Review before starting another". `cancel_multi_review` then answered
`cancelling`, after which delete succeeded.

**Context.** Seen through the backend commands, not the UI.

**Investigation.** Not traced. A failed review that still offers Retry may
deliberately count as active.

**Decisions.**

- **Is this a defect?**
  - **Check what the UI offers on a failed review first; if it offers Delete or Start new, make the backend accept them for `failed` (recommended).**
    - Pros: decides from what users can reach.
    - Cons: needs a UI run.
  - **Document that `failed` is active until cancelled.**
    - Pros: no code.
    - Cons: the wording "running" is wrong for a failed review either way.

## Related

- [0190-claude-read-only-turns-without-working-sandbox.md](../agent-engines/0190-claude-read-only-turns-without-working-sandbox.md)
- [7080-linux-host-firewall-blocks-profile-signals.md](7080-linux-host-firewall-blocks-profile-signals.md)
- [7041-manual-docker-profiles-on-exhausted-pools.md](7041-manual-docker-profiles-on-exhausted-pools.md)
