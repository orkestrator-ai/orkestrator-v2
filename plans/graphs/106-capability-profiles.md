---
id: 106
title: "Capability profiles and enforcement tiers"
phase: 1
plan: "P1.6"
status: not-started
depends_on: [101]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `graphs/capability-profiles.ts`: `observer`, `reviewer`, `verifier`, `researcher`, `builder` and `custom`, each compiled to a `NativeAgentExecutionPolicy` layered over the environment's policy, plus a set of granted actions. No `shipper` profile.
- [ ] Extend `NATIVE_AGENT_CAPABILITIES` (`packages/protocol/src/native-agent.ts`) with `git.commit`, `git.push`, `github.write`, `subagents`, `mcp:<server>` (deny only until [404](404-per-node-user-mcp.md)) and `orkestrator:<group>`, with stand-ins for bridges that predate them.
- [ ] Every agent profile, `custom` included, denies `git.push` and `github.write`.
- [ ] An enforcement matrix (`enforced`, `provider-configured`, `advisory`) per profile, provider and platform, generalised from `coordinator-providers.ts`. Coordinator qualification calls the same function.
- [ ] Default `minEnforcement: "provider-configured"` for profiles that deny writes.

## Tests

- [ ] Profile → policy mapping for host, container and coordinator environments.
- [ ] A property test that a profile never widens the environment's policy.
- [ ] The matrix reproduces today's coordinator tiers for the coordinator policy.
- [ ] Bridge translation of the new capabilities, at unit level where cheap.

## Done when

- [ ] Profiles, capabilities and the matrix are merged with tests, and coordinator qualification uses the shared function.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
