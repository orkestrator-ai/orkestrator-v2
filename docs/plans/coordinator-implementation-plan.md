# Project coordinator implementation plan

Status: Done — implemented.

The project landing page will open a **Coordinator** tab by default. Its chat
runs against the project's actual local checkout, can inspect the codebase and
discuss ideas, and delegates implementation to environments through the
Orkestrator control MCP. The coordinator cannot edit project files. A user can
explicitly switch the checkout's branch or synchronize it through the UI.

**1. Product behavior and initial decisions**

- Project navigation becomes **Coordinator / Kanban / GitHub / Linear /
  Features**, with Coordinator first and selected by default. Existing boards
  remain available. Preserve a user's selection during the current application
  session; a fresh application launch defaults to Coordinator, matching the
  current non-persisted board-selection behavior.
- Use the same segmented selector for project navigation and the new-environment
  modal's **A feature / With a prompt** choice. Extract their shared component
  instead of copying its styles.
- Entering Coordinator creates or resumes a durable coordinator workspace and
  one native conversation tab. Repeated mounts and simultaneous windows must
  converge on the same initial tab. Creating the session must not send a prompt
  or launch an environment automatically.
- Reuse native chat rendering, model selection, streaming, questions, history,
  cancellation, and message queues. Offer additional coordinator conversation
  tabs using the same lifecycle once the initial tab exists. All tabs share the
  project's real checkout and current branch.
- Display the project path, current branch, upstream status, and a persistent
  **Read-only coordinator** indicator. Composer copy should explain that code
  changes happen in environments.
- Default to the configured agent if it passes coordinator capability checks.
  Support configured providers only after enforced read-only access and MCP
  messaging have been verified. Never silently fall back to unrestricted access
  or silently switch the user's provider. Provider coverage remains an explicit
  implementation gate, not a claim that every existing bridge already supports it.
- A project without a valid `Project.localPath` shows a local-checkout setup
  state. It cannot silently use an environment worktree, create a container, or
  substitute a temporary clone for the requested project root.
- Automatic acceptance means authenticated coordinator messages are eligible
  for delivery without a per-message confirmation. It does not mean answering
  arbitrary tool approvals or user questions automatically.

**2. Existing code and the gaps to close**

| Area | Existing implementation | Required change |
| --- | --- | --- |
| Project landing page | `apps/web/src/App.tsx` renders `KanbanBoard` when a project is selected without an environment | Add a project-page host that selects Coordinator or the existing boards |
| Board selection | `uiStore.ts` defines `ProjectBoardTab`; `ActionBar.view.tsx` has separate desktop tabs and compact controls | Add Coordinator and use one shared segmented selector across responsive layouts |
| Reference selector | `FeatureBuildFields.tsx` renders its choice as inline buttons | Extract a typed, reusable UI component and retain the modal's appearance |
| Native sessions | `native-agent-service-*`, native projections, prompt queues, and `AgentNativeTab` | Introduce project-owned session context without requiring a running environment |
| Workspace data | Backend `models.ts` and web `types/index.ts` distinguish only local and containerized environments | Model coordinator ownership separately from disposable environments |
| Control MCP | `control-mcp-server.ts` exposes discovery, tickets, environment/job launches, prompts, and external inbox messages | Add scoped coordinator identity, workflow controls, and authenticated mailbox tools |
| Agent messaging | `agent-tools-messaging.ts`, `storage-agent-mail.ts`, `agent-mail-service.ts`, protocol `agent-mail.ts` | Address coordinator mailboxes and permit bounded two-way coordinator delivery |
| Build/review | Backend build-pipeline and multi-review services already supervise durable workflows | Expose these services through MCP and associate their results with the originating coordinator |
| Git helpers | `commands-agent-support.ts:listGitBranchesAtPath` is intended for environment naming | Add structured project Git status; this helper collapses remote names and swallows fetch failures |

Three messaging details are particularly important. Control-MCP messages are
currently classified as external and cannot auto-inject. The delivery service
requires a ready running environment. In addition, storage blocks injection
after prior injected-message lineage, and the carrier explicitly tells agents
they are not authorized to follow peer instructions. Changing only the default
inbox policy would therefore fail this feature.

