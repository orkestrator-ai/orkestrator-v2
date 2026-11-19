# Orkestrator v2 — credentials and access implementation plan

**Version:** 1.0 · **Prepared:** 29 October 2026 · **Status:** Proposed implementation blueprint

**Target repository:** orkestrator-ai/orkestrator-v2. The Orkestrator source baseline is commit **f2d217138d938f4302ffdc312503a71b92178643**, observed on 29 October 2026. T3 observations refer to the explicitly pinned comparison snapshot in the source appendix. All new API names, modules, defaults, and schemas below are proposals. Implementers must read current repository instructions and reconcile changes since this baseline.

**Document contract:** This is a standalone engineering plan. “Must” denotes a release requirement; “should” denotes a recommended default; optional work is labelled explicitly. No repository changes or runtime security tests were performed while preparing it. Source inspection establishes implementation facts, not proof that a deployed system satisfies the proposed guarantees.

## 1. Executive decision

Build a **backend-owned system for granting tasks permission to use credentials**. The core product objects are connections, access requests, grants, operations, and runtime exposures. A private input card is one entry point; it is not the security boundary.

The selected architecture has two initially supported forms of use:

1. **Trusted-operation access.** Existing, trusted Orkestrator integration code performs a bounded operation. The agent supplies constrained parameters and receives an allowlisted result. The real credential stays outside agent-controlled execution, provided the runtime cannot bypass the broker boundary.
2. **Task-code access.** An Orkestrator-owned runner executes an approved command or managed service with the credential supplied as data. That code can read the value. Orkestrator limits exposure, enforces the applicable runtime policy, filters supported output before it reaches the provider, and controls the lifecycle.

Add **restricted proxy access** later through an enforcement adapter. It can allow compatible task code to use a service with a placeholder while a proxy supplies the real credential at an approved network destination. Do not make the first release depend on a new proxy, universal provider-shell interception, or a central distributed vault.

### Decisions to implement

| Decision | Required outcome |
| --- | --- |
| Credential values are separate from ordinary state | Settings, events, drafts, task records, receipts, and exports contain safe references and metadata only. |
| Saving and granting are distinct | Saving a connection does not authorize every agent to use it. |
| The backend owns authority | The model requests a scope; the server calculates and the user approves the effective scope. |
| Requests are provider-independent | Expose the feature through AgentToolsServer and existing MCP wiring. |
| Secret-consuming execution is explicit | Use an owned runner or a trusted operation; do not add task secrets to shared provider environments. |
| Execution permissions still apply | A credential grant cannot bypass command approval, read-only policy, sandboxing, filesystem restrictions, or network restrictions. |
| Ownership follows the actual execution context | Bind grants to backend, environment, runtime incarnation, task/session, and execution attempt. |
| Expiry is checked during use | Background cleanup removes resources but never substitutes for authorization checks. |
| Failure closes access | Missing context, unsupported isolation, ambiguous ownership, or unavailable storage produces a clear refusal or unavailable state. |
| Product claims reflect the mode | Task-code access never promises that the agent or model cannot disclose the credential. |

### First release boundary

Ship secure reusable storage on supported backends; temporary memory-only storage; private intake; scoped grants; trusted-operation access for a small set of integrations Orkestrator already owns; one policy-preserving execution path for generic commands; an active-access view; and the acceptance gates in this document.

Support only runtime configurations whose execution restrictions can be enforced by the new runner. Unsupported configurations must remain unsupported for that delivery mode. Native provider tools continue to work normally for tasks that do not need this feature.

## 2. What to adopt from T3, and what to design independently

T3 provides several strong patterns: a dedicated secret request, metadata-only orchestration records, a separate user submission RPC, explicit distinction between a reference and an agent-readable file, cancellation of abandoned requests, and error handling that avoids serializing secret-bearing request objects. Adopt those ideas. They are useful independently of T3's framework or internal types. [T1] [T2] [T3]

The reviewed T3 store writes permission-restricted files without a cryptographic storage layer. Its request references are checked against project ownership and a lifetime; file removal uses periodic sweeps. These observations apply to the reviewed feature and snapshot. They are not a claim about all T3 security controls. [T4] [T5]

### Retain the good interactions

- Ask for a reason and show it in the task.
- Let the user provide a value outside ordinary chat.
- Show a safe “available / declined / expired” status.
- Keep the actual submission out of ordinary transcript and replay data.
- Return a reference, an operation result, or an execution binding instead of echoing the value.
- Fail safely on cancellation races, repeated submissions, and storage errors.
- Prevent generic error reporters from capturing the input.

### Make independent architecture choices

Orkestrator should use reusable **connections** plus temporary **grants**, rather than modelling every need as a new pasted secret. It should also own the command execution path that consumes raw credentials, rather than defaulting to a file left available for an extended period.

Use native or explicitly configured secure storage for durable values. Bind grants more narrowly than a project: include execution identity, runtime incarnation, connection revision, permitted use, and lifecycle. Make remote revocation acknowledgement visible. Handle per-use retries explicitly so an external side effect is not blindly duplicated.

Do not copy T3's storage layout, identifier derivation, fixed retention period, state machine, or framework dependencies merely for compatibility. No migration from T3 data is required.

## 3. Current Orkestrator foundations and gaps

The following observations were rechecked against the pinned Orkestrator baseline. Revalidate them before editing.

| Current implementation | Implication for this plan |
| --- | --- |
| AgentToolsServer authenticates project/environment/optional-tab scope and supports host/container connections and revocation. [O1] | Extend the existing agent-facing MCP surface. Do not expose an operator-level credential to agents. |
| Artifact grants bind execution identity, permissions, expiry, and revocation generation; the native service has issue/settle hooks. [O2] [O3] | Reuse the integration pattern, with a separate secret authority and stricter failure semantics. |
| Graph tools derive activation identity from credential-bound workflow result keys. [O4] | Include graph run, activation, and attempt ownership. Rewinds and retries invalidate old grants. |
| Secret question inputs avoid persistent drafts but deliver their actual answer to the provider's live interaction. [O5] [O6] | Reuse presentation patterns, not the ordinary answer path. New intake must preserve exact bytes. |
| GitHub, Anthropic, Cursor, and OpenCode key setters retain raw values in configuration. The current config.json is explicitly excluded from the SQLite document store. [O7] [O8] | Migrate these values into CredentialStore. Describe the current persistence accurately as permission-restricted JSON, not encrypted storage. |
| Normal configuration APIs redact credentials, but update_agent_messaging_settings returns the full updated config. [O9] [O10] | Close this authenticated response exposure before expanding the feature. |
| The current Codex app-server process is shared within an environment and receives environment values at launch. [O11] | Per-task values must not be added to that shared process. |
| Claude query environments and provider permission callbacks are not a universal process-spawn interception interface. [O12] | Make the owned MCP runner the portable path. |
| Existing shell/user-command utilities contain useful spawn and cancellation mechanisms, but are not a complete secrets-safe runner. [O13] [O14] | Audit all output consumers before reusing helpers. Do not inherit raw output persistence. |

### Immediate repair

Change the messaging-settings mutation to return only the saved messaging settings or an intentionally safe response schema. Add a fake-credential canary test across configuration-returning commands.

The finding is an unnecessary secret-bearing response to an authenticated client. This plan does not claim an unauthenticated breach or evidence that real credentials have been exfiltrated.

### Separate the new authority

Artifact access and credential access have different consequences. The artifact integration is not a ready-made credential authorization service. Do not reuse artifact tokens, keys, signing domains, permissive recovery behavior, or best-effort issuance. Secret-grant creation must either establish the complete required scope or fail.

## 4. Threat model and honest guarantees

### Protected assets

Protect reusable API keys, temporary passwords/tokens, private key material when supported, upstream refresh/signing credentials used by trusted integrations, backend administration credentials, and the confidentiality of credential-related application state.

Keep model-provider account authentication separate from this feature unless a specific supported adapter intentionally integrates with it. CredentialStore records must have an enforced purpose class: task connection, provider authentication, or backend/control-plane authentication. GrantService accepts only eligible task-connection records. Migrating a provider API key into secure storage must not put it in the task connection picker or make it grantable. Do not make provider refresh tokens generally available through the task-credential interface.

