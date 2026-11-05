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

## Outcome

Built on 2026-11-05 from `main` at `33b3d953a`. Every claim above was re-checked against that commit and still held; only the line numbers had moved (in `commands-containers.ts` the staging check was at `:486` and the home-mount branch at `:518-588`, and `EnvironmentInputsSection.tsx` showed its sentence at `:104`).

| Item | Outcome | Where |
| --- | --- | --- |
| Task 1: refuse to create from an image without `staged-inputs` (recommended) | Done, as recommended. The message names the image and asks for a current one, and a failed start persists it. Nothing is created, staged or mounted | `requireStagedInputsImage` (`apps/backend/src/core/commands-containers.ts`), `imageWithoutStagedInputsMessage` (`commands-error-text.ts`); `apps/backend/tests/container-legacy-host-mounts.test.ts` |
| Task 1: home-mount branch | Removed, being unreachable, along with the `-e ANTHROPIC_API_KEY` and `-e CURSOR_API_KEY` forwards only it used | `commands-containers.ts` |
| Task 1: a container from a current image | Created as before, with staged inputs. The existing creation suites keep covering it, now with a manifest that declares them | `container-legacy-host-mounts.test.ts`, `docker-image.test.ts` |
| Task 1: existing containers (leave running, recommended) | Done, as recommended. A start or a read never reaches the create, so they keep their mounts and are not migrated | `container-legacy-host-mounts.test.ts` |
| Task 1: lifecycle document | Updated | `docs/architecture/container-lifecycle.md`, "Rollout switches and legacy runtimes" |
| Task 2: a row in the cleanup review (recommended) | Done, as recommended, with a Rebuild action per environment; nothing shows when there are none | `apps/backend/src/core/docker-cleanup-legacy-runtimes.ts`, `apps/web/src/components/docker/DockerCleanupReview.tsx` and its test |
| Task 2: Rebuild uses the preserving rebuild | Done. The row confirms through the same dialog and sends `intent: "preserve"` with the reviewed container | `RebuildConfirmDialog.tsx`, `DockerCleanupReview.test.tsx` |
| Constraint: policy 1 in the same list | Included. It reads one more label in the same inspect and needed no other design | `legacyExposures` |
| Current state: per-environment notice | Kept. It reports `host-mounts` from a missing label alone, which the list does not; the difference is in the to-do | [5860](../../todo/containers-and-environments/5860-legacy-host-mounts-live-evidence.md) task 3 |
| Needs verification: how many real environments | Not answered: only a running install can | [5860](../../todo/containers-and-environments/5860-legacy-host-mounts-live-evidence.md) task 1 |
| Not in the report: a real old image | Tested with a fake Docker only | [5860](../../todo/containers-and-environments/5860-legacy-host-mounts-live-evidence.md) task 2 |

Found while building, not in the report: a failed start persists only fixed category messages, so the refusal needed its own path through that classifier or the image name would never have reached the user; and Bun freezes `os.homedir()` at process start, so the staging roots now read `HOME` first and no test stages from a developer's real home.