**3. Project-owned runtime and persistence**

Introduce a discriminated session owner / execution context shared by protocol,
backend, and frontend:

```ts
type AgentSessionOwner =
  | { kind: "environment"; projectId: string; environmentId: string }
  | { kind: "coordinator"; projectId: string; coordinatorId: string };
```

The exact names can follow repository conventions, but the distinction must be
explicit. A coordinator is not a local environment whose `worktreePath` happens
to point at the project root. Existing delete, merge, setup, and cleanup paths
assume they own a disposable workspace; routing the root through them risks
modifying or deleting the real checkout.

Persist one coordinator workspace per project, with a stable ID, tab layout,
selected tab, session mappings, immutable execution policy, repository-context
revision, lifecycle state, and sanitized last startup error. Persist workflow
associations separately so their lifetime is independent of an open chat tab.
Use normal storage serialization, bounded records, schema versions, and manifest
revisions. Existing records without an owner migrate to environment ownership.

Add a backend `CoordinatorService`, registered through `createCommandRegistry`,
with operations to ensure the workspace, retrieve its snapshot, create/resume/
close a conversation, and pause/resume coordination. Ensure must serialize by
project and recover partially completed creation after restart.

Introduce a workspace resolver that provides the canonical working directory,
runtime availability, bridge identity, and policy from the persisted owner.
Generalize the native service's environment-specific readiness and connection
resolution through this boundary. Existing environment command payloads remain
valid through an adapter; new coordinator commands carry explicit ownership.
Use distinct cache and logical-session key namespaces so a coordinator cannot
share a permissive worker provider accidentally.

Audit each environment-ID dependency in session persistence, native projections,
prompt queues, compose-draft occupancy, attachment staging, mailbox addressing,
bridge routing, and transcript history. Adapt these at their boundaries instead
of manufacturing an environment row with fake setup/running flags. Keep worker
build and review services environment-only.

Launch the coordinator bridge from its trusted installed package directory,
then supply the canonical project root as the agent's working directory. Do not
run project setup scripts, install dependencies, copy environment files, or load
arbitrary project startup hooks as part of coordinator initialization. Runtime
state, transcripts, attachments, generated configuration, and scratch files
belong under application data, outside the project checkout.

Unmounting the page or changing projects detaches the view only. Backend-owned
sessions, pending mail, and workflows continue. On return, hydrate transcripts,
activity, controls, pending questions, repository state, and mail from snapshots.
Use events as incremental updates with detectable gaps, and preserve existing
replay and dispatch invariants. Idle coordinators may detach providers using
non-touching activity probes; queued work reattaches them transparently.

Explicitly closing a conversation settles live approvals, revokes its credential,
and tombstones its mailbox without deleting provider history or the checkout.
Do not immediately recreate a tab the user just closed; show a New conversation
state. Worker jobs continue and their results remain in project workflow history;
another coordinator tab can explicitly adopt them. Project removal tears down
coordinator processes and records, never the user's local repository.

**4. Enforced read-only coordinator policy**

Add a persisted execution policy such as `coordinator-read-only`, separate from
the selectable plan/build conversation mode. Resolve it from trusted backend
ownership on every create, resume, fork, dispatch, queued-message delivery, and
provider-control update. Reject attempts to replace it through renderer commands,
slash commands, restored settings, MCP arguments, or approval responses.

The policy permits code reading, searching, discussion, and the scoped
Orkestrator MCP controls. It denies direct file writes, patches, write-capable
shell execution, arbitrary process controls, and tools that can bypass the
filesystem restriction. All code changes, including fixes to review findings,
must run in worker environments.

For Codex, the checked-in bridge already carries explicit sandbox configuration
at thread creation and turn dispatch. Pin read-only independently of conversation
mode and prevent escalation. The official app-server documentation confirms
that turn settings can override the sandbox and persist as later defaults,
which makes enforcement on every dispatch necessary. Validate exact fields
against the repository's pinned generated protocol, rather than adopting newer
documentation fields automatically. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

