# Grok: a per-process "never trust" switch for the folder-trust gate

**Tracker:** xAI, Grok Build CLI, through the in-CLI `/feedback` command. xAI's launch post says "Type `/feedback` in Grok Build to send bugs, requests, and reactions straight to the team" (<https://x.ai/news/grok-build-cli>), and the command reference lists `/feedback [text]` as "Send feedback about the current session" (<https://docs.x.ai/build/modes-and-commands.md>). There is no public issue tracker: the source repository <https://github.com/xai-org/grok-build> has issues and discussions turned off and its `CONTRIBUTING.md` accepts no external pull requests; security reports go to HackerOne (`SECURITY.md`). Checked 2026-11-15.
**Status:** ready to file
**Source:** [0001](../todo/agent-engines/0001-agent-interactions-and-permissions.md) task 1 and its code item 12 (evidence) and decision 14; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item
**Filed:** —

## Issue text

**Title:** Feature request: a per-process switch that keeps the folder-trust gate closed (never trust)

**Summary.** An application that launches Grok as an ACP agent cannot stop Grok from loading a checkout's project resources (AGENTS.md, skills, commands, hooks and MCP servers) once the user has trusted that repository in Grok. Grok has switches that open the trust gate for one process (`GROK_FOLDER_TRUST=0`, `--trust`, `[folder_trust] enabled = false`) but none that closes it. A `git worktree` of a trusted repository also inherits the trust with no grant of its own.

**Use case.** We run Grok per session under an execution policy. When the policy says "project resources off", we need Grok to treat the checkout as untrusted for that process only, without rewriting the user's `~/.grok/trusted_folders.toml` or replacing their `GROK_HOME` (which would drop their own config, skills, MCP servers and the session store `session/load` reads).

**Reproduction** (Grok 1.0.77, macOS arm64, an empty `GROK_HOME` and `HOME`; no model turn is sent). The repository needs a project config, here a project hook: a repository with none counts as trusted anyway, because there is nothing to gate.

1. Make `repo` with an `AGENTS.md` and `.grok/hooks/start.json` holding a `SessionStart` command hook (`echo ran >> .hook-ran`), and commit both.
2. Trust it once: `grok --trust inspect --json` in `repo` (writes `trusted = true` for `repo` to `trusted_folders.toml`).
3. `git worktree add ../wt -b wt`
4. In `../wt`, run `grok --always-approve agent --no-leader stdio` and send `initialize`, `session/new` and `_x.ai/hooks/list`.
5. The worktree reports `"projectTrusted": true` and lists `project/start:session_start[0].hooks[0]`, and the project `SessionStart` hook runs (`.hook-ran` appears in `wt`). `grok inspect --json` in `wt` also reports `projectTrusted: true` and lists `AGENTS.md` under `projectInstructions`. A never-granted repository with the same files reports `projectTrusted: false`, lists no hooks and does not run the hook.

Things tried on the worktree on 1.0.77. Every one still reported `projectTrusted: true`, listed the project hook and ran it:

- `GROK_FOLDER_TRUST=1`, `=true` and `=never` in the environment (`GROK_FOLDER_TRUST=0` does open the gate on the never-granted repository, so the variable is read);
- `_meta {"x.ai/folderTrust": …}` on `session/new` with `false`, `"never"`, `"untrusted"`, `{trusted:false}`, `{enabled:true, trusted:false}` and `{mode:"never"}`;
- `_meta {"x.ai/folderTrust": …}` on `initialize` with `false`, `"never"`, `{interactive:true}` and `{interactive:false}` (`interactive` only lets Grok ask the client about an untrusted folder through `x.ai/folder_trust/request`);
- a `trusted = false` entry for the worktree in `trusted_folders.toml`.

`strings` of the 1.0.77 binary, and of 1.0.87 (the newest build we found), shows `GROK_FOLDER_TRUST` as the only `GROK_*` trust variable. In the published source, `decide()` (`xai-grok-permission-rules/src/folder_trust.rs`) returns trusted when the feature is off or the store holds a grant, before any other rule, so nothing can close the gate on a granted folder. The `GROK_CONFIG` overlay is documented as unable to "elevate trust" and covers only models, features, toolset and part of the shell policy. Untrusting (`/hooks-untrust`, `x.ai/hooks/action`) rewrites the user's own trust store.

**Expected.** A per-process way to force the gate closed, for example `GROK_FOLDER_TRUST=never` (or a separate variable), or a `session/new` meta key such as `_meta {"x.ai/folderTrust": "never"}`, under which `_x.ai/hooks/list` reports `projectTrusted: false` and no project-scoped resource is loaded, whatever the trust store says. User-scope resources stay loaded.

**Actual.** Trust comes only from the trust store, so a host that wants project resources off for one session cannot have it once the user trusted the repository (or its main checkout) in Grok.

**Versions.** Reproduced on Grok 1.0.77 (2026-11-15; the current pin in `packages/toolchain/src/manifest.ts`, and the build the download bucket's `stable` pointer names). 1.0.87 (built 2026-11-14) was checked with `strings` only, not run. Earlier evidence: 1.0.67 (2026-10-25) and a binary search on 1.0.52 (2026-10-22).

**Impact.** A host that offers a "project resources off" policy has to report it as on for Grok, and the checkout's hooks and MCP servers run in sessions where the user chose not to allow them. A small per-process switch would fix it.

## Existing-report search

Searched 2026-11-15. xAI keeps no public tracker (GitHub issues and discussions are off on `xai-org/grok-build`), so `/feedback` submissions cannot be searched.

- `gh search issues` across GitHub with `"GROK_FOLDER_TRUST"`, `"trusted_folders.toml"`, `grok "folder trust"`, `grok "folder-trust"`, `grok "projectTrusted"`, `grok build "never trust"`, `grok "untrusted" worktree`, `grok worktree trust`, `grok trust worktree inherit`, `grok "force untrusted"` and `"grok agent" trust`: 76 distinct hits, all in third-party projects. None asks for a way to close the gate. Most want the opposite, a pre-granted or automatic trust: for example getpaseo/paseo#6862, stablyai/orca#27836, kunchenguid/firstmate#3729 and overnightworks/marketplace#199 (worktrees read no AGENTS.md until trusted).
- Web search for `GROK_FOLDER_TRUST` never trust, untrusted worktree and worktree-inherits-trust found no such request either, only release notes, docs and articles about Grok Build's earlier data-upload incident.

No duplicate found.

## Before filing

- [x] Confirm where xAI takes Grok CLI feature requests. The in-CLI `/feedback` command (see **Tracker**). The user files it from a signed-in Grok. Run it in a fresh session in an empty directory, because `/feedback` is tied to the current session. It gives no public URL, so record the date under **Filed**.
- [x] Re-run the reproduction on the current pin (1.0.77) or the newest release with `_x.ai/hooks/list`; update the version line, and drop the request if a "never trust" switch now exists. Reproduced on 1.0.77 on 2026-11-15: worktree `true` (project hook listed and run), never-granted control `false`, every "Things tried" value still `true`, no closing switch. 1.0.87 is newer than the pin but has no manifest checksum, so it was checked statically only.
- [x] Re-check `strings` of the binary for new `GROK_*` trust variables. 1.0.77 and 1.0.87: only `GROK_FOLDER_TRUST`.
- [x] Search for duplicates. None found (see above).

## After filing

Record the date under **Filed**, with "via `/feedback`, no public URL". Set **Status** to `filed`, and link this file and the date in [0001](../todo/agent-engines/0001-agent-interactions-and-permissions.md) task 1 (and code item 12).
