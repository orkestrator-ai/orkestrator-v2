# Container improvements — implementation plan

Status: Active plan; all implementation steps are **not started**.

Prepared: 2026-09-21 against `88c2f9cc`.
Source: [container investigation](../../containers.md).

## Outcome

Keep one long-lived development container per environment, but make the runtime
replaceable without silently discarding work. Backend-owned operations must
survive renderer inactivity and recover from backend crashes. Host inputs,
network access, resource consumption and diagnostic output must have explicit
boundaries. An image upgrade must be identifiable, compatible and recoverable.

This directory is an implementation specification, not evidence that these
features exist. Proposed filenames, types and commands are marked as such.
Existing source links identify integration points, not APIs to replace blindly.
Recheck those points when beginning a step because the repository can change.

## Steps and dependencies

Execute in numerical order unless the listed dependencies are already complete.
Each row can require several small pull requests; it is not a recommendation to
combine the whole row into one large change.

| Step | Plan | Depends on | Status | Deliverable |
| --- | --- | --- | --- | --- |
| 01 | [Immediate data-loss safeguards](01-immediate-data-loss-safeguards.md) | — | Implemented, in review | Accurate warnings, protected cleanup and safe failure of legacy recreation |
| 02 | [Lifecycle authority and durable operations](02-lifecycle-authority-and-durable-operations.md) | 01 | Implemented, in review | Shared ownership checks, operation records, serialization and reconciliation |
| 03 | [Image contracts and daemon preflight](03-image-contracts-and-daemon-preflight.md) | 02 | Not started | Immutable image identity, capabilities and supported topology checks |
| 04 | [Runtime readiness and graceful shutdown](04-runtime-readiness-and-graceful-shutdown.md) | 02, 03 | Not started | Generation-bound readiness, process draining and safe setup retries |
| 05 | [Persistent workspace and agent state](05-persistent-workspace-and-agent-state.md) | 02, 03, 04 | Not started | Versioned, owner-labeled storage for new environments |
| 06 | [Migration and transactional replacement](06-migration-and-transactional-replacement.md) | 04, 05 | Not started | Verified migration, replacement commit point and rollback rules |
| 07 | [Recovery, deletion and cleanup UX](07-recovery-deletion-and-cleanup-ux.md) | 02, 05, 06 | Not started | Exact cleanup inventory and resumable, intentional data deletion |
| 08 | [Portable inputs and credential lifecycle](08-portable-inputs-and-credential-lifecycle.md) | 02, 03, 04 | Not started | Bounded staging, provider scope and refresh/revocation behavior |
| 09 | [Environment networks and egress policy](09-environment-networks-and-egress-policy.md) | 02, 03, 04 | Not started | Separate networks, narrow host access and tested effective policy |
| 10 | [Resource budgets and usage telemetry](10-resource-budgets-and-usage-telemetry.md) | 02, 03, 04 | Not started | Configurable limits and truthful bounded usage snapshots |
| 11 | [Bounded logs and diagnostic subscriptions](11-bounded-logs-and-diagnostic-subscriptions.md) | 02, 04 | Not started | Rotated logs, bounded tails and owned log followers |
| 12 | [Image build and release delivery](12-image-build-and-release-delivery.md) | 03 | Not started | Multi-stage builds, reproducible artifacts and compatibility checks |
| 13 | [Performance baselines and targeted optimization](13-performance-baselines-and-targeted-optimization.md) | 06, 08–12 | Not started | Comparable measurements and evidence-based optimization decisions |
| 14 | [Integrated qualification and rollout](14-integrated-qualification-and-rollout.md) | 01–13 | Not started | Cross-platform failure matrix, staged adoption and release evidence |

Step 12 can introduce the build structure after step 03; its final image must
include and qualify the contracts added by subsequent steps. Step 13 completes
with measurements and decisions even if no additional optimization is justified.
External egress enforcement is a separately gated experiment in step 09, not a
dependency that blocks shipping the other improvements.

## Cross-cutting design decisions

