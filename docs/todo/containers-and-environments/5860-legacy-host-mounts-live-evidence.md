# What the legacy host mount work left for a running install

Carried from the security report's S-0080 file (finding M9) when it was closed on 2026-11-05. New containers no longer get host agent homes, and the cleanup review lists the environments that still have them. What is left needs a real install or a real old image, or is a follow-up to that work.

## Task analysis

Analysed 2026-11-05 against `main` at `33b3d953a`.

### Tasks

1. **Count the real environments in this shape**: only a running install can answer. Status: open.
2. **Run the refusal and the row's rebuild against a real old image**: the code paths are covered with a fake Docker only. Status: open.
3. **Stop the inputs section claiming mounts it has no evidence for**: it reports `host-mounts` from a missing label alone. Status: open.
4. **Decide when the old-runtime paths can go**: they stay while any runtime needs them. Status: open (depends on 1).

### 1. Count the real environments in this shape

**Problem.** The report asked how many real environments still mount host agent homes. A worktree build has no real environments, and this work was not allowed to read a production install.

**Context.** The cleanup review now lists them (`docker_cleanup_preview`'s `legacyRuntimes`, `apps/backend/src/core/docker-cleanup-legacy-runtimes.ts`). Open it from Settings, Docker, "Review cleanup…", on each machine.

**Investigation.** Nothing was measured. The list has only run against fake Docker answers and intercepted responses on an isolated profile.

**Decisions.**

- **How should the count be taken?**
  - **The user opens the review once on each machine and records the number here (recommended).**
    - Pros: read-only; the same list the user acts on; no new code.
    - Cons: a manual step per machine.
  - **Add a usage counter for the list's size.**
    - Pros: visible through `get_compatibility_path_usage` without opening anything.
    - Cons: new code and a stored count to answer one question once.

### 2. Run the refusal and the row's rebuild against a real old image

**Problem.** The refusal and the row's Rebuild action were tested with a fake Docker and, for the screenshots, with intercepted responses. No real image from before `staged-inputs` was used, and no real runtime in the old shape was rebuilt from the row.

**Context.** `apps/backend/tests/container-legacy-host-mounts.test.ts` and `apps/web/src/components/docker/DockerCleanupReview.test.tsx` own the behaviour. The rebuild itself is the existing preserving rebuild, which has its own live suites (`container-live-replacement.test.ts`). `apps/backend/tests/portable-inputs-stamps-docker.test.ts` already takes an old image through `ORKESTRATOR_QUALIFICATION_OLD_IMAGE`.

**Investigation.** Docker's real `.Mounts` JSON and an absent label's `{{ index }}` output are assumed from Docker's documented format; the fake answers an absent label both as an empty field and as `<no value>`. An old-shape runtime can no longer be created by this backend, so a live run has to create it by hand or keep one from an older release.

**Decisions.**

- **How should this be run?**
  - **Once by hand on a throwaway profile with a pre-`staged-inputs` image (recommended).** Create the old-shape container by hand with the profile's owner labels and an environment record pointing at it, check it starts and is listed, press Rebuild, then check the new runtime has an inputs revision and the workspace survived.
    - Pros: proves the real mounts format and the whole path once.
    - Cons: needs an old image on the host and a hand-built runtime.
  - **Add a case to `container-live-replacement.test.ts`.**
    - Pros: repeats on each live run.
    - Cons: the suite would have to keep an old image available for a shape that is on its way out.

### 3. Stop the inputs section claiming mounts it has no evidence for

**Problem.** An environment's inputs section can say its home directories are mounted when they are not, so it can disagree with the cleanup review.

**Context.** `environmentInputStatus` (`apps/backend/src/core/portable-input-status.ts`) reports `host-mounts` when the inputs-revision label is missing, and `containerLabel` answers `null` for a failed `docker inspect` as well as for an absent label. The review's list requires both no label and a bind at one of the old mount points, and counts a failed inspect as unchecked.

**Investigation.** A runtime with no label and no such bind exists when the host had none of those directories at creation. A failed inspect reaches the same answer. The per-environment notice was out of this work's scope, which was the aggregate list.

**Decisions.**

- **What should the section do?**
  - **Read the same evidence as the list, and report `unknown` when Docker does not answer (recommended).**
    - Pros: one definition of "has host mounts"; `unknown` already has its own wording.
    - Cons: one more Docker read's worth of parsing on a status path, and the revocation flow that shares `containerLabel` must keep its own behaviour.
  - **Leave it.**
    - Pros: no change.
    - Cons: a false alarm for a rare runtime, and a disagreement between two views of the same fact.

### 4. Decide when the old-runtime paths can go

**Problem.** Some code exists only for runtimes created before staged inputs: the entrypoint's raw `/claude-config.json` and home-mount copies, `applyActiveCodexLoginAfterLegacyBoot`, the plain-token and `host-mounts` reports. They can go only once no such runtime is left.

**Context.** This is unmigrated user state, not version skew, so the support window does not retire it ([version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)). The lifecycle document's rule stays: a start or a read never migrates a runtime.

**Investigation.** The creation branch is already gone, so these paths serve existing runtimes only. Task 1's count is the input this decision needs.

**Decisions.**

- **When should they be removed?**
  - **When task 1 finds none on the machines we can reach, with the release note saying such a runtime must be rebuilt first (recommended).**
    - Pros: removes credential-handling code once it serves nobody we know of.
    - Cons: an unattended install's old runtime would lose its login sync.
  - **Keep them indefinitely.**
    - Pros: no risk to an old runtime.
    - Cons: permanent code for a shape nothing can create any more.

## Constraints and rationale

- Never refuse to start an existing runtime for this, and never migrate one on a start or a read. The user's work lives there, and a rebuild of a large workspace takes time.
- An image whose manifest Docker cannot read is not an old image. It is reported as Docker being unavailable, and nothing is created from it.

## Needs verification

- Task 1's number, and task 2's run.
- A user on an old default image `orkestrator-v2:latest` gets the refusal and the Settings download. Whether the first start should download a current image by itself, as it does for a missing one (`ensureEnvironmentImage`), was not decided here. Refusing is the safe outcome, and the message says what to do.

## Related

- [Container lifecycle: rollout switches and legacy runtimes](../../architecture/container-lifecycle.md#rollout-switches-and-legacy-runtimes)
- [Security review, M9](../../reports/2-26-10-27-security.md#m9-legacy-pre-staged-inputs-images-still-mount-whole-host-agent-homes)
- [Security index](../../reports/security/0000-index.md)
