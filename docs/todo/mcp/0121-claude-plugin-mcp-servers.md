# Claude plugin MCP servers in the editor

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Container run**: a container environment whose home holds a plugin, read by the real container reader and loaded by a real container session, including an install turned off on the host. Status: open.
2. **Narrow-viewport check**: the 390×844 layout of the plugin rows was not exercised in the real-app pass. Status: open (low value).
3. **Stale decision text and file retirement**: one decision row still describes the pre-0151 gap, and the file should be retired once task 1 is done. Status: open.

### 1. Container run

**Problem.** The container path of the plugin editor is proven only with the fake reader in unit tests and with the real reader against a bare `docker run` container; no container environment created by Orkestrator has loaded a plugin in a real Claude session and had its live row joined to the editor's row. Since 0151, the same run is also the only end-to-end proof that a plugin turned off on the host stays off in a rebuilt container. Users of container environments with Claude plugins are the ones affected.

**Context.** The file asks for this run to be batched with the container session run in [0040](0040-mcp-environment-delivery.md) (its "Open for a live run" item). It needs an image built from a tree that includes `35081a81` ("fix(claude): honor plugin enablement across runtimes (#1289)"), because older images neither merge the staged `enabledPlugins` nor carry the filtering bridge. 0151 proved each piece separately in `orkestrator-v2:dev-0c3cd9a3dec9`.

**Investigation.** The pieces are all on `main`: the container reader path in `apps/backend/src/core/mcp-management/claude-plugins.ts`, the staging filter (`apps/backend/src/core/portable-inputs.ts:235`, `claudeContainerPluginSettings` at `packages/protocol/src/node/claude-plugin-set.ts:296`) and the entrypoint merge (`docker/entrypoint.sh:855-865`). The opt-in real-reader test is `apps/backend/tests/claude-plugin-mcp-container.test.ts` (gated by `RUN_LIVE_CLAUDE_PLUGIN_MCP_DOCKER=1` at `:14`); it defaults to the image `orkestrator-v2:latest` (`:90`) unless `CLAUDE_PLUGIN_MCP_DOCKER_IMAGE` is set. On this host `orkestrator-v2:latest` was built on 2026-10-07, before #1289, and the image named in 0151 is not present, so a run here must build a fresh image (`mise run docker:build:dev`) and pass it explicitly; the unset default would silently test a stale image. Pins are unchanged since the qualification: `@anthropic-ai/claude-agent-sdk` 0.3.309 (`bridges/claude-bridge/package.json:16`) and `CLAUDE_CLI_VERSION=2.1.309` (`docker/Dockerfile:193`), so the CLI rules recorded below still apply. `mise run test:agent:docker` exists but its Docker fixture does not install plugins, so it does not cover this on its own.

**Decisions.**

- **How to run it?**
  - **Batch with 0040's container session run on one fresh dev image (recommended).** Build with `mise run docker:build:dev`, run `claude-plugin-mcp-container.test.ts` with `CLAUDE_PLUGIN_MCP_DOCKER_IMAGE` set to that image, then in an isolated `dev:test` profile with `--fixture-environments local,container` create a container environment whose staged home has one enabled and one host-disabled install, start one short Claude session, and check the editor row, live row and join.
    - Pros: one image build and one credentialed profile serve both files, as both already ask; proves staging, merge, bridge filter and editor together.
    - Cons: blocks this low-rated file on 0040's larger run; needs Claude credentials and Docker time.
  - **Run it alone now.** Same steps, without waiting for 0040.
    - Pros: closes this file sooner; smaller scope per run.
    - Cons: a second image build and credentialed session for the same machinery; 0040 would repeat most of it.
  - **Retire the item, accepting the piecewise evidence from 0151.**
    - Pros: no further cost; each component is already proven in a real image.
    - Cons: never proves the pieces compose in an Orkestrator-created container, which is the case users hit.
- **What counts as a pass?**
  - **Editor rows equal the session's live plugin servers, every live row joins its editor row, and the host-disabled install is absent from the session and shown disabled with its reason (recommended).**
    - Pros: the same pass criteria as the local live test, so results are comparable.
    - Cons: requires reading the live panel inside a container session, not just a reader test.
  - **Only the real-reader test passes on the fresh image.**
    - Pros: credential-free and repeatable.
    - Cons: does not load a session, so the bridge filter and the live join stay unproven in a container.
