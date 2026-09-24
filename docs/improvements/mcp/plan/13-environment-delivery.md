# 13 — Deliver configuration to containers, remote backends and terminals

Status: partly done — Pi `mcp.json` container delivery and read-only container catalogs. The durable
environment overlay (container-private writes) is **not** implemented; container targets stay read-only.
Depends on: 03–11. [Plan index](00-index.md).

## Purpose and existing owners

Make scope semantics true across environment lifecycles. This is a required gate
before enabling container-private writes; without it, copied config can disappear
or be replaced on restart.

Inspect `apps/backend/src/core/commands-containers.ts`, `commands-servers.ts`,
environment storage/lifecycle code, `tmux-session-manager.ts`, `tmux-shared.ts`,
and `docker/entrypoint.sh`. Reuse exact-owner lifecycle patterns and bounded copy
helpers. Do not replace read-only host inputs with writable home bind mounts.

## Configuration authority table

| Selected scope | Durable authority | Runtime delivery |
| --- | --- | --- |
| Backend user | Native provider file on that backend | Local processes read it; new containers may receive an explicit portable input copy |
| Project/worktree | Native file in that exact worktree | Provider reads mounted worktree subject to trust/policy |
| Claude private local | Native private JSON project-path entry on selected host | Provider resolution for that project; do not copy arbitrary host path keys into containers |
| Environment-private container | Backend-private, versioned MCP overlay keyed by environment/provider | Materialized after bootstrap into writable container config, before provider starts |

Do not create a second registry for every native source. The environment overlay
exists only because container writable homes are not a durable source of user
intent. It records explicit additions/replacements/removals relative to inherited
container inputs, with provenance and revisions.

## Durable overlay design

1. Store overlay entries in private backend application data outside worktrees,
   keyed by environment id/incarnation and provider. Use the shared storage
   patterns, atomic persistence, schema version and byte limits. Persist literals
   only with the same restricted permissions as private provider config.
2. Track overlay revision, baseline source fingerprint, materialized fingerprint
   and tombstones for removed inherited entries. A tombstone must persist across
   recreation; otherwise a host copy can resurrect a removed server.
3. Record explicit baseline/server ownership, not a copy of the entire provider
   home. Avoid including sessions, logs, account credentials or unrelated config.
4. Materialize after native bootstrap copies and before provider/tmux launch.
   Merge only the MCP subtree into the writable native destination, preserving
   non-MCP settings. Report conflict/error before allowing the provider to start
   with a falsely acknowledged desired revision.
5. Once materialized, compare the runtime file fingerprint on refresh/apply.
   If an external editor/CLI changed the owned subtree, mark divergent. Offer
   explicit import into the overlay or reapply the saved overlay after preview;
   do not overwrite the external edit automatically.
6. On recreation, resolve a fresh inherited baseline and reapply overlay intent.
   If both baseline and overlay changed the same entry incompatibly, stop that
   provider's config application and show a conflict. Do not silently choose
   either source or fail the entire environment unnecessarily.

Source fingerprinting and operation records must never publish secret-bearing
file content or per-secret hashes. The durable overlay is subject to application
backup/export policy as credential-bearing data; exclude it from ordinary
diagnostic bundles and document its private-storage behavior.

## Host defaults and copy behavior

Changing backend-user config does not push it into every running container.
Report that new starts/recreations can import updated defaults according to the
existing lifecycle. Provide a deliberate refresh-defaults operation only after
previewing overlay/external-edit conflicts; do not silently rewrite a live home.

Add Pi `agent/mcp.json` to the bounded portable-input allowlist when host Pi
configuration sharing is enabled. Keep the existing credential-source opt-outs.
Verify file size, regular-file/symlink rules and mode. Do not copy the whole
`~/.pi/agent` directory to achieve this.

Define a deliberate Cursor user-MCP delivery path if advertised in containers.
The current bootstrap does not establish one. Copy only authorized MCP config,
not Cursor account/IDE state or unrelated hooks/plugins. A user-provided config
file can contain executable commands, so preserve the existing distinction
between user-approved inputs and repository-controlled project settings.

Audit Claude's filtered JSON and Grok/OpenCode portable config paths. Translate
scope/path identity where appropriate; never reuse host absolute executable or
working-directory paths blindly. A missing binary is a runtime failure with an
actionable explanation, not a reason to install a package automatically.

## Remote and network semantics

All paths, environment references and stdio executables resolve on the selected
execution machine. A remote browser's `localhost` is different from the backend's;
the container's `localhost` is different again. Show execution location near URL
and command inputs and in connection-error details.

Container restricted networking stays authoritative. A new MCP hostname may
require a separate allowlist change; do not automatically widen firewall rules
on save/apply. Preserve network policy for coordinator/review sessions too.
Do not log rejected URL query strings or headers.

OAuth callback routing is provider-specific. Verify callback reachability from
the browser to the owning runtime before advertising in-app sign-in. Do not copy
host OAuth stores into containers as a shortcut. Existing static env/header
authentication can be supported while a callback flow is unavailable.

Bridge/config delivery uses existing private authenticated channels. If a container
requires a file write before the bridge is running, use a narrow backend-owned
writer with structured stdin, bounded payload, exact destination mapping and
private modes. The renderer never supplies a shell command or container path.

## Terminal modes

Native-file edits may affect future CLI launches, but the service cannot prove
that an already running terminal CLI has reloaded. Show restart/refresh guidance
for supported terminal providers. Never inject commands into an active tmux
session, send Ctrl-C, or restart it as part of native MCP configuration apply.

Keep existing Claude terminal trusted-MCP injection intact. Do not claim that Pi's
bridge MCP extension is available to terminal Pi; do not invent Cursor terminal
support. Separate native apply status from terminal guidance in the UI.

## Cleanup, migration and acceptance

- [ ] Environment overlay survives backend restart, container stop/start and
  recreation; removal tombstones prevent inherited entries reappearing.
- [ ] Host/user config is byte-for-byte unchanged by container-private edits.
- [ ] External runtime edits cause a conflict and can be imported deliberately.
- [ ] Changed host defaults reconcile with an overlay without silent data loss.
- [ ] Pi/Cursor delivery paths obey opt-outs, bounds, symlink rules and permissions.
- [ ] Project worktree edits survive expected lifecycle without affecting siblings.
- [ ] Remote browser and restricted-network cases show correct execution/callback scope.
- [ ] Disabled/stopped targets save only when a durable authority exists.
- [ ] Environment deletion removes only its own overlay/jobs; cloning an environment
  does not copy secrets automatically without an explicit policy.
- [ ] Existing terminal work and background native sessions remain uninterrupted.

Next: [14 — verification and rollout](14-validation-and-rollout.md).
