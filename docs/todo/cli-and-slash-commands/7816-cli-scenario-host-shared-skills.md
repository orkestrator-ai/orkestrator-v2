# CLI scenario backends read the operator's own `~/.agents/skills`

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Keep scenario sessions from discovering the operator's shared skills**: a scenario's catalogue depends on the host it runs on. Status: open.

### 1. Keep scenario sessions from discovering the operator's shared skills

**Problem.** A CLI scenario's Pi session listed the four skills in the operator's own `~/.agents/skills` (`/skill:<name>` rows) beside the fixture's prompt template. The run read nothing under `~/.pi` or `~/.claude` and wrote nothing, but the catalogue a scenario checks, and every manifest or log that lists it, now depends on which machine ran it, and the skills' instructions can reach a live run's model.

**Context.** `isolateProviderHomes` (`packages/cli/scenarios/provider-homes.ts`) moves every provider's own state into a disposable home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `GROK_HOME`, the XDG roots) but keeps `HOME` so Git, `gh` and mise still find their settings. `~/.agents/skills` is read relative to `HOME` by every shared-skill reader (Codex, Cursor, Grok, OpenCode and Pi; `SHARED_SKILL_READERS` in `apps/backend/src/core/portable-inputs.ts`), so it is the one provider input the isolation misses. Seen on 2026-11-11 in [0015](0015-slash-command-qualification.md)'s mixed-version probe (Pi, local environment, project resources on so Pi loads templates and skills). Container runs are not affected: staging reads the disposable home (`ORKESTRATOR_AGENT_TEST_HOST_HOME`).

**Investigation.** Observed on Pi only. Not checked: whether Pi resolves the directory from `HOME` or `os.homedir()` (Bun reads the latter once at startup, so a later `HOME` change does not move it), and which of the other readers also list it in a host session. No current scenario asserts on the absence of foreign rows, so nothing failed.

**Decisions.**

- **How to isolate it?**
  - **Run the scenario backend with `HOME` set to the disposable home, and point Git, `gh` and mise at the operator's settings explicitly, as `prepareIsolatedBackendEnvironment` already does for Git's global config (recommended).**
    - Pros: covers every reader of any `~/.<tool>` path at once, including ones added later.
    - Cons: every host tool the backend spawns has to be checked for a `HOME` dependency (mise trust, `gh` auth, SSH keys for a fixture remote), and a missed one fails a scenario in a confusing way.
  - **Set each reader's own override, where one exists.**
    - Pros: smallest change.
    - Cons: not every reader has an override for the shared root, and a new reader would reopen the gap.
  - **Leave it, and make scenarios ignore rows they did not create.**
    - Pros: no change to the environment.
    - Cons: the operator's skills still reach live runs' sessions.

## Related

- [0014-cli-qualification.md](0014-cli-qualification.md): the scenario harness and its 2026-10-18 provider-home isolation, which this extends.
- [0015-slash-command-qualification.md](0015-slash-command-qualification.md) task 1: the run that found it.