- **Should the container test's default image change?**
  - **Leave the default but always pass `CLAUDE_PLUGIN_MCP_DOCKER_IMAGE` in the run notes (recommended).**
    - Pros: no code change in a research item; the env var already exists.
    - Cons: a future runner who omits it tests a stale `orkestrator-v2:latest` without a warning.
  - **Make the test require the image variable (or fail when `latest` predates the code under test).**
    - Pros: removes the stale-image trap.
    - Cons: a code change outside this todo's remaining scope; needs its own small change.

### 2. Narrow-viewport check

**Problem.** The real-app pass did not exercise the 390×844 layout: the fullscreen settings layer closed when the viewport switched to the mobile layout, and the script could not reach the settings entry from the mobile menu.

**Context.** The change added no layout, and `McpStatusAndStates.test.tsx` covers the rendering. The AGENTS.md change-type table asks for a narrow viewport only for layout-affecting changes.

**Investigation.** Nothing in this todo's code changed layout since the pass. The "settings layer closes on viewport switch" behaviour is a property of the settings shell, not of plugin rows, and is not tracked as a defect in this file.

**Decisions.**

- **Run the narrow-viewport check?**
  - **Drop it from this file, noting that the change is not layout-affecting (recommended).**
    - Pros: matches the documented verification rule; no extra profile run.
    - Cons: the mobile reachability of MCP settings remains unverified (but it is not this file's concern).
  - **Run it with the container session in task 1, opening settings fresh at 390×844 rather than resizing.**
    - Pros: cheap when a profile is already up; would show whether the mobile menu reaches settings.
    - Cons: scope creep; any finding belongs in a new todo, not here.

### 3. Stale decision text and file retirement

**Problem.** The "Which enablement rule to mirror" row in "Assumptions and decisions" still says, as a con, that turning a plugin off in Claude Code does not show it off here and points to 0151 as "the bridge gap". Since `35081a81` that is no longer true for installs. Separately, once task 1 is done the file is finished and should be retired.

**Context.** The README allows correcting an existing item. The durable behaviour is already in `docs/architecture/mcp-management.md:178-200` ("Claude plugins"). [0151](0151-claude-bridge-plugin-settings.md) is finished and also due for retirement, and this file links to it twice.

**Investigation.** The "Answers" section of this file (line beginning "`<name>@<marketplace>` entries never apply") was already updated for 0151; only the decision-table con was not. `mcp-management.md` cites this todo by number in its "Claude plugins" section and evidence table, so retiring the file needs those references reworded too.

**Decisions.**

- **When to fix the stale con and retire the file?**
  - **Correct the con now; retire the file (and repoint links from 0151's replacement text) as part of the change that records task 1 (recommended).**
    - Pros: readers stop seeing a fixed gap described as current; retirement happens in one change with the final evidence.
    - Cons: two small docs edits instead of one.
  - **Leave everything until task 1 is done.**
    - Pros: one edit.
    - Cons: the stale con misleads anyone reading the decisions in the meantime.

Split from item 7 of [0039-mcp-management.md](0039-mcp-management.md) on
2026-10-25 (`ba7cc8d4`). The MCP editor
([`mcp-management.md`](../../architecture/mcp-management.md)) shows the files
each provider reads, but not the servers Claude Code plugins add. Of the
layers item 7 listed, only Claude plugins have a passive reader, so only they
can be modelled; the others (Cursor plugins and team settings, OpenCode
remote and organisation configuration, Codex profiles) stay unmodelled for the
reasons recorded there.

Code items and the qualification were done on branch
`todo-0121-claude-plugin-mcp-82b345b9f0c5` (base `20f6de91`, 2026-10-25). What
is left is one container run.

## Current state

- **Shared plugin set** (`packages/protocol/src/node/claude-plugin-set.ts`).
  The bridge's merge (`plugins` in `~/.claude.json` < `installed_plugins.json`
  remapped onto the local plugins folder, or the folder scan < project entry
  in `~/.claude.json` < `<cwd>/.claude/plugins.json`, de-duplicated by
  resolved path, project layers only with project resources) moved here.
  `bridges/claude-bridge/src/services/plugin-config.ts` and the editor both
  call it, each with its own bounded reads. The module also holds the pinned
  CLI's rules: plugin names, `plugin:<plugin>:<server>`, `enabledPlugins` for
  `<name>@inline`, the installed-copy rule and the MCP declaration order.
- **Plugin sources** (`apps/backend/src/core/mcp-management/claude-plugins.ts`,
  called from the Claude case of `providerSources`). Every plugin the bridge
  passes that declares servers gets one read-only source (scope and owner
  `plugin`, "Managed by Claude Code's plugin settings.") per place it declares
  them: `.mcp.json`, then the manifest's inline `mcpServers` or a file it
  names inside the plugin. Entries are named as the CLI names them through
  `SourceSpec.entryNamePrefix`. A disabled plugin's rows are `disabled` with
  the setting that disables it (`SourceSpec.disabledReason`); notes cover a
  marketplace id that does not apply, an installed copy that still loads,
  local settings, the backend-user target, unmodelled declarations, duplicate
  names and the 64-source bound. Container targets read the container's own
  plugins through the container reader. Plugin rows sort after file rows when
  a snapshot is trimmed, and after file sources in the list.
- **Live join** (`mcp-live-join.ts`, `McpLiveJoinNotice.tsx`,
  `ProviderMcpSettings.tsx`). A live plugin row joins its plugin row by exact
  name and highlights it. The Claude bridge now labels plugin servers with the
  `plugin` layer from `mcpServerStatus()`'s `source`
  (`mcp-runtime-status.ts`): the pinned CLI reports their `scope` as
  `dynamic`, which the bridge used to show as `user`, so the join could never
  find them.
- Plugin server names are namespaced, so they never shadow or are shadowed by
  a file entry.

## Outstanding work

### Code

1. ~~**Read-only plugin source.**~~ Done 2026-10-25. One read-only source per
   place a loaded plugin declares servers, for the backend-user, local
   environment and container targets, named `plugin:<plugin>:<server>`, with
   the reason "Managed by Claude Code's plugin settings.". The set is the
   bridge's own: both build it with `mergeClaudePluginLayers`, and
   `claude-plugin-mcp-parity.test.ts` runs the bridge's `getPluginsForSdk` and
   the catalogue over the same files (installed plugins with host paths and a
   traversal entry, the folder scan, an unreadable `installed_plugins.json`,
   every layer with `~` and relative paths and missing folders, malformed
   lists; project resources on and off; 10 cases). Evidence:
   `service-claude-plugins.test.ts` (16 cases), `claude-plugin-set.test.ts`
   (9 cases).
2. ~~**Enablement.**~~ Done 2026-10-25. A plugin the CLI will not load is
   shown disabled with the setting that disables it, mirroring the pinned CLI
   (rules in [Answers](#answers-to-the-open-question-and-rules-read-from-the-cli)).
   The parity requirement is met twice: against the bridge's plugin set (item
   1's parity test) and against the pinned CLI itself, which is what decides
   enablement (`apps/backend/tests/claude-plugin-mcp-live.test.ts`, below).
3. ~~**Variable expansion.**~~ Done 2026-10-25. Values are shown as written:
   `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in commands and
   arguments are visible verbatim, and in env and header values they are
   references, never resolved (`service-claude-plugins.test.ts`, "environment
   references are shown as written"; the live test reads the same row back).

### Qualification

- ~~Install a fixture plugin with one stdio server in a disposable profile
  and confirm the editor's row, the live row and the join agree, including a
  plugin disabled in project settings.~~ Done 2026-10-25, twice:
  - **Pinned CLI, credential-free** (`mise run verify:claude:plugin-mcp-live`,
    `apps/backend/tests/claude-plugin-mcp-live.test.ts`, 1 pass, 43 expects,
    1.6–3.6 s). Eight fixture plugins with one stdio server each in a
    disposable home and project; the bridge's own probe
    (`plugin-mcp.live-probe.ts`) starts CLI 2.1.309 with the bridge's plugin
    set three times (user + project, + local, user only) and reads
    `mcpServerStatus()`. In every run the editor's in-use plugin rows equal
    the live servers, and every live row joins (the settings page's own
    `joinLiveMcpServer`, the bridge's own scope mapping) to the editor's
    winning row. Covered: a plugin turned off in project settings, a
    marketplace id that does not turn the bridge's copy off, a case-folded
    `@inline` key, `defaultEnabled: false`, local settings, the manifest
    replacing `.mcp.json`, the global and project plugin lists, and
    `${CLAUDE_PLUGIN_ROOT}` shown as written.
  - **Real app, real session** (`dev:test` profile `agent-claude-plugin-mcp`,
    Claude credentials only, Playwright at 1440×900 against the browser URL;
    scripts and captures in `output/agent-testing/plugin-mcp-qa/`, not
    committed). Two fixture plugins installed in the profile's isolated home,
    `offfix@inline: false` and `docsfix@market: false` in the profile's
    `$CLAUDE_CONFIG_DIR/settings.json`. A one-word Claude session loaded only
    `docsfix`; the agent panel's "Saved configuration" link opened the editor
    with "The session's plugin:docsfix:search is the highlighted row in
    Plugin docsfix." and exactly that row `aria-current`; `offfix` was
    disabled naming the settings file, `docsfix` carried the marketplace-id
    note. With the environment's project resources turned on and
    `{"docsfix@inline": false, "offfix@inline": true}` in the worktree's
    `.claude/settings.json`, a new session loaded only `offfix`, the link
    highlighted `plugin:offfix:search`, and `docsfix` showed "Disabled:
    enabledPlugins["docsfix@inline"] is false in
    `<worktree>`/.claude/settings.json.". A fresh visit to the settings page
    re-read the same rows; no horizontal overflow. The pass found and fixed
    the `CLAUDE_CONFIG_DIR` settings path and a disabled row's Enable reason.
    Not exercised: the 390×844 layout (the fullscreen settings layer closes
    when the viewport switches to the mobile layout, and the mobile menu did
    not expose the settings entry to the script); the change adds no layout,
    and `McpStatusAndStates.test.tsx` covers the rendering.
- **Container run.** Not done: a container environment whose home holds a
  plugin, read through the real container reader and loaded by a container
  session. The container path is covered only with the fake reader
  (`service-claude-plugins.test.ts`, "a container lists the plugins in its own
  home"). It needs the workspace's development image built and a container
  session, which this run did not do; batch it with the container session run
  in [0040](0040-mcp-environment-delivery.md). Since
  [0151](0151-claude-bridge-plugin-settings.md) (2026-10-26) the same run
  should also turn one install off on the host (`claude plugin disable`),
  rebuild, and confirm the container session does not load it and its row
  says why; the pieces were each proven in an existing image (0151,
  "Qualification"), and the real container reader part passes with
  `RUN_LIVE_CLAUDE_PLUGIN_MCP_DOCKER=1`.

## Answers to the open question and rules read from the CLI

Read from the pinned CLI binary (Agent SDK 0.3.309, `claudeCodeVersion`
2.1.309) on 2026-10-25 and proven by the live test above.

- **Does the CLI read inline `mcpServers` from `plugin.json`, and in which
  order?** Yes. It reads the plugin's `.mcp.json` (`{"mcpServers": …}` or a
  bare map) first, then the manifest's `mcpServers`, which may be an inline
  map, a path to a JSON file, an MCPB bundle, or a list of those; a later
  same-name server replaces an earlier one, so the manifest wins.
- Every plugin the bridge passes in the SDK's `plugins` option is a
  `--plugin-dir` plugin with id `<name>@inline`, its name from `plugin.json`
  or the folder. The CLI refuses names containing `@`, `:`, whitespace, a
  path separator or an invisible character.
- It skips the plugin when the first loaded settings layer (local, project,
  user; managed policy first, not modelled) whose `enabledPlugins` names
  `<name>@inline`, compared without case, sets it to `false`; any other value
  enables it. With no entry, `defaultEnabled: false` in the manifest skips it.
- `<name>@<marketplace>` entries never apply to the `@inline` copy. Since
  [0151](0151-claude-bridge-plugin-settings.md) (2026-10-26) the bridge passes
  an install only when that id is `true` in the first loaded layer naming it,
  so disabling a plugin through Claude Code's own plugin settings does stop
  Orkestrator's sessions loading it. When the `@inline` copy is off, an
  installed copy whose exact id is `true` still loads when the CLI can resolve
  its marketplace (proven live in the first case of
  `claude-plugin-mcp-live.test.ts`).
- Servers are named `plugin:<plugin>:<server>` and report `scope: "dynamic"`,
  `source: "plugin"`.
- User settings come from `$CLAUDE_CONFIG_DIR/settings.json` when set.

## Assumptions and decisions

| Decision | Options | Choice | Why | Pros | Cons |
| --- | --- | --- | --- | --- | --- |
| How the editor uses "the bridge's own plugin set" | (a) backend imports the bridge module; (b) re-implement in the backend with a parity test; (c) move the merge into `@orkestrator/protocol/node` and call it from both | (c), plus a parity test over the real `getPluginsForSdk` | Production backend code never imports a bridge; a shared pure function cannot drift, and the parity test also pins the two sides' reads | One merge, two bounded readers; the bridge keeps its stat-validated cache | The bridge's malformed-input handling changed slightly (non-list `plugins` and bad entries are skipped instead of throwing), and project-off sessions now resolve `~` and de-duplicate like project-on ones |
| Which enablement rule to mirror | (a) the marketplace id users toggle in Claude Code; (b) the CLI's actual rule for the copy the bridge passes (`<name>@inline`) | (b) | It is what decides whether a session loads the plugin; the live test proves it | Rows match what runs | Surprising: turning a plugin off in Claude Code does not show it off here. The source says so and names the `@inline` key; the bridge gap is [0151](0151-claude-bridge-plugin-settings.md) |
| Proving the rule | (a) unit tests only; (b) a credential-free probe of the pinned CLI; (c) a real-app session | (b) as an opt-in `mise` task, and (c) once by hand | (b) is repeatable on every SDK upgrade (added to `upgrade-agents.md`); (c) proves the UI and the link | Real behaviour, no tokens for (b) | (b) is opt-in (`RUN_LIVE_CLAUDE_PLUGIN_MCP=1`), so drift is caught at upgrade time, not by CI |
| Local settings | (a) always include; (b) never; (c) default state plus a note | (c) | Sessions read local settings only with "Include local settings", a per-session toggle | The row matches the default session | A session with the toggle on can differ; the note says how |
| Settings layers not modelled | managed policy, flag settings, per-account `CLAUDE_CONFIG_DIR` | Not modelled; managed policy named in the docs | Several sources (MDM, server-managed, drop-ins) and per-session account homes the backend cannot see | No guessed state | A managed policy can turn a plugin off without the row saying so |
| Duplicate-server suppression | (a) model it; (b) leave it | (b), documented | The CLI compares expanded commands and URLs; item 3 forbids expanding values | Item 3 holds | A plugin server that duplicates a manual server shows in use but does not run |
| Unusual declarations | MCPB bundles, inline maps inside an `mcpServers` list, files outside the plugin | Named in the source note, not listed | Bundles are resolved only at load; files outside the plugin are not the plugin's to show | No reads outside the plugin folder | Those servers have no row |
| Bounds | per-plugin and per-snapshot limits | 1 MiB per plugin file, 8 sources per plugin, 64 plugin sources per snapshot, counted in a note | Matches the todo's constraint and keeps snapshots under budget | Large plugin sets stay cheap | Very large sets are incomplete, and say so |
| Ordering | (a) plugins interleaved by precedence with files; (b) after files, in the bridge's order | (b) | Plugin names never collide with file names | Editable rows first; trimming drops plugin rows first | Precedence numbers above the files' do not mean "wins over files" |
| The live panel's plugin layer | (a) leave the bridge's `scope` mapping; (b) prefer `source` | (b) | The pinned CLI reports plugin servers as `scope: "dynamic"`, `source: "plugin"` | The join works for real sessions | None found |

## Constraints and rationale

- Read-only: plugin files belong to the plugin and are replaced on update.
- No path from a client: sources stay opaque ids (`claude:plugin-<hash>`),
  like every other source.
- Plugins can be large; reads are bounded like other sources (1 MiB).

## Related

- [0039-mcp-management.md](0039-mcp-management.md), item 7.
- [0151-claude-bridge-plugin-settings.md](0151-claude-bridge-plugin-settings.md):
  the bridge passed plugins Claude Code's own settings turned off (fixed
  2026-10-26).
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Claude
  plugins").

## Replaces

- Item 7 of [0039-mcp-management.md](0039-mcp-management.md), for Claude
  plugins only.
