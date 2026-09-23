# 03 — Resolve execution targets and build passive source inventory

Status: done for backend and local-worktree targets; container targets read the container's files read-only
(`targets.ts`, `providers.ts`, `catalog.ts`). No file watchers: catalogs are read per request. Depends on: 01–02. [Plan index](00-index.md).

## Purpose and integration points

Create `McpTargetResolver` and a passive configuration catalog under the proposed
backend `mcp-management/` directory. Follow existing `CommandContext`, storage,
environment resolution and provider launch paths. The renderer supplies an opaque
target selection, never an arbitrary path to read or write.

Inspect existing `commands-servers.ts`, `commands-containers.ts`,
`host-agent-credentials.ts`, `extension-discovery.ts`, provider home helpers and
the native-agent provider resolver. Do not reuse side-effecting CLI health checks
to discover editable configuration.

## Target resolution

1. Resolve the authenticated backend and persisted project/environment before
   selecting paths. Reject a target id from another backend or a deleted/replaced
   environment. Include environment incarnation to prevent stale container ids
   targeting a replacement accidentally.
2. Resolve the execution location: backend host, local worktree, container, or
   stopped environment with durable managed overlay. The browser's home, OS and
   `localhost` are not inputs to this resolution.
3. Derive provider home, config variables, XDG directories and workspace root
   through the same policy as the launcher. Correct drift between launch and
   discovery behind shared tested helpers; do not guess paths independently.
4. Enumerate available scopes. A stopped provider process must not prevent local
   file management. An inaccessible container without a durable source must be
   read-only/offline, not quietly replaced by its host's user config.
5. Resolve project roots and ancestor config searches explicitly. Show which
   worktree/ancestor file is selected; edits must not jump to the main checkout.
6. Attach execution-policy/trust information. Reading an untrusted project config
   is allowed as passive inspection; executing its command is a separate gate.
7. Identify shared backing paths to calculate impact across providers and
   environments. Grok compatibility consumers are relevant even when editing a
   Claude or Cursor source.

## Initial source catalog

| Provider | Native sources to investigate and represent |
| --- | --- |
| Claude | User JSON MCP map; project-path local map in the same JSON; worktree `.mcp.json`; plugin/policy origins read-only |
| Codex | Effective Codex home TOML; supported trusted project TOML/layers; launch overrides and plugins read-only |
| OpenCode | User JSON/JSONC, custom config path, project/ancestor files, remote/inline policy layers read-only |
| Cursor | User `.cursor/mcp.json`, allowed project file, plugin/team sources read-only, trusted inline injection |
| Grok | User/project TOML; compatibility imports, managed/requirements sources, ACP injection |
| Pi | Resolved agent-dir `mcp.json`, allowed project `.pi/mcp.json`, injected connection |

This table lists discovery responsibilities, not permission to enable every scope
at once. Step 01 decides which can be safely written at the pinned baseline.

## Source and effective views

Parse source entries without resolving environment secret values or invoking
provider clients. Retain raw provider data only inside the backend adapter;
public summaries contain safe fields and presence metadata. Distinguish absent
file, empty file/map, invalid source, permission error, policy exclusion and
unsupported source format.

Build two related products: a list of source entries and an effective-name map.
Use each provider's actual precedence and merge semantics. Mark a source entry
shadowed rather than hiding it. Show why a configured entry is excluded by policy,
disabled, invalid, or not loaded in the selected runtime.

Do not join source definitions to runtime rows only by display name. Match exact
native name plus target/runtime identity and generation; annotate uncertain
matches. Inventory discovered from historical tool calls cannot establish source
ownership. A runtime-only name with no known source is read-only/unknown-origin.

Add stable source revisions based on bytes or provider-owned version metadata.
Hash only inside the backend and expose opaque revisions; avoid exposing hashes
of individual low-entropy secrets. A source's revision covers all content that a
write could overwrite, not just the selected entry.

## Cache and invalidation

Cache passive reads by actual source identity and a bounded stat/content revision.
Share in-flight reads; retain last-good results with explicit stale/error metadata.
Never treat stale cached data as the expected revision for an unconditional write.

Invalidate on successful save, provider-home change, environment recreation,
explicit refresh and known external-file changes. Prefer lazy stat validation
with bounded watchers only where justified. Release watchers for deleted targets;
do not spawn provider sessions from a watcher callback.

Publish a catalog revision/invalidation event through existing transport rather
than broadcasting definitions. A reconnecting UI reads a complete snapshot and
can detect a revision/generation gap. Management status reads are no-touch reads:
they must not refresh `lastAccessed`, resume Codex threads, or hydrate transcripts.

## Acceptance scenarios

- [ ] Settings opens with no session and launches zero MCP processes.
- [ ] Same-name entries in multiple scopes retain distinct identities.
- [ ] Malformed high-priority source is shown as an error, never as an empty map
  eligible for overwrite.
- [ ] Remote browser selects a remote backend and sees that backend's paths.
- [ ] Two worktrees resolve their own project files and shared user source correctly.
- [ ] Custom home variables match actual launch behavior; test profiles stay isolated.
- [ ] Old bridge, stopped environment, excluded project and unsupported scope all
  have useful read-only reasons.
- [ ] External changes invalidate cached revisions; catalog refresh does not wake
  idle conversations or keep them attached.

Exit: [04 — safe persistence](04-persistence-and-secrets.md).
