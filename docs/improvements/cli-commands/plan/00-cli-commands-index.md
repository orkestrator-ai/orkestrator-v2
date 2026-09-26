# CLI commands — implementation plan

Status: Planned; implementation has not started.
Prepared: 2026-09-26.
Source review: [CLI commands for composability and targeted testing](../../cli-commands.md),
against revision `06af4d86`.

## Intended outcome

Provide a supported `orkestrator` client for creating and editing projects and
environments, starting and controlling native-agent conversations, sending
prompts, and observing the outcome of a particular request. Every ongoing
operation remains owned by the existing backend, bridge, or external process.
Scripts can disconnect and return using a durable receipt; a visible desktop
tab is never required for progress or recovery.

The plans describe future implementation. They do not claim that proposed
commands, public operation records, or qualification tests already exist.
Keep the source review as the dated findings document and track implementation
and evidence here.

## Numbered steps

| Step | Plan | Required predecessors | Status |
| --- | --- | --- | --- |
| 01 | [Public command and compatibility contract](01-public-command-and-compatibility-contract.md) | None | Planned |
| 02 | [Separate CLI client and service startup](02-client-and-service-entrypoints.md) | 01 | Planned |
| 03 | [Connection discovery and authenticated transport](03-connections-and-authenticated-transport.md) | 01, 02 | Planned |
| 04 | [Shared backend actions and read-only discovery](04-shared-actions-and-discovery.md) | 01, 03 | Planned |
| 05 | [Durable operation receipts and idempotency](05-operation-receipts-and-idempotency.md) | 01, 04 | Planned |
| 06 | [Project creation, metadata, and removal](06-project-commands.md) | 04, 05 | Planned |
| 07 | [Environment creation and lifecycle](07-environment-lifecycle.md) | 04, 05, 06 | Planned |
| 08 | [Project and environment settings](08-settings-and-concurrent-edits.md) | 06, 07 | Planned |
| 09 | [Session creation and prompt dispatch](09-sessions-and-prompt-dispatch.md) | 04, 05, 07, 08 | Planned |
| 10 | [Request-specific completion and waiting](10-run-completion-and-waiting.md) | 05, 09 | Planned |
| 11 | [Session controls and pending interactions](11-session-controls-and-interactions.md) | 09, 10 | Planned |
| 12 | [Bounded transcripts and resumable observation](12-transcripts-and-observation.md) | 04, 09, 10 | Planned |
| 13 | [Structured environment command execution](13-environment-command-execution.md) | 05, 07, 10 | Planned; second stage |
| 14 | [Targeted scenarios and real-stack qualification](14-targeted-testing-and-qualification.md) | 06–12 for full qualification; 13 for exec cases | Planned |
| 15 | [Packaging, operator documentation, and rollout](15-packaging-documentation-and-rollout.md) | 01–12, 14; 13 if shipped | Planned |

Numeric order is the default. Step 14's harness and first local-worktree smoke
should be built incrementally with steps 04–07, not postponed until all commands
exist. Step 15's packaging checks also accompany step 02 and each new command.
Steps 11 and 12 are independent once their prerequisites are complete.
Step 13 and the event-following extension in step 12 are not prerequisites for
the initial supported command set.

## Delivery milestones

| Milestone | Deliverable | Release gate |
| --- | --- | --- |
| A: inspect an existing backend | Explicit connection, help/version, project/environment/session discovery, machine output | Steps 01–04 and corresponding packaged-client tests |
| B: reproducible workspaces | Project and environment creation/editing/lifecycle, durable receipts, readiness, safe cleanup | Steps 05–08 and credential-free local-worktree scenario from 14 |
| C: compose agent work | Start/follow up/control a session, answer interactions, inspect transcripts, reconcile and wait for a particular run | Steps 09–12 and full core qualification in 14 |
| D: execute repository checks | Structured local/container exec with authoritative exit status | Step 13 and its additional qualification |

Each published milestone also passes the relevant checks in step 15. Do not
publish `run wait` as a success signal before step 10 qualifies completion for
the advertised provider. Capability discovery can leave an unqualified
provider's completion support unavailable while preserving supported actions.

## Architecture and scope

The public CLI is a thin client of the existing authenticated gateway. Public
actions enter the same command registry and backend services used by other
clients. Extract reusable Control MCP validation and tab-resolution behavior;
retain its role checks in the authority boundary. Do not implement Docker,
worktree, provider, or settings persistence separately inside the CLI.

The initial implementation does not require a new listener, daemon, SDK
dependency, agent upgrade, or application version bump. It preserves the
existing foreground launcher, adds explicit `serve`, and never silently
starts a second backend for a client command.

Local-only project initialization, project-removal cascade, declarative apply,
scenario DSLs, prompt attachments, shell completion, and worker-scoped CLI
credentials are follow-on work unless explicitly added to a numbered step.
Keep their absence visible in help/capabilities. This plan does include explicit
private-GitHub project creation using the existing backend operation.

## Contracts that apply to every step

1. Resolve a concrete backend and resource identity. Explicit profile failures
   never fall back to production; desktop selection never chooses a target.
2. Backend state owns accepted work. CLI exit, unmount, navigation, timeout of
   an observer, and dropped SSE do not cancel an operation.