### Threats addressed

- Accidental inclusion in chat, drafts, logs, telemetry, settings, exports, artifacts, or provider tool results.
- A copied reference being used by another task, backend, environment, or stale runtime.
- Prompt-injected agent instructions requesting broader access than the user approved.
- Race conditions around submission, consumption, expiry, revocation, and task replacement.
- A new MCP runner bypassing normal execution policy.
- Credential persistence surviving longer than intended.
- A remote node staying authorized after a task changes or a grant ends.
- Duplicate side effects after transport errors or process crashes.
- Repository configuration being treated as an authorization source.

### Trust boundaries

The backend credential service and its selected storage provider are trusted. An authenticated human UI may approve access within its authority. Agent text, repository files, generated scripts, dependency code, tool parameters, and external service responses are untrusted.

A registered remote backend is a separate trust boundary. For raw delivery, the user is authorizing that execution backend to possess the selected value. A trusted relay that carries plaintext submissions is also inside that trust boundary; ordinary TLS on each hop does not make the relay unable to read the value.

### Guarantee matrix

| Property | Trusted operation | Task-code access | Future restricted proxy |
| --- | --- | --- | --- |
| Private intake bypasses chat and drafts | Required | Required | Required |
| No raw value returned by the intended tool API | Required | Required for runner result; executed code still receives it | Required |
| Credential absent from agent-controlled process environment | Required | Not promised | Required for supported proxy paths |
| Upstream permissions narrowed by Orkestrator | Enforce operation/resource policy | Only to the extent the credential itself or runtime can enforce it | Enforce inspected request policy plus upstream scope |
| Deliberate disclosure by arbitrary task code prevented | Only when code cannot bypass credential custody | Not promised | Limited to supported, enforced paths and trusted upstream handling |
| Local expiry makes copied permanent keys unusable upstream | Not promised | Not promised | Not promised |
| Root/administrator compromise resisted | Outside initial scope | Outside initial scope | Outside initial scope |

A raw grant labelled “read-only” cannot make a full-privilege token read-only. Verify upstream scope where an adapter supports it; otherwise show the uncertainty and treat the real credential authority honestly.

### Same-user execution

File permissions, keychain storage, a private directory, and a separate JavaScript process are not automatically an isolation boundary against another unrestricted process under the same OS identity. Native keychains reduce plaintext persistence; their access semantics depend on platform and configuration. Linux Secret Service may allow other clients to access an unlocked collection. [E2] [E3]

For the first release, distinguish **isolated execution** from **trusted local execution**. The latter protects the supported data path and avoids accidental persistence, but must not promise adversarial isolation from the user's other local processes.

## 5. Components and ownership

Implement focused modules behind internal interfaces. The following names are proposed and should be adjusted to repository conventions.

| Component | Responsibility | Must not do |
| --- | --- | --- |
| CredentialStore | Store, resolve, version, replace, and delete credential material for trusted internal consumers. | Expose a generic user/agent “read value” API. |
| ConnectionService | Manage safe service/account/resource configuration and a private credential locator. | Equate “configured” with “authorized for all agents.” |
| SecretRequestService | Create pending requests, calculate effective scope, accept user decisions, and publish safe state. | Trust model-supplied ownership or approval claims. |
| GrantService | Issue, validate, reserve, revoke, and expire execution-bound access. | Fall back to broader environment authority when context is missing. |
| OperationService | Track one use, idempotency, admission, upstream outcomes, and safe results. | Automatically replay ambiguous external effects. |
| CredentialExecutor | Run raw-access commands through a policy-preserving runtime adapter. | Spawn an unrestricted host shell from an MCP request. |
| ExposureRegistry | Track processes, temporary files, remote copies, deadlines, and cleanup acknowledgement. | Treat file unlinking as upstream credential revocation. |
| OutputBoundary | Filter supported output before provider return, persistence, logging, and streaming fan-out. | Promise protection against arbitrary transformations or binary exfiltration. |
| TrustedOperationRegistry | Register typed service actions and safe result schemas. | Offer an unrestricted authenticated fetch helper to agents. |
| EnforcementAdapter | Optional future proxy/sandbox integration. | Become a mandatory dependency of the first release. |

### Backend placement

The backend that owns the execution environment normally owns the request, grant, and temporary value. Keep durable credentials on an explicitly selected backend or external provider.

Existing integrations may use a credential on its owning backend and return a bounded result. Raw delivery to another backend requires an explicit destination-bound grant. There is no automatic replication of every credential to connected nodes.

### Dependency direction

Protocol types describe safe metadata and tightly controlled submission contracts. UI components call authenticated user routes. Agent MCP tools call request/operation services. Those services use storage and runtime adapters. Provider bridges receive ordinary tool availability and results; they do not become the credential authority.

Do not introduce a circular dependency where generic configuration loading resolves all secrets. Resolve a value only at the trusted point that needs it.

## 6. Data model and invariants

Use six distinct entities. Keep secret material outside application documents that can be enumerated, synced, exported, or returned.

### Credential record

This internal record connects a versioned stored value to its owner backend, purpose class, storage provider, and lifecycle. Actual material remains inside CredentialStore. Only records explicitly classified as eligible task credentials may back a task Connection; provider-authentication and backend/control-plane records cannot be granted through this interface by default.

Keep private locators and store capabilities internal. A credential record is not a public DTO, a user approval, or a task grant.

### Connection

A Connection is reusable configuration. Suggested fields:

~~~ts
type Connection = {
  id: string;
  ownerBackendId: string;
  revision: number;
  adapter: string;
  displayName: string;
  allowedProjectIds: string[];
  resourcePolicy: SafeResourcePolicy;
  supportedUses: Array<"trusted-operation" | "task-code">;
  credentialVersion: string;
  status: "ready" | "locked" | "unavailable" | "migration-required";
};
~~~

The private credential locator belongs to a server-internal record. Do not serialize a native keychain item identifier, file path, arbitrary vault URI, or provider signing material into the normal connection DTO unless there is a concrete user-facing reason and an explicit safe schema.

### Secret request

A request contains a proposal and the server-calculated effective scope. Record the authenticated requester, real destination, request revision, purpose, delivery class, waiting deadline, and lifecycle state. The model can supply a label and desired use; it cannot set owner, human identity, granted state, backend identity, or trusted ancestry.

The approval binds to the exact request revision and effective scope. A change to the connection, destination, use mode, resource, or deadline requiring additional authority produces a new approval.

### Grant

A Grant is an immutable authorization scope plus mutable lifecycle and budget state:

~~~ts
type GrantScope = {
  grantId: string;
  connectionId: string;
  connectionRevision: number;
  credentialVersion: string;
  ownerBackendId: string;
  executorBackendId: string;
  projectId: string;
  environmentId: string;
  runtimeIncarnation: string;
  conversationId: string;
  providerSessionId: string;
  executionId: string;
  executionGeneration: string;
  graph?: { runId: string; activationId: string; attemptId: string };
  use: "trusted-operation" | "task-code";
  resourcePolicy: SafeResourcePolicy;
  allowedOperations: string[];
  expiresAt: string;
  maxUses?: number;
};
~~~

These identifiers are conceptual. Map them to existing authoritative session, workflow, graph, and runtime records; do not invent duplicate sources of identity just to match this example.

Use an unguessable opaque reference with authenticated context checks. A 256-bit random reference with a digest lookup is a suitable initial option. Do not use a deterministic hash of the credential as the reference. Do not store secret-value hashes in logs, especially for low-entropy values.

The reference is not the whole authorization decision. A copied handle must fail from another authenticated scope. Public exports should use inert request/grant identifiers, not reusable bearer material.

### Operation

One attempted use has its own operation identifier, grant identifier, canonical parameter fingerprint, state, use reservation, upstream idempotency key where supported, safe result, timestamps, and reconciliation state.

A one-use handoff does not mean a downstream system will use the credential only once. If a trusted operation saves a credential into a persistent integration, that persistence must be explicit in the approved operation and its user-facing explanation.

### Runtime exposure

Track every materialization: runtime incarnation, delivery method, managed process/job identity, temporary path or binding identifier, local monotonic deadline, remote deadline, cleanup state, and acknowledgement.

