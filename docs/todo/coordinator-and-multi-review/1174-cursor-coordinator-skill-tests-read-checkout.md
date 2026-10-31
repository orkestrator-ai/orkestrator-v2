# Cursor coordinator skill tests read the checkout's own skills

Two `ensureAgent` cases in `bridges/cursor-bridge/src/agent-session.test.ts`
fail in any checkout that has a local `.claude/skills/` (every Orkestrator
worktree here has an untracked `release` skill), because skill discovery reads
the process's working directory as the project. Found on 2026-10-31 by
[0030](../cross-cutting/0030-test-suite-and-ci-health.md).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Give the two cases their own project directory**. Status: open.

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
own release skill.

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

Fails on local checkouts with project skills; passes on CI.

## Outstanding work

### Code

1. The temporary project directory in both cases.

## Constraints and rationale

- Do not change skill discovery's order for a test.

## Assumptions and decisions

- 2026-10-31: filed here because the feature is the coordinator's skill tool.

## Open questions

- None.

## Needs verification

- Other bridges' coordinator skill tests for the same dependency.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md).

## Replaces

- Nothing.
