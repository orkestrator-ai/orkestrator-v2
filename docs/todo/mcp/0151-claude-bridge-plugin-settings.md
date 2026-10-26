# Claude bridge loads plugins Claude Code's settings turned off

Found on 2026-10-25 while qualifying
[0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md) against
the pinned Claude CLI (2.1.309). Orkestrator's Claude sessions load plugins,
and their MCP servers, hooks, skills, commands and agents, that the user
turned off in Claude Code.

**Finished 2026-10-26.** Every item below is done. Kept until the branch
merges for its decisions, then deleted; the durable behaviour is in
[`mcp-management.md`](../../architecture/mcp-management.md) ("Claude
plugins") and [`container-lifecycle.md`](../../architecture/container-lifecycle.md)
(staged Claude inputs).

## Current state

- Before this change the Claude bridge passed every plugin directory it found
  to the SDK's `plugins` option (`getPluginsForSdk` in
  `bridges/claude-bridge/src/services/plugin-config.ts`), including every
  install recorded in `~/.claude/plugins/installed_plugins.json`, whether or
  not Claude Code had it enabled. The CLI treats each as a `--plugin-dir`
  plugin with id `<name>@inline`, where the `<name>@<marketplace>` key that
  `/plugin` and `claude plugin disable` write never applies, so a plugin
  turned off in Claude Code still ran in every Orkestrator Claude session.
- Now the bridge passes an install only when the first settings layer the
  session loads (local, then project, then user) whose `enabledPlugins` names
  its exact `<name>@<marketplace>` id sets it to `true`, the CLI's own rule for
  its installs (`claudeInstalledPluginIdEnablement` and
  `enabledInstalledPlugins` in
  `packages/protocol/src/node/claude-plugin-set.ts`). The layers are the
  session's `settingSources`; a follow-up that leaves local settings unsaid and
  joins the running CLI uses that CLI's layers (`claudeTurnSettingSources` in
  `session-manager-runtime.ts`). `~/.claude.json` and project plugin lists,
  and the plugins-folder scan, are unchanged.
- The MCP editor (`apps/backend/src/core/mcp-management/claude-plugins.ts`)
  still lists an install the bridge leaves out, disabled, with
  `Disabled: enabledPlugins["<id>"] is false in <file>, so Orkestrator does not
  pass this installed plugin to Claude Code.` (or that no loaded layer sets it
  to `true`), and notes when "Include local settings" would change that.
- Containers: the entrypoint writes the container's own
  `~/.claude/settings.json`, which never held the host's `enabledPlugins`. The
  backend now stages the host's user `settings.json` filtered to its boolean
  `enabledPlugins` (`claudeContainerPluginSettings`, `filteredFiles` in
  `portable-inputs.ts`), and `docker/entrypoint.sh` merges it in, so the same
  rule holds there.

## Outstanding work

### Code