A runtime exposure is an implementation resource. Do not put raw values or secret-bearing environment maps into it. A file path is still sensitive operational metadata and should be excluded from unnecessary exports.

### Core invariants

- Connections and credentials are versioned; the first release invalidates grants when the connection, credential, account, destination, or effective policy revision changes.
- A runtime replacement, graph rewind, attempt retry, or session replacement cannot inherit old authority.
- Task grants are not automatically delegated to newly spawned agents. Child processes of an approved raw job remain within that job's actual exposure boundary.
- Forks and handoffs may copy explanatory metadata but never live grants.
- Maximum use budgets cannot be multiplied by racing or creating child requests.
- The provider may remember an old handle in its own transcript; the backend must make that handle useless outside its live scope.

## 7. Authorization algorithm

Every new operation must pass the same central authorization path. Avoid scattered per-provider implementations.

1. Authenticate the transport and resolve the server-owned caller context.
2. Resolve the current task/session/execution and verify it is live.
3. Resolve the actual backend, environment, runtime incarnation, and graph attempt when present.
4. Load the grant by opaque reference and verify all bound identity fields.
5. Verify the connection revision, credential version, and effective policy revision.
6. Verify the requested use mode, operation, resource, and destination against the approved scope.
7. Check expiry, revocation, use budget, and runtime capability.
8. Apply existing execution/command approval policy independently of credential access.
9. Atomically reserve the operation and its use budget.
10. Recheck immediately before execution if the operation waited in a queue.
11. Resolve the credential only after admission, execute through the selected adapter, and produce an allowlisted result.
12. Record the safe outcome and cleanup state.

The effective permission is the intersection of the requested scope, authenticated user authority, connection policy, task policy, runtime capability, and product limits. An agent request can narrow authority but cannot create it.

### Delegation

Disable automatic cross-task delegation in the first release. A coordinator that can create workers does not thereby gain permission to give them every credential it can use.

If later supported, delegated grants must be server-derived subsets. Child expiry cannot exceed parent expiry, resources cannot expand, aggregate use limits cannot increase, and parent revocation invalidates descendants. Verify ancestry from server records; never accept the agent's assertion that it is an authorized child.

### Repository declarations

A project may declare that a test profile needs a connection alias. That is a request for configuration, not permission to read a stored credential.

A user can approve a standing rule for a specific project, execution target, resource scope, and use class. Branch changes that expand the declaration must not silently inherit that approval. Keep user-approved policy outside agent-writable project files or bind it to reviewed configuration revisions.

## 8. Request lifecycle and private intake

### Request states

| State | Meaning and allowed progression |
| --- | --- |
| pending | Awaiting a valid user decision; may become approved, declined, timed_out, or cancelled. |
| approved | Decision accepted; storage and grant creation must still succeed. |
| available | A usable grant has been established; its expiry, revocation, and consumption are tracked separately. |
| declined / timed_out / cancelled | Terminal request decision; cannot silently transfer to another task. |

Keep the request decision separate from grant state. “Approved” means a user accepted the scope; “available” means the backend successfully established usable storage and authority. Never show available before the required write and grant creation have succeeded.

### Dedicated input path

Create a separate authenticated user submission command. Enforce the application's origin/CSRF controls where applicable. Agent MCP credentials may request access but cannot supply a human approval or select an unrestricted saved credential on the user's behalf.

Values must bypass ordinary prompts, interaction answers, event payloads, generic request logging, telemetry, replay buffers, support exports, and persisted frontend state. Failure objects must not retain a request body in a serializable cause chain. Use generic error codes and safe messages.

The UI keeps the unsent input in component state only and clears it after successful submission, cancellation, or unmounting. This is not a guarantee of JavaScript memory zeroization.

### Exact input and size constraints

For v1, support explicitly typed UTF-8 tokens, passwords, and multiline text credentials. Preserve bytes after UTF-8 encoding: no automatic trim, case conversion, Unicode normalization, truncation, interpolation, or shell expansion.

Proposed limits are 64 KiB for a temporary secret value, 120 characters for a label, 1,000 characters for a purpose, and a bounded overall submission body. Validate durable-store size limits before committing a saved connection. Environment-variable bindings must reject NUL bytes and values incompatible with the selected runtime; file/stdin support can differ. Return a safe, precise unsupported-size or unsupported-binding error.

Do not add binary-upload credential support implicitly. If required later, define its own size, display, encoding, and storage contracts.

### Duplicate submission and cancellation races

A request has one accepted decision. Compare-and-set its revision/state, coordinate value storage with grant creation, and clean up an unreferenced value if the request becomes invalid. Concurrent conflicting submissions must not silently overwrite the first accepted credential.

Do not fingerprint a submitted password with an ordinary persistent hash for idempotency. Use request identity and one-time acceptance semantics. A repeated completed submission returns safe status without re-exposing or replacing the original value.

If the task stops or is replaced during submission, fail the grant and clean up its temporary material. Do not redirect it to the next session automatically.

### Initial lifetime defaults

| Item | Proposed initial default |
| --- | --- |
| Waiting for the user | 10 minutes, explicitly extendable while the request remains valid. |
| Single trusted action | A short admission deadline, initially 5 minutes. |
| Raw test/command job | Until job completion, capped initially at 60 minutes. |
| Managed development service | Explicit lifetime selection, initially capped at 8 hours. |
| Extended task access | Explicit approval, bounded by a backend maximum; 24 hours is an upper option, not the universal default. |
| Saved credential | Stored independently of grants; issuer expiry and rotation still apply. |

These are product defaults, not claims of a universal security standard. Make them centralized policy constants with tested bounds. An extension is a new approved grant revision or grant, not an agent-written timestamp.

## 9. Per-use operations, concurrency, and uncertain outcomes

A grant authorizes use; an Operation records one use. Keeping them separate is necessary for retries and remote execution.

### Admission and budgets

Reserve an operation atomically with validation and use-budget consumption. Do not hold a database transaction open across asynchronous keychain, network, or process work. The reservation must survive competing requests even when the value itself remains memory-only.

A simple initial rule is to count a use when admitted. Do not refund an ambiguous attempt automatically. A known pre-execution failure can be handled through a narrowly defined adapter policy, but budget restoration must be atomic and tested.

### Idempotency

Scope an idempotency key to the authenticated caller and grant. Fingerprint canonical operation parameters, connection revision, credential version, and safe references; never include the credential value in persisted fingerprints.

- Same key and same operation returns the existing safe state/result.
- Same key with changed operation parameters is rejected.
- Concurrent identical calls create one reservation.
- Expired or revoked queued operations never start.
- A caller cannot convert a trusted-operation grant into a raw-execution grant by retrying with another mode.

### Operation states

| State | Meaning |
| --- | --- |
| reserved | Admission and budget reserved; execution has not begun. |
| running | Execution started; an external effect may already have occurred. |
| succeeded | Adapter established the successful outcome. |
| failed_no_effect | Adapter established that the intended external effect did not occur. |
| outcome_unknown | An effect may have occurred; reconciliation is required. |
| cancelled_before_start | Execution was prevented before any external action. |

Record cancellation requests and raw-process termination separately from effect certainty. Once an upstream request may have been transmitted, cancellation does not establish failed_no_effect. Keep outcome_unknown until the adapter can establish the outcome. A raw process can be confirmed terminated while its prior side effects remain unknown; this does not justify automatic retry or a use-budget refund.

Exactly-once external effects cannot be guaranteed by a local transaction. If an external request may have reached its service before a timeout, disconnect, or crash, record outcome_unknown. Do not blindly repeat it.

Use an upstream idempotency mechanism when supported and retain the same upstream key for reconciliation. Otherwise, retry only when the adapter can establish that no effect occurred. A network error alone does not establish that.

For a raw job, a lost response may mean the process is still running. Reconnect to its managed identity or require reconciliation; do not launch another copy merely because the client timed out.

### Safe results

Each trusted operation defines a positive result schema. External response JSON may contain newly issued keys or signed access URLs. Do not forward arbitrary service responses, headers, request objects, or exception causes to the provider.

