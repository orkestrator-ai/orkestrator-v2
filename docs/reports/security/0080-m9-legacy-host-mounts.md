# Deal with images that still mount whole host agent homes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop new containers getting home mounts**: a new container from an image without staged inputs still gets them. Status: open.
2. **List the affected environments**: the only warning sits in each environment's own inputs section. Status: open.

### 1. Stop new containers getting home mounts

**Problem.** `~/.claude`, `~/.codex`, `~/.pi`, the OpenCode directories, the raw `~/.claude.json` and `~/.gitconfig` are mounted read-only into any container whose image lacks `staged-inputs`. That exposes refresh tokens, history and every host transcript. It also carries the raw file the M8 filter otherwise keeps out.

**Context.** `docs/architecture/container-lifecycle.md:532-539` says these shapes follow what the image declares, are "not retired", and that an environment leaves through a preserving rebuild. The switch that forced this on a capable image is gone (`docs/architecture/container-lifecycle.md:547`, removed 2026-10-25). So the decision here is about what the backend does for an old image, not a switch.

**Investigation.** `apps/backend/src/core/commands-containers.ts:459` stages inputs only when the image declares them. Otherwise the `else` branch at `:491` binds the homes (`:503-504`, `:511`, `:534`, `:549-550`, `:559`). The comment at `:441-443` confirms it. Nothing refuses this.

**Decisions.**

- **What should creating a container from such an image do?**
  - **Refuse, with a message that names the image and asks for a current one (recommended).**
    - Pros: closes the exposure for every new container; the report's first option; no credential ever goes into an old shape.
    - Cons: a user pinned to an old custom image cannot create containers until they rebuild it.
  - **Create it without any home mounts.**
    - Pros: nothing is exposed and creation still succeeds.
    - Cons: that image's entrypoint expects those mounts, so agents start without credentials and fail later with a less clear cause.
  - **Keep creating with mounts and warn.**
    - Pros: no compatibility break.
    - Cons: the exposure continues, and it is what happens today.
- **What about containers that already exist in this shape?**
  - **Leave them running and rely on the rebuild path, with task 2 listing them (recommended).**
    - Pros: never removes a user's work; matches the lifecycle document's rule that a start or a read never migrates a runtime.
    - Cons: the mounts persist until the user acts.
  - **Refuse to start them.**
    - Pros: ends the exposure at the next start.
    - Cons: blocks work until a rebuild, which can take a long time for a large workspace.

### 2. List the affected environments

**Problem.** A user cannot see in one place which environments still expose their agent homes.

**Context.** The report asks for a warning that lists them.

**Investigation.** `apps/backend/src/core/portable-input-status.ts:170` reports `host-mounts` when the inputs-revision label is missing, and `apps/web/src/components/environments/EnvironmentInputsSection.tsx:104-108` shows a sentence inside that environment's section. No aggregate surface was found.

**Decisions.**

- **Where should the list go?**
  - **A row in the existing cleanup review, with a Rebuild action per environment (recommended).**
    - Pros: it is already where users act on old runtimes (the lifecycle document's legacy table).
    - Cons: not noticed by someone who never opens that review.
  - **A global banner.**
    - Pros: cannot be missed.
    - Cons: noisy until every environment is rebuilt.

## Current state

Partly in place, so not in Tasks: the per-environment status and message above, and the removal of `ORKESTRATOR_PORTABLE_INPUTS=host-mounts`.

## Constraints and rationale

- Policy 1 (the shared bridge and the host `/24`, security finding I4) is the same class of old runtime (`apps/backend/src/core/container-network.ts:47-50`). The list in task 2 could carry it too.

## Needs verification

- How many real environments are in this shape: only a running install can answer that.

## Related

- [Security report, M9](../2-26-10-27-security.md#m9-legacy-pre-staged-inputs-images-still-mount-whole-host-agent-homes)
- `docs/architecture/container-lifecycle.md`, "Rollout switches and legacy runtimes"
