# Shared and linked user skills in containers

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`.

### Tasks

1. **Shared skills root**: stage `~/.agents/skills` for providers that read it. Status: done.
2. **Linked skill entries**: stage a linked skill whose target is a skill directory inside an allowed root. Status: done.

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

## Current state

Rechecked on 2026-11-02 against `main` at `38d55ee14`: both gaps were still
open (`portable-inputs.ts` skipped every link and had no `~/.agents/skills`
source; `entrypoint.sh` had no `/agents-skills` copy). Both tasks are now
implemented:

- `portableInputSpec` has a `shared-skills` entry staging `~/.agents/skills`
  (one unit per top-level entry, credential guard on) into the
  `agents-skills` stage, bound at `/agents-skills`. `withSharedSkillsInput`
  adds it when Codex, Cursor, Grok, OpenCode or Pi is staged and the image
  declares `staged-inputs=4` (`imageCopiesSharedSkills`). `entrypoint.sh`
  copies it per entry into `~/.agents/skills` in a self-contained block after
  the Cursor setup, and the root entrypoint relays it under rootless Docker
  (`STAGED_INPUT_MOUNTS`). Input spec version 5.
- A top-level link in Claude's, Grok's or Pi's `skills`, or in
  `~/.agents/skills`, is staged as a real directory when it resolves to a
  directory holding a regular `SKILL.md` strictly inside `~/.agents/skills`
  or a skill root of a provider staged in the same run, with no link between
  that root and the skill (`ProviderCopier.linkedSkill`). Every other link is
  still skipped and counted as `symlink`.
- Tests: `apps/backend/tests/portable-inputs-shared-skills.test.ts` (fixture
  homes only), plus updated expectations in
  `portable-inputs-user-extensions.test.ts` and the inputs section test.
- Documented in
  [`container-lifecycle.md`](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs).

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
- A live container built from this tree (`staged-inputs=4`) has not been
  booted with a fixture home to confirm `~/.agents/skills` and a linked
  Claude skill arrive end to end; the staging and the entrypoint copy are
  each covered by unit tests that run the real entrypoint functions.

## Related

- [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md),
  task 3, which staged `~/.claude/skills` and `~/.grok/commands`.

## Replaces

Nothing.

## Assumptions and decisions

### Task 1: the shared root is a pseudo-provider, `shared-skills`

Chosen: the recommended option, a new `agents-skills` mount. It is staged
under its own summary entry, `shared-skills`, rather than under one of the
providers that read it. A spec entry belongs to one provider and copies once
per staging run; attaching the root to each reader would copy it several
times into one stage, or attribute it to an arbitrary reader. The entry is
added by `withSharedSkillsInput` in the container create path, so the image
gate sits beside the existing Cursor gate. The environment's inputs section
labels it "Shared skills" and offers no "Remove credentials" action, because
it holds no login; `disabledProviders` never lists it.

### Task 1: readers include Pi, not Claude

`rootSpecsFor` in `agent-skills.ts` lists `~/.agents/skills` for Codex,
Cursor, Grok, OpenCode and Pi, so all five stage it (the to-do named four).
Claude does not read it, so a Claude-only environment stages no
`/agents-skills`; its linked skills still arrive through task 2.

### Task 1: credential guard on, capability bumped to 4

The root is newly portable, so its entries get the same credential guard as
Claude's `skills` (input spec version 4's rule). `staged-inputs` goes to 4
and the backend stages the mount only for an image that declares it, so an
older image never reports shared skills it would not copy. The agent-test
source is the host home (`agentTestHostHome`), like Pi's and Cursor's
user resources.

### Task 2: which roots a link may resolve into

Chosen: the recommended option. Allowed targets are `~/.agents/skills`
(always, even when it is not staged, because the `npx skills` layout links
Claude's skills into it) and the skill roots of providers staged in the same
run (Claude, Codex, Grok and Pi `skills`). A link into Claude's skills from
Grok's is followed only when Claude is staged. A root that resolves to `/`, a
home or an ancestor of one is dropped, so a mislinked root cannot make the
whole home an allowed target. The target must lie strictly inside the root
(the root itself is refused) and be a real directory with a regular
`SKILL.md`; nested skills (`group/name`) are allowed.

### Task 2: identity re-checked, credentials always withheld

The target's components below the allowed root are checked for links, its
inode is compared before and after the copy, and the copy is discarded as
`changed-while-reading` when it moved. Files are still opened `O_NOFOLLOW`
and links inside the skill are skipped. The credential guard applies to every
followed link, including in Grok's and Pi's skill roots, whose own entries
keep their earlier policy, because a link reaches content that root did not
hold. A refused link keeps the existing `symlink` reason rather than a new
one, so the status UI and its counts are unchanged.

### Task 2: Codex skills copy per entry

Review repair: Codex now uses per-entry staging and entrypoint copying, including
valid top-level links. This replaces the earlier tree-mode decision: a skill
stored only in another provider root must reach Codex through its alias too.
Per-entry bounds preserve siblings when one skill is rejected or oversized.

### Tasks 1 and 2: shared-root and alias safety

Review repair: apply the safe-root validator to direct shared staging as well
as allowed link roots. Reject credential-bearing resolved source ancestry
before copying a linked skill. Recheck ancestry and link resolution after the
copy as well as target identity, with deterministic swap regression tests.

### Shared skills in the entrypoint stay self-contained

The `/agents-skills` copy is one `if` block after the Cursor setup, using only
the existing helpers, so it does not overlap other edits to `entrypoint.sh`
(to-do 1200 edits a different part concurrently).