The runner returns a managed operation identifier, safe status, exit information, and filtered bounded output. Raw runtime environments, credential-bearing command previews, and internal credential locators are never result fields.

## 10. Credential storage, key custody, and migration

### Storage interface

Provide a small internal interface with capabilities such as temporary storage, durable storage, maximum supported size, locked/unavailable state, and versioned resolution. A callback-style withCredential helper may reduce accidental serialization but is not itself an isolation boundary.

Use safe connection metadata in ordinary application persistence. Store actual values through a native credential provider or an explicitly configured service credential facility.

Bun.secrets is a suitable native adapter candidate for the Bun backend. Its current documentation describes macOS Keychain, Linux libsecret/Secret Service, and Windows Credential Manager, and marks the API experimental. Pin supported Bun versions and test platform behavior. On Windows, explicitly request local persistence for backend-bound values rather than relying on a roaming default. [E1]

### Headless operation

Do not assume a desktop keyring on a headless backend. Offer:

1. Temporary memory-only credentials and restart-invalidated grants.
2. An explicitly configured durable provider.
3. An external secret manager adapter when the deployment already has one.

A configured encrypted local provider must use audited cryptographic APIs and a separately provisioned unlocking key. A key stored beside its ciphertext does not protect against compromise of the same account. Systemd service credentials are one possible provisioning mechanism; adopting them is a deployment choice, not a mandatory cross-platform dependency. [E4]

When durable storage is locked or unavailable, return a distinct state. Allow the user to choose temporary use where appropriate. Do not silently persist new values as plaintext, truncate a value to fit the store, or claim encryption merely because a file is mode 0600.

### Namespace and custody

Separate production, development, tests, backend instances, and profiles in the credential namespace. Test adapters must never discover or modify the user's real keychain. Models cannot supply arbitrary store paths or item names.

Do not mount the backend's credential directory, native keyring interface, general gateway token, or Docker control socket into an agent runtime to make credential access convenient.

### Temporary values

Hold task-only values in backend memory by default. Clear references when grants end and minimize copies. Do not promise that runtime strings are securely zeroed or immune to swap/crash dumps. Materialize only when the selected operation requires it.

On restart, invalidate temporary grants and mark their requests unavailable. Keep safe records for explanation and reconciliation, and clean abandoned files/processes using the exposure registry.

### Migration of existing keys

For each existing inline key:

1. Discover it through a trusted internal path.
2. Write a new versioned credential-store entry.
3. Read it back and compare in memory without logging.
4. Commit the appropriate internal credential reference and purpose class; create a task Connection only when that credential is eligible for task use.
5. Switch the relevant consumers to on-demand resolution.
6. Remove the inline field only after successful cutover.
7. Clean current application-controlled backups/legacy copies where supported.
8. Record safe migration status and allow restart-safe continuation.

Migration is idempotent. If storage fails, preserve the working old value, mark migration-required, and report the failure without creating new plaintext fallback writes. Do not advertise the backend as fully migrated until every required consumer has switched.

Eliminating current plaintext fields does not prove that old backups, snapshots, exports, or storage media contain no historical copy. Document that boundary and provide rotation guidance when historical exposure matters.

### Rotation and deletion

The first release invalidates grants pinned to the old credential version when a value changes. Let existing operations report their actual state; do not silently swap credentials midway through an admitted operation.

Deleting a saved connection revokes future grants and starts cleanup. Upstream revocation is an explicit adapter operation when supported. Distinguish removing Orkestrator's copy from revoking the service credential itself.

## 11. Credential execution and runtime qualification

### Prefer a trusted action when one exists

A credential grant should normally authorize a specific integration operation: read a selected repository's pull-request metadata, create a deployment in a named project, or call a supported service endpoint through a reviewed adapter. These are examples of the proposed product surface, not claims that all of these adapters exist today.

The adapter owns endpoint selection, resource authorization, request construction, timeout policy, upstream authentication, and the result schema. Do not accept an arbitrary URL, HTTP headers, shell command, or callback from the model and call that a trusted operation. Redirects must not carry authorization to an unapproved destination.

When service support permits, mint a short-lived upstream credential with the smallest useful permissions. Local grant policy and upstream credential scope are complementary. For example, GitHub App installation tokens can be limited to selected repositories and permissions and expire after one hour; choosing GitHub Apps still requires an integration design and installation workflow. [E6]

### Own the raw execution path

Provide one explicit agent tool, provisionally execute_with_credentials. It accepts a live grant reference, a structured command or approved job profile, a working directory, an idempotency key, and logical credential bindings. It never accepts actual credential values.

The runner must:

1. Resolve the actual execution target from authenticated scope.
2. Enforce the intersection of session policy, command approval, runtime policy, and grant policy.
3. Reserve the operation and prepare its managed job identity and cleanup record without starting task code.
4. Resolve only the approved credential versions.
5. Construct child-only environment, stdin, or private-file bindings and register every materialization.
6. Install the deadline and required containment/supervision, then spawn the process with the prepared bindings.
7. Filter bounded text output before any downstream consumer sees it.
8. Track the managed containment boundary, processes, and every exposure.
9. Terminate and clean up on completion, deadline, cancellation, revocation, or ownership replacement.

A failure after materialization but before spawn still requires cleanup. Never resolve a credential or create a file and then rely on a process that has not started to clean it up.

Credential approval is separate from command approval. An approved connection does not authorize arbitrary host execution. If a provider-specific sandbox cannot be reproduced or enforced through the owned runner, reject this delivery path for that configuration.

### Containment and deadline supervision

A process group and a timer inside the API backend are insufficient for a strong managed-lifetime claim: task code can create detached descendants, and an API crash can leave children running.

Each qualified adapter must identify its actual job boundary and independent deadline enforcement. For the initial isolated path, use an owned container or equivalent OS-managed job with a supervisor outside agent control. Its bounded lifetime must survive loss of the API process and control connection. Startup reconciliation is a secondary recovery mechanism, not the only deadline enforcement.

Test detached descendants and abrupt backend termination. If a trusted-local or shared-runtime adapter cannot enforce the required containment, disclose best-effort termination and unconfirmed descendant cleanup; do not advertise guaranteed bounded exposure for that mode. Confirmed cleanup refers only to managed resources the runtime can account for, never all copies a task may have created.

### Binding rules

| Binding | Allowed implementation | Prohibited shortcut |
| --- | --- | --- |
| Environment | Construct an explicit child-only environment at spawn; allowlist binding names and inherited variables. | Mutate backend/global environment, a shared provider server, or a shared container configuration. |
| Stdin | Pass through a dedicated pipe with bounded buffering; define which input stream the program receives. | Paste the value into an interactive terminal command or persist a replay transcript. |
| File | Create a private per-operation directory outside the repository; exclusive creation, restrictive permissions/ACLs, and verified cleanup. | Put it in the worktree, cache, ordinary temporary directory with broad permissions, or automatic artifact/export scope. |
| Trusted action | Resolve inside reviewed backend code immediately before use. | Return the resolved value or arbitrary authenticated upstream response to the agent. |

Do not place secret values in command arguments, shell text, command previews, container exec arguments, or diagnostic environment dumps. A file path can be supplied as a path; the value must not become shell syntax.

Validate environment names and reserve variables that can change loaders, startup scripts, executable lookup, or runtime configuration. Names such as PATH, LD_PRELOAD, NODE_OPTIONS, and BASH_ENV are not ordinary credential slots. Reject unsafe overrides unless an explicitly reviewed job profile defines their semantics.

For file delivery, defend against symlink/reparse-point substitution, path traversal, pre-existing targets, and ownership changes. Use platform-appropriate APIs and private directories with unpredictable names. Do not promise that unlinking a file erases copies, open handles, filesystem snapshots, or storage media.

### Command identity and mutable code

An approval of a command string is not an approval of an immutable program: the script or dependency it calls may change between approval and execution.

Offer two accurate policies:

- A reviewed job profile can bind to a fixed executable/configuration and a verified snapshot or digest where the runtime can enforce it.
- A task-code grant explicitly authorizes code in the selected task/runtime to receive the credential for the approved lifetime.

Do not present the second policy as though every instruction that will run has been reviewed. Repository write access, dependency scripts, and inherited process authority belong in the same exposure decision.