1. ~~Decide whether the bridge should honour Claude Code's own enablement for
   installed plugins: pass an `installed_plugins.json` install only when the
   first loaded settings layer whose `enabledPlugins` names its exact id sets
   it to `true` (the CLI's rule for its own installed copies), or stop passing
   installed plugins and let the CLI load its own installed copies from the
   same settings. Keep `~/.claude.json` and project plugin lists as they are.
   Update `claude-plugin-set.ts`, the editor's notes, the parity test and the
   live test together.~~ Done 2026-10-26: the first option (see decisions).
   Evidence: `claude-plugin-set.test.ts` (the rule, layers, coordinator,
   container filter), `plugin-config.test.ts` (the bridge with host-recorded
   paths, every layer, an edit reaching the next turn, `CLAUDE_CONFIG_DIR`),
   `session-manager-runtime.test.ts` and `session-manager-prompt.test.ts` (the
   turn's settings sources reach `getPluginsForSdk`, including the inherited
   local layer), `service-claude-plugins.test.ts` (disabled rows, reasons,
   local-settings notes, container), `claude-plugin-mcp-parity.test.ts` (the
   bridge's set equals the editor's passed set, with a dedicated fixture), and
   `portable-inputs.test.ts` (staged file holds only `enabledPlugins`, byte
   accounting, the entrypoint block merges it and refuses a symlink or broken
   file).

### Qualification

- ~~Rerun `mise run verify:claude:plugin-mcp-live` with a fixture whose
  marketplace id is turned off and confirm the session no longer loads it, and
  that the editor's row says so.~~ Done 2026-10-26 on the pinned CLI 2.1.309,
  credential-free in disposable homes: 2 pass, 64 expects. The first case now
  ends with `installed@fixture-market: false` alone (what
  `claude plugin disable` writes): the bridge passes no plugin, the CLI loads
  no server, and the row reads `Disabled: enabledPlugins["installed@fixture-market"]
  is false in ~/.claude/settings.json, so Orkestrator does not pass this
  installed plugin to Claude Code.` The second case covers a turned-off install
  (`gamma`), one turned off in project settings (`iota`), one never enabled
  (`lambda`) and one turned off only in local settings (`kappa`), with editor
  rows, live rows and the join equal. With the filter removed the same run
  fails: the CLI loads `plugin:gamma:one`, `plugin:iota:one` and
  `plugin:lambda:one`.
- Container checks, 2026-10-26, on the existing development image
  `orkestrator-v2:dev-0c3cd9a3dec9` (Claude CLI 2.1.309, aarch64), no
  credentials, `--network none`:
  - `RUN_LIVE_CLAUDE_PLUGIN_MCP_DOCKER=1` with that image: 3 pass. The real
    container reader shows an enabled install in use and the same install,
    turned off by its marketplace id, disabled with the reason above.
  - The entrypoint's merge block, run in the image's `bash` and `jq` 1.7,
    produced `{"permissions":…,"enabledPlugins":{"docs@market":true,"off@market":false}}`
    from a staged file that also held a non-boolean value.
  - This branch's bridge probe, bundled and run in that image with its own
    CLI, against a home whose installs record another machine's paths and
    whose settings came from this branch's staging filter and the entrypoint
    block (`on@market: true`, `off@market: false`): the bridge passed only the
    remapped `on` folder and the CLI connected only `plugin:on:one`. With both
    ids `true`, both were passed and connected.
  - Not run: a container created from an image built from this branch, with a
    real Claude session. That belongs to the open "Container run" in
    [0121](0121-claude-plugin-mcp-servers.md), which now also checks that a
    host-turned-off install stays off.

## Constraints and rationale

- Containers copy `~/.claude/plugins` but, it turned out, not the user
  settings: the entrypoint writes its own `settings.json`. Only the boolean
  `enabledPlugins` of the host's file is staged and merged, never its hooks,
  permissions or environment. The host's later toggles reach a container when
  it is next created (a rebuild), like every other staged input.
- Changing which plugins load changes users' sessions (hooks and commands as
  well as MCP servers). Release note, carried in the commit and for the PR:
  "Claude sessions now honour Claude Code's own plugin settings. A plugin you
  installed and then turned off in Claude Code (`/plugin`, `claude plugin
  disable`) no longer loads in Orkestrator's Claude sessions, including its
  MCP servers, hooks, skills, commands and agents. An installed plugin that no
  settings file turns on, and every installed plugin in a coordinator session,
  is no longer loaded either. Plugins listed in `~/.claude.json` or a project's
  `.claude/plugins.json` are unchanged. Containers pick this up when they are
  rebuilt."

## Open questions

- ~~Does the CLI load its own installed copies when the bridge stops passing
  them, with the paths it recorded on another machine (containers remap them
  today)?~~ Answered 2026-10-26 on the pinned CLI 2.1.309 in disposable homes
  (`claude plugin marketplace add` of a local directory, `claude plugin
  install`, then a home moved elsewhere): with the recorded install paths and
  the marketplace source both gone, as in a container's copied home, the CLI
  loaded no install of its own, while the bridge's remapped copy loaded. With
  the marketplace source present and the install path gone it did load its own
  copy; with the install path present and the marketplace source gone it did
  not, even with the `@inline` copy passed and turned off. So the CLI's own
  copy depends on resolving the marketplace, which a container cannot rely on;
  this decided the approach below. `claude plugin install` wrote
  `enabledPlugins["gamma@mk"]: true` to user settings and `claude plugin
  disable` wrote `false`.

