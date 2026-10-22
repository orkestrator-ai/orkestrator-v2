# MCP environment delivery

Checked against `main` at `2459b05c` (2026-10-15).

MCP scopes are only truthful on the backend host today. A container's provider
homes are copies made when the container was created, so the editor cannot
offer environment-private configuration, and Cursor's user servers never reach
containers at all. Remote backends and restricted container networks also
change where a server runs, what it can reach and whether a sign-in callback
works. This file covers durable container-private configuration, deliberate
delivery of host defaults, and those location, network and authentication
semantics. Until it lands, container MCP targets stay read-only.

## Current state

- Container targets are read-only with `CONTAINER_READ_ONLY_REASON`
  (`apps/backend/src/core/mcp-management/targets.ts`). The catalogue reads the
  container's own files with a bounded `docker exec --user node`, or reports
  `offline`. The protocol reserves the `environment-private` scope and the
  `environment-overlay` source kind (`packages/protocol/src/mcp-management.ts`);
  nothing produces either.
- `containerDelivery` (`apps/backend/src/core/mcp-management/apply.ts`)
  reports container sessions as `restart-required` for backend-user changes,
  with the copy "recreate the environment", and Cursor container sessions as
  `blocked-policy`.
- Since #877, `stagePortableInputs` (`apps/backend/src/core/portable-inputs.ts`)
  stages allowlisted host inputs into a per-environment revision, including
  Pi `agent/mcp.json`, Codex and Grok `config.toml` and a filtered Claude
  `.claude.json`. There is no Cursor entry. `docker/entrypoint.sh` copies them
  into the writable homes (Pi `mcp.json` with mode 0600, symlinks refused).
- For images with the `staged-inputs` capability, `createDockerContainer`
  (`apps/backend/src/core/commands-containers.ts`) stages a fresh revision
  every time it runs, and a rebuild creates its candidate through it
  (`container-replacement.ts`). From the code, a rebuild therefore re-imports
  the host's current defaults and drops any edit made inside the old
  container's homes; no run has confirmed it.
- The persistent `state` volume holds only the session paths in
  `PROVIDER_STATE_LAYOUT` (`apps/backend/src/core/container-state-layout.ts`);
  provider MCP config lives in the container layer. `/workspace` is a
  persistent volume for `volume-v1` environments
  (`apps/backend/src/core/container-storage.ts`), so project files there
  survive rebuilds.
- `McpServerForm.tsx` says where a stdio command runs. Nothing warns about the
  container allowlist or OAuth callback reachability.

## Outstanding work

### Code

1. **Durable environment overlay.** No module exists yet.
   - Store it in private backend data, keyed by environment id (not container
     generation, so it survives preserving rebuilds) and provider, with a
     schema version and byte limits.
   - Record explicit additions, replacements and removals relative to the
     inherited container inputs: overlay revision, baseline fingerprint,
     materialised fingerprint, and tombstones so a removed inherited server
     does not come back on rebuild.
   - Materialise after the entrypoint copies and before the bridge or tmux
     starts, merging only the MCP subtree and keeping other settings.
   - On refresh, detect divergence caused by in-container edits and offer an
     explicit import or reapply, never a silent overwrite. On rebuild, reapply
     over the fresh baseline and stop with a conflict on an incompatible
     change rather than choosing a side or failing the whole environment.
   - Exclude it from diagnostic bundles, delete it with the environment, and
     do not copy its secrets when an environment is cloned.
   - If a write must happen before the bridge runs, use a narrow
     backend-owned writer: structured stdin, bounded payload, exact
     destination, private mode. The renderer never supplies a command or a
     container path.
   - Then enable container write capabilities and retire
     `CONTAINER_READ_ONLY_REASON`.
2. **Container project scope.** With `/workspace` persistent, consider
   allowing project-file writes inside `volume-v1` containers through the same
   bounded writer, without an overlay. User scope still needs the overlay.
3. **Cursor user-MCP delivery.** Add a staged input that copies only
   `~/.cursor/mcp.json`, never Cursor account, IDE, hooks or plugin state,
   respecting the existing credential-source opt-outs. Then retire Cursor's
   `blocked-policy` branch in `containerDelivery`.
4. **Refresh defaults.** Since a rebuild already re-stages inputs, change the
   "recreate the environment" copy to point at rebuild once a run confirms it.
   Add a separate operation that re-imports changed host defaults into an
   existing container after previewing overlay and divergence conflicts.
5. **Path audit.** Check the filtered `.claude.json` copy and the Grok and
   OpenCode portable configs for host-absolute `command` and `cwd` paths. A
   missing binary is an actionable runtime failure; nothing is installed
   automatically.
6. **Network and authentication.** Show the execution location near URL
   fields and in connection errors. Warn that restricted container
   networking may need an allowlist entry, and never widen the allowlist on
   save or apply. Advertise in-app sign-in for containers or remote backends
   only after the callback is proven reachable from the browser to the
   owning runtime, and never copy host OAuth stores into containers.

### Qualification

Container runs batch with
[0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
through `mise run test:agent:docker`; remote runs with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- The overlay survives backend restart, container stop and start, and a
  preserving rebuild; tombstones hold.
- Host files are byte-for-byte unchanged by container-private edits.
- An in-container edit produces a conflict and can be imported.
- Environment deletion removes only its own overlay and jobs.
- Pi and Cursor delivery respect opt-outs, size bounds, symlink rules and
  modes.
- A remote browser and a restricted network show the right execution and
  callback scope.
- Existing terminal work and background native sessions are not interrupted.

## Constraints and rationale

- The overlay exists only because container homes are copies, not a durable
  statement of intent. It is not a second registry for native sources, and it
  records intent relative to inherited inputs rather than a copy of a whole
  provider home.
- Do not mount writable host homes into containers, and never write a
  container-home edit through to the host staging copy.
- All paths, environment references and stdio executables resolve on the
  execution machine: a remote browser's `localhost`, the backend's and a
  container's are three different hosts.
- Container network policy stays authoritative, for coordinator and review
  sessions too. Do not log rejected URL query strings or headers.
- Terminal sessions get guidance only; no command is injected and nothing is
  restarted.

## Open questions

- Is container project-scope writing (item 2) acceptable without the overlay?
- Should overlay data be included in or excluded from rebuild recovery
  copies?

## Related

- [0039-mcp-management.md](0039-mcp-management.md) for the editor, apply paths and
  provider rules.
- [0021-container-rebuild-state-preservation.md](../containers-and-environments/0021-container-rebuild-state-preservation.md)
  for state layout and staged inputs, and
  [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md)
  for the allowlist and staged-input credentials.
- [`container-lifecycle.md`](../../architecture/container-lifecycle.md)
  ("Provider state", the provider-state inventory).
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Containers").

## Replaces

- `docs/improvements/mcp/plan/13-environment-delivery.md`
- `docs/improvements/mcp/plan/00-index.md` (the container recreation release
  gate)
- `docs/improvements/mcp/plan/14-validation-and-rollout.md` (container and
  remote-browser evidence)
- `docs/improvements/mcp.md` ("Environment and persistence findings")