### Runtime capability matrix

Qualify combinations of provider, operating system, environment type, and execution policy. A green “supported” state requires evidence for the entire path.

| Runtime class | v1 delivery decision | Required condition |
| --- | --- | --- |
| Dedicated container or sandbox | Preferred generic-command target. | Enforced filesystem/network policy, no backend credential mount, managed job boundary, independent deadline supervision, output filtering, cleanup. |
| Shared container | Conditional task-code support. | Explicit shared-runtime disclosure; do not claim protection from other processes with equivalent OS authority. |
| Local host execution | Optional trusted-local mode. | Existing host execution approval, explicit target display, per-job binding, no isolation claim; disclose any limits on descendant termination and crash-time cleanup. |
| Read-only coordinator | Trusted read operations only when authorized. | No new raw shell privilege or ability to hand grants to workers automatically. |
| Provider sandbox unavailable to the runner | Raw mode unavailable. | A separate qualified adapter is required; no host fallback. |
| Shared provider process | No task-value injection. | Use separate owned jobs or trusted operations. |
| Remote execution backend | Enable after local qualification. | Destination-bound authority, authenticated routing, local deadline enforcement, acknowledgement handling. |

A container alone does not establish the required isolation. Mounts, sockets, user identity, process visibility, capabilities, network access, and backend reachability must match the guarantee shown to the user.

Native provider shell tools do not automatically gain private injection or output filtering. Initially teach agents to use the dedicated tool when a task requires a connection. If a provider cannot supply authoritative per-task identity through its MCP connection, that provider/configuration is unsupported until an explicit capability-routing adapter exists.

## 12. Backend ownership, revocation, and lifecycle

### Keep the first topology simple

For initial raw execution, make credential owner and executor the same backend. A user chooses the destination before entering a value or selecting an available connection. This avoids inventing a distributed vault in the first release.

A trusted operation may execute on its credential-owning backend and return a constrained result through authenticated routing. Supporting raw transfer between two backends is a later capability with explicit approval, destination identity, transport requirements, transfer lifetime, and cleanup acknowledgement.

Orkestrator's current command-node relay is a trusted relay, not a demonstrated application-level end-to-end encrypted secret channel. If private intake traverses it, the UI and deployment documentation must reflect that trust. Add end-to-end payload encryption only when excluding the relay from credential custody is an actual product requirement. [O17]

### Three different meanings of expiry

| Clock or state | What it controls |
| --- | --- |
| Grant admission expiry | Whether a new operation may start. Every admission checks it. |
| Runtime exposure deadline | How long a managed job or materialization may retain access. Enforced on the execution backend. |
| Upstream credential expiry | Whether the service itself accepts a token. Controlled by the issuer. |

Define how a trusted operation already in flight is handled when admission expires. Use a bounded operation timeout and cancellation where supported; record the actual outcome. A local timeout cannot guarantee that an upstream side effect was cancelled.

Use an absolute deadline for display and reconciliation, plus a monotonic deadline for local elapsed-time enforcement. A backward wall-clock adjustment must not extend access. Queues revalidate at dequeue. Initial ephemeral grants should fail closed across backend restart; safe operation records remain available to reconcile jobs and uncertain effects.

For a remote job, install a bounded local deadline and qualified independent supervision before making the credential available. Loss of the control connection or API process must not silently grant unlimited retention in a mode advertised as managed and bounded. Such enforcement still depends on the execution runtime being trusted and functioning; it is not issuer-side revocation. Any weaker mode must expose its cleanup limitation explicitly.

### Revocation states

Expose distinct states rather than one misleading “deleted everywhere” indicator:

- **Access denied:** the authority will admit no further operations.
- **Cleanup requested:** termination and removal have been requested.
- **Cleanup confirmed:** the owning runtime acknowledged the managed cleanup.
- **Cleanup unconfirmed:** the target is offline or could not prove completion.
- **Issuer revoked:** an upstream revocation action succeeded, where supported.

Revocation invalidates grants immediately at the authority, cancels queued work, and requests termination of active raw jobs. It cannot undo completed actions or guarantee retrieval of a copied permanent credential. In a trusted operation, an already transmitted upstream request may still finish.

### Lifecycle triggers

Invalidate authority on session replacement, environment deletion, runtime replacement, task completion where applicable, graph rewind/cancellation, activation-attempt replacement, connection policy change, credential rotation, user revocation, and backend restart.

Graph retries receive new grants or re-enter approved standing policy; they do not inherit the previous attempt's handle. A workflow result may contain safe connection aliases and statuses, never live secret values or transferable grant authority.

## 13. Product experience and approval policy

### Connections settings

Add a Connections area showing service, account label, backend, status, supported use modes, approved resources, last successful use, and credential version/rotation status. Values are write-only: add, replace, test through a safe operation, revoke, and delete.

Do not add a general “reveal credential” endpoint to make settings easier. If the product later requires export or reveal, treat it as a separate human-only capability with an explicit security design.

Separate connection ownership from project access. Let users assign a saved connection to selected projects without giving all tasks unlimited use.

### In-task access card

Show information the user can act on:

- The requesting task and purpose, with untrusted text safely escaped.
- The actual backend and execution environment.
- The selected connection/account, or “temporary value.”
- Trusted operation versus task-code access.
- The requested resource and the effective permission.
- Lifetime and use limit.
- Whether the runtime is isolated or shared/trusted local.
- Whether the credential's upstream permissions have been verified.

For raw access, state plainly: **“Code running in this task will be able to read this credential.”** For a trusted action, describe the concrete action and resource, rather than promising that a token is safe merely because it is hidden in the UI.

The default action is “Allow this use.” Saving the supplied value is a separate optional choice; a temporary secret should not become a persistent connection because a checkbox was preselected. Selecting a saved connection does not reveal its value to the frontend.

### Standing rules without prompt fatigue

Support user-owned rules for repetitive, low-risk actions: selected project, backend, connection, resource, use class, and limits. The backend still checks each operation.

Do not ask again for an operation already inside an approved active scope. Ask for new authority when the destination, resource, use mode, lifetime, or permissions expand. A model cannot self-approve an expansion by rewriting its purpose.

Standing rules are explicit policy, not a transcript inference. A prior “yes” in chat or a repository instruction does not create a durable credential grant.

### Active access and failure states

Provide a compact active-access view with task, connection, destination, mode, deadline, use count, operation state, and revoke action. Show cleanup status separately.

Design the non-happy paths before release: locked store, unavailable native keyring, unsupported delivery mode, stale request, cancelled task, timeout, rejected scope, migration required, unknown operation outcome, offline destination, and unconfirmed cleanup.

A retry button must explain whether it retries safe request delivery, reconnects to an existing job, or starts a new external operation. Do not label all three “Try again.”

## 14. Output, diagnostics, and audit boundaries

### Filter before fan-out

The owned runner's text output must pass through OutputBoundary before it reaches provider tool results, frontend streams, operation records, logging, telemetry, or support bundles. A renderer that masks already-delivered text is too late.

Use a typed, positive result schema for trusted actions. Known-value redaction is a supplemental control for accidental echoes; it cannot sanitize arbitrary service objects reliably.

Existing buffered shell redaction is a useful starting point, but current user-command paths retain output. Reusing process helpers requires moving the boundary ahead of every consumer, not applying a final string replacement before returning the tool result. [O13] [O14]

### Streaming requirements

Implement a bounded streaming matcher with an explicit supported input contract:

- Maintain sufficient lookbehind to recognize a supported secret spanning chunks.
- Handle UTF-8 decoder boundaries, multiline values, simultaneous values, stdout, and stderr.
- Do not flush an unresolved trailing fragment into an unsafe sink.
- Bound the number and length of active values and total buffered output.
- Suppress overly short secret values conservatively or reject output-visible use that cannot be safely filtered.
- Enumerate any supported transformed representations, such as specific URL or JSON escaping; do not imply universal encoding detection.
- Treat regex patterns and service-token detectors as additional safeguards with tested false-positive behavior.

Validate size limits for existing and externally stored credentials too, before starting an operation. A 64 KiB intake cap is ineffective if an adapter later resolves an unbounded value.

