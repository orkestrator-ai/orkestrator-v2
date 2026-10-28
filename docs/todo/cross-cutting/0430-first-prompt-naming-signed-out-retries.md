# First-prompt naming retries `codex exec` every 30 seconds when Codex cannot sign in

Checked against `main` at `1d1f0a87` (2026-10-28).

When an environment is launched with a first prompt, the backend names it by
running `codex exec` (`generateEnvironmentNameWithCodexExec`,
`apps/backend/src/core/commands-agent-support.ts`). If that fails, the
environment keeps its pending rename intent and the `pending-renames`
recurring job retries it about every 30 seconds while the environment runs
(`pendingEnvironmentRenameTask` in `apps/backend/src/core/commands-registry.ts`).
For a user whose Codex is signed out, missing or offline, every retry spawns a
Codex process that fails the same way. Feature-build naming instead falls back
to a local title after one failure (`refineFeatureTitle` in
`apps/backend/src/core/feature-build.ts`). Split from the open question in
[0731-ci-backend-test-spawns-real-codex.md](0731-ci-backend-test-spawns-real-codex.md),
which made the failure log content-free and logs repeats only as a count.

## Task analysis

Not analysed yet.

## Current state

- A failed rename keeps `pendingRenamePrompt` and sets a 30-second retry time;
  the retry has no upper bound while the environment is running.
- Failures are logged once per environment and intent, then as a count at the
  2nd, 4th, 8th... failure (`PendingRenameFailureLog`,
  `apps/backend/src/core/pending-rename-failure-log.ts`), so the log no longer
  grows every 30 seconds.
- The error summary already tells a missing binary (`command-missing`) and a
  timeout (`command-timed-out`) from a refused login (`command-failed`).

## Outstanding work

### Code

1. Decide whether a failure class that will not fix itself (missing binary,
   a refused login) should stop retrying, back off further, or fall back to a
   local slug, and whether the user should see that naming gave up.
2. Implement the choice with a test using a failing stub `codex`.

### Qualification

- None beyond the unit and command-registry tests.

## Constraints and rationale

- Naming is cosmetic; it must never block a launch or a prompt.
- Logs never contain prompts (AGENTS.md invariant 12).
- A user who signs in to Codex later should still get a generated name if the
  environment is still on its generated name, unless the choice says otherwise.

## Open questions

- Is a local slug from the prompt (as feature-build does) acceptable for
  environment and branch names, or should the generated timestamp name stay?

## Needs verification

- How often this happens for real users: no rename failure lines were found in
  this host's app logs for 2026-10-25 to 2026-10-27 (from 0731's analysis).

## Related

- [0731-ci-backend-test-spawns-real-codex.md](0731-ci-backend-test-spawns-real-codex.md): where this was split from.

## Replaces

Nothing; new on 2026-10-28.
