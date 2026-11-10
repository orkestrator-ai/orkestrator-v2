# Rootless Linux runtime gaps

## Task analysis

Analysed 2026-11-10 against main at `04639b12b71d4326a3b8941485367aca197f4966`.

This is a reference stub. Implementation and qualification are complete;
retirement waits for the inbound links in files owned by other builds to move.
The full historical evidence remains in Git before `eaa3cd985`.

### Tasks

1. Staged inputs readable by `node` on rootless: done.
2. Agent tools on rootless: done.
3. Read-only binds from `nosuid`/`nodev` sources: done.
4. Start retry on port collision: done.
5. Rootless re-run on a freshly built image: done 2026-11-09.
6. Retire the file: open (inbound reference migration only).

### 1. Staged inputs readable by `node` on rootless

**Problem.** Owner-only staged inputs were unreadable inside rootless containers.
**Context.** The root-phase relay is implemented.
**Investigation.** Its durable rationale now lives in [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs).
**Decisions.** Keep the architecture document as the current reference.

### 2. Agent tools on rootless

**Problem.** Rootless containers could not reach the host agent-tools service.
**Context.** Host-loopback detection is implemented.
**Investigation.** See [Agent tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts); the remaining driver gap is [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md).
**Decisions.** Keep current behavior and limits in those destinations.

### 3. Read-only binds from `nosuid`/`nodev` sources

**Problem.** Rootless bind refusals needed seed-copy handling and a typed error.
**Context.** Both are implemented.
**Investigation.** See [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs); later `docker cp` refusals belong to [7549](7549-rootless-docker-cp-refusals.md).
**Decisions.** Keep the follow-up refusals in 7549.

### 4. Start retry on port collision

**Problem.** An automatically chosen host port could collide during start.
**Context.** The single retry is implemented and was live-tested.
**Investigation.** Repeated collisions past that retry belong to [7549 task 3](7549-rootless-docker-cp-refusals.md#3-an-automatic-port-can-collide-twice-in-a-row).
**Decisions.** Preserve this heading while 7549 links to it.

### 5. Rootless re-run on a freshly built image

**Problem.** The earlier qualification did not use a freshly built image.
**Context.** The fresh-image run completed on 2026-11-09.
**Investigation.** The [qualification record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09) holds the results; gaps it found are in [7549](7549-rootless-docker-cp-refusals.md).
**Decisions.** Preserve the evidence there rather than duplicate the run here.

### 6. Retire the file

**Problem.** Deletion in `eaa3cd985` left ten inbound links in five files that the ticket excluded from editing.
**Context.** Those files are owned by concurrent builds. This stub keeps their links usable without editing them.
**Investigation.** Their owning edits must migrate the following references before this stub and its index row are deleted:

| Referrer | References at the reviewed head | Replacement destination |
| --- | --- | --- |
| 0019-container-platform-qualification.md | Lines 203, 1024, 1309 | Qualification record linked in task 5; architecture for current behavior |
| 6101-egress-name-checks-platform-coverage.md | Line 45 | Qualification record linked in task 5 |
| 6820-agent-tools-peer-gate-linux-evidence.md | Lines 51, 314 | Agent tools reachability linked in task 2 |
| 7548-rootless-gvisor-tap-vsock-host-loopback.md | Line 91 | Agent tools reachability linked in task 2 |
| 7549-rootless-docker-cp-refusals.md | Lines 6, 218, 220 | Qualification record linked in task 5; task 3 in 7549 for repeated collisions |

**Decisions.** Retain the stub until every inbound link has moved (recommended): this preserves references and avoids conflicts, at the cost of temporary documentation. Deleting immediately follows the usual retirement rule but breaks those links. Editing the five referrers now would remove the stub sooner but violates the ticket's scope.

## Assumptions and decisions

### Task 6: defer final deletion until referrers migrate

Restored this small reference stub on 2026-11-10 to address the review finding.
The implementation remains complete and its durable rationale remains in the
architecture document. Only reference migration delays deletion; this does not
reopen qualification or add implementation work.
