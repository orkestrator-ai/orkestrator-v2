# Slash-command implementation plan

Status: proposed; no implementation has been performed.
Baseline: 2026-09-21, commit `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.

Read the [investigation](../../slash-commands.md) first. Finding IDs below refer
to that report. This plan specifies future changes; code-shaped contracts and
suggested new modules are design proposals, not existing APIs.

## Objective and completion criteria

Make every enabled command in the native composer execute the behavior its
descriptor promises, with provider-native discovery, truthful availability,
preserved input, and recoverable state outside mounted React components.

Completion requires:

- All six integrations have an explicit support policy and pinned-version
  evidence. Unsupported Cursor provider commands remain unsupported.
- Claude/OpenCode executable inventories contain no guessed TUI commands.
- Claude, Codex, and Pi skills use the correct transport and name resolution.
- Aliases, collisions, multiline input, literal text, queued commands, and
  attachments have deterministic, tested behavior.
- A chosen command cannot degrade into a normal prompt after discovery failure,
  stale selection, reconnect, restart, or ambiguous acknowledgement.
- Dynamic catalogues and command outcomes recover after environment switching.
- Existing journals, approval denial rules, dispatch reconciliation, transport
  bounds, and idle-detach behavior remain intact.
- Focused tests, required full validation, isolated browser QA, and applicable
  provider probes have recorded results. Unqualified entries stay unavailable.

## Numbered steps

| Step | Work | Dependencies | Findings |
| --- | --- | --- | --- |
| [01](01-qualify-provider-contracts.md) | Capture pinned provider contracts and fixtures | None | F01–F03, F09–F13 |
| [02](02-command-contract-and-resolution.md) | Define descriptors, snapshots, parsing, collisions, compatibility | 01 | F04–F06, F14 |
| [03](03-dispatch-intent-and-recovery.md) | Carry explicit intent through backend dispatch, actions, queues, recovery | 02 | F04–F06, F13 |
| [04](04-catalogue-lifecycle.md) | Implement bounded authoritative catalogue lifecycle and refresh | 02 | F06–F07 |
| [05](05-claude.md) | Correct Claude inventory, skill names, query scope, change events | 01–04 | F01–F02, F07, F13 |
| [06](06-codex-skills-and-actions.md) | Bind Codex skills to structured input; qualify runtime shortcuts | 01–04 | F03, F07 |
| [07](07-codex-template-compatibility.md) | Bound and correct Codex legacy template behavior | 02–04, 06 identity model | F05, F08 |
| [08](08-opencode.md) | Use real OpenCode command catalogue and exact command API identity | 01–04 | F01, F05–F06, F09 |
| [09](09-pi.md) | Consolidate Pi inventory; handle precedence and headless execution | 01–04 | F10, F13 |
| [10](10-grok-and-cursor.md) | Correct ACP metadata/freshness and preserve Cursor capability limit | 01–04 | F11–F12 |
| [11](11-composer-and-command-feedback.md) | Expose identity, availability, arguments, aliases, and results in UI | 02–04; provider adapters for release | F05–F06, F14 |
| [12](12-validation-and-rollout.md) | Run contract, lifecycle, browser, mixed-version, and release gates | All previous steps | All |

The numbered order is the review sequence. Provider adapters can be developed
independently after the shared contracts settle, but no adapter is considered
complete until it passes the end-to-end gates. This document does not request
agent delegation or authorize implementation.

## Architectural decisions

1. Extend the current native-agent projection and prompt/action contracts.
   Do not introduce a second transport, composer, or generic RPC executor.
2. Discovery and invocation share an authoritative backend/bridge registry.
   The renderer receives descriptors, never executable filesystem authority.
3. Keep provenance separate from execution. Missing provenance is `unknown`.
4. Keep request IDs and the existing at-most-once ownership. Command metadata
   enriches the existing transaction; it does not create competing journals.
5. Explicit selection is binding. Removal or execution-route changes require
   re-selection. Harmless description updates do not invalidate a selection.
6. Unknown slash text stays usable as text, with a deliberate literal-send
   option where intent is ambiguous. Known unavailable commands do not run.
7. Workflow/structured prompts opt out unless their caller explicitly requests
   a provider command supported by that workflow contract.
8. Start with existing steer and compact action implementations. Other UI and
   session-management shortcuts are follow-up work, not implied support.
9. Disable Codex template shell substitution by default. Do not enlarge the
   current unsandboxed shell surface while improving command compatibility.
10. Keep changes additive until an explicit compatibility window ends. Never
    treat an unknown session's 404 as proof that a bridge is merely old.

## Intended review slices

- Foundation: 01–04, with legacy behavior characterized and enhanced execution
  disabled until an adapter declares support.
- Provider corrections: 05–10, each independently reviewable with fixtures.
- Product integration: 11, enabling only qualified provider entries.
- Release: 12, including retirement decisions and documentation updates.

Do not enable a display-only command ahead of its executor. Small fixes such as
ACP `input.hint` parsing can land earlier if they do not introduce new contract
dependencies. Avoid a monolithic provider rewrite.

## Out of scope

Terminal keystroke injection, reimplementing provider TUIs, a generic extension
UI renderer, cross-provider skill conversion, installing commands/plugins,
automatic dependency upgrades, destructive session reset, arbitrary account
actions, and replacing the existing agent skill-management feature.

During implementation, update the older
[SDK coverage command plan](../../../plans/sdk-coverage/06-commands-skills-and-templates.md)
and [documentation catalogue](../../../README.md) to point at the final owners.
Those files are intentionally unchanged by this investigation-only task.
