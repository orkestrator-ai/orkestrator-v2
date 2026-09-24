# 09 — Implement Cursor configuration management

Status: planned. Depends on: 01–05. [Plan index](00-index.md).

## Existing owners

- `bridges/cursor-bridge/src/mcp.ts`: config parsing, protected injection, observed
  inventory and read-only coordinator custom-tool hosting.
- `agent-session.ts`: SDK create/resume and settings sources.
- `http.ts`: authenticated session operations and attach lifecycle.
- `config.ts`: working directory and process-level settings-source policy.
- `state.ts`: session identity/runtime metadata.
- `mcp.test.ts`, `http.test.ts`: existing regression owners.

The current SDK pin is `1.0.31`. The existence of a method in current public docs
does not replace the compatibility probes from step 01.

## Source adapter

1. Add passive source discovery and persistence for backend-user
   `~/.cursor/mcp.json` and the selected worktree's `.cursor/mcp.json`. Keep plugin,
   team and hosted configurations read-only unless a separately verified writer
   exists. Cloud account configuration is not a target for this local SDK feature.
2. Preserve the entire source definition, including unknown authentication and
   advanced fields. The current `normalizeMcpConfig` is a runtime subset and must
   not serialize the editor's saved result.
3. Keep project-resource permission separate from file existence. A project entry
   can be visible but excluded; saving it must not alter `local.settingSources`
   to enable project code on the host.
4. Support add/update/rename/remove with source revisions. Gate persistent toggle
   until the pinned SDK's on-disk disabled behavior is proven; the present bridge
   parser does not establish that behavior simply by accepting a definition.
5. Detect inherited fallback after removal and explain it. Do not present deletion
   of an inline override as deletion of a same-name plugin/user definition.

## Select the runtime strategy

Preferred, if proven on the pin: use per-send `mcpServers` for the next run. Build
the full intended inline set at the send boundary, including current protected
entries. Passing one edited entry as a whole-set override is incorrect. Keep
file/plugin settings sources intact and verify the effective merged result.

This strategy needs explicit evidence that removing an inline entry does not
revive an unwanted creation-time or inherited definition. If a file-backed server
cannot be removed through a per-send set, update its owning file and use the
verified lifecycle needed to make the SDK reread it. Do not invent a disabling
sentinel in `mcpServers`.

Fallback: detach and resume an idle SDK agent using its stored vendor identity
with newly resolved options. Integrate with existing attachment/token rotation
logic rather than starting a second agent. Reject or queue while a turn, tool
operation or interaction is active. Saving config must never cancel user work.

If the current resume path falls back to creating a new conversation after a
resume error, do not silently use that fallback for a config apply. Report an
application failure/restart requirement, preserve the old conversation, and let
the user choose a new session separately.

## Revision and inventory handling

Track desired revision, applied revision and attachment/run generation. Include
configuration revision in refresh decisions; the current connection key covers
only trusted token rotation. An unchanged Orkestrator token does not mean user
configuration is unchanged.

Reset generation-specific tool inventory on reattach/new run as appropriate.
Retain history for transcript rendering but do not let `observedMcpTools` prove a
removed server is still connected. Separate last-seen evidence from current
configuration status. Tool counts are exact only when the SDK advertises a
complete inventory; observed calls give evidence of availability, not a full count.

Do not force eager attachment to discover a user's config. An offline or idle
session can show configured/pending/unknown-health while the passive catalog is
fully editable.

## Authentication and restricted sessions

Only advertise authentication that the bridge can complete. Existing provider
account sign-in is not MCP OAuth. For local MCP servers whose login must happen
in Cursor, display that limitation and refresh status after the external flow;
do not create a fake in-app browser callback.

Keep the read-only coordinator branch intact: it excludes user/project settings
and may host only Orkestrator tools in process. A user config change must not
rebuild that session with ordinary settings sources. Protected tokens must be
resolved at apply time and must not enter SDK configuration saved by our editor.

## Test matrix and acceptance

- [ ] User/project CRUD works with comments/unknown fields preserved where valid.
- [ ] User sources work independently of project-source policy.
- [ ] Per-send whole-set replacement retains protected entries and handles empty
  user sets, removal, rename and inherited-name collision correctly.
- [ ] Fallback reattach preserves vendor conversation identity; failed resume
  does not silently substitute a new conversation.
- [ ] Active turn, token rotation and config update serialize safely.
- [ ] Removed tools do not survive in the current-generation inventory.
- [ ] Read-only hosted tools and project exclusion remain unchanged.
- [ ] Authentication controls accurately reflect the pinned local SDK's support.

Next adapter: [10 — Grok](10-grok.md).
