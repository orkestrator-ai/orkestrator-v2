# MCP management implementation plan

Date: 2026-09-21. Baseline: `88c2f9cc`.
Status: planned; none of these implementation steps has been executed.

Start with the [investigation](../../mcp.md). This directory specifies future
implementation work only. The investigation's source links identify existing
code; new filenames and API names in this plan are proposals unless explicitly
described as existing.

## Outcome and scope

Deliver persistent add, edit, rename, remove, and capability-gated enable/disable
of MCP servers for `claude`, `codex`, `opencode`, `cursor`, `grok`, and `pi`.
Support management without a conversation, truthful runtime apply status, shared
backend use, project provenance, and durable container configuration. Reuse the
existing connection/authentication actions where they are valid.

The backend is authoritative. Native files remain authoritative for native user,
Claude local, and project scopes. A separate backend-owned overlay is authoritative
only for explicitly selected environment-private container settings. The UI never
writes config directly, chooses arbitrary filesystem paths, or owns a reload job.

Do not promise identical transports, hot reload, authentication, or terminal
behavior across providers. Capability differences must be modeled and displayed.

## Delivery sequence

| Step | Document | Depends on | Reviewable result |
| --- | --- | --- | --- |
| 01 | [Compatibility evidence and decisions](01-compatibility-and-decisions.md) | None | Pinned-version fixtures, source maps, resolved blocking API questions |
| 02 | [Contracts and validation](02-contracts-and-validation.md) | 01 | Typed management DTOs, bounds, errors and capability model |
| 03 | [Targets and passive inventory](03-targets-and-inventory.md) | 02 | Correct backend/provider/scope catalog without starting servers |
| 04 | [Safe native persistence](04-persistence-and-secrets.md) | 02–03 | Atomic, conflict-aware, secret-safe add/edit/remove primitives |
| 05 | [Backend operations and runtime reconciliation](05-operations-and-reconciliation.md) | 02–04 | Durable save/apply state and recovery independent of UI |
| 06 | [Claude adapter](06-claude.md) | 01–05 | Scoped JSON management and safe next-query application |
| 07 | [Codex adapter](07-codex.md) | 01–05 | Versioned TOML management and honest reload tracking |
| 08 | [OpenCode adapter](08-opencode.md) | 01–05 | Native config management with directory-scoped reconciliation |
| 09 | [Cursor adapter](09-cursor.md) | 01–05 | Native source management with pinned next-send/reattach strategy |
| 10 | [Grok adapter](10-grok.md) | 01–05 | Grok native management, compatibility provenance and ACP application |
| 11 | [Pi adapter](11-pi.md) | 01–05 | JSON management and client/tool-registry replacement |
| 12 | [Provider settings and editor UI](12-ui-and-user-flows.md) | 02–05, adapter capabilities | Complete editor, operation feedback, deep links and accessibility |
| 13 | [Containers, remote backends and terminals](13-environment-delivery.md) | 03–11 | Durable environment overlays and verified startup delivery |
| 14 | [Validation, migration and release](14-validation-and-rollout.md) | All preceding steps | Evidence matrix, safe rollout and operator documentation |

Complete common contracts before provider-specific work. Each adapter can be a
separate PR after the shared foundations. A UI can be developed against fixtures,
but a provider's write controls stay off until its persistence and apply tests
pass. Step 13 is a release requirement for container write support; until then
container catalogs must be explicitly read-only, not silently redirected to host
files. This ordering does not authorize implementation in this documentation task.

## Product decisions used throughout

1. “Provider” means agent platform. Do not create one MCP registry per Pi model
   vendor or OpenCode model vendor.
2. Default to an explicit provider-native user target on the selected backend.
   From an environment deep link, preselect that environment and show the actual
   available scope; never silently select a shared user target.
3. Offer project writes only when the source and execution policy are known.
   Saving a project file does not grant permission to execute it on the host.
4. A server's source identity is distinct from its runtime name. Shadowed entries
   stay visible. Removal may reveal a lower-priority entry; preview that result.
5. Save is passive persistence. Save and apply may start a process or connect to
   a server. It is a separate explicit user action; it cannot interrupt a turn.
6. A valid save survives runtime connection failure. Report both facts, with a
   retry-apply action that does not re-save or resend a user prompt.
7. Provider-required restarts happen at a safe boundary and report their scope.
   Existing terminal sessions get guidance, not injected restart commands.
8. Protected Orkestrator, plugin and policy-managed definitions are not generic
   editable rows. Authentication has its own ownership and lifecycle.
9. Preserve provider-native unknown options. A basic form changes only fields
   it owns. Unsupported definitions remain inspectable and removable only when
   source ownership and a safe remove operation are established.
10. Secrets use keep/replace/clear operations, private provider storage and
    environment references. Do not build an unrelated credential vault or copy
    OAuth token stores as part of server CRUD.

## Proposed component boundaries

```text
Provider settings / live MCP panel
  -> authenticated backend management commands
  -> McpManagementService
       -> McpTargetResolver + source catalog
       -> provider config adapters + safe config writer
       -> durable operation records + runtime reconciler
       -> environment overlay materializer (container targets only)
  -> existing native-agent providers / private bridge apply routes
  -> vendor runtime
```

Suggested new modules are `packages/protocol/src/mcp-management.ts` and a focused
`apps/backend/src/core/mcp-management/` directory. Keep catalog, persistence,
provider codecs, operations and runtime scheduling separate. Register commands
through `createCommandRegistry()` and the existing registry composition; do not
grow another monolithic `commands.ts` or duplicate provider routing in React.

## Release gates

- [ ] All six providers have verified add, edit, rename and remove in each scope
  advertised writable; unsupported scope/transport combinations are explicit.
- [ ] Every write detects stale source revisions and preserves unrelated data.
- [ ] Secrets and internal MCP tokens are absent from public snapshots and logs.
- [ ] Active turns, approvals, background jobs and coordinator policies survive
  edits and reload requests.
- [ ] Passive list/validate operations launch no MCP processes or network probes.
- [ ] Runtime apply recovers after tab switch, browser reload, bridge restart,
  backend restart and duplicate/lost responses.
- [ ] Container changes survive the promised recreation boundary; host config
  remains unchanged by environment-private edits.
- [ ] Existing externally edited native files continue working; no automatic
  migration or takeover occurs merely by opening settings.
- [ ] Real browser, local and container evidence is recorded under the repository
  test guide; unverified flows are not advertised as supported.

## Deferred follow-ups

Server marketplaces, automatic package installation, cross-provider copying,
bulk import/export, provider account login redesign, organization policy editing,
MCP resource browsing/tool execution, arbitrary raw native config editing, and a
new cross-platform credential vault are not required for this feature. Per-server
connection tests may be added later if they clearly disclose execution and share
the same policy and lifecycle boundaries.

## Estimate and sequencing risk

This is a cross-cutting feature, not a one-component settings change. Estimate
after step 01 rather than committing to a schedule based on assumed hot-reload
support. The highest uncertainty is provider deletion/merge behavior, container
ownership and external-edit reconciliation. Keep persistence, runtime application
and UI PRs reviewable separately; release gates still require the full path.
