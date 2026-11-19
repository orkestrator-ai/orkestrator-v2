# Agent Capabilities follow-ups

## Task analysis

Analysed 2026-11-19 against `main` at `fb2c01e83`. Created by the Agent Capabilities build ([agent-capabilities-management.md](../../architecture/agent-capabilities-management.md)).

### Tasks

1. **Live provider conformance for capability installs**: open.
2. **Isolated provider homes for exclusive session selections**: open (depends on 1).
3. **Merge for local changes**: open.
4. **Package registries and signed team manifests**: open.
5. **Command-node handover of capability state**: open.
6. **Native plugin lifecycle beyond Claude**: open (depends on 1).

### 1. Live provider conformance for capability installs

**Problem.** The support matrix marks several operations `unqualified` (Codex prompts, Cursor commands, OpenCode commands and agents), and `supported` skill installs are proven by unit and integration tests over real files, not by a pinned provider binary listing the installed skill.

**Context.** `BASELINE_CAPABILITY_SUPPORT` in `packages/protocol/src/capability-resources-support.ts`; the verification ladder stops at `present` without runtime evidence, so nothing claims readiness falsely today. Live runs belong with the batching index in [0031](0031-live-provider-and-platform-qualification.md).

**Investigation.** Each provider's command catalogue (`native-agent-commands.md`) already lists skills for Claude, Codex, Grok and Pi; the session chip records `advertised` evidence from a `ready` catalogue. A conformance spec can install a skill through the executor into an isolated profile's home and assert the catalogue lists it.

**Decisions.**

- **How to qualify.**
  - **One isolated `dev:test` profile spec per provider that installs, reads the catalogue and removes (recommended).**
    - Pros: proves the pinned binary; reuses the agent-testing harness.
    - Cons: needs credentials for the providers that start only signed in.
  - **Unit fixtures of each provider's directory layout only.**
    - Pros: cheap.
    - Cons: proves nothing about loading.

### 2. Isolated provider homes for exclusive session selections

**Problem.** A selection that should reach only one agent (for example Claude only) cannot be enforced where other providers read the same directory; the UI reports `cannot-enforce-without-isolated-home` instead.

**Context.** `planCapabilityLocations` and the shared-location table; Claude and Codex account homes already link shared directories (`agent-accounts-homes.ts`).

**Investigation.** A per-session overlay home (a temporary `CLAUDE_CONFIG_DIR` or `CODEX_HOME` with only the selected skills linked) would make exclusion real, but changes the credential and account-home rules and must preserve the OAuth refresh safeguards.

**Decisions.**

- **Approach.**
  - **Per-session overlay homes for the providers whose launcher already sets a config directory (recommended).**
    - Pros: real enforcement; no change to the user's own directories.
    - Cons: touches launchers and account-home linking; needs task 1's qualification.
  - **Keep reporting the limitation.**
    - Pros: no risk.
    - Cons: exclusive selections stay advisory.

### 3. Merge for local changes

**Problem.** Local changes can be kept, adopted or replaced, but not merged.

**Context.** `resolveCapabilityDrift` in `apps/backend/src/core/capabilities/service.ts`.

**Investigation.** A three-way merge needs the base revision's bytes, which the artifact cache keeps for the previous five revisions.

**Decisions.**

- **Merge model.**
  - **Text three-way merge per file, conflicts shown for manual resolution (recommended).**
    - Pros: covers SKILL.md edits, the common case.
    - Cons: binary files cannot merge.
  - **Leave merge to the user's editor.**
    - Pros: nothing to build.
    - Cons: no guided path.

### 4. Package registries and signed team manifests

**Problem.** The `registry` source kind is defined but refused ("No package registry is configured"), and team manifests are not signed.

**Context.** `PackageSource` in `capability-resources.ts`; graph template sharing already has signing keys (`storage-graph-templates.ts`, item 405).

**Investigation.** Reusing the graph-sharing key pair would sign `orkestrator.capabilities.lock.json`.

**Decisions.**

- **Signing.**
  - **Reuse the installation's graph-sharing key pair and trusted keys (recommended).**
    - Pros: one trust model.
    - Cons: the key's scope widens beyond graphs.
  - **A separate capabilities key.**
    - Pros: separate revocation.
    - Cons: a second trust list to manage.

### 5. Command-node handover of capability state

**Problem.** The executor refuses an older epoch, but `handOverCommand` does not yet transfer the `capabilities` store or raise its epoch.

**Context.** `nodes/node-service.ts` (`previewHandover`, `handOverCommand`, `acceptHandover`) and `CapabilityState.epoch`.

**Investigation.** The store and the artifact cache would travel with the handover bundle; the receiving node sets `epoch + 1`.

**Decisions.**

- **Transfer.**
  - **Include the store and referenced artifacts in the handover bundle and bump the epoch on accept (recommended).**
    - Pros: leaves follow the new authority at once; the old one is refused.
    - Cons: larger handover bundles.
  - **Re-import from a Git export after handover.**
    - Pros: no handover change.
    - Cons: loses operations, receipts and drift decisions.

### 6. Native plugin lifecycle beyond Claude

**Problem.** Only Claude marketplace plugins install; Codex, Grok, OpenCode and Pi plugins are discovery only.

**Context.** The OpenCode mirror strips user plugins and the Pi bridge excludes extensions by design (they would run inside the bridge process).

**Investigation.** Codex plugin enablement is a `config.toml` flag that `mcp-management/toml-edit.ts` could edit; the others need bridge changes first.

**Decisions.**

- **Order.**
  - **Codex enablement first, behind task 1's qualification (recommended).**
    - Pros: smallest change with an existing safe editor.
    - Cons: install still happens through Codex.
  - **Bridge plugin loading for OpenCode and Pi.**
    - Pros: full lifecycle.
    - Cons: security review of in-process extensions.

## Related

- [Agent Capabilities management](../../architecture/agent-capabilities-management.md)
- [MCP management](../../architecture/mcp-management.md)
- [0031](0031-live-provider-and-platform-qualification.md)
