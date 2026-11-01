# Cursor coordinator skill tests read the checkout's own skills

Two `ensureAgent` cases in `bridges/cursor-bridge/src/agent-session.test.ts`
fail in any checkout that has a local `.claude/skills/` (every Orkestrator
worktree here has an untracked `release` skill), because skill discovery reads
the process's working directory as the project. Found on 2026-10-31 by
[0030](../cross-cutting/0030-test-suite-and-ci-health.md).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Give the two cases their own project directory**. Status: done.

### 1. Hermetic skill discovery in the tests

**Problem.** `a coordinator process hosts the user's skills as a read-only
tool` and `a coordinator process hosts its research servers beside
Orkestrator's tools` fail locally (passing on CI, which has no local skills):
the first finds the checkout's `release` skill instead of the test's HOME
skill ("project ones first"), the second finds an unexpected
`orkestrator-skills__load` tool.

**Context.** `hostSkillCustomTools(env, cwd, home)` and
`discoverCoordinatorSkills(cwd, home)` (`bridges/cursor-bridge/src/coordinator-skills.ts:99`, `:205`);
the tests set `HOME` to a temporary directory but not the project directory.
`.claude/` is gitignored (`.gitignore:85`).

**Investigation.** Reproduced on 2026-10-31 with the unchanged file (2 fail,
96 pass with `initial-run.test.ts`); the received description is the checkout's
own release skill. Still true on 2026-11-01 at `93b99bfba`: with a
`.claude/skills/release/SKILL.md` planted in the checkout, the same two cases
fail (78 pass, 2 fail in `agent-session.test.ts` alone). The attach passes
`workingDirectory` from `config.ts`, a constant fixed when the module first
loads from `CWD` or `process.cwd()`; discovery does not walk up from it.

**Decisions.**

- **How?**
  - **Run the attach with a temporary project directory (the session's cwd or
    an injected root) in both cases (recommended).**
    - Pros: hermetic on every checkout; no product change.
    - Cons: needs the seam the attach uses for its cwd.
  - **Leave it; CI passes.**
    - Pros: none worth having.
    - Cons: every local `mise run test` in a worktree with skills fails.

## Current state

Done. `ensureAgent` in `bridges/cursor-bridge/src/agent-session.ts` takes the
skill discovery project from `setCursorSkillsProjectForTests` when a test has
set one, and from `workingDirectory` otherwise. Both cases set a temporary
project directory under the file's state root and clear it in their `finally`.
They pass with and without a checkout `.claude/skills/release`.

## Constraints and rationale

- Do not change skill discovery's order for a test.

## Assumptions and decisions

- 2026-10-31: filed here because the feature is the coordinator's skill tool.

### Task 1: a test seam for the project directory, not `CWD`

Chose a `setCursorSkillsProjectForTests(directory?)` seam beside
`setCursorMcpConfigHomeForTests` in `agent-session.ts`. `workingDirectory` is
read once when `config.ts` first loads, and Bun shares that module across test
files in one process, so setting `CWD` before the test's import would not be
reliable; it would also move every other case's `workingDirectory`, which
several write `.cursor/mcp.json` under. The seam changes only which directory
counts as the project for skill discovery; the order (project first, then
HOME) is untouched.

### Task 1: set in the two cases, not in `beforeEach`

Several cases set `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` to
`coordinator-read-only` and can discover skills from the checkout. The two cases
addressed here assert the hosted tool inventory or the user skill fixture, so
they need an isolated project directory. Each sets a directory that does not
exist (an empty project) and clears the seam in its existing `finally`.

### Needs verification: other bridges

Checked 2026-11-01 with the planted checkout skill: the Cursor
`coordinator-skills.test.ts`, Pi `coordinator-skills.test.ts`, Claude
`coordinator-skills.test.ts`, `session-manager-coordinator-skills.test.ts` and
`read-only-policy.test.ts`, and Codex `app-server-runtime-prompt.test.ts` all
pass. Codex's `live-coordinator-skills.test.ts` is a live suite and was not
run; it builds its own workspace under `mkdtemp` and passes it as `cwd`, so it
does not read the checkout's skills.

## Open questions

- None.

## Needs verification

- None.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md).

## Replaces

- Nothing.
