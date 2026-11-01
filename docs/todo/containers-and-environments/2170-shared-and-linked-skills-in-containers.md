# Shared and linked user skills do not reach containers

Checked against `main` at `93b99bfba` (2026-11-01).

Since 0015 task 3 (2026-11-01) a container gets the host's `~/.claude/skills`
and `~/.grok/commands`, but only entries that are real directories and files.
Two common layouts still leave a container's skill list shorter than the
host's:

- `~/.agents/skills`, the shared root Codex, Grok, OpenCode and Cursor read
  (`rootSpecsFor` in `apps/backend/src/core/agent-skills.ts`), is not staged
  for any provider.
- A skill linked into a provider root, typically `~/.claude/skills/<name>`
  linking to `~/.agents/skills/<name>` (an `npx skills` install), is a
  symlink. Staging never follows a link below a home entry
  (`portable-inputs.ts`, [`container-lifecycle.md`](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs)),
  so it is skipped and counted as `symlink`.

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`.

### Tasks

1. **Shared skills root**: stage `~/.agents/skills` for providers that read it. Status: open.
2. **Linked skill entries**: stage a linked skill whose target is a skill directory inside an allowed root. Status: open.

### 1. Shared skills root

**Problem.** Codex, Grok, OpenCode and Cursor list `~/.agents/skills` on the host; in a container that root is empty.

**Context.** Container homes are `/home/node`; every provider there reads `~/.agents/skills` from that HOME. Nothing in `portableInputSpec` or `docker/entrypoint.sh` stages or copies it, and no mount exists for it.

**Investigation.** Not started. The pinned Grok 1.0.70 lists `~/.grok/skills`, `~/.grok/commands` and `~/.claude/skills` (`grok inspect` in a fixture home, 2026-11-01); whether it lists `~/.agents/skills` the same way is from `agent-skills.ts`, not probed.

**Decisions.**

- **How should it be staged?**
  - **A new `agents-skills` mount, staged when any provider that reads it is enabled, copied per entry to `~/.agents/skills` (recommended).**
    - Pros: one copy serves every provider; the same per-entry rules as the other skill roots.
    - Cons: a new mount and entrypoint copy, so a `staged-inputs` capability bump, and the relay and mirror tests grow.
  - **Copy it into each provider's own root.**
    - Pros: no new mount.
    - Cons: duplicates skills, and changes precedence where a provider reads both roots.

### 2. Linked skill entries

**Problem.** A linked skill is the normal result of a shared install, and it is dropped in every container.

**Context.** The rule that nothing below a home entry is followed protects against a link that points at a credential or at history. A skill link would have to be followed safely to be staged.

**Investigation.** Not started. `codexCoordinatorSkillReadRoots` (`docs/architecture/coordinator.md`) already grants a link target only when it holds a `SKILL.md` and is not HOME, `/` or an ancestor; that rule could be reused.

**Decisions.**

- **Which links should be followed?**
  - **A top-level entry of a skill root whose resolved target is a directory holding `SKILL.md`, inside `~/.agents/skills` or another staged skill root, copied as a real directory (recommended).**
    - Pros: covers the `npx skills` layout; the target is still a skill, not an arbitrary host path.
    - Cons: widens the never-follow rule; the copy must re-check the target's identity like every other read.
  - **Keep skipping links.**
    - Pros: nothing new to reason about.
    - Cons: linked skills stay host-only, which is the layout shared-skill tools create.

## Constraints and rationale

- Stage only user-authored content, never logins, history or caches
  ([`container-lifecycle.md`](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs)).
- Test with fixture homes only, never the real `~/.agents`, `~/.claude` or
  `~/.grok`.

## Open questions

None.

## Needs verification

- Whether the pinned Grok and Cursor list `~/.agents/skills` in a container
  HOME (from code only).

## Related

- [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md),
  task 3, which staged `~/.claude/skills` and `~/.grok/commands`.

## Replaces

Nothing.
