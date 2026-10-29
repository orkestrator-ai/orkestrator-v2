---
id: 106
title: "Capability profiles and enforcement tiers"
phase: 1
plan: "P1.6"
status: in-progress
depends_on: [101]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-106-capabilities"
pr: ""
updated: 2026-10-29
---

# 106 · Capability profiles and enforcement tiers

- **Plan:** [P1.6 Capability profiles and enforcement tiers](../composable-graphs.md#p16-capability-profiles-and-enforcement-tiers)
- **Decisions:** D4, D12, D18
- **Depends on:** [101](101-template-schema.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Each node's profile compiles to an execution policy that only narrows the environment's, and the user can see how strongly each provider enforces it.

## Work

- [x] `graphs/capability-profiles.ts`: `observer`, `reviewer`, `verifier`, `researcher`, `builder` and `custom`, each compiled to a `NativeAgentExecutionPolicy` layered over the environment's policy, plus a set of granted actions. No `shipper` profile.
- [x] Extend `NATIVE_AGENT_CAPABILITIES` (`packages/protocol/src/native-agent.ts`) with `git.commit`, `git.push`, `github.write`, `subagents`, `mcp:<server>` (deny only until [404](404-per-node-user-mcp.md)) and `orkestrator:<group>`, with stand-ins for bridges that predate them.
- [x] Every agent profile, `custom` included, denies `git.push` and `github.write`.
- [x] An enforcement matrix (`enforced`, `provider-configured`, `advisory`) per profile, provider and platform, generalised from `coordinator-providers.ts`. Coordinator qualification calls the same function.
- [x] Default `minEnforcement: "provider-configured"` for profiles that deny writes.

## Tests

- [x] Profile → policy mapping for host, container and coordinator environments.
- [x] A property test that a profile never widens the environment's policy.
- [x] The matrix reproduces today's coordinator tiers for the coordinator policy.
- [x] Bridge translation of the new capabilities, at unit level where cheap.

## Done when

- [x] Profiles, capabilities and the matrix are merged with tests, and coordinator qualification uses the shared function.

## Notes

**2026-10-29 · Files and exports.** `packages/protocol/src/native-agent-capabilities.ts`
(re-exported from `@orkestrator/protocol/native-agent`), `packages/protocol/src/graphs/capability-profiles.ts`
(export `./graphs/capability-profiles`, which also re-exports `graphs/capability-enforcement.ts`).
Tests: `native-agent-capabilities.test.ts`, `graphs/capability-profiles.test.ts`,
`graphs/capability-enforcement.test.ts`; backend `graph-capability-profiles.test.ts` (property test over
the real `resolveNativeAgentExecutionPolicy`), `opencode-capability-rules.test.ts`, additions to
`coordinator-providers.test.ts` and `http-bridge-provider.test.ts`; Claude
`read-only-policy-capabilities.test.ts`; Cursor `agent-session.test.ts`.

**2026-10-29 · Vocabulary and wire form.** `NATIVE_AGENT_CAPABILITIES` = the legacy six
(`LEGACY_NATIVE_AGENT_CAPABILITIES`) + `git.commit`, `git.push`, `github.write`, `subagents`;
`NativeAgentCapability` adds `mcp:<server>` (`NATIVE_AGENT_MCP_SERVER_NAME_PATTERN`, ≤ 64) and
`orkestrator:<group>` (`NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS`, which `GRAPH_ORKESTRATOR_CAPABILITY_GROUPS`
now aliases; `GRAPH_CAPABILITIES` is `NATIVE_AGENT_CAPABILITIES`). Every released bridge validates
`deny`/`allow` against the six and on failure drops the whole policy (fail open), so the backend never
sends new names in `deny`: `HttpBridgeProvider` sends `nativeAgentPolicyForBridge(policy, platform)`,
whose `deny`/`allow` keep the six and whose `capabilityPolicy.extendedDeny` (≤ 64 strings ≤ 128 chars;
unknown names tolerated and skipped) carries the rest; `orkestrator:*` never leaves the backend. Bridges
read denials with `nativeAgentDeniedCapabilities(policy)` (both forms). Canonical policies (all names in
`deny`) stay in the backend (records, OpenCode).

**2026-10-29 · Stand-ins** (`nativeAgentCapabilityHold`, `NATIVE_AGENT_BRIDGE_EXTENDED_TRANSLATIONS`).
Claude: `subagents` → `Task`, `Agent`; `mcp:<s>` → `mcp__<normalised s>__*` (and the read-only hook
refuses it); `git.commit`/`git.push` → `Bash(git commit|push)` and `Bash(git … *)`; `github.write` →
`Bash(gh)`, `Bash(gh *)`; a read-only turn now keeps the session's extra denials
(`readOnlyTurnPolicy`). OpenCode: `task` deny, `<s>_*` deny (raw and sanitised name), bash/shell
pattern denies; `openCodeRulesBlockNetwork` now ignores pattern-scoped rules. Cursor: `subagents` →
`task`. Codex, Grok, Pi: none. Where a bridge does not translate `mcp:<s>`, the wire form sets
`projectResources: false`. The plan's "git.push/git.commit become a `shell.mutate` denial when the
profile allows no other mutation" is implemented as: covered by the policy's own `shell`/`shell.mutate`
denial when it has one (every read-only profile); otherwise held by the post-hoc guards. A
`shell.mutate` denial is never *added*, because the profiles that lack one (verifier, builder,
custom) allow shell mutation on purpose and adding it would stop their builds.

**2026-10-29 · Profiles.** Deny sets: observer `file.write, file.patch, shell, shell.mutate, network,
subagents, git.commit, git.push, github.write`; reviewer `file.write, file.patch, shell.mutate, network,
git.commit, git.push, github.write`; verifier `file.write, file.patch, git.commit, git.push,
github.write`; researcher as observer but sub-agents allowed, plus `allow: [web.search]`; builder and
custom `git.push, github.write`. Orkestrator groups are opt-in on every profile via
`allow: ["orkestrator:<group>"]`. Node `deny` adds; node `allow` carves out of the profile (never
`git.push`/`github.write`; `mcp:<s>` grants are ignored). `compileGraphCapabilities({spec, environment,
ceiling?})` → `{profile, policy, denied, webSearch, readOnly, orkestratorGroups, removedByCeiling,
removedByEnvironment, defaultMinEnforcement?}`; the policy is the environment's with
`capabilityPolicy` = union of profile, ceiling and environment denials (hosted search only where all
three allow it). `readOnly` = file tools and shell mutation denied; the runtime (204) must dispatch such
nodes as read-only turns, which is what the matrix rates. Ceiling (D18): `GraphCapabilityCeiling =
{deny, allow?: ["web.search"]}`, `DEFAULT_GRAPH_CAPABILITY_CEILING = {deny: []}`,
`graphCapabilityCeilingIssues`/`isGraphCapabilityCeiling` (rejects `git.push`/`github.write`: outside the
ceiling). D4: `defaultGraphMinEnforcement`, `effectiveGraphMinEnforcement`,
`graphMinEnforcementLowered` (107 requires an `enforcement-floor` acknowledgement when true). Verifier
gets no default floor: its source protection is the post-hoc guard, as for today's Verify.

**2026-10-29 · Compiler checks.** `checkGraphCapabilities(spec, workspaceAccess)` codes:
`capability-remote-write` (error, D12), `capability-mcp-grant` (error, until 404),
`capability-allow-unused` (warning), `capability-workspace-write-denied` and
`capability-workspace-read-writable` (errors; `checkGraphWorkspaceAccess`: `write` needs writable file
tools, `read`/`none` need them denied). Also `graphCapabilitySpecRequestsRemoteWrite`.

**2026-10-29 · Granted actions and statement.** `graphGrantedActions({outputs, inputs, askHuman,
orkestratorGroups, typeHasItems})` → `{submit, validate, status, reportProgress, readArtifact, askHuman,
orkestrator: [{group, tools}]}`; `graphGrantedActionNames` gives `submit_<port>`, `validate_<port>`,
`result_status`, `report_progress`, `read_artifact`, `ask_human` and the group tools
(`GRAPH_ORKESTRATOR_GROUP_TOOLS`). The names are the contract's; 204 mints the real tools.
`describeGraphCapabilities({compiled, actions?, enforcement?})` is the statement for 105.

**2026-10-29 · Matrix.** `agentPolicyEnforcement(policy, platform, host)` →
`{tier, reason?, readOnly, axes[]}` (`agentPolicyEnforcementMatrix`, `agentPlatformsMeetingFloor`,
`agentEnforcementTierSatisfies`, `agentEnforcementHostForOs` for the designer,
`coordinatorEnforcementPolicy`). Read-only policies get the coordinator's table (Codex, Pi enforced;
Claude enforced with its sandbox, else provider-configured; OpenCode, Cursor provider-configured; Grok
advisory), which also holds their network, commit and remote denials. Otherwise per boundary axis: file
tools (Claude, Cursor provider-configured; others advisory), shell, network (provider-configured only
when commands are sandboxed without the network; Grok advisory), commit (advisory, HEAD guard) and
remote (held by a shell or network denial, else advisory, guards). Sub-agents, MCP and search-only
denials are secondary axes that do not lower the tier. So builder, custom and verifier are advisory on
every provider (guards hold push and commits). `coordinator-providers.ts` now takes tier and reason from
this function; its tests assert agreement.

**2026-10-29 · Per-bridge gaps** (for 209 and 404). Codex: no tool removal for sub-agents, MCP or git
commands. Pi: no capability translation outside its read-only gate. Grok: nothing new translated; its
auto-approval ignores the new names. Cursor: MCP is one tool group (no per-server denial); its and
Grok's read-only turns still swap in a fixed policy that drops the session's extra denials. Claude and
OpenCode git/GitHub rules match commands as written (rated advisory). Claude read-only turns keep
hosted search off even for a researcher (unchanged behaviour): 204 must decide how a researcher on
Claude gets search. A bridge older than this change ignores `extendedDeny`; it still validates the
policy and holds the legacy denials. GitHub credential withholding and the remote-ref guard are 209.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Profiles, ceiling, checks, granted actions, statement, extended vocabulary with wire form and stand-ins, shared enforcement matrix used by coordinator qualification, bridge translations and tests. · complete; awaiting PR
