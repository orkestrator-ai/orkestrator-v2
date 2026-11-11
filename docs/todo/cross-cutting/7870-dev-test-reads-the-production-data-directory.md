# `dev:test` reads the production data directory with no way to turn it off

## Task analysis

Analysed 2026-11-11 against `main` at `963ffa6ab`, from the live run for to-do 7835 (retired 2026-11-11).

### Tasks

1. **Let an agent-test profile start without reading the production data directory**: every start copies pinned toolchains and model catalogues from it, and no flag stops that. Status: open.

### 1. Let an agent-test profile start without reading the production data directory

**Problem.** Pipeline tickets for live qualification often forbid reading anything under the real data directory (`~/.config/orkestrator-v2` on Linux, `toolchains/` included). The documented command, `mise run dev:test --profile <p> --fixture --no-agent-credentials`, cannot meet that. On every start of an agent-test profile, `seedAgentTestProfileState` (`apps/desktop/scripts/dev/lifecycle.ts`) reads the production data directory twice:

- `seedInstalledAgentToolchains` (`apps/desktop/scripts/dev/profile-io.ts`) copies each selected platform's pinned toolchain, and the support tools, from `<productionDataDir>/toolchains/` when the profile lacks it. The 7835 run on beelink2 printed `Seeded toolchains from the host install: codex@0.167.0, gh@2.102.0`.
- `seedInstalledModelCatalogCaches` exports the agent and OpenCode model catalogues from the production SQLite database (`exportDatabaseCatalogues`), falling back to its JSON files, when the profile has no database yet.

`--no-agent-credentials` stops credential seeding (the Cursor key read from the production `config.json` happens only when Cursor is an authorized source), and an agent-test profile reads the production `config.json` worktree setting only with `--use-dev-worktree-folder`. Nothing stops the two reads above.

**Context.** The copies are read-only: nothing is written to, or run from, the production directory, and the profile runs its own copy. Seeding exists so a start costs a local copy instead of a download; Cursor and Grok have no PATH fallback, so a profile without a seed downloads them at startup (`prefetchAgentToolchains`) and needs network access. Model catalogues give a credential-free profile last-known model metadata.

**Investigation.** Not started beyond reading the call sites named above. Whether the toolchain download alone is fast enough on a loaded host, and whether the suites that use a credential-free profile need the seeded catalogues, has not been measured.

**Decisions.**

- **How to turn the reads off?**
  - **A `--no-host-seed` flag for `dev:test` that skips both seeders, so missing toolchains download and catalogues start empty (recommended).**
    - Pros: one explicit switch a ticket can require; the default stays fast for people.
    - Cons: a profile started with it needs network access for Cursor and Grok toolchains, and its model pickers start empty until the providers answer.
  - **Seed only from a directory named by the caller (`--seed-from <dir>`), never from the production directory by default.**
    - Pros: never touches the production directory unless asked.
    - Cons: changes the default for every user of `dev:test`; every documented command and suite runner needs the extra argument to stay fast.
  - **Leave it and word tickets to allow read-only copies.**
    - Pros: no code change.
    - Cons: the reads stay invisible to whoever writes the constraint, and the next run breaks it again.

## Related

- [agent-testing.md, Agent toolchains in an isolated profile](../../development/agent-testing.md#agent-toolchains-in-an-isolated-profile): how a profile's toolchains are seeded and downloaded today.
- To-do 7835 (retired 2026-11-11): its run is where the copy was seen.
