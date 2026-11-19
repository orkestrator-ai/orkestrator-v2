# Agent Capabilities follow-ups

## Task analysis

Analysed 2026-11-19 against `main` at `fb2c01e83`. Created by the Agent Capabilities build ([agent-capabilities-management.md](../../architecture/agent-capabilities-management.md)).

### Tasks

1. **Live provider conformance for capability installs**: done for Claude Code 2.1.326, Codex 0.169.0 and OpenCode 2.3.1 (2026-11-19); Grok Build, Pi and the Cursor SDK remain open (no pinned binary outside Orkestrator's toolchain, no credential-free listing). See [Assumptions and decisions](#assumptions-and-decisions).
2. **Isolated provider homes for exclusive session selections**: open (depends on 1).
3. **Merge for local changes**: done (2026-11-19; see [Assumptions and decisions](#assumptions-and-decisions)).
4. **Package registries and signed team manifests**: done (2026-11-19; with lockfile format 2 for mixed revisions; see [Assumptions and decisions](#assumptions-and-decisions)).
5. **Command-node handover of capability state**: done (2026-11-19; with leaf launch authority; see [Assumptions and decisions](#assumptions-and-decisions)).
6. **Native plugin lifecycle beyond Claude**: Codex enablement done (2026-11-19), and Claude managed installs restored from immutable artifacts; Grok, OpenCode and Pi remain open. See [Assumptions and decisions](#assumptions-and-decisions).
7. **Container delivery through portable inputs**: done (2026-11-19; with project delivery into local worktrees and added-account verification; see [Assumptions and decisions](#assumptions-and-decisions)).

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

**Investigation.** A three-way merge needs the base revision's bytes, which the artifact cache keeps for the previous five revisions and for older revisions still pinned by a toolkit.

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

### 7. Container delivery through portable inputs

**Problem.** The executor writes into this machine's provider homes. A container environment receives provider resources only through its staged portable inputs, so a capability added after the container was created reaches it only on a rebuild, and the Capabilities page does not yet show a container's installed revision or offer the refresh.

**Context.** `portable-inputs.ts` stages provider resources and shared skills into containers with bounded copies and withholds credentials; `describeCapabilitySupport` already reports native plugin lifecycles as unsupported in a container.

**Investigation.** The container's inputs revision label (`DOCKER_LABEL_INPUTS_REVISION`) can carry the manifest digest; the environment card can compare it with the environment's current effective manifest and offer the existing rebuild action.

**Decisions.**

- **Delivery.**
  - **Stage the effective manifest's artifacts into the portable inputs and compare digests on the environment card (recommended).**
    - Pros: reuses the bounded staging and the rebuild flow; no writes into a running container.
    - Cons: a change needs a rebuild of the inputs.
  - **Write into running containers with `docker exec`.**
    - Pros: immediate.
    - Cons: a second writer inside the container boundary; conflicts with the in-container firewall and ownership rules.

## Assumptions and decisions

### Task 3: diff3 implementation

- **Options.**
  - **A small in-repo diff3 (`capabilities/merge.ts`) over a bounded Myers diff (chosen).**
    - Pros: no new dependency; pure and unit-tested (clean merge, conflict, identical changes, deletions, CRLF, binary refusal, large rewrites); line-ending and executable-bit rules fit capability files.
    - Cons: ours to maintain; a rewrite past 2,000 edits becomes one conflict instead of a finer merge.
  - **`diff` (jsdiff 8), already in `bun.lock`.**
    - Pros: maintained.
    - Cons: only a transitive dependency of the Pi SDK, so the backend would add it directly; version 8 has no three-way merge, so diff3 chunking would still be ours.
  - **`node-diff3`.**
    - Pros: complete diff3.
    - Cons: a new dependency for about 200 lines of logic.

### Task 3: merge base and scope

- The base is the revision the machine's copy was installed from (the receipt's package digest), read from the artifact cache, which keeps the previous five revisions and older toolkit pins. When it is gone the merge is refused with "keep, adopt or replace instead"; no older base is guessed.
- A merge (and an adoption) covers every open local change to the package on that machine, so a multi-component package is published whole. Two copies of one component that differ (for example `~/.claude/skills` edited one way and `~/.agents/skills` another) are refused until one is kept or replaced.
- Binary files (NUL, or not UTF-8) and conflicted files over 256 KiB changed on both sides are not merged; the dialog offers keep, adopt or replace. MCP server and plugin configuration drift stays keep or replace only.
- A merge always publishes the package's next revision (it already contains the configured revision), never a local variant.

### Task 3: conflict resolution

- **Options.**
  - **Return each conflicted file's base, local and configured text, the marked-up merge and hunk lines; the user edits the resolved text and submits it with the merge's basis digest (chosen).**
    - Pros: the command node re-runs the merge, refuses a moved side or leftover markers, and inspects the result like any authored source (secrets included) before the usual preview and approval.
    - Cons: large conflicted files (over 256 KiB) are not editable in the dialog.
  - **Resolve per hunk with "take local / take configured" buttons only.**
    - Pros: simpler UI.
    - Cons: cannot combine both sides; deletion conflicts need a separate path anyway.

### Task 3: identity when adopting local changes

- **Options.**
  - **The user chooses: the package's next revision, or a separate package (local variant) (chosen).** Next revision is the default for authored packages, a variant for anything with an outside source, following the identity rule (a local variant has its own identity unless explicitly adopted as the next revision).
    - Pros: explicit; Git packages are never rewritten silently.
    - Cons: two flows to explain.
  - **Always the next revision.**
    - Pros: one flow.
    - Cons: silently rewrites a Git or registry package's identity.
- A variant is a new `managed` package with `derivedFrom`; it replaces the original in every setup that selected it, re-keying component choices and exceptions. Its installs carry `takeoverFrom`, and the executor lets it take over only copies the original owns; the original's removal then settles as "another package now manages this item". A leaf on an older build ignores `takeoverFrom` and reports a collision until updated.

### Task 3: divergence from an upstream source

- Adopting or merging into a Git, registry or marketplace package records `diverged` (upstream revision and digest, reason, time) and sets provenance `managed`. Pending proposals made against the replaced revision are deleted so the next check proposes the upstream head again.
- The update checker compares the remote head with the upstream revision (an unchanged upstream is not news), marks the proposal `diverged`, always requires approval and never auto-applies, even for a trusted source. Approving it applies the upstream revision, replacing the local changes, and clears `diverged`.

### Task 5: how the state travels with a handover

- **Options.**
  - **Push the state and its artifacts from the old command node over the handover's own transport before `accept_command_handover`, then install on accept (chosen).**
    - Pros: uses the link the handover already holds (a leaf cannot call its command node); reuses the content-addressed chunked bundle and its digest check; the install runs inside `acceptHandover` after the machines are adopted, so a refused accept (no room, not a controller) installs nothing and the old node can safely stay the authority.
    - Cons: a large state and artifact cache lengthen the handover; a new internal command (`stage_capability_node_handover`).
  - **Carry the state in `accept_command_handover`'s arguments.**
    - Pros: one call.
    - Cons: unbounded request size; the nodes contract would change, and its decode drops undeclared keys on older targets.
  - **Re-import a Git export after the handover.**
    - Pros: no handover change.
    - Cons: loses operations, receipts, drift decisions and the epoch.
- Inspections and import previews stay behind (short-lived; the new authority makes its own). Every artifact the state references and the old node holds travels; one it no longer holds is not required on arrival.
- The receiver's new epoch is `max(bundle epoch, its state epoch, its executor epoch) + 1`, and its own executor moves to it; the old node moves its executor to the bundle epoch + 1 with the target as controller once the target accepted, so even its own executor refuses its stale plans.

### Task 5: crash safety and idempotency

- Every step is keyed by the handover journal's id (`pendingHandover.id`): artifact chunks are content-addressed, the state bundle is staged under the id and digest, and an install already done answers `installed`, so the journal's retry (on restart or a repeated `hand_over_command`) resumes a lost answer without a second epoch.
- The old node is non-authoritative from the first byte sent (`sending`), not only after the accept: otherwise a mutation between export and accept would be lost.
- A transfer that fails on a fresh handover rolls the registry back and clears `sending` (nothing was offered to accept); a failure during the journal's retry keeps the journal, as an accept failure does.
- A target from before capability management may take command only when the state carries nothing (no package, receipt or operation in flight); otherwise the handover is refused with "update it, then hand over again".

### Task 5: what happens to machines and nodes left behind

- Capability authority moves as a whole. Machines the user leaves with the old command node keep what they last applied but receive no new plans (the old node is no longer an authority) until they join the new command node. Splitting authority per machine would need two live epochs, which the single-writer rule forbids.
- A node that handed over stays non-authoritative even when standalone ("manage capabilities from the command node") until command is handed back to it, which installs that node's state again at a higher epoch. Resuming automatically could not prove no machine saw the newer epoch.

### Task 5: leaf launch authority channel

- **Options.**
  - **The leaf emits `node-capability-launch-requested` on its own event stream; the command node, which already follows that stream, resolves, records and answers with `answer_capability_node_launch` (chosen).**
    - Pros: no new credential (links only run command node to leaf); the answer is admitted by the executor's epoch, so a stale or competing controller is ignored; the command node records the launch at once.
    - Cons: launch waits for a round trip (bounded at five seconds, skipped when no command node has been in contact for three heartbeats); the event carries ids and digests of the leaf's managed copies.
  - **Push each leaf a resolution snapshot (setups, packages, receipts) on every reconcile and resolve locally.**
    - Pros: no launch latency; works offline.
    - Cons: the leaf would hold a copy of the authority's state that can be stale at launch, and the launch record reaches the command node only later.
  - **A leaf-to-command-node link.**
    - Pros: a direct call.
    - Cons: the leaf would need a credential for its command node and a route back, which today's attachment does not have.
- The leaf sends its own managed copies (component, location, digest, drifted) so the command node does not observe the leaf again during the launch; the leaf re-checks the required copies against its own bytes when the answer arrives.

### Task 5: when the command node is unreachable

- A cached answer stands in only for the same logical session and target (including template, graph node, worktree and ceiling digest), when under six hours old, from the leaf's current controller and epoch, and when this machine's applied installations (a digest of the executor's applied keys) and the required copies' bytes are unchanged. It is persisted in the leaf's capability store (bounded to 100), so it survives a restart.
- Otherwise the launch fails closed when the last answer said something is required on this machine (or the cached answer for the target had required components), and only warns when not. A leaf that never had an answer does not block: it cannot know whether anything is required, and blocking every launch on a leaf of an unreachable command node would stop users who use no required capabilities.
- A launch resolved from the cache is not recorded on the command node; the leaf's own record names the controller whose answer it used.

### Task 5: launch delivery enforcement

- The resolver's `requiredDelivery` needs one matching observed copy; launch now also requires every machine-wide copy of a required component that the provider reads (its receipts for that provider and revision) to be observed, managed, unchanged and equal to its receipt digest. A copy only other providers read may change without blocking. Worktree and account-scoped copies keep their own rules (`scoped-delivery`).
- The launch record lists exactly the observed copies (`deliveries`: package, component, location, digest).

### Task 5: proof

- In-memory network (real `NodeService`, `NodeLink`, handover journal and capability services; fake `fetch`): transfer and epoch advance, the old controller refused by a leaf and by its own executor, a pending operation resuming on the new authority with only the latest revision, an interrupted transfer abandoned and retried, a lost accept answer recovered without a second epoch, digest and epoch checks on staging, leaf launches answered, recorded and enforced, cache rules and fail-closed behaviour.
- Two real `OrkestratorBackend`s behind real gateways on loopback (`tests/capabilities-two-node.integration.test.ts`): enrolment and delivery, offline leaf catching up with the latest revision only, a leaf launch resolved and recorded over the real event stream, handover to the leaf with epoch 2 and the old controller refused over HTTP. Not covered: a third machine moving with the handover (loopback routes are not handed over) and separate OS processes (`scripts/two-node/harness.ts` could host that as a weekly check).

### Task 4: registry index format and identity

- **Options.**
  - **An Orkestrator JSON index (`orkestrator-capability-registry`, version 1) mapping qualified ids to versions, each naming a Git repository, subpath and full commit, or an HTTPS tarball with its SHA-256 and subpath (chosen).**
    - Pros: every version names immutable content, so the artifact digest a lockfile pins can always be re-fetched and checked; Git versions reuse the safe Git fetch; a static file on any HTTPS host is a registry; bounded and validated in the browser-safe protocol (`capability-registry.ts`).
    - Cons: a new format publishers must produce; no search API, so the Add dialog lists from the whole index (at most 2,000 packages, 2 MiB).
  - **Reuse an existing ecosystem registry (npm, OCI).**
    - Pros: existing tooling and hosting.
    - Cons: install scripts, mutable tags and authentication flows that capability inspection must never run or depend on; a client per ecosystem.
- Identity is `registry:<registryId>/<qualifiedId>` (the `/` replaced the unused `:` separator), so `forbiddenSources` forbids a whole registry with the prefix `registry:<id>/` (or `registry:<id>`). The check runs before any fetch: inspection, update discovery and listing are refused, and a version whose Git repository is forbidden is refused too. The resolver already blocks forbidden packages in setups.
- The revision is the registry version; the artifact digest is the inspected tree's. Republishing a version with different bytes is caught by the lockfile digest on import; update discovery follows only `latest` moving to a new version name.
- Registries are stored in the capabilities store (`settings.registries`, at most 16) through `set_capability_registry`; saving fetches the index once and records the package count or the error, never refusing the save, so a registry that is briefly down can still be configured.
- Registry access is unauthenticated. An index or tarball behind credentials is out of scope (no credential may enter the capabilities store).

### Task 4: tarball extraction

- **Options.**
  - **An in-memory tar reader in `registry.ts` (ustar, pax `path`, GNU long names; gzip through `node:zlib` with `maxOutputLength`) (chosen).**
    - Pros: nothing touches the disk before inspection; the SHA-256 is checked before a byte is unpacked; every entry type other than a regular file or directory (links, devices, FIFOs, unknown types) and every absolute, drive-letter or `..` path refuses the whole archive; size, per-file and entry-count limits apply while reading; the result goes through `validatePackageFiles` like an upload.
    - Cons: ours to maintain; sparse and base-256 size entries are refused rather than read.
  - **The system `tar` binary into a temporary directory, then `readPackageTree`.**
    - Pros: complete format support.
    - Cons: platform-dependent flags for refusing links and absolute paths; extraction writes before anything is checked.
- HTTPS fetches follow redirects by hand (at most three, each https without credentials) and are bounded in size and time (`boundedHttpsGet`); tests inject `fetch`.

### Task 4: manifest signing

- Reuses the graph-sharing key pair and trusted keys (the recommended option above): one trust list, and an untrusted signer can be trusted from the import preview with the same `graph_sharing_key_trust` command graph bundles use. The key's scope now covers capability manifests as well as graphs.
- The signature lives in the lockfile (`signature`: algorithm, key id, public key, intent digest, value) and covers the lockfile as written minus the value, as canonical JSON, plus the SHA-256 of the validated intent. Signing the parsed intent rather than its YAML text keeps comments and formatting free to change; any semantic edit to either file invalidates the signature.
- A signed lockfile is always format 2, so an installation that does not know signatures refuses it instead of importing it unverified.
- **Require signed project manifests** (`settings.requireSignedManifests`, `set_capability_manifest_policy`) applies to every import, pasted or from a project checkout. The preview records its signature status, and the import refuses a preview that was not trusted when the policy is on at import time.

### Task 4: lockfile format 2 and when to write it

- **Options.**
  - **Write format 1 whenever it suffices (one revision per package, unsigned) and format 2 otherwise (chosen).**
    - Pros: teams with installations from before this change keep exchanging ordinary exports; those installations refuse a format 2 file cleanly ("Expected format version 1") instead of misreading it.
    - Cons: two writers (format 2 is the in-memory shape; format 1 is a projection of it in `capabilityLockfileDocument`).
  - **Always write format 2.**
    - Pros: one writer.
    - Cons: every export from this version breaks importing on older installations, even when nothing needs format 2.
- Format 2 lists a package once per (id, artifact digest); each setup names its entry. Import creates a new package at its first entry (export orders the library's current revision first, then earlier ones newest first), keeps the others as earlier revisions with their inventories, and pins each setup's selection to its entry (by digest when two entries share a revision name). A revision the library already keeps, current or earlier, imports as unchanged; any other revision of an existing package is still a conflict for the update or rollback workflow. Earlier revisions count toward the five kept for rollback.
- Proof: unit tests for the validators (format 2 round trip, format 1 read and written, refs to missing entries, duplicate refs, secrets and host paths) and service tests across two installations: two toolkits pinned to two registry revisions export as format 2 and import to the same (package, digest) pins; a format 1 export imports; signed exports verify as trusted, untrusted and invalid, and the policy blocks unsigned and untrusted ones.

### Task 1: which listing proves a delivery

- **Options.**
  - **Each provider's own credential-free listing against a fresh isolated home (chosen).** Claude's `-p` `init` event (printed before it reports "Not logged in", `apiKeySource: none`), `claude plugin list --json`, `codex debug prompt-input` and `codex plugin list --json`, and `opencode debug agents --standalone`.
    - Pros: proves the pinned binary loads the delivered bytes; no sign-in, no credentials, no network writes; runs in seconds.
    - Cons: the `init` event and `prompt-input` are diagnostic surfaces that a provider release can change; they are pinned along with the binary.
  - **A signed-in `dev:test` profile per provider (the original recommendation).**
    - Pros: the full Orkestrator session path.
    - Cons: needs credentials, which these runs must never use.
- **Binaries.** `ORKESTRATOR_CONFORMANCE_<TOOL>` or the mise install of exactly the pinned version, checked with `--version`; never Orkestrator's own toolchain directory, so a run cannot touch its data. The environment is minimal (no inherited session variables), so no credential or messaging token reaches the child.
- **OpenCode.** `debug agents` without `--standalone` starts the shared background service on a fixed port and leaves it running; the test uses a private server instead. OpenCode subagents and commands stay `unqualified`: the binary lists the agent, but the session configuration mirror Orkestrator launches OpenCode 2 with is not covered, and there is no credential-free command listing.
- **Result (2026-11-19, Linux x64).** 7 passed, 1 skipped (Grok, Pi, Cursor): Claude skill listed and removed; Claude plugin install, replay, update, removal with an external plugin kept, and `<plugin>:<skill>` in the session catalogue; Codex skill listed and removed; Codex plugin switched off and on; OpenCode agent listed.

### Task 1 and 6: Claude plugins from immutable artifacts

- **Options.**
  - **An Orkestrator-owned directory marketplace serving each approved artifact from a digest directory, registered and installed with Claude's own CLI, verified by reading `claude plugin list --json` back (chosen).**
    - Pros: Claude writes its own settings and registry; the bytes Claude reads are the approved bytes, by path and by digest, both in place (`readFromFolder`) and in its cache (`installPath`).
    - Cons: one more directory in the Claude home; Claude caches by the manifest version, so an update must uninstall (keeping data) and install again.
  - **Editing `settings.json`, `known_marketplaces.json` and `installed_plugins.json` directly.**
    - Pros: no CLI process.
    - Cons: those files are Claude's internal formats; a second writer races Claude.
  - **`claude plugin install name@marketplace` from the source marketplace.**
    - Pros: simplest.
    - Cons: the mutable identifier this task exists to avoid.
- **Ambiguous outcomes.** A non-zero exit, timeout or unreadable answer is settled by the read-back; the write is not repeated in the same pass. The reconciler settles an unanswered plan from the inventory, which now reports managed plugins at `plugin:claude` with the digest Claude reads.
- **Ownership.** Only `<name>@orkestrator-managed` is ever uninstalled. An enabled external plugin of the same name blocks delivery; Adopt is accepted only when its installed bytes equal the approved digest, and the adopted copy is never removed. A same-named marketplace Orkestrator did not register fails the install untouched.
- **Parts and hooks.** For Claude, a delivered plugin carries its dependent components, which are not delivered again (they would load twice); a required part is satisfied by the plugin's receipt. Hooks are only ever installed inside an approved plugin revision.
- **Not done.** Bare `name@marketplace` packages stay unsupported for delivery (no reviewed bytes); fetching and pinning a marketplace entry's source is a separate change.

### Task 6: Codex plugin enablement

- **Verified on Codex 0.169.0.** `codex plugin add` writes `[plugins."<id>"] enabled = true` to `config.toml`; setting it to `false` is honoured by `codex plugin list --json` and removes the plugin's skills from `codex debug prompt-input`.
- **Options.**
  - **Flip only `enabled` with MCP management's format-preserving TOML editor (chosen).** Refuses a plugin Codex does not list as installed, a missing entry (never added), inline or dotted layouts, linked or oversized files; checks the re-parsed document differs only in that flag; keeps the file mode; compare-and-swap on the bytes read; confirms with Codex's list.
    - Pros: no second TOML writer; comments and formatting kept.
    - Cons: a writer that changes the file between the check and the rename is not excluded (MCP management's lock is not shared).
  - **`codex -c plugins."<id>".enabled=false` per session.**
    - Pros: no file edit.
    - Cons: a per-launch override, not the persisted state the user sees in Codex.
- **Surface.** `set_capability_plugin_enabled` (admin, on the machine that answers), the web client function, and an "Enable <plugin>" switch in Capabilities → Installed on this machine → Plugins → Codex (disabled with its reason for another machine, a plugin without a reported marketplace, or a failed/pending one; `AgentPluginsBrowser.test.tsx`). Claude answers `unsupported` (managed plugins follow setups; external ones are switched in Claude); other providers answer `unsupported`.

### Task 7: where the container's manifest is recorded

- **Options.**
  - **Reuse the inputs revision label only, with the record in the revision's `manifest.json`.**
    - Pros: no new label.
    - Cons: the digest is not visible on the container without reading the revision directory.
  - **A dedicated `orkestrator-capabilities-digest` label plus the per-component record under `extensions.capabilities` in the revision's `manifest.json` (chosen).**
    - Pros: `docker inspect` shows the digest; the record ties to the exact revision the container binds; a label that does not match its record proves nothing, so launch refuses rather than trusting either alone.
    - Cons: two places to read.
- **Staging point.** `stagePortableInputs` gained `StagingOptions.beforeCommit`, run in the partial revision before its manifest is written and the revision renamed into place, so the capability files are as atomic as the rest of the inputs; a stage the hook creates (no host files of that kind) still gets its mount. A hook failure never stops container creation: the container is created without a capability label and its card says "Rebuild to update".
- **What is staged.** Everything the container target resolves to (My setup, machine-wide toolkits, project and environment setups), not only the project's packages: the container's homes are its own. File kinds only; MCP servers keep arriving through the staged provider configuration and are reported as not staged.
- **Current versus installed.** The current digest is computed with the providers and stages recorded at staging, so enabling a provider later does not make every container look stale; a container staged before this change has no record and is reported stale.

### Task 7: project delivery into local worktrees

- **Options.**
  - **Keep refusing project-only delivery until isolated homes exist (task 2).**
    - Pros: nothing new.
    - Cons: imported project setups reach no machine.
  - **Write into the worktree's own provider directories (chosen).**
    - Pros: the providers already read them, scoped to that checkout; one copy per environment.
    - Cons: other providers in the same worktree may read the same directory, which `alsoVisibleTo` reports.
- **Git.** Paths go into `info/exclude` of the Git common directory in a block per environment (`# >>> orkestrator capabilities env-<id> >>>`); blocks of environments this machine no longer has are dropped. `git ls-files` decides tracked collisions; if it fails, nothing is written (a directory outside any repository is written without an exclude). The tracked `.gitignore` is never edited.
- **Which packages.** Only packages a project or environment setup selects, minus what the machine-wide copies already give that provider at that revision, so Claude does not see the same skill twice.
- **Locations.** Project paths follow the providers' documentation (OpenCode, Pi and Codex docs checked through Context7; Claude Code, Cursor and Grok as `acp-provider-config.ts` and the bridges read them). Coverage counts only documented readers; `mayAlsoRead` (Cursor and Grok for `.claude/skills` and `.agents/skills`, Pi for `.claude/skills`) only widens `alsoVisibleTo`.
- **Scope.** The command node's own local worktrees at first; worktrees on other machines followed (see "Task 7: project delivery into worktrees on other machines").

### Task 7: added-account verification

- **Options.**
  - **Keep refusing required packages for an added account.**
    - Pros: nothing new.
    - Cons: an account whose directories are linked (the normal case) is refused for no reason.
  - **Check each linked entry and give a private one its own copy (chosen).**
    - Pros: the linked case uses the host receipt; a private directory gets real, verified delivery; credentials are never involved.
    - Cons: a private directory receives only what the machine-wide installations hold (setups are not per account).
- **Re-linking.** A receipt whose directory is linked again is forgotten without touching files, because the path now reaches the host's copy.

### Task 5 and 7: launch deliveries for targets with their own copies

- **Problem.** `verifyLaunchDeliveries` checked the host's copies for every target, so a container whose staged record matched was blocked by a drifted host copy it never reads.
- **Options.**
  - **Ask `scopedRequiredDelivery` first and skip the host check when the target reads no host copy (container, private account directory) (chosen).**
    - Pros: one rule shared with the resolver; the staged record's refusal (with "rebuild") is the blocker; deliveries name the copy actually read (`container:<location>`, `account:<location>`, project location ids).
    - Cons: a worktree still checks host copies (below).
  - **Skip the host check for every scoped target, worktrees included.**
    - Pros: simpler.
    - Cons: a false pass. Claude ranks a personal skill above a project one (Claude Code skills docs, "Resolve skills that share a name"), so a drifted `~/.claude/skills` copy of the same revision is what a worktree session runs.
- A worktree's verified project copy is recorded in `deliveries`; host copies of the same revision the provider reads must still match. A personal copy at another revision with the same name also shadows the project copy in Claude; that is not detected yet.
- **Leaves.** The leaf's launch request carries the target's own copies (worktree managed copies, or its container's record and label; ids and digests, reasons stripped) as `scoped`; the command node maps them onto its receipts as scoped evidence, and the leaf re-checks scoped deliveries against a fresh report.

### Task 7: project delivery into worktrees on other machines

- **Which environments live where.** The command node's federation read model (node summaries: environment id, project id, type, deletion state) lists each machine's local worktrees; environments it holds receipts for are always asked about too. A node never read yet answers `null` and nothing changes.
  - **Alternative: the machine lists its environments in the observation.** Pros: never stale. Cons: needs a second round trip before the plan can be probed for collisions. The machine's answer is authoritative anyway (`missing` releases receipts), so the read model's staleness only delays.
- **Transport.** Two `internal` commands instead of widening `apply_capability_node_plan`: an older leaf answers `unknown-command` and nothing is written, and the machine-wide plan keeps its strict location table. Keys must start with `<that node>|env:<environment>|` and locations must be project locations; the worktree path never travels.
- **One pass, two places.** `runScopedPass` takes an IO (observe, apply): local for this machine, remote for another. The remote IO marks receipts `outcomeUnknown` before writing; the next pass settles them from the observation (planned digest → confirmed; previous digest → restored; anything else → planned afresh, with the executor's ownership rules deciding).
- **Triggers.** After each machine's reconcile pass (`afterNodePass`), and after every applied change (`reconcileScoped`), since a project toolkit's change has no machine-wide target. A recheck is scheduled after an unknown outcome.
- **Environment cards (done).** The window already asks its command scope; the command node answered "none" for any environment not in its own store. It now finds the environment in its read model and answers from its receipts and plan for that machine (`environment-authority.ts`); a container's staged record is read from the machine that owns it (`get_capability_node_container_delivery`).
  - **Option: the window asks the environment's own node, which proxies to its command node.** Pros: the container's record is local to the answer. Cons: every card needs a leaf→command round trip on the event channel and a leaf with no command node in contact shows nothing.
  - **Option: the command node answers for every machine (chosen), and a leaf's own window proxies.** Pros: one read for the usual window (on the command node); receipts and setups never leave the command node; a leaf's own window still gets the command node's view, or its own record with a notice. Cons: one extra link call for a container's record; a just-created environment is unknown until the read model refreshes.

### Container staging on a leaf

- **Problem.** A leaf staged a new container from its own store, which holds no setups: nothing was staged and required components always blocked.
- **Options.**
  - **The leaf asks on its event stream (`node-capability-leaf-requested`, kind `container-staging`); the command node stages the plan's artifacts on the leaf, then answers (`answer_capability_node_request`) (chosen).**
    - Pros: the launch channel's direction (command node to leaf) and epoch admission; artifacts arrive through the existing verified chunked transfer before the leaf copies anything; the plan is computed where the setups are, and its digest is computed the same way on both sides, so the card's comparison holds.
    - Cons: container creation waits up to 20 seconds when the command node is slow; a first large transfer can exceed it (the late answer is cached).
  - **The command node pushes every container plan to its leaves after each change.** Pros: no wait at creation. Cons: the command node does not know which containers a leaf is about to create (providers and stages depend on the image and the enabled platforms), so it would push plans for every combination; still stale whenever the push was missed.
  - **Reuse `node-capability-launch-requested` / `answer_capability_node_launch` with a `kind`.** Pros: no new contract. Cons: an older command node would read a container request as a malformed launch; the names would lie.
- **When the command node is away.** The last plan cached for that container target (environment, project, providers, stages) is staged if every artifact it names is still in the leaf's cache; otherwise nothing, with a record (`unstaged: command-node-unreachable`) that the card shows as "Capabilities not staged: command node unreachable" and that blocks required components with that reason until a rebuild. No age limit on the cached plan: the launch check on the command node still refuses an older revision than the one required.

### Task 7: project MCP servers

- **Options.**
  - **Write through MCP management's environment target and the provider's project source (chosen).**
    - Pros: its editors (format-preserving JSON and TOML), revisions, symlink and root checks, and ownership fingerprints; project trust comes from the same model the MCP servers settings show.
    - Cons: the target must exist on the machine that owns the worktree (it does for local environments).
  - **Write the JSON ourselves like file components.**
    - Pros: no dependency on MCP management's targets.
    - Cons: a second editor for the same files; TOML (Codex, Grok) would need another.
- **Which file.** A fixed table (`PROJECT_MCP_LOCATIONS`) of the file and the source id MCP management gives it; delivery requires that source, so OpenCode with an `opencode.jsonc` is reported unsupported instead of writing a second file.
- **Ownership of the file.** Recorded on the executor's MCP ownership (`createdFile`): a file Orkestrator created is excluded from Git and deleted once its last server is removed and it holds only an empty server map; an untracked file the user had is edited in place and kept; a tracked one is a collision.
- **Credentials.** As for machine-wide MCP: env and header keys only, `needs-auth` until the user's own definition supplies them; nothing is written for such a server.
- **Proof.** `project-mcp.test.ts` over the real `McpManagementService` and a real Git worktree.

### Administrator policy editing

- **Options for the read.**
  - **Fold the policy into `list_capability_registries`.**
    - Pros: no new read; the Setups view already loads it.
    - Cons: mixes organisation policy into the registry list and its revision (the whole store's), so any change elsewhere looks like a policy conflict.
  - **A dedicated `get_capability_admin_policy` / `set_capability_admin_policy` pair with its own revision (chosen).**
    - Pros: compare-and-swap only conflicts on a policy change (`settings.policyRevision`); the view can list what the policy blocks now.
    - Cons: two more commands in the contract.
- **Edit shape.** Whole-list replacement per list (chosen) rather than add/remove operations: the CAS already serialises administrators, and the form sends the list it showed.
- **Validation.** One browser-safe parser (`capability-admin-policy.ts`) used by the form and the command: Git addresses canonicalised like package ids, `registry:<id>` gains its slash, component entries are a kind (`kind:hook`), a component id or a package id. `kind:` entries are new; the resolver checks them through the same `capabilityPolicyDenial`.
- **Effect.** Activity (`admin-policy`) and `reconcileAll("admin-policy")`, so forbidden copies are removed on the next pass.
- **Proof.** `admin-policy.test.ts` (normalisation, refusals, CAS conflict, Activity, a forbidden source and a forbidden kind blocking on a machine's plan), `AdminPolicySection.test.tsx`, and the policy check in `e2e/CapabilitiesAccessibility.spec.ts`.

## Related

- [Agent Capabilities management](../../architecture/agent-capabilities-management.md)
- [MCP management](../../architecture/mcp-management.md)
- [0031](0031-live-provider-and-platform-qualification.md)