| Concern | Decision |
| --- | --- |
| Container lifetime | Stop/start retains work. Runtime rebuild preserves declared workspace/session state. Reset and permanent delete are distinct operations. |
| Storage | Prefer per-environment named volumes. Never mount all of the user's host checkout or all of `/home/node` to obtain persistence. |
| Authority | Backend storage plus verified Docker state; React state and live events are projections only. |
| Recovery | Persist intent before external effects. Reconcile ambiguous effects by exact identity; do not blindly repeat create, setup, delete or agent dispatch. |
| Ownership | App, owner, environment and resource-role labels are checked in every entry path. Existing strict-profile protection is retained and generalized. |
| Replacement | Build and validate a candidate against a separate storage copy before committing its pointer. Never run old and candidate workloads as simultaneous writers. |
| Rollback | Before commit, return to the original stopped source. After new writes, preserve candidate data and repair forward; switching to an older copy is an explicit restore. |
| Compatibility | A versioned image capability manifest gates behavior. Unknown old images keep guarded legacy operations and cannot silently receive new assumptions. |
| Networking | Per-environment bridges and explicit host-service rules first. Do not claim IP allowlisting provides complete exfiltration prevention. |
| Privileges | Preserve current restricted-mode sudo constraints until a tested replacement exists. Do not add blanket sudo or mount the Docker socket. |
| Scope | Continue using Docker CLI primitives behind a small backend service. No Kubernetes, wholesale Docker SDK rewrite or per-agent image matrix. |

### Identities that must not be conflated

- `environmentId`: stable user-visible environment identity.
- `runtimeGeneration`: changes when the container instance is replaced.
- `bootId`: changes each time that instance starts, including Docker restarts.
- `workspaceGeneration`: changes on an intentional workspace reset/import,
  not a runtime-only rebuild. It anchors checkout baseline and setup meaning.
- `storageSetId`: identifies the physical workspace/session volumes. A verified
  replacement copy can have a new storage set for the same workspace generation.
- `operationId`: idempotency/recovery identity for one requested mutation.
- `revision`: monotonic backend state revision for conflict detection and UI
  catch-up. It is not a Docker timestamp or an agent turn ID.

These are proposed field names. Step 02 must define one shared representation
and validation policy, and later steps must use it consistently.

## Findings coverage

| Investigation finding | Implementation steps |
| --- | --- |
| 1. Filesystem loss and misleading preservation promise | 01, 05, 06, 07 |
| 2. Stale setup and retained-name replacement failures | 01, 02, 04, 06 |
| 3. Broad host-home exposure | 08; 05 must keep imported credentials out of selected durable state |
| 4. Mutation/ownership inconsistency | 02, 07 |
| 5. Network policy gaps | 03, 09 |
| 6. Readiness and shutdown gaps | 04, 06 |
| 7. Resource, telemetry and log bounds | 10, 11 |
| 8. Image size and upgrade compatibility | 03, 12 |
| 9. Missing measurements and daemon-locality contract | 03, 13 |

## Validation and completion rules

### Decisions that must be closed during implementation

| Decision | Owning step | Gate |
| --- | --- | --- |
| Supported reader/writer schema floor and downgrade enforcement | 02 | Before writing durable operation/storage versions |
| Minimum tested Engine/Desktop versions and rootless support | 03, confirmed in 14 | Before advertising supported topology |
| Exact resume-critical provider paths/formats | 05 | Before advertising provider session preservation |
| Archive metadata fidelity and safe extraction implementation | 06 | Before migrating any existing workspace |
| Aggregate input staging budget | 08 | Before enabling staged inputs by default |
| Required host callback rules and IPv6 behavior | 09 | Before replacing the default network policy |
| Measured default resource profiles | 10, confirmed in 13 | Before applying limits to new environments by default |

These are explicit implementation gates, not permission to ship placeholder
behavior. Resolve them through source tracing and isolated measurements, record
the chosen result in the owning step, and gate unsupported cases in the product.

### Evidence and status

Each step specifies focused tests, real Docker scenarios and completion
criteria. Follow the [testing guide](../../../development/testing-guide.md)
and [isolated agent guide](../../../development/agent-testing.md). Use Bun and
mise, explicit test paths and the logged runner. A fake Docker executable is
useful for error injection, but cannot prove filesystem retention, kernel
network rules, actual mount permissions, name conflicts or signal delivery.

For every user-visible lifecycle change, start work, switch to another
environment, let it progress, reconnect if applicable, then return. Verify
status, transcript, pending approvals, controls and operation progress against
backend snapshots. Unmount must not cancel work. Every new event stream needs
bounded replay or an explicit reconciliation signal.

Do not log prompts, terminal contents, credential values, copied file contents
or archive manifests as telemetry. Keep sensitive artifacts private and bounded.
No global Docker prune and no testing against production environments.

An implementation step is complete only when its checklist and exit criteria
are satisfied, relevant tests have passed, limitations are recorded, and a human
has merged its pull request. Update the step and this index together. Agents
may prepare branches and PRs, but must not merge into `main`.

## Plan maintenance

Maintain a short implementation record at the end of each step: PR/commit,
schema or API decisions, commands/results, real-platform evidence and remaining
limitations. Do not mark skipped Docker/Desktop/provider tests as passed.
Keep the investigation a dated snapshot; maintain current decisions here and
move shipped operating behavior into living architecture/development docs.
