# What the legacy host mount work left for a running install

Carried from the security report's S-0080 file (finding M9) when it was closed on 2026-11-05. New containers no longer get host agent homes, and the cleanup review lists the environments that still have them. What is left needs a real install or a real old image, or is a follow-up to that work.

## Task analysis

Analysed 2026-11-05 against `main` at `33b3d953a`; tasks 2 and 3 done
2026-11-06 against `main` at `c1724ab74`.

### Tasks

2. **Run the refusal and the row's rebuild against a real old image**: run live on Docker Desktop with an image built from `d56c3b68e`; the row's Rebuild migrated it. Status: done (the refusal itself was not run live; see the task).
3. **Stop the inputs section claiming mounts it has no evidence for**: it now reads the cleanup review's evidence and reports `unknown` when Docker does not answer. Status: done.
4. **Decide when the old-runtime paths can go**: they stay while any runtime needs them. Status: blocked (waits on 7568: 5860 task 1).

### 2. Run the refusal and the row's rebuild against a real old image

**Problem.** The refusal and the row's Rebuild action were tested with a fake Docker and, for the screenshots, with intercepted responses. No real image from before `staged-inputs` was used, and no real runtime in the old shape was rebuilt from the row.

**Context.** `apps/backend/tests/container-legacy-host-mounts.test.ts` and `apps/web/src/components/docker/DockerCleanupReview.test.tsx` own the behaviour. The rebuild itself is the existing preserving rebuild, which has its own live suites (`container-live-replacement.test.ts`). `apps/backend/tests/portable-inputs-stamps-docker.test.ts` already takes an old image through `ORKESTRATOR_QUALIFICATION_OLD_IMAGE`.

**Investigation.** Docker's real `.Mounts` JSON and an absent label's `{{ index }}` output were assumed from Docker's documented format; the fake answers an absent label both as an empty field and as `<no value>`. An old-shape runtime can no longer be created by this backend, so a live run has to create it by hand or keep one from an older release.

