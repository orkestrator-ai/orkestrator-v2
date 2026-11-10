# Rootless Linux runtime gaps (retired)

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`.

Retired on 2026-11-10. Every task is done and nothing here is open: its
decisions are in [container lifecycle](../../architecture/container-lifecycle.md),
its qualification evidence is in the
[fresh-image re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09),
and the remaining rootless gaps are tracked in
[7548](7548-rootless-gvisor-tap-vsock-host-loopback.md) and
[7549](7549-rootless-docker-cp-refusals.md). This page holds no work; it only
forwards links that still name it (see Constraints and rationale). The full
historical file is in Git at `04639b12b`.

### Tasks

1. **Staged inputs readable by `node` on rootless**: done (`1aabf049`, #1307).
2. **Agent tools on rootless**: done; the gvisor-tap-vsock driver gap is [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md).
3. **Read-only binds from `nosuid`/`nodev` sources**: done; the `docker cp` refusals found later are [7549](7549-rootless-docker-cp-refusals.md) tasks 1 and 2.
4. **Start retry on port collision**: done; a second consecutive collision is [7549](7549-rootless-docker-cp-refusals.md) task 3.
5. **Rootless re-run on a freshly built image**: done 2026-11-09; the gaps it found are in [7549](7549-rootless-docker-cp-refusals.md).
6. **Retire the file**: done 2026-11-10; decisions 1, 4 and 6 moved to the architecture document, the body reduced to this forwarding record.

### 1. Staged inputs readable by `node` on rootless

**Problem.** Under rootless Docker, `node` could not read the owner-only staged mounts.
**Context.** Fixed by the root-phase relay.
**Investigation.** Current behaviour and the reason for the relay: [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs).
**Decisions.** None open.

### 2. Agent tools on rootless

**Problem.** A rootless container could not reach the agent-tools service.
**Context.** Fixed by probing RootlessKit's host loopback, otherwise showing an unavailable state.
**Investigation.** Current behaviour: [Agent tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts). The remaining gap, the gvisor-tap-vsock driver's `10.0.2.1`, is [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md).
**Decisions.** None open.

### 3. Read-only binds from `nosuid`/`nodev` sources

**Problem.** Rootless refused read-only binds from `nosuid`/`nodev` sources.
**Context.** Fixed by copying the GitHub seed in, with a typed refusal.
**Investigation.** Current behaviour: [Portable inputs](../../architecture/container-lifecycle.md#portable-inputs-staged-inputs). The `docker cp` refusals the 2026-11-09 re-run found are [7549 task 1](7549-rootless-docker-cp-refusals.md#1-docker-cp-refused-when-a-read-only-binds-source-is-nosuidnodev) and [7549 task 2](7549-rootless-docker-cp-refusals.md#2-docker-cp-into-a-container-that-is-not-running-fails-with-device-or-resource-busy).
**Decisions.** None open.

### 4. Start retry on port collision

**Problem.** An automatically chosen host port could collide during start.
**Context.** Fixed by one retry that reconnects the network.
**Investigation.** A collision that outlasts the single retry is [7549 task 3](7549-rootless-docker-cp-refusals.md#3-an-automatic-port-can-collide-twice-in-a-row).
**Decisions.** None open.

### 5. Rootless re-run on a freshly built image

**Problem.** The first rootless qualification did not use an image built from current `main`.
**Context.** Re-run on 2026-11-09 on a disposable rootless daemon; C20, C22 and readiness passed.
**Investigation.** Evidence: [qualification record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09). Gaps it found: [7549](7549-rootless-docker-cp-refusals.md).
**Decisions.** None open.

### 6. Retire the file

**Problem.** The file was complete once task 5 passed.
**Context.** `docs/README.md` moves durable content out and deletes a finished file.
**Investigation.** Decisions 1, 4 and 6 are in container-lifecycle.md ("Why a root-phase relay", "Why copy the seed and classify the rest", "Why detect rather than configure"). Links from files this change could edit were moved to those destinations or to 7548/7549.
**Decisions.** Keep this forwarding record, marked Finished, rather than deleting it outright; see Constraints and rationale.

## Constraints and rationale

Ten links in 0019, 6101, 6820, 7548 and 7549 still name this file. Those files
belong to builds running at the same time and were out of scope for the change
that retired this one, so they could not be edited. Deleting this file would
leave those links broken and give a reader no route to 7548 and 7549. The
folder already keeps finished files that other files cite (7041, 7081, 7470),
so this record stays with **Finished** Yes. Delete it, and its index row, once
no file links here.

| Referrer | Where it links | Destination for that link |
| --- | --- | --- |
| [0019](0019-container-platform-qualification.md) | Three links (rootless qualification, Related) | [Qualification record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09), 7548, 7549 |
| [6101](6101-egress-name-checks-platform-coverage.md) | Task context (rootless hosts) | [Qualification record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09) |
| [6820](6820-agent-tools-peer-gate-linux-evidence.md) | Task problem (host loopback), Related | [Agent tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts), 7548 |
| [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md) | Related | [Agent tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts) |
| [7549](7549-rootless-docker-cp-refusals.md) | Introduction, Related (including task 4) | [Qualification record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09); 7549 task 3 for repeated collisions |

## Assumptions and decisions

### Task 6: a finished forwarding record instead of deletion

Chosen on 2026-11-10. Deleting the file (the default rule) left the ten links
above broken; editing their files breaks the ticket's scope. A forwarding
record marked Finished, with no open task, keeps every link working and routes
each remaining gap to 7548 or 7549, and follows the folder's practice of
keeping cited finished files. An earlier draft of this record left task 6 open
and the row unfinished; this one closes both.