3. Separate admission, dispatch, execution, and observation outcomes. Running
   does not imply setup-ready; accepted or idle does not imply completed.
4. Bind idempotency keys to canonical intent and persist before side effects.
   Never retry ambiguous execution under a new key automatically.
5. Expired, missing, corrupted, and old-generation evidence is not proof that
   an action never ran. Retention must not reopen an executable request key.
6. Preserve provider capabilities and intent. Unsupported steering or a selected
   slash command must not become ordinary prompt text.
7. Read authoritative snapshots after missed events. Background status checks
   must not hydrate full transcripts or keep idle provider sessions attached.
8. Stop requests and approval answers refer to an exact current target. Unknown
   cancellation is not success; malformed/expired approvals never approve.
9. Every request, page, replay queue, operation store, and capture buffer has
   byte/count bounds and a defined overflow result.
10. Routine output and telemetry use bounded public metadata. Credentials,
    prompt bodies, attachments, file contents, and terminal contents stay out
    of logs; explicit content reads have separate bounds.
11. Patches run under backend validation and concurrency control. A client
    must not replace a whole configuration document to change one setting.
12. Preserve old web/desktop callers and existing server flags. Add capabilities
    and structured outcomes without silently redefining legacy responses.

The governing instructions are [AGENTS.md](../../../../AGENTS.md). When an
implementation needs library or vendor API behavior, consult current Context7
documentation and the pinned source/types as required there. This planning work
does not require an external-library change.

## Decisions made for planning

| Topic | Default |
| --- | --- |
| Command grammar | Singular nouns; IDs are authoritative; name conveniences require an explicit unique scope |
| Connection selection | Explicit connection or dev profile; otherwise an explicitly configured default; no implicit port scan |
| Transport | Existing gateway invoke route and bearer authentication |
| Output | Versioned single JSON envelope, explicit ID output, separate JSONL following |
| Remote paths | Project/workspace paths are on the backend; prompt/patch files are on the client |
| Project removal | Refuse while child environments exist; no cascade in the initial implementation |
| Busy session | Reject ordinary follow-up by default; steering and supported queueing require explicit intent |
| Waiting | Bounded snapshot polling first; Ctrl+C stops observing and preserves a recovery receipt |
| Completion | Positive evidence for one request; unsupported/unknown if a provider cannot supply it |
| Exec and events | Second-stage exec; event following optional after snapshot reads are correct |

The exact public schema, capability names, retention limits, installed-instance
descriptor, and per-provider completion mappings are implementation decisions
owned by steps 01, 03, 05, and 10. Those steps must record their decisions and
tests before exposing dependent mutations. They are engineering work, not a
requirement to stop this planning task for approval.

## Validation and evidence

Follow the [testing guide](../../../development/testing-guide.md) and
[isolated-stack guide](../../../development/agent-testing.md). Each step adds
the smallest meaningful regression tests at the owning layer, then runs the
required affected/static/full checks. Use repository mise tasks and explicit
focused Bun test paths; never bare root-level `bun test`.

Use controlled provider barriers for lifecycle races, real temporary storage
for restart/durability, and actual Git worktrees for filesystem behavior.
Do not equate mocks, a clean shutdown, or source inspection with a crash-recovery
or live-provider result. Tests must own their processes, ports, data roots, and
Docker labels and confirm cleanup before deleting fixture directories.

Record evidence with each implementation step: changed owners, cases exercised,
commands and exit codes, profile/run IDs, relevant revision and toolchain,
bounded artifact paths, compatibility checks, and remaining limitations.
Add proposed test paths/tasks only when implemented; do not document an invented
mise task as an existing validation command.

## Completion tracking

Use `Planned`, `In progress`, `Verified`, and `Merged`. `Verified` requires the
step's acceptance criteria and its required QA evidence. `Merged` requires a
human-maintainer merge; agents must not merge into `main`. Dependencies should
be verified before a dependent contract is released, even if implementation
changes share a PR.

- [ ] Existing service startup remains compatible and client commands stay clients.
- [ ] Explicit connection identity prevents accidental production targeting.
- [ ] Projects/environments can be created, edited, started, and cleaned up.
- [ ] Same-key replay and conflicting reuse behave correctly through restart/deletion.
- [ ] Prompt runs have request-specific, recoverable outcomes.
- [ ] Controls/interactions remain correct with inactive environments and concurrent tabs.
- [ ] Snapshot/transcript reads are bounded and do not alter background liveness.
- [ ] Credential-free, live-provider, UI, and Docker evidence are distinguished.
- [ ] Packed distribution and operator documentation match shipped capabilities.

## Related work

Coordinate with the [inconsistency remediation plan](../../inconsistencies/plan/00-index.md)
for bridge publication, session retention, and late-work ownership. Do not assume
its planned fixes are present. Reuse existing contracts and record a dependency
when a provider cannot be qualified until one of those fixes lands. The
[slash-command plan](../../slash-commands/plan/00-index.md) owns selected-command
semantics; the [test-streamlining plan](../../streamlining-tests/plan/00-index.md)
owns suite efficiency work. CLI scenarios should complement those efforts.