Run on 2026-11-06 (Docker Desktop 29.9.2, linux/arm64, profile `legacy-5860`, credential-free, Codex only, full network, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`):

- **Old image.** `staged-inputs` (and the image manifest itself) arrived with #877 (`1cdba8e0c`), so the image was built from its parent `d56c3b68e` (`git archive` into a scratch directory, `docker build -f docker/Dockerfile`), tagged `orkestrator-v2:legacy-5860-d56c3b68e` and labelled `orkestrator-qualification=5860-legacy`. Every pinned download still resolved; the build took about 20 minutes. It has no `/usr/local/share/orkestrator/` manifest.
- **Old-shape runtimes.** Two records were made with `orkestrator environment create` (no container), then, with the profile stopped, pointed at two containers created by hand with `d56c3b68e`'s `createDockerContainer` arguments and the profile's owner label: `legacy-host-mounts` with read-only binds at `/claude-config`, `/claude-config.json`, `/codex-home`, `/pi-config` and `/tmp/gitconfig` from a scratch directory of dummy files, and `legacy-no-mounts` with none. Neither record had a `containerLifecycle`, as an install before #877 would have left it.
- **Docker's real answers.** For the shared inspect format, an absent label is an empty field (not `<no value>`), and the mounts JSON has `Type: "bind"` and the expected `Destination`. A missing container answers `error: no such object: <id>`, which the parser counts as missing.
- **Start.** `orkestrator environment start` started both on the old image, setup completed, and the old entrypoint copied the scratch files into `~/.claude`, `~/.codex` and `~/.gitconfig`. Nothing was migrated by the start.
- **Review and inputs section.** The review listed `legacy-host-mounts` ("Your agent home directories are mounted into it. It shares a Docker network…") and `legacy-no-mounts` (shared network only). The inputs section of `legacy-host-mounts` showed the home-directories notice; `legacy-no-mounts` showed no inputs section (`none`). Before task 3 it would have said host mounts, by the code; that was not run live.
- **Rebuild from the row.** A marker file was written to `/workspace`, then **Rebuild…** on the review row and **Rebuild** in the confirmation ran a `migrate` operation that succeeded in 23.8 s (copying 14.0 s, verify 3.7 s). The new runtime runs the profile's current image with inputs revision `rmw4hs98a-2f978852`, network policy 3, `/workspace` on a volume, and no host-home binds. The marker, the branch and the untracked status survived. The old runtime stayed stopped as a recovery copy. The review then listed only `legacy-no-mounts`.

Screenshots were taken under `output/visual-previews/legacy-5860-*.png` (not committed). The profile was reset afterwards, which removed the four owner-labelled containers (both hand-built ones included), their volumes and networks; the labelled image was removed.

Not run live: the refusal to *create* a new runtime from an old image (the rebuild here used the current image, as the row requires). A credential-free profile also stages no provider, so the rebuilt runtime's inputs section is an empty box; that is [7320](7320-empty-inputs-section.md).

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

Done 2026-11-06: both views now read `legacy-runtime-shape.ts` (one `docker inspect` of the two labels and `.Mounts`). The section reports `host-mounts` only for no label and an old bind, `none` for no label and no such bind or a container Docker says is gone, and `unknown` for a failed inspect or unreadable mounts. `revokeProviderCredentials` still uses `containerLabel` unchanged. Tests: `container-legacy-host-mounts.test.ts` ("the inputs section reads the same evidence…") and `EnvironmentInputsSection.test.tsx`.

**Decisions.**

- **What should the section do?**
  - **Read the same evidence as the list, and report `unknown` when Docker does not answer (recommended).**
    - Pros: one definition of "has host mounts"; `unknown` already has its own wording.
    - Cons: one more Docker read's worth of parsing on a status path, and the revocation flow that shares `containerLabel` must keep its own behaviour.
  - **Leave it.**
    - Pros: no change.
    - Cons: a false alarm for a rare runtime, and a disagreement between two views of the same fact.

### 4. Decide when the old-runtime paths can go

**Problem.** Some code exists only for runtimes created before staged inputs: the entrypoint's raw `/claude-config.json` and home-mount copies, `applyActiveCodexLoginAfterLegacyBoot` and the `host-mounts` status. They can go only once no such runtime is left.

**Context.** This is unmigrated user state, not version skew, so the support window does not retire it ([version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)). The lifecycle document's rule stays: a start or a read never migrates a runtime.

**Investigation.** The creation branch is already gone, so these paths serve existing runtimes only. The count of real legacy runtimes (7568: 5860 task 1) is the input this decision needs.

**Decisions.**

- **When should they be removed?**
  - **When the count (7568: 5860 task 1) finds none on the machines we can reach, with the release note saying such a runtime must be rebuilt first (recommended).**
    - Pros: removes credential-handling code once it serves nobody we know of.
    - Cons: an unattended install's old runtime would lose its login sync.
  - **Keep them indefinitely.**
    - Pros: no risk to an old runtime.
    - Cons: permanent code for a shape nothing can create any more.

## Assumptions and decisions

### Task 3: what a runtime with no label and no old bind reports

Chosen: `none`, the existing mode for "nothing exposed". The section hides
`none` unless the environment has revoked providers, so "Allow again" stays
reachable on such a runtime. A container Docker says is gone is also `none`;
only Docker's silence (or mounts it cannot parse) is `unknown`. Adding a new
mode was not needed: the review's list and the section now agree.

### Task 3: one shared reader rather than a second inspect

Chosen: move the old mount points, the parser and the inspect into
`legacy-runtime-shape.ts`, used by both the review's list and the section,
so there is one definition. The mounts JSON is parsed only when the revision
label is absent, so a staged runtime's status costs no more parsing than
before. `containerLabel` stays for revocation and the MCP routes.

### Task 2: how the old runtime and its record were made

Chosen: build the image from `d56c3b68e` (the parent of the commit that
added `staged-inputs`), create the containers by hand with that commit's
`docker create` arguments and scratch binds, create the records through the
CLI and point them at the containers with the profile stopped. The records
were left without `containerLifecycle`, as a pre-#877 install's are. The
binds used a scratch directory of dummy files, never a real agent home.

## Constraints and rationale

- Never refuse to start an existing runtime for this, and never migrate one on a start or a read. The user's work lives there, and a rebuild of a large workspace takes time.
- An image whose manifest Docker cannot read is not an old image. It is reported as Docker being unavailable, and nothing is created from it.

## Needs verification

- The refusal to create a runtime from a pre-`staged-inputs` image, against a real old image (task 2 ran the row's rebuild, not the refusal).
- A user on an old default image `orkestrator-v2:latest` gets the refusal and the Settings download. Whether the first start should download a current image by itself, as it does for a missing one (`ensureEnvironmentImage`), was not decided here. Refusing is the safe outcome, and the message says what to do.

## Related

- [7320: the inputs section shows an empty box for a staged revision with no providers](7320-empty-inputs-section.md)
- [Container lifecycle: rollout switches and legacy runtimes](../../architecture/container-lifecycle.md#rollout-switches-and-legacy-runtimes)
- Security review, M9 (`git show 413bd6219:docs/reports/2-26-10-27-security.md`)
- Security index (`git show 413bd6219:docs/reports/security/0000-index.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, counting legacy runtimes on the user's real machines) moved there on 2026-11-10.