For Claude and other providers, verify tool denial, subprocess behavior, and
read-only enforcement against their pinned SDK and runtime before enabling them.
The current Claude prompt path commonly uses `bypassPermissions`; it must not
be reused as the coordinator policy. If a provider cannot safely expose a shell,
offer bounded read/search tools without arbitrary execution. A provider that
cannot enforce the boundary remains unavailable with a clear explanation.

Restrict coordinator MCP configuration to approved Orkestrator capabilities;
inherited write-capable filesystem MCP servers, project extensions, hooks, or
other execution paths must not provide an escape. The coordinator token cannot
invoke a generic backend command dispatcher, launch a job in its own root,
merge a worker into that root, change application settings, or mint credentials.
MCP tool annotations describe behavior but do not enforce it; backend scope and
target validation do.

Restrict agent-readable paths to the project and required safe runtime resources.
In particular, it must not be able to read the general control-MCP credential or
renderer gateway credential and use that broader identity instead. Keep required
provider authentication available to the trusted runtime without exposing those
files through agent read tools. Include this boundary in provider qualification.

Git synchronization and branch switching are separate, user-triggered backend
operations. They are intentionally allowed to change the checkout, but are not
tools exposed to the coordinator agent. Do not offer an approval path that turns
a coordinator into an editor.

**5. Branch selection and synchronization**

Add a backend project Git service keyed by canonical checkout path, with
structured status and operation snapshots. Resolve paths from `Project.localPath`
and validate the actual repository root; do not accept caller-provided paths.
Preserve local and remote branch identities rather than stripping `origin/`.

Status should include current branch or detached HEAD, HEAD commit, configured
upstream and remote, ahead/behind counts, tracked/untracked changes, conflicts,
ongoing merge/rebase state, branches occupied by other worktrees, fetch freshness,
operation progress, and a structured last error. Represent unknown remote state
explicitly instead of treating fetch failure as “up to date.”

On entering the page, read local status immediately and schedule a deduplicated,
bounded fetch using the tracked remote. Reuse `git-fetch-scheduler.ts` where its
locking and error behavior fit. Refresh on focus, explicit refresh, Git changes,
and successful mutations, with a cooldown rather than aggressive network polling.

| Repository state | UI behavior |
| --- | --- |
| Behind upstream, no local divergence | Show “N commits behind” and an explicit Sync action |
| Equal | Show Up to date after a successful fresh fetch |
| Ahead only | Show local ahead count; no pull needed |
| Ahead and behind | Show divergence and explain that automatic fast-forward sync is unavailable |
| Fetch/auth/network error | Retain local status, mark remote status stale, show details and Retry |
| Missing upstream, detached/unborn HEAD | Show the specific state; disable sync until a valid tracking branch exists |
| Dirty checkout, conflicts, merge/rebase in progress | Allow read-only conversation; block branch/sync operations with an actionable reason |