Filtering one stream cannot reliably detect a secret deliberately split across separate outputs, files, images, archives, network requests, or arbitrary transformations. Task-code mode must state this limit. It is not a data-loss-prevention sandbox.

### Artifacts and error handling

Disable automatic export of raw-job working files and private runtime paths. Agent-controlled output files require their own explicit artifact path and policy; do not let a file attachment silently bypass the runner's text boundary.

If the task has arbitrary network or file access, it may disclose a received credential through those channels. Stronger isolation and egress policy can reduce this exposure; text redaction cannot eliminate it.

Errors must use allowlisted fields. Never serialize credential-bearing request bodies, environment maps, command objects with values, HTTP authorization headers, raw upstream responses, or exception cause chains. Test crash reporting and debug logging, not just normal success.

### Audit and performance

Audit safe identities and decisions: connection ID/version, task, backend, effective scope, approval source, operation, timestamps, state changes, and cleanup acknowledgement. Do not log secret values, secret-value hashes, active bearer handles, or unnecessary private file paths.

Use metadata-only audit retention with configurable limits. Display names and purposes may themselves contain user-sensitive information; avoid exporting them unnecessarily.

Resolve credentials at admitted use, not for every rendered status or every output chunk. Bound concurrent operations and output buffers. Keep active grant checks efficient without creating an unlimited plaintext cache. Store safe operation state durably where restart reconciliation requires it, while temporary credential values remain ephemeral.

## 15. Integration strategy and future adapters

### What belongs in the first release

Prioritize trusted operations around integrations Orkestrator already maintains. Keep ordinary model-provider sign-in, backend/node authentication, and task connection access as separate credential classes. A generic “all secrets” picker would blur those boundaries.

Where an existing internal integration needs its configured API key, switch that internal consumer to on-demand CredentialStore resolution. Do not route all internal backend work through the human task-grant flow merely to share storage.

The first generic raw path should target the best-understood isolated runtime, then expand only when the capability matrix passes. Per-provider integration should register the same tools and authoritative context, not duplicate the grant engine.

### Upstream authorization improvements

Prefer service-native short-lived tokens, repository/project scopes, and revocation when supported. An adapter should report whether upstream authority is verified, unknown, or broader than the requested operation.

For trusted operations, enforce the exact resource at execution time as well as approval time. Validate redirects, service endpoints, tenancy, identifier parsing, and response schemas. Prevent an agent-controlled URL from turning a credentialed integration into a general network proxy.

A credential that can mint other credentials deserves a separate action policy and safe result treatment. Creating a new token must not automatically return that token to the model.

### Optional proxy integration

An enforcement adapter can later provide network-side credential injection, restricted egress, and stronger isolation. NVIDIA OpenShell is one example worth evaluating, rather than recreating a complete proxy stack. Its provider documentation describes placeholder replacement governed by destination and credential-binding policy, and notes unsupported paths including non-HTTP traffic. That is a compatibility and threat-model constraint, not a universal guarantee. [E7] [E8]

Before enabling any proxy mode, verify hostname/port/path/method rules, redirects, TLS handling, credential binding, direct-network bypass, DNS behavior, inherited credentials, and upstream response handling. A proxy that keeps a token out of process memory can still authorize damaging requests unless request policy is constrained.

Keep these adapters behind stable capabilities. The core feature must remain usable without adopting a new orchestration platform, distributed secret service, or custom cryptographic scheme.

## 16. Proposed API and code boundaries

The names below are an implementation sketch. Final naming and file layout should follow current repository instructions.

### User-facing commands

| Command | Input | Safe response |
| --- | --- | --- |
| list_connections | Filters within authenticated user scope. | Metadata and supported capabilities. |
| create_connection / replace_credential | Dedicated protected value input plus approved connection policy. | Connection ID, revision, status. |
| approve_secret_request | Request ID/revision, chosen connection or new value, effective scope confirmation. | Request status and safe grant metadata. |
| decline_secret_request | Request ID/revision. | Decision status. |
| list_active_access | Authenticated project/backend filters. | Safe grants, operations, and cleanup state. |
| revoke_access | Grant ID or explicitly authorized connection scope. | Admission revoked plus cleanup status. |
| delete_connection | Connection ID/revision. | Deletion/revocation state. |

There is no generic read_credential command. User-route authorization must be distinct from agent MCP authorization. Prefer dedicated typed transport handling for value submission so ordinary request instrumentation cannot capture it.

### Agent-facing tools

| Tool | Purpose | Authority rule |
| --- | --- | --- |
| request_connection_access | Ask for a connection/use/resource or temporary input. | Backend derives ownership and effective scope. |
| get_access_request_status | Poll safe status when needed. | Same requesting execution only; prefer existing event plumbing where available. |
| invoke_connection_action | Execute a registered trusted operation. | Validate live grant, resource, action, revision, budget, and ordinary task policy. |
| execute_with_credentials | Start or reconnect to a managed raw job. | Only qualified runtime policies; logical bindings, never value arguments. |
| get_credential_operation | Retrieve an existing safe result/state. | Bound caller and operation ownership; no authority expansion. |

An agent must not call the human approval command through a general command bridge. Register explicit allowlists and test alternate transport paths.

Use stable error codes such as ACCESS_EXPIRED, SCOPE_MISMATCH, STORE_LOCKED, UNSUPPORTED_RUNTIME, REQUEST_STALE, and OUTCOME_UNKNOWN. The detailed internal error may require safe operator diagnostics, but must not carry a value through serialization.

### Existing anchors and proposed modules

| Area | Existing integration anchor | Proposed addition |
| --- | --- | --- |
| Protocol | agent-interactions.ts and command schemas. [O5] | agent-secrets.ts: safe DTOs, distinct submission contracts, lifecycle events. |
| MCP | AgentToolsServer and provider dispatch. [O1] [O3] | Credential tool registration plus authoritative task-context adapter. |
| Authority | Native execution hooks; artifact-grant pattern. [O2] [O3] | Separate request/grant/operation services and signing/digest domain. |
| Storage | storage-config.ts, storage-context.ts, config redaction. [O7] [O16] [O18] | CredentialStore adapters, connection metadata, versioned migration. |
| Execution | shell.ts and user-command process helpers. [O13] [O14] [O19] | Policy-enforced runner, exposure registry, streaming output boundary. |
| Lifecycle | Session/environment handling, graph ownership, backend routing. [O4] [O17] [O20] | Revocation hooks, runtime incarnation checks, remote acknowledgements. |
| UI | Existing native interaction presentation. [O6] | Dedicated CredentialRequestCard, Connections settings, active-access view. |

Candidate backend files under apps/backend/src/core/secrets are credential-store.ts, connections.ts, requests.ts, grants.ts, operations.ts, runner.ts, execution-policy.ts, output-boundary.ts, exposures.ts, migration.ts, and tools.ts. These names describe responsibilities; they are not a demand to create a large framework or one class per file.

## 17. Implementation work packages

Deliver in reviewable increments with explicit gates. Storage and UI work can progress in parallel after contracts are agreed; credential-consuming execution must wait for authority, policy, and output boundaries.

### WP0 — close existing response exposure

**Priority:** Immediate. **Dependencies:** None.

Return a narrow messaging-settings response, audit other configuration-returning mutations, and add fake-value canaries covering renderer responses and error paths. Preserve existing safe configured/source metadata.

**Done when:** Every tested configuration response excludes raw canaries; the specific mutation no longer returns the full credential-bearing config; normal settings behavior still works.

### WP1 — define authority and contracts

**Priority:** Foundation. **Dependencies:** WP0 may run independently.

Define the six entities, safe DTOs, versioning, state transitions, effective-scope calculation, runtime capability interface, and stable error codes. Map authoritative identity across normal sessions, coordinators, graph activations, and shared provider brokers.

Keep secret authority separate from artifact grants. Define restart policy, operation admission semantics, and which first runtime is supported.

**Done when:** A design fixture can demonstrate owner/caller mismatch rejection, stale-generation rejection, distinct approval authority, and fail-closed unsupported states without reading any real credential.

### WP2 — implement storage and migrate existing consumers

**Priority:** Foundation. **Dependencies:** WP1.