## Assumptions and decisions

| Decision | Options | Choice | Why | Pros | Cons |
| --- | --- | --- | --- | --- | --- |
| How to honour Claude Code's enablement | (a) keep passing installs, only those whose `<name>@<marketplace>` id is enabled by the CLI's rule; (b) stop passing installs and let the CLI load its own copies | (a) | The open question's experiments: the CLI's own copy needs a resolvable marketplace, which a container's copied home does not have, so (b) would drop every install in containers; (a) keeps the remapped path that works there | Same rule as Claude Code; containers keep working; `~/.claude.json` and project lists untouched | Installs still join as `<name>@inline`, so `@inline` keys still apply to them on top of the marketplace id |
| Which settings layers decide | (a) the session's own `settingSources`; (b) always user and project | (a), with a joining turn that leaves local settings unsaid using the running CLI's layers | The CLI reads exactly those layers; a mail delivery or Control MCP prompt joining a CLI launched with local settings must not see a different plugin set and be refused or relaunched | Bridge and CLI agree for every session kind | A turn that inherits local settings but then has to launch a new CLI for another reason computes its plugin set with the old CLI's layers (rare; noted in `claudeTurnSettingSources`) |
| Coordinators | (a) apply the rule to their empty `settingSources`, so no install is passed; (b) keep passing every install | (a) | A coordinator loads no settings, so Claude Code would enable no install for it, and its boundary exists to exclude user hooks and MCP servers, which plugins carry | Narrower coordinator boundary, consistent rule | A coordinator no longer gets installed plugins' skills or agents (in the release note) |
| Plugins-folder scan (no `installed_plugins.json`) | (a) keep passing; (b) drop | (a) | Those folders have no install id, so no marketplace key can name them; the todo kept the other non-install layers too | No change for that legacy layout | Only `@inline` keys turn them off |
| Where the bridge reads user settings | `$CLAUDE_CONFIG_DIR/settings.json` else `~/.claude/settings.json`, from the bridge's environment | As the CLI does | The CLI inherits the bridge's environment; account homes link `settings.json` back to the host's | Same file as the CLI | A test home ignores `CLAUDE_CONFIG_DIR` so suites never read the developer's settings |
| The editor's rows for left-out installs | (a) list them disabled with the reason; (b) omit them | (a) | The qualification item asks that the row say so; users look there for why a plugin is missing | Clear reason, names the setting and file | The editor lists more plugins than the bridge passes; the parity test compares only the passed ones |
| Containers had no host `enabledPlugins` | (a) stage the host's `settings.json` filtered to boolean `enabledPlugins` and merge it in the entrypoint; (b) stage the whole file; (c) leave containers passing every install | (a) | (b) would copy hooks, permissions and environment secrets across the container boundary; (c) breaks the constraint that the same rule holds there | Same rule in containers, nothing else of the host file staged, bounded to 1000 ids | Toggles reach a container only when it is rebuilt; old images ignore the staged file and keep their old bridge (which passes every install), so a new backend's editor can show their installs off until the environment is rebuilt |
| Editor's "Claude Code still loads its own installed copy" note | (a) keep; (b) model marketplace resolvability | (a), documented | It is right on a host with the marketplace present (proven live); modelling marketplace sources (directory, git, remote) is a separate piece of work | No new guesses | In a container or with a vanished marketplace, an install whose `@inline` copy is off can show in use while nothing loads |
| Release notes | No release-notes file exists in the repo | The note above, in the commit message and the coordinator mail for the PR body | The todo asks that the release notes say so | Reaches whoever writes the release | Depends on the PR description being carried into the release |
| Skills settings page | (a) fix here; (b) new todo | (b), [0205](../agent-engines/0205-claude-skills-list-turned-off-plugins.md) | It is a display list outside this file's scope and needs a UI caveat about project settings | Keeps this change to what sessions load | The page lists skills of turned-off plugins until 0205 |

## Related

- [0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md).
- [0205-claude-skills-list-turned-off-plugins.md](../agent-engines/0205-claude-skills-list-turned-off-plugins.md).
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Claude
  plugins").

## Replaces

- Nothing.
