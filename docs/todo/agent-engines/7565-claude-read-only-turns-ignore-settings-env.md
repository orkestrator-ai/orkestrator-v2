# Claude read-only turns ignore the `env` and `apiKeyHelper` in Claude's settings files

Found on 2026-11-10 while running [0190](0190-claude-read-only-turns-without-working-sandbox.md)
task 3 (a container Multi Review on a fake Messages API).

## Task analysis

Analysed 2026-11-10 against `main` at `c98b20e6f`.

### Tasks

1. **Decide whether read-only turns honour the provider connection settings in Claude's settings files**: a user who points Claude Code at its model through `~/.claude/settings.json` (`env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_API_KEY`, `env.CLAUDE_CODE_USE_BEDROCK`, `apiKeyHelper`, …) gets "Not logged in" or the wrong endpoint in every Multi Review reviewer and consolidation turn. Status: open.

### 1. Decide whether read-only turns honour the provider connection settings in Claude's settings files

**Problem.** A `readOnly` turn (Multi Review's reviewers and consolidation,
plan-mode fan-out reviewers) runs under `READ_ONLY_TURN_POLICY`, whose id is
`coordinator-read-only`, so `claudeSettingSources` returns `[]`
(`bridges/claude-bridge/src/services/claude-query-config.ts`). The CLI then
reads no user, project or local settings file. Whatever a user configured
there to reach their model is gone for those turns, while every ordinary turn
in the same session keeps it.

**Context.** Loading no settings files is deliberate: a settings file can
carry hooks, permission rules and plugins that would widen a read-only turn,
and a project settings file is repository content. Orkestrator's own
credential paths are unaffected: the OAuth credentials file (or Keychain) and
an `ANTHROPIC_API_KEY` in the bridge's process environment
([credentials-and-models.md](../../development/credentials-and-models.md))
do not depend on settings sources. Managed settings
(`/etc/claude-code/managed-settings.json` on Linux) are still read.

**Investigation.** Observed on beelink on 2026-11-10, container fixture of an
isolated profile, image `claude` 2.1.319:
- With the fake API's base URL and a fixture token in `~/.claude/settings.json`
  `env`, the preparation turn (writable, settings sources `user` and
  `project`) reached the fake and submitted its plan. Both reviewer turns
  ended at once with `isApiErrorMessage: true`, `error:
  "authentication_failed"`, text "Not logged in · Please run /login", and the
  review failed with "Claude ended the turn on an API error".
- The same values in `/etc/claude-code/managed-settings.json` reached the
  fake from every turn, and the review completed. That is how
  `container-multi-review-read-only.spec.ts` stages its fake.
- Not checked: whether Orkestrator copies a host `settings.json` `env` into
  containers at all, how many users sign Claude in through settings files,
  and whether `apiKeyHelper` behaves the same (it is a settings key, so it is
  expected to).

**Decisions.**

- **What should a read-only turn do about connection settings?**
  - **Pass the connection-only keys through: read the user settings file's
    `env` entries that choose the model endpoint and its credential
    (`ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`, the cloud provider
    variables) in the bridge and hand them to the read-only turn's process
    environment, never hooks, permissions or plugins (recommended).**
    - Pros: the review reaches the same model the user's other turns reach;
      nothing that widens the boundary is loaded; project and local files
      stay out.
    - Cons: an allowlist of variable names to keep current with Claude Code;
      `apiKeyHelper` runs a command, so it needs its own decision (it
      executes outside the hook).
  - **Load the user settings source for read-only turns and rely on the
    managed policy layer to hold the boundary.**
    - Pros: every user setting works, `apiKeyHelper` included.
    - Cons: user hooks and permission rules run in a turn that is meant to
      be read-only; `allowManagedHooksOnly` covers hooks but not every other
      key, so it reopens what the empty source list closed.
  - **Keep it, document it, and refuse such a turn with a clear reason.**
    - Pros: no change to the boundary.
    - Cons: Multi Review with Claude stays unusable for these users; the
      failure only says "Not logged in".

## Current state

- Read-only turns load no settings files; only managed settings and the
  process environment reach them.
- The container qualification spec works around it with managed settings.

## Constraints and rationale

- Whatever is passed must not let a read-only turn run a command outside the
  hook or write the checkout; `apiKeyHelper` is a command.
- Never log the values: they are credentials.

## Related

- [0190-claude-read-only-turns-without-working-sandbox.md](0190-claude-read-only-turns-without-working-sandbox.md),
  where this was found.
- [credentials-and-models.md](../../development/credentials-and-models.md),
  Orkestrator's own Claude credential paths.

## Replaces

Nothing.