Implement memory-only and qualified native-store adapters, fake test adapters, backend/profile namespacing, safe connection records, locked/unavailable states, credential versions, and migration checkpoints. Update current consumers to resolve on demand. Account for early Electron/toolchain readers because config.json is intentionally available before backend startup. [O8]

Resolve that startup dependency deliberately: keep non-secret boot configuration readable; move credential-dependent work behind the credential-owning backend or a narrow authenticated startup service. Do not replace one plaintext config with another boot-time cache.

**Done when:** Existing consumers work after migration; interruptions preserve recoverability; durable storage never silently falls back to plaintext; tests cannot touch a real user's store.

### WP3 — implement requests, grants, and operations

**Priority:** Foundation. **Dependencies:** WP1; storage adapter from WP2.

Add dedicated human submission, request revision checks, atomic acceptance, scoped grant issuance, per-use reservation, idempotent status retrieval, expiry/revocation checks, and safe durable operation records. Resolve cleanup races without retaining abandoned values.

**Done when:** Concurrent submissions and uses obey first-decision/use-budget rules; stale handles fail; cancellation races clean up; ambiguous external outcomes are represented without automatic repetition.

### WP4 — build the user experience

**Priority:** Core product. **Dependencies:** WP1 contracts; wire to WP2/WP3.

Build the private request card, saved/temporary choice, Connections settings, active-access view, and status/error handling. Preserve input bytes and avoid ordinary answer/draft telemetry paths. Display actual runtime guarantees and cleanup acknowledgement.

**Done when:** A user can understand which account, task, destination, authority, and lifetime they approve; no value enters frontend persistence or ordinary transcript; keyboard, cancellation, and failure states work.

### WP5 — qualify one execution path and trusted action

**Priority:** Core product. **Dependencies:** WP2/WP3; policy contract from WP1.

Implement one reviewed trusted action and the first qualified raw runner. Integrate policy enforcement, managed process identity, logical bindings, streaming filtering, bounded outputs, artifact restrictions, deadlines, and cleanup. Do not silently route unsupported provider sandbox cases to the host.

**Done when:** Canary tests prove the controlled path excludes values from provider-visible results and persistence; sibling task checks fail; runtime restrictions remain effective; documented raw-mode limits are visible.

### WP6 — integrate lifecycle and remote operation

**Priority:** Required before broad rollout. **Dependencies:** WP3/WP5.

Wire task/session/environment/graph lifecycle events. Add startup reconciliation, runtime incarnation changes, queued-operation cancellation, remote status routing, acknowledgement states, local deadline enforcement, and safe reconnection to existing jobs.

Start with owner-equals-executor raw access. Cross-backend raw transfer and delegated grants remain separate future work.

**Done when:** Replacement sessions cannot use old authority; graph retries do not inherit handles; offline cleanup remains accurately unconfirmed; lost responses do not spawn duplicate jobs.

### WP7 — qualify, release, and document

**Priority:** Release gate. **Dependencies:** WP0–WP6 for advertised capabilities.

Run the acceptance matrix, review dataflow from input to every sink, exercise platform storage failures, document supported provider/runtime combinations, and stage rollout. Provide migration recovery, rotation, and cleanup troubleshooting.

**Done when:** All advertised paths pass their gates; unsupported combinations fail clearly; product documentation states the mode-specific guarantees; disabling the feature stops new access without reintroducing plaintext storage.

## 18. Acceptance and abuse-case matrix

Use generated sentinel values, a fake credential store, a fake clock, controllable remote jobs, and controlled upstream fixtures. Do not use production credentials or the user's native store.

| Test | Required evidence |
| --- | --- |
| Configuration response canary | Raw configured values absent from all audited user response DTOs, including the messaging mutation. |
| Private intake path | No sentinel in chat messages, provider answers, persistent drafts, telemetry, request logs, replay events, support exports, or error causes. |
| Exact value handling | Leading/trailing whitespace, Unicode, multiline input, and size limits preserved or safely rejected; no silent trim or truncation. |
| Human/agent authority separation | Agent credentials cannot approve requests, choose unrestricted stored values, or call a hidden read-value route through another transport. |
| Copied reference | Other task, project, backend, provider session, and runtime cannot use a captured handle. |
| Generation changes | Session replacement, container replacement, graph rewind, and attempt retry invalidate the old handle. |
| Scope and version changes | Rotation, policy revision, changed resource, and changed destination cannot reuse the old grant. |
| Use-budget race | Simultaneous calls cannot exceed maxUses; same idempotency key yields one operation. |
| Changed retry parameters | A reused key with altered command/resource/mode is rejected. |
| Unknown side effect | Timeout after upstream acceptance becomes outcome_unknown; no automatic second request. |
| Lost raw-job response | Client reconnects to the managed job or sees a reconciliation state; no automatic duplicate spawn. |
| Submission/cancellation race | At most one accepted decision; cancelled tasks receive no usable grant; abandoned values are removed. |
| Expiry and clocks | Checks work without the sweeper; queued operations expire; backward wall-clock movement does not extend access. |
| Restart | Ephemeral handles fail; safe operation records reconcile; orphan cleanup status is accurate. |
| Backend crash and detached descendants | Qualified containment enforces the deadline after abrupt API termination and accounts for detached children; weaker modes report unconfirmed cleanup without a false guarantee. |
| Execution policy | Read-only, sandbox, path, network, and command-approval restrictions cannot be bypassed through the new MCP tool. |
| Environment isolation | Backend/shared provider environment unchanged; bindings exist only in the intended child/job; unsafe variable names rejected. |
| File binding | Traversal, symlink/reparse substitution, wrong ownership, and cleanup failure are handled without exposing values in argv or repo files. |
| Streaming boundaries | Split UTF-8, split secret bytes, multiline values, stderr, long chunks, simultaneous values, and final flush do not leak supported plaintext forms. |
| Upstream result schema | Unexpected response fields, authorization headers, newly issued tokens, and nested exceptions do not reach the provider. |
| Artifact boundary | Private files and raw-job outputs cannot silently enter automatic artifact/export paths. |
| Storage failure | Locked keyring, absent daemon, oversized entry, unavailable provider, and permission errors produce safe states with no plaintext fallback. |
| Migration interruption | Failure at every cutover step preserves recovery, avoids premature deletion, and resumes idempotently. |
| Remote revocation | New admissions stop; local deadline works during disconnect; offline cleanup is never reported confirmed without acknowledgement. |
| Raw-mode disclosure limits | Documentation and UI state that receiving code can copy/exfiltrate the value; tests do not misrepresent text filtering as isolation. |
| Test-store isolation | Development/test identifiers and adapters cannot read or overwrite production credential entries. |

### Release-blocking evidence

For every advertised provider/runtime combination, capture a redacted test trace that proves authoritative context, the enforced policy, exact execution target, bounded credential delivery, pre-provider output filtering, lifecycle invalidation, and cleanup reporting.

Run focused tests for security invariants and integration boundaries. Avoid a large suite that merely duplicates DTO implementation. Independent review should follow the data from private input through storage, admission, execution, diagnostics, artifact handling, and deletion.

The plan does not claim these tests have passed; they are implementation acceptance requirements.

## 19. Rollout, recovery, and operating defaults

### Staged rollout

1. Ship the current response fix independently.
2. Introduce CredentialStore and migrate existing consumers behind controlled rollout.
3. Enable temporary requests and grants in an internal/test profile using fake values.
4. Qualify the first trusted action and isolated raw runtime.
5. Enable a small supported deployment cohort with active-access visibility.
6. Add qualified remote and provider configurations.
7. Expand adapters and standing rules based on observed needs.

Do not enable a raw runner by default merely because a backend can spawn processes. Feature availability is a capability decision, not just a global boolean.

### Recovery and rollback

A feature switch can stop new grants and queue admission. Revoke outstanding grants and reconcile active jobs separately; switching off a UI does not terminate a process.

Preserve migrated secure credentials and references during rollback. Do not restore an old build that requires plaintext fields without an explicit compatibility/recovery plan. Schema compatibility and minimum supported versions must be part of the migration release.