Sync performs an explicit fast-forward-only pull against the branch's configured
upstream, with autostash/rebase behavior disabled. It must not reset, force,
auto-stash, create a merge commit, or resolve conflicts. Fetch alone updates
remote knowledge without merging; fast-forward-only integration refuses
divergence. See [Git pull](https://git-scm.com/docs/git-pull) and
[Git upstream branches](https://git-scm.com/docs/gitglossary#def_tracking_branch).

The dropdown lists local branches and unambiguous remote tracking choices. A
remote-only selection can create the corresponding local tracking branch.
Refuse occupied branches and preserve Git's normal worktree checks; do not use
force switching or `--ignore-other-worktrees`. Validate refs and use subprocess
argument arrays, not shell interpolation. See [Git switch](https://git-scm.com/docs/git-switch).

Serialize sync and switch operations by canonical repository, across windows
and coordinator tabs. Hold a repository mutation lease that also prevents new
coordinator turns and mail injections from starting. Mutations are unavailable
while any coordinator turn is running, waiting, cancelling, or recovering; the
user can stop the turn and retry once the backend confirms it settled. Recheck
HEAD, branch, dirty state, and upstream after acquiring the lease.

On success, increment repository context revision, refresh files/status, and
append a visible context-change event to affected chats. Supply the new branch
and commit context before their next turn so the agent does not assume its old
analysis still describes the checkout. Detect external branch/HEAD changes as
well and mark analysis potentially stale; application locks cannot stop another
terminal from modifying Git.

Failures need persistent, expandable UI details with operation, exit code,
bounded sanitized stderr, and retry guidance. Redact credentials and strip
control sequences before persistence/rendering. After timeout or restart,
inspect repository state before retrying a mutation; an interrupted request may
already have completed. Fetch errors must remain visible instead of disappearing
into the current branch-name helper's catch path.

**6. Scoped access to the external Orkestrator MCP**

Extend the existing control MCP surface rather than creating a competing set of
orchestration tools. Keep the ordinary external-client credential and semantics.
Add backend-issued coordinator credentials bound to project, coordinator,
conversation tab, mailbox incarnation, and allowed capabilities. Authenticate
the role server-side; a caller cannot gain coordinator privileges by supplying
`role: coordinator`, a sender tab ID, or text in its message.

Inject credentials into private runtime configuration outside the checkout,
never the system prompt, transcript, frontend snapshot, or logs. Revoke them
when the tab/session is retired, and reissue them on backend restart before
reattachment. Revalidate scope per request, including existing MCP sessions.
If control MCP is disabled or unavailable, explain why orchestration is blocked;
do not silently re-enable an explicitly disabled service.

Coordinator discovery returns current-project environments, tabs, mailboxes,
agent/model choices, workflow summaries, and bounded transcripts. Mutations
validate project membership and disposable worker ownership. Preserve external
client compatibility while sharing handlers and validation internally.

Required control operations:

- Launch a local/container environment, with explicit base branch/commit and
  initial coordinator delegation context. Return durable environment and tab
  IDs even when startup fails, so retries do not create duplicates.
- Start/stop an existing worker environment and launch independent worker jobs
  within the allowed project. Prefer mailbox messaging for existing-tab work
  requests rather than direct `send_prompt_to_tab` injection.
- Start/get/pause/resume/cancel a build pipeline through existing backend services.
- Start/get/cancel a multi-review, choose reviewers/fix model, and invoke the
  existing address-findings operation when requested.
- List/read/send/reply/acknowledge messages and inspect delivery status with a
  coordinator mailbox identity.

Use stable request IDs and durable action receipts for every launch or workflow
mutation that can create work. `StartMultiReviewInput` currently lacks a caller
request ID, so its public mutation path needs an idempotency extension or a
durable wrapper that records the resulting workflow. Claim/reserve before side
effects and reconcile partial success after restart; an in-memory cache is not
sufficient. Reject reuse with a different payload.

Resolve base branch and commit at delegation time. Thread them through local
worktree and container creation and persist them on the task/workflow. Otherwise
a later branch switch or pull could make an environment start from code other
than the version discussed. Distinguish starting a coding agent with a prompt
from starting the application's structured Build pipeline; expose both clearly.

If the root has uncommitted changes, show that its live contents differ from the
delegation base. Default worker creation to the recorded commit and do not copy,
stash, or commit those changes implicitly. If the task depends on them, surface
the mismatch before launching and require an explicit transfer decision. Capturing
and applying a user-selected patch in a worker can be a separate follow-up feature.

**7. Automatic two-way messaging and role context**

Generalize mailbox ownership so a coordinator is addressable without an
environment. Add authoritative conversation-role and coordinator-association
metadata to mailbox descriptors and delegation records. Preserve existing
environment addresses through compatibility parsing, while using explicit
owner identities for coordinator destinations.

Authenticated coordinator traffic within its project is eligible for idle
delivery in both directions, including worker replies, without changing ordinary
peer-to-peer or external-client defaults. Existing sessions contacted by the
coordinator receive server-attested delegation context at delivery; newly created
workers receive it before their initial prompt. Worker credentials retain their
limited messaging capabilities and never inherit coordinator control access.

Keep automatic delivery distinct from receipts: stored, pending, injected,
agent-acknowledged, and user-seen still mean different things. A successful
injection does not prove the task completed. Busy recipients queue messages;
waiting approvals, compose drafts, ambiguous dispatches, stopped environments,
and explicit pause/mute controls hold delivery with a visible reason. Do not
interrupt or silently restart a worker just to deliver mail.

Replace the blanket injected-lineage prohibition only for verified coordinator
exchanges. Retain bounded bodies, queues, retention, idempotency, per-tab dispatch
leases, rate limits, incarnation checks, and thread-hop limits. Track lineage
across related messages so starting a new subject or acknowledging a message
cannot reset loop protection. After the configured hop/run budget is exhausted,
hold further autonomous delivery and expose Resume to the user. Do not generate
automatic “thanks” replies or wake the coordinator for every progress token.

Update the carrier according to authenticated role:

- Coordinator instructions identify its project, mailbox, read-only role, and
  available MCP controls. It may inspect and plan locally; implementation,
  commands that change files, builds, and fixes belong in worker environments.
- Worker instructions identify the requesting coordinator and delegated task.
  They may act on that task inside their environment under their normal project
  and tool policies, and send meaningful completion, failure, or blocked reports.
- Coordinator recipients may use associated worker reports to continue the
  user's orchestration task. Report content cannot expand project scope or
  change the coordinator's read-only policy.
- Ordinary external and unrelated peer carriers retain their current treatment.

Role metadata must survive resume, compaction/reconnection paths, and backend
restart. It belongs in trusted session instructions and structured message
envelopes, not in a repository `AGENTS.md` rewrite. Render clear coordinator
badges and source links on both sides so users can follow the exchange.

**8. Build-to-review completion and recovery**

The complete target workflow is:

1. User discusses an idea against branch/commit X in Coordinator.
2. Coordinator uses MCP to create a local worker environment based on X.
3. Coordinator starts the requested build and uses mail to contact its worker tab.
4. Build progress and completion live in the existing backend workflow service.
5. A durable completion notification wakes the coordinator when it is available.
6. Coordinator inspects the authoritative result and starts multi-review through
   MCP only after the build has actually succeeded and its run has settled.
7. Review findings return through the same project association; any requested
   fixes run in the worker environment. Coordinator summarizes and links results.

Persist coordinator/workflow associations and completion delivery intents. Use a
transactional outbox or a restart-safe scan of terminal workflow revisions with
stable message IDs so a crash between completion and notification neither loses
the event nor starts review twice. Backend-generated workflow notifications must
have their own authenticated system origin; do not spoof the worker agent.
Agent replies use the ordinary authenticated tab identity.

Do not depend on the worker remembering to send a completion message or on a
mounted React callback. Reconcile pipeline/review status before acting on a
report. Failure, cancellation, recoverable interruption, and successful completion
must remain distinguishable. Preserve the existing rule that cancelling and
recovering sessions are still busy. If no coordinator tab remains available,
retain the notification and association for explicit adoption rather than
creating a new autonomous conversation.

**9. Frontend implementation**

Create a `ProjectWorkspace` page host and `CoordinatorPanel` with a repository
toolbar and a native conversation tab area. Keep board rendering in its current
components initially; avoid loading Kanban-specific data and notes just to show
Coordinator. Extract deeper board routing only where necessary.

Extract the modal selector into `components/ui/segmented-selector.tsx` with
typed options, icons, disabled state, controlled selection, focus handling, and
active styling. Preserve the modal's `aria-pressed` behavior; expose appropriate
tab semantics, panel relationships, and arrow/Home/End navigation for project
navigation. Support five items on narrow windows through a responsive wrapping
or scrollable presentation, using the same component rather than a separate
button grid with different selected styling.

Reuse the native chat surface through an owner-aware adapter, not by passing
fake container-running flags into `TerminalContainer`. Hide controls that cannot
be honored in coordinator context: terminal creation in the root, file-edit
actions, unrestricted permission/mode changes, and root build/merge actions.
Keep model/effort selection, attachments stored outside the checkout, search,
questions, cancellation, queues, and linked worker navigation where supported.

Provide recoverable startup, authentication, unavailable-provider, missing-path,
MCP-disabled, Git-error, paused-mail, and loading states. The project coordinator
must remain usable when Docker is unavailable. New revisions and snapshots drive
all status indicators, including after navigating to an environment and back.

**10. Delivery sequence and acceptance gates**

| Stage | Deliverable | Acceptance gate |
| --- | --- | --- |
| 1. Contracts and ownership | Owner union, coordinator storage/service, migrations, command/resource schemas | Old environments load unchanged; coordinator cannot enter environment deletion/setup/merge paths |
| 2. Runtime and policy | Trusted launcher, owner-aware native services, read-only enforcement, provider capability checks | Real project reads work; direct and indirect writes fail across initial/resumed/queued turns |
| 3. MCP identity and mail | Scoped credentials, coordinator mailboxes, role carriers, bounded two-way delivery | Request and reply auto-deliver; external/spoofed/cross-project traffic cannot gain the exception |
| 4. Workflow controls | Build/review MCP tools, idempotency, provenance, completion outbox | Create → build → multi-review completes and survives restart without duplicated work |
| 5. Git operations | Repository snapshots, branch dropdown backend, sync, operation leases/errors | Safe branch/sync operations work; failures and stale state remain visible |
| 6. Product UI | Shared selector, default Coordinator page, chat tabs, branch/sync/status controls | Modal and navigation share the component; all views rehydrate after switching away |
| 7. End-to-end validation | Real-stack tests, migration/regression coverage, architecture documentation | Required scenario passes with root unchanged except explicit user Git actions |

The selector extraction can land as a small independently reviewable change.
Do not enable Coordinator as the default landing view until its runtime, policy,
and messaging acceptance gates pass. All application changes go through feature
branches and pull requests; final merging remains with a human maintainer.

**11. Validation plan**

Use focused protocol, storage, service, bridge, and component tests for the new
behavior, then the repository's required isolated real-stack browser cycle.

- Session lifecycle: concurrent ensure calls, no prompt on opening, multiple tabs,
  startup failure/retry, missing checkout, path changes, provider death, backend
  restart, close/reopen, project removal, and Docker unavailable.
- Read-only enforcement: attempted edit/patch, shell redirection, subprocess and
  script writes, symlink escape, write-capable MCP, mode change, fork/resume,
  queued message, and permission escalation. Verify tracked and untracked file
  hashes and Git state; verify application-owned attachments do not appear in
  the project. Run these against every provider enabled for coordinator use.
- Messaging: both directions, new and existing worker sessions, busy recipient,
  user draft, pending approval, global pause/mute, stopped environment, stale tab
  incarnation, revoked credential, forged role, cross-project destination,
  ordinary external client, loop budget, duplicate request, and ambiguous inject.
- Workflows: build success/failure/cancel, review idempotency, explicit base commit,
  crash between launch and response, crash between completion and notification,
  duplicate worker/system report, adoption after tab closure, and no review while
  a build is still cancelling or recovering.
- Git: use temporary repositories and bare remotes for behind/ahead/diverged,
  alternate upstreams, duplicate remote branch names, dirty/untracked changes,
  conflicts, detached/unborn HEAD, unavailable upstream, authentication failure,
  occupied worktree branch, external branch change, timeout, and concurrent
  operation/turn dispatch. Assert failed fast-forward sync does not discard work.
- UI: default selection; shared modal/project selector styling and keyboard use;
  existing board navigation; branch/sync states; persistent error details; worker
  links; narrow windows; coordinator and environment mailbox badges.
- Background scenario: start coordinator work, switch to an environment and then
  another project, let build/review/messages progress, reload or restart backend,
  return, and verify exact transcript/status/pending prompts/controls. No extra
  session, build, review, or message may be created by remount.

Run checks through `mise run test:logged --name <name> -- <command>` as required
by `AGENTS.md`. Start the real stack with a unique `dev:test --fixture` profile,
use only its returned fixture project, discover URLs through `dev:status`, and
authenticate with `dev:login`. Run owning tests and affected package typechecks
before browser QA. Run root formatting/lint checks and the declared `mise run test`
suite before delivery; never substitute bare root-level `bun test`.

Update `docs/architecture/control-mcp.md`, session architecture docs,
and user-facing coordinator guidance to explain identity, provider availability,
read-only enforcement, branch/sync behavior, message delivery, and recovery.
