# 03 — Preserve command intent through dispatch and recovery

Status: proposed. Dependencies: 02. [Index](00-index.md).

## Owners

`apps/backend/src/core/agent-provider-contract.ts`,
`native-agent-service-prompt.ts`, `native-agent-service-dispatch.ts`,
`http-bridge-provider.ts`, native-session storage/queue contracts, and the
bridge prompt validators and existing dispatch journals. Extend current durable
ownership instead of building a separate command transaction service.

## Submission model

Extend the existing submission with explicit intent: ordinary/literal prompt,
typed-command resolution, or selected command. A selected invocation carries
only the descriptor ID, binding revision, original input, and argument suffix;
the trusted executor binding is resolved server-side. Retain the existing
request ID, attachments, model/agent selections, and session identity.

Resolve before handoff prefixes, annotations, attachment-reference text, plan
wrappers, and structured-output instructions are added. Derive the provider
payload only after the input policy is validated. Keep the display prompt
separate from provider execution text so optimistic transcript reconciliation
does not depend on their string equality.

## Dispatch sequence

1. Validate session/environment ownership and enhanced-protocol support.
2. Check the existing session dispatch lock and parked request. A different
   request cannot pass a parked ambiguous command.
3. Resolve selection using the catalogue registry; refresh once if needed and
   safe. Fail before dispatch if absent, disabled, ambiguous, or incompatible.
4. Check arguments, attachments, annotations, handoff, current turn state, and
   command execution policy. Preserve the draft on rejection.
5. For a session action, reuse `performProjectionAction` and the action's own
   idempotency/reconciliation behavior. For a provider command, use the existing
   provider send/journal path with a prepared private binding.
6. Persist resolved identity and an execution fingerprint as part of the
   existing dispatch record before any potentially side-effecting preparation.
   For templates, preparation may itself have effects; step 07 restricts it.
7. Send once; record positive acceptance with the same request ID. Do not
   mistake a completed HTTP response for the completion of a running command.
8. Publish a durable outcome/transcript reference, including local commands
   that return without a model turn. Rehydration must find it after unmount.

## Retry and queue semantics

Keep the current prepared/dispatched/unknown recovery model. If a network
failure leaves acceptance ambiguous, reconcile using the provider's existing
dispatch journal or authoritative transcript. Never retry under a new ID, and
never reinterpret that same ID as a normal prompt. A positive dispatch record
is proof of acceptance; missing records after restart are not proof of absence.

Store command intent with queued prompts. Revalidate availability at dequeue,
but do not rebind a command to a different implementation with the same name.
If a binding changed, park or reject it with a user-actionable reason and retain
the original input. Harmless catalogue description updates do not block it.

The private binding is prepared once. Persist only what the existing bounded
dispatch store needs to reconcile; avoid duplicating full templates/attachments
in multiple journals. If a prepared payload cannot be reconstructed safely
after restart, mark it unknown and use the existing recovery UI rather than
rerunning preparation. Record a bounded fingerprint, never secret payloads in
logs. Define retention/pruning with the current dispatch owners.

## Workflows and literal text

Propagate the existing `allowProviderCommands` intent through HTTP bridge
requests, rather than honoring it only in OpenCode. Treat it as an explicit
protocol field on both sender and receiver. Structured/workflow requests
default to literal handling and cannot be satisfied by a local `/help` reply.

For Pi use the qualified SDK expansion opt-out. For Codex bypass bridge command
resolution when literal. For Claude/Grok qualify the real provider behavior:
plain text can itself trigger commands. If there is no native suppression,
use only a tested representation that preserves workflow semantics or reject
ambiguous command-leading workflow input. Do not silently assert suppression
that the provider does not offer. Existing structured-output validation remains.

## Session actions

Retain running-turn `/steer` semantics, expected-turn checking, text-only input,
and local idle explanation. Add `/compact` only through providers' existing
compact action and capability. Reject unsupported arguments rather than
ignoring them. Busy-state refusal must be atomic with dispatch/compaction so
the shortcut cannot abort an unrelated turn. Other actions stay out of scope.

## Tests and acceptance

- Same selected command via picker, direct API, and queue resolves identically.
- Removed command fails before provider send; discovery failure does not run a
  model turn; literal path/message remains usable.
- Retry after lost acknowledgement sends at most once with the same identity.
- Restart at prepare/send/accept/persist boundaries yields correct recovery.
- Attachments and arguments reach the intended transport exactly once.
- Pending handoff cannot silently suppress or consume a command.
- Local/extension commands with no model output have visible durable outcomes.
- Workflow opt-out is verified on every adapter, not just the shared type.
- Approval timeout, malformed answer, disconnect, and generation death retain
  existing deny semantics; command support introduces no new approval shortcut.