Document how to recover from a locked store, reinstall/re-register a backend, replace lost credentials, and resolve an unknown operation outcome. Credentials bound to a local backend are not promised to roam or survive an unplanned machine wipe.

### Useful operational signals

Track approval latency, unavailable-store counts, rejected scope attempts, expired queued work, operation outcomes, cleanup delay, migration progress, and unsupported-runtime requests. Use safe IDs and aggregate counts. Never add a value or bearer handle to make a metric easier to correlate.

Alerts should distinguish access denial, cleanup failure, and issuer revocation failure. These are different operational problems with different remedies.

## 20. Recommended decisions and deferred scope

### Decisions to adopt now

- Backend-owned credential storage and authorization.
- Native secure storage where qualified; explicit durable provider or temporary-only mode on headless systems.
- Reusable connections separate from execution-bound grants.
- Dedicated human input outside ordinary agent answers.
- Trusted service operations as the preferred use mode.
- One owned, policy-preserving raw runner for qualified runtimes.
- Atomic per-use admission and explicit uncertain outcomes.
- Exact input preservation, typed safe DTOs, and pre-provider filtering.
- Visible access lifetime and cleanup acknowledgement.
- No automatic secret replication or cross-task delegation.

### Deliberately defer

- Transparent secret injection into every provider's native shell.
- Universal interception of all output or data-loss prevention.
- A bespoke distributed vault, cryptographic protocol, or proxy platform.
- Arbitrary secret reveal/export APIs.
- Cross-backend raw transfer and automatic delegated grants.
- Binary credential uploads and broad provider-login import.
- Claims that 0600 files, native keychains, or text redaction isolate hostile code under the same account.

### Product result

A user can save a connection once, authorize a specific task to use it, understand whether code will see the value, inspect active access, and revoke future use. An agent receives a constrained result or a scoped execution capability. It does not receive raw credentials through ordinary conversation.

This goes beyond the useful private-entry interaction seen in T3 by treating custody, authorization, execution policy, retries, and lifecycle as one coherent feature. The initial implementation remains small enough to qualify: a common authority service, a small storage interface, a bounded set of trusted operations, and one carefully supported execution path.

## 21. Sources and review boundaries

Repository links below are immutable snapshots. The Orkestrator baseline is **f2d217138d938f4302ffdc312503a71b92178643**. The T3 comparison baseline is **d7935f135f50f3798c1e247ebe8b88587dd62adf**. Upstream branches and documentation can change after this review.

The findings are based on read-only source inspection and primary documentation. No runtime exploit was attempted, no real credential was retrieved, and no repository code was changed. The design choices, initial limits, proposed names, work packages, and acceptance criteria are recommendations.

### Orkestrator source index

| Ref | Source | Relevant evidence |
| --- | --- | --- |
| O1 | [AgentToolsServer][O1] | Authenticated tool scope, routing, credential revocation, workflow result ownership. |
| O2 | [Artifact grants][O2] | Existing scoped capability pattern and lifecycle fields; separate authority required for secrets. |
| O3 | [Native agent service][O3] | Session dispatch and grant issue/settle hooks. |
| O4 | [Graph agent tools][O4] | Activation ownership derived from server-bound workflow context. |
| O5 | [Agent interaction protocol][O5] | Secret-question metadata, draft and transcript handling. |
| O6 | [Native question card][O6] | Masked local input and ordinary answer submission path. |
| O7 | [Configuration storage][O7] | Current inline integration key fields and setters. |
| O8 | [Storage selection][O8] | config.json excluded from SQLite for early readers. |
| O9 | [Messaging commands][O9] | Full-config return from messaging-settings mutation. |
| O10 | [Project/config commands][O10] | Existing redacted ordinary config reads and writes. |
| O11 | [Codex process supervisor][O11] | Shared app-server process and launch-time environment. |
| O12 | [Claude prompt/query setup][O12] | Query environment and permission callback limitations. |
| O13 | [Shell helpers][O13] | Buffered redaction and subprocess support. |
| O14 | [User command service][O14] | Raw output retention requiring a new output boundary. |
| O15 | [Backend invocation][O15] | Handler result returned without universal response redaction. |
| O16 | [Storage context][O16] | Atomic permission-restricted JSON persistence. |
| O17 | [Node relay][O17] | Trusted command-node routing and credentials. |
| O18 | [Command validation/redaction][O18] | Safe config metadata and explicit raw-field redaction. |
| O19 | [Container process control][O19] | Process-group identity and termination mechanisms. |
| O20 | [Local server runtime][O20] | Provider/environment runtime ownership. |

### T3 source index

| Ref | Source | Relevant evidence |
| --- | --- | --- |
| T1 | [Orchestrator MCP service][T1] | Dedicated secret request and metadata-oriented orchestration flow. |
| T2 | [Secret request card][T2] | Separate private input UI and request states. |
| T3 | [Client secret request handling][T3] | Submission and error-handling boundary. |
| T4 | [Server secret store][T4] | File-based custody and permission controls in the reviewed snapshot. |
| T5 | [Secret request service][T5] | Request lifecycle, scope checks, references, and cleanup. |

### Primary implementation guidance

- [Bun secrets API][E1] — native backends, experimental status, persistence options.
- [Electron safeStorage][E2] — platform-specific protection and Linux backend caveats.
- [Freedesktop Secret Service unlocking][E3] — collection access and unlock semantics.
- [systemd execution environment][E4] — service credential provisioning.
- [OWASP secrets-management guidance][E5] — lifecycle, scope, rotation, and audit considerations.
- [GitHub App installation tokens][E6] — scoped short-lived installation credentials.
- [OpenShell provider architecture][E7] — proxy credential injection and compatibility limits.
- [OpenShell security guidance][E8] — deployment and sandbox considerations.

[O1]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/agent-tools.ts
[O2]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/transcript-artifacts/grants.ts
[O3]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/native-agent-service.ts
[O4]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/graph-agent-tools.ts
[O5]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/packages/protocol/src/agent-interactions.ts
[O6]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/web/src/components/native-agent/NativeAgentQuestionCard.tsx
[O7]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/storage-config.ts
[O8]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/storage-stores.ts
[O9]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/commands-registry-mail.ts
[O10]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/commands-registry-projects.ts
[O11]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/bridges/codex-bridge/src/app-server/process-supervisor.ts
[O12]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/bridges/claude-bridge/src/services/session-manager-prompt-query.ts
[O13]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/shell.ts
[O14]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/user-commands.ts
[O15]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/index.ts
[O16]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/storage-context.ts
[O17]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/nodes/node-relay.ts
[O18]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/commands-validation.ts
[O19]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/user-command-container.ts
[O20]: https://github.com/orkestrator-ai/orkestrator-v2/blob/f2d217138d938f4302ffdc312503a71b92178643/apps/backend/src/core/local-server-runtime.ts
[T1]: https://github.com/pingdotgg/t3code/blob/d7935f135f50f3798c1e247ebe8b88587dd62adf/apps/server/src/mcp/OrchestratorMcpService.ts
[T2]: https://github.com/pingdotgg/t3code/blob/d7935f135f50f3798c1e247ebe8b88587dd62adf/apps/web/src/components/chat/SecretRequestCard.tsx
[T3]: https://github.com/pingdotgg/t3code/blob/d7935f135f50f3798c1e247ebe8b88587dd62adf/packages/client-runtime/src/secretRequest.ts
[T4]: https://github.com/pingdotgg/t3code/blob/d7935f135f50f3798c1e247ebe8b88587dd62adf/apps/server/src/auth/ServerSecretStore.ts
[T5]: https://github.com/pingdotgg/t3code/blob/d7935f135f50f3798c1e247ebe8b88587dd62adf/apps/server/src/secrets/SecretRequests.ts
[E1]: https://bun.com/docs/runtime/secrets
[E2]: https://www.electronjs.org/docs/latest/api/safe-storage
[E3]: https://specifications.freedesktop.org/secret-service/latest/unlocking.html
[E4]: https://freedesktop.org/software/systemd/man/latest/systemd.exec.html
[E5]: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
[E6]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
[E7]: https://docs.nvidia.com/openshell/how-it-works/providers/overview
[E8]: https://docs.nvidia.com/openshell/security/best-practices
