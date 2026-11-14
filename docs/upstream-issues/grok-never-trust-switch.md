# Grok: a per-process "never trust" switch for the folder-trust gate

**Tracker:** xAI, Grok Build CLI. The feedback channel or issue tracker is not recorded in this repository (the product documentation is <https://docs.x.ai/build>); confirm it before filing.
**Status:** draft
**Source:** [0001](../todo/agent-engines/0001-agent-interactions-and-permissions.md) task 1 and its code item 12 (evidence) and decision 14; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item
**Filed:** —

## Issue text

**Title:** Feature request: a per-process switch that keeps the folder-trust gate closed (never trust)

**Summary.** An application that launches Grok as an ACP agent cannot stop Grok from loading a checkout's project resources (AGENTS.md, skills, commands, hooks and MCP servers) once the user has trusted that repository in Grok. Grok has switches that open the trust gate for one process (`GROK_FOLDER_TRUST=0`, `--trust`, `[folder_trust] enabled = false`) but none that closes it. A `git worktree` of a trusted repository also inherits the trust with no grant of its own.

**Use case.** We run Grok per session under an execution policy. When the policy says "project resources off", we need Grok to treat the checkout as untrusted for that process only, without rewriting the user's `~/.grok/trusted_folders.toml` or replacing their `GROK_HOME` (which would drop their own config, skills, MCP servers and the session store `session/load` reads).

**Reproduction** (observed on Grok 1.0.67 with an isolated `GROK_HOME` and a loopback model; no model turn is needed):

1. `git init repo && cd repo && git commit --allow-empty -m init`
2. Trust it: run Grok once in `repo` with `--trust`.
3. `git worktree add ../wt`
4. Start `grok agent` (ACP) in `../wt`, send `initialize` and `session/new`, then `_x.ai/hooks/list`.
5. `projectTrusted` is `true` for the worktree; a never-granted repository reports `false`.

Things tried on the worktree that did not make it report `false`:

- `GROK_FOLDER_TRUST=1` in the environment;
- `_meta {"x.ai/folderTrust": …}` on `session/new` with `false`, `true`, `"untrusted"`, `{trusted:false}` and `{enabled:true, trusted:false}`, and `false`/`true` on `initialize`;
- a `trusted = false` entry for the worktree in `trusted_folders.toml`.

`strings` of the binary shows `GROK_FOLDER_TRUST` as the only `GROK_*` trust variable. The `GROK_CONFIG` overlay is documented as unable to "elevate trust" and covers only models, features, toolset and part of the shell policy. Untrusting (`/hooks-untrust`, `x.ai/hooks/action`) rewrites the user's own trust store.

**Expected.** A per-process way to force the gate closed, for example `GROK_FOLDER_TRUST=never` (or a separate variable), or a `session/new` meta key such as `_meta {"x.ai/folderTrust": "never"}`, under which `_x.ai/hooks/list` reports `projectTrusted: false` and no project-scoped resource is loaded, whatever the trust store says. User-scope resources stay loaded.

**Actual.** Trust comes only from the trust store, so a host that wants project resources off for one session cannot have it once the user trusted the repository (or its main checkout) in Grok.

**Versions.** Evidence from Grok 1.0.67 (2026-10-25) and a binary search on 1.0.52 (2026-10-22). The pin is now 1.0.77 (`packages/toolchain/src/manifest.ts`); see Before filing.

**Impact.** A host that offers a "project resources off" policy has to report it as on for Grok, and the checkout's hooks and MCP servers run in sessions where the user chose not to allow them. A small per-process switch would fix it.

## Existing-report search

None known; nothing in the sources says one was searched. Search terms: `folder trust`, `GROK_FOLDER_TRUST`, `trusted_folders`, `never trust`, `untrusted worktree`, `projectTrusted`, `git worktree trust`.

## Before filing

- [ ] Confirm where xAI takes Grok CLI feature requests.
- [ ] Re-run the reproduction on the current pin (1.0.77) or the newest release with `_x.ai/hooks/list`; update the version line, and drop the request if a "never trust" switch now exists.
- [ ] Re-check `strings` of the binary for new `GROK_*` trust variables.
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and link the request in [0001](../todo/agent-engines/0001-agent-interactions-and-permissions.md) task 1 (and code item 12).
