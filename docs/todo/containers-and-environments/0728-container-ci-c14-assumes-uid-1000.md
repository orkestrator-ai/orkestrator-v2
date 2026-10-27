# Container CI case "C14 legacy migration with staged provider inputs" fails on any host whose user is not uid 1000

Checked against `main` at `863b5782` (2026-10-27).

The live case [0058](0058-legacy-migration-root-symlink.md) added reads the
staged Codex input `/codex-home/config.toml` as the container's `node` user
before it migrates anything. The staged file is owner-only and belongs to the
host user, so the read works only where that user is uid 1000, as on
omarchy-hp, where 0058 was qualified. On GitHub's runners it fails with
`Permission denied` on both architectures, so the case has been red in the
"Container live qualification" workflow since 0058's own PR, and again on the
0109 PR. Both PRs merged because the workflow is not a required check. The
migration itself is never reached. Found in 0058's task analysis.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Make the precondition uid-independent**: assert the staged mount and what `node` actually imports, not the raw owner-only mount. Status: open.
2. **Prove re-staging, not copying**: make the final `config.toml` assertion able to fail if the migration copied the source's copy. Status: open.
3. **Correct the relay comment**: the relay also runs on a rootful daemon whose user is not uid 1000. Status: open.
4. **Green CI run**: both architectures pass the whole replacement file. Status: open (depends on 1).
5. **Whether the workflow should gate merges**: decide how a red qualification run stops a PR. Status: open.

### 1. Make the precondition uid-independent

**Problem.** The case fails before the migration runs, so CI never exercises the migration it was written for.

**Context.** Staged inputs are bound read-only, mode 0700/0600, owned by the backend's user (`apps/backend/src/core/portable-inputs.ts:540-541`, `:778-783`). Since 0109 (`1aabf049`, staged-inputs=3), the root entrypoint copies every staged mount `node` cannot read into `/run/orkestrator-inputs` before dropping privileges (`relay_staged_inputs`, `docker/network-policy-entrypoint.sh:144-196`), and `docker/entrypoint.sh` imports from that copy (`staged_input_path`, `:46-58`; the Codex import at `:1051-1067`).

**Investigation.** Confirmed from CI logs (`gh run view --log-failed`).
- The assertion is `expect(await exec(containerId, "cat /codex-home/config.toml"))` at `apps/backend/tests/container-live-replacement.test.ts:239`. `exec` runs `docker exec -u node` (`apps/backend/tests/container-live-workspace.ts:98-100`).
- Run 40333566613 (0058's PR, head `69857dac`) and run 40409285999 (0109's PR, head `e53ea683`) fail this case on linux-x64 and linux-arm64 with `CommandFailedError: cat: /codex-home/config.toml: Permission denied`. The other 11 cases in the file pass in both runs.
- Run 40338400817 (an earlier 0109 head, `e8306626`) passed because that branch did not yet contain the case.
- The same uid shape already broke C20 ("C20 staged portable inputs") in every run from at least the weekly `main` run 40304582303 (2026-10-26), with `cat: /home/node/.codex/auth.json: No such file or directory`: the entrypoint could not read the mount, so nothing was imported. 0109's relay fixed C20, which passes in 40409285999. C14's case reads the raw mount directly, so the relay cannot help it.
- The runner's uid is inferred, not read from the log: a 0600 file owned by uid 1000 would be readable to `node`, so the runner user is some other uid (uid 1001 on GitHub's Ubuntu images, by their documented setup).
- Certainty: high. The failure line, the user and the file mode are all on record; only the runner's exact uid is inferred.

**Decisions.**

- **What should the precondition check?**
  - **Follow C20: assert the bind with `docker inspect` (destination `/codex-home`, read-only) and read the imported `/home/node/.codex/config.toml` as `node` (recommended).**
    - Pros: independent of the host uid; checks what Codex in the container actually uses; the same pattern C20 already passes with (`container-live-qualification.test.ts:415-445`).
    - Cons: an indirect check of the mount's content (through the entrypoint's import).
  - **Read `/codex-home/config.toml` as root (`docker exec -u root`).**
    - Pros: one-word change; proves the mount's content directly.
    - Cons: tests an access `node` never makes, so it would hide a relay or import regression.
  - **Resolve the relay copy first, like `staged_input_path`.**
    - Pros: exercises the relay on CI.
    - Cons: the case takes a different branch per host, so a pass on omarchy-hp says nothing about the relay; the relay already has its own suite (`apps/backend/tests/staged-input-relay-docker.test.ts`).

### 2. Prove re-staging, not copying

**Problem.** The final assertion (`container-live-replacement.test.ts:280-284`) expects the candidate's `~/.codex/config.toml` to be the host value, with the comment "staged afresh from the host, not copied from the source's edited home". The source's copy holds the same value, so a migration that copied it would also pass.

**Context.** The main C14 case asserts `config.toml` is not carried over when nothing is staged (`:199-205`).

**Investigation.** The test never edits the source's copy, despite the comment. Certainty: high, from reading the test.

**Decisions.**

- **How to make the assertion discriminating?**
  - **Overwrite the source's `~/.codex/config.toml` with another value before migrating, and keep expecting the host value in the candidate (recommended).**
    - Pros: matches the comment; one extra `exec`; fails if the copy plan ever starts carrying configuration.
    - Cons: none seen.
  - **Leave it, relying on the main C14 case's "absent" check.**
    - Pros: no change.
    - Cons: that case stages nothing, so it does not cover a migration with staged inputs.

### 3. Correct the relay comment

