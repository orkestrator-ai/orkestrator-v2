# 12 — Execution policy and host/container parity

**Status:** 🟨 In progress · code complete, awaiting Docker/browser QA · Depends on: 04

Refreshed 2026-09-11. `NativeAgentExecutionPolicy` is resolved in the backend
and applied on session create across adapters. Remaining work is the
container-matrix QA and any leftover per-environment override UI polish.

## Goal

Trust decisions are scattered across environment variables and per-bridge
defaults: Cursor loads project settings only in containers and runs
unsandboxed on the host; Grok passes `--always-approve` everywhere; Pi gates
project resources and approvals behind two flags; Claude defaults to
`bypassPermissions`; Codex has a real permission profile only for the
coordinator. Each is defensible, but the user sees the same repository behave
differently between a host worktree and a container with nothing saying why.
Introduce one backend-owned execution policy per environment that every
adapter honours, so behaviour is decided in one place and stated in the tab.

## Normalized model

`packages/protocol/src/native-agent.ts`:

```
NativeAgentExecutionPolicy = {
  id: "interactive-host" | "interactive-container" | "coordinator-read-only" | "pipeline"
  sandbox: "provider" | "container" | "none"
  approvals: "ask" | "auto-approve" | "deny"
  projectResources: boolean          // rules, extensions, .mcp.json, .cursor/, .pi/
  toolPolicy?: { allow?: string[]; deny?: string[] }
  networkAccess: "restricted" | "full"
}
```

The backend computes it from environment kind, coordinator/pipeline origin
and the existing per-environment settings, passes it to the bridge on
session create (`ProviderCreateSessionOptions.policy`) and through the
existing `/session/:id/config` route, and the projection carries
`policy` so the tab can show a one-line summary ("Container sandbox,
approvals off, project rules on"). The existing coordinator
`coordinator-read-only` profile becomes one value of this type.

## Tasks

### Protocol and backend

- [ ] Add the type, the create option and the projection field; protocol
  tests. A resolver in the backend service with tests for every
  (environment kind × origin) cell.
- [ ] Replace launcher-level env vars (`CURSOR_BRIDGE_PROJECT_SETTINGS`,
  `CURSOR_BRIDGE_SANDBOX`, `PI_BRIDGE_PROJECT_RESOURCES`,
  `PI_BRIDGE_REQUIRE_APPROVAL`, `ACP_APPROVE_PROJECT_MCPS`) with the policy
  passed at session create. Keep the env vars for one release as overrides
  with a deprecation log line.
- [ ] Renderer: a policy summary line in the agent info panel from the
  projection. No decisions in the renderer.
- [ ] Per-environment override UI (allow the user to loosen or tighten from
  the defaults) is backend settings plus a generic form; the resolver
  applies it.

### Claude adapter

- [ ] `approvals: "ask"` → `permissionMode: "default"` with `canUseTool`
  routed through plan 04; `"auto-approve"` → `bypassPermissions` (today's
  default); `"deny"` → `dontAsk`. `toolPolicy` → `disallowedTools`/
  `allowedTools` (fix the inert `"mcp:*"` entry at
  `session-manager-prompt.ts:782-796`). `projectResources` →
  `settingSources` includes `project`; `sandbox: "provider"` →
  `Options.sandbox`.

### Codex adapter

- [ ] Map to `approvalPolicy`/`sandbox` on `thread/start` and a permission
  profile written through `-c permissions.*` (today coordinator-only,
  `codex-config.ts:56-61`); enumerate with `permissionProfile/list` to
  verify the profile took. `networkAccess` → the sandbox network setting.

### Cursor adapter

- [ ] `sandbox: "provider"` → `local.sandboxOptions.enabled = true` and
  `autoReview: true`; `projectResources` → `settingSources` includes
  `project` (and `team`/`plugins` when the policy allows);
  `toolPolicy` → `tools`/`disallowedTools` (re-passed on resume since they
  are not persisted). Closes the host gap plan 01 only documented.

### Grok adapter

- [ ] `approvals` → pass `--always-approve` only for `auto-approve`; for
  `ask`, rely on `session/request_permission` through plan 04.
  `projectResources` → the MCP passthrough decision from plan 07.

### Pi adapter

- [ ] `approvals: "ask"` → register the approval extension (today the env
  flag); `projectResources` → `noExtensions`/`noSkills`/`noPromptTemplates`
  and `reload({ resolveProjectTrust })` so trust-requiring extensions are
  answered by the policy, not left unresolved. `toolPolicy` →
  `tools`/`excludeTools`/`setActiveToolsByName`.

### OpenCode adapter

- [ ] `approvals` → the unattended policy from plan 04 plus the session
  permission ruleset via `session.update` where the v1 surface allows;
  `projectResources` is always on (OpenCode reads its config itself) and
  the policy summary says so.

### Documentation

- [ ] `docs/architecture/agent-engines.md`: replace the scattered
  "permissive by default" paragraphs with one section on the execution
  policy and the per-adapter mapping table.

## Verification

- [ ] Backend tests: the resolver table; each adapter's mapping from a
  policy fixture to SDK options.
- [ ] Docker suite (`test:agent:docker`) for the container cell on Cursor
  and Pi; host browser QA for the host cell; confirm the summary line
  matches what the adapter received.

## Out of scope

Changing the coordinator's read-only boundary. Network allowlist contents
(already environment settings).

## Implementation notes

- The backend resolves and persists one policy for each provider session;
  policy-only settings tiers are retained and the renderer displays the
  effective policy without making trust decisions.
- Claude, Codex, Cursor, ACP/Grok, Pi and OpenCode translate the normalized
  axes at their SDK boundary. Legacy environment variables remain temporary,
  warning overrides, but normal launchers no longer set them.
- Codex maps a deny policy to `approvalPolicy: never` plus a read-only sandbox,
  so denying escalation cannot silently leave workspace-write authority.
  Project-resource MCP passthrough remains governed by plan 07's inventory
  work rather than being inferred in the bridge.
- Resolver and adapter tests are automated. The container matrix and host
  browser summary check remain required before merge.