**Problem.** The comment above the relay says that on a rootful daemon the backend's user "is the container's node" (`docker/network-policy-entrypoint.sh:145-147`), and `docker/AGENTS.md` describes the relay as a rootless measure. Both are true only when the host user is uid 1000.

**Context.** The relay's behaviour is already right for any uid: it runs whenever `node` cannot read a mount (`:175-176`). This is wording only.

**Investigation.** The CI runners are rootful with a non-1000 user, and C20 passes there only because the relay runs. Certainty: high.

**Decisions.**

- **Where to state it?**
  - **Reword the script comment and the `docker/AGENTS.md` bullet to "whenever `node` cannot read a mount: rootless Docker, or a host user other than uid 1000" (recommended).**
    - Pros: the next author of a live test knows the raw mounts are not readable to `node` on CI.
    - Cons: touches `docker/`, so the change triggers the container workflow (which this file's task 4 wants anyway).
  - **Leave the wording.**
    - Pros: no change.
    - Cons: it is what led a test to assume the raw mount is readable.

### 4. Green CI run

**Problem.** Nothing proves the fix until both runners pass.

**Context.** The workflow runs on pull requests that change `apps/backend/tests/container-live-*.test.ts` (`.github/workflows/container-live-qualification.yml:12-33`), weekly (Monday 04:17 UTC) and on demand. Main now contains both 0058 and 0109, so the next weekly run is expected to fail the same way.

**Investigation.** Of the 15 most recent runs, one passed (40338400817).

**Decisions.**

- **What counts as a pass?**
  - **The fix PR's own run, green on linux-x64 and linux-arm64, plus a local pass on a uid-1000 Linux Engine host (recommended).**
    - Pros: covers both host shapes; the PR triggers the run by its path filter.
    - Cons: the local half needs a quiet window on a busy host.
  - **CI only.**
    - Pros: disposable runners.
    - Cons: leaves the uid-1000 branch (no relay) unproved for the new assertion.

### 5. Whether the workflow should gate merges

**Problem.** Two PRs merged with this case red, and the workflow has been red on almost every run since 2026-10-26, so a new real failure would not stand out.

**Context.** The workflow is path-filtered and takes 17 to 20 minutes per architecture.

**Investigation.** It is not listed as a required check. A path-filtered workflow made required stays pending on PRs that do not touch its paths, which blocks them.

**Decisions.**

- **How should a red run stop a PR?**
  - **Keep it optional, and add a rule to `AGENTS.md`'s validation guidance (which review preparation reads) that a PR on which this workflow ran red needs a green rerun or a recorded reason before merge (recommended).**
    - Pros: no blocked unrelated PRs; follows `container-qualification.md`'s "fixed, or the reason is recorded" rule. The repository has no PR template to put it in.
    - Cons: relies on the reviewer reading the run.
  - **Make it required, with an always-running stub job for PRs outside its paths.**
    - Pros: a red run cannot merge.
    - Cons: every PR pays at least a job start; a flaky live case blocks unrelated work.

## Current state

- `container-live-replacement.test.ts:214-291` is the case. Its precondition
  at `:239` reads the raw staged mount as `node`.
- It fails on GitHub's runners on both architectures (runs 40333566613 and
  40409285999, 2026-10-26) and passes on omarchy-hp, where the host user is
  uid 1000.
- 0058 is marked Finished in the folder index, and its qualification evidence
  in `docs/development/container-qualification.md` comes from omarchy-hp only.
- The relay that makes owner-only staged inputs usable to `node` on any uid
  ships in `staged-inputs=3` images (`docker/network-policy-entrypoint.sh`).
- The workflow is not a required check.

## Outstanding work

### Code

1. Replace the precondition at `container-live-replacement.test.ts:239` with
   a `docker inspect` check of the `/codex-home` bind (read-only) and a `node`
   read of `/home/node/.codex/config.toml`.
2. Before the migration, overwrite the source's `~/.codex/config.toml`, and
   keep the candidate's expected value as the host's.
3. Reword the rootful case in `docker/network-policy-entrypoint.sh:145-147`
   and the staged-inputs bullet in `docker/AGENTS.md`.

### Qualification

- The fix PR's "Container live qualification" run passes every case in
  `container-live-replacement.test.ts` on linux-x64 and linux-arm64.
- The same file passes on a uid-1000 Linux Engine host with
  `RUN_LIVE_DOCKER_TESTS=1`, on a workspace-specific qualification image.

## Constraints and rationale

- Never widen the staged mounts' permissions to make a test pass
  (`docker/AGENTS.md`): the relay is the supported path.
- A live test must not assume the host user's uid. CI runners, rootless
  daemons and second users on a shared host all differ from uid 1000.
- Live Docker runs use a workspace-specific image and never
  `orkestrator-v2:latest`.

## Open questions

- Should other live tests be audited for raw reads of `/claude-config`,
  `/codex-home` and the other staged mount points as `node`? A search at
  `863b5782` found only this one; the C20 check that reads a raw mount is
  guarded by `test ! -r` under rootless.

## Needs verification

- The runner user's uid, read from a CI step (`id -u`), if the explanation is
  ever disputed.

## Related

- [0058-legacy-migration-root-symlink.md](0058-legacy-migration-root-symlink.md)
  (the source; its task analysis proposes deleting it once this file exists)
- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md) (the staged-input relay)
- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
- [Container qualification](../../development/container-qualification.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0058-legacy-migration-root-symlink.md](0058-legacy-migration-root-symlink.md)'s
task analysis.
