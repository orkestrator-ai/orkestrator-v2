# 11 — Make command selection explicit in the composer

Status: proposed. Dependencies: 02–04; steps 05–10 for release readiness.
[Index](00-index.md).

## Owners

`apps/web/src/components/native-agent/AgentNativeTab.controller.tsx`,
`components/chat/SlashCommandMenu.tsx`, `hooks/useSlashCommandMenu.ts`, native
draft/submission state, `stores/nativeAgentProjectionStore.ts`, and their
existing tests. Use the current shared composer and UI components.

## Discovery experience

Keep `/` as the picker entry point. Search canonical/display names, aliases,
and descriptions with bounded deterministic ranking: exact name, name prefix,
alias match, then other substring matches. Search normalization must not mutate
the provider's outgoing spelling. Keep grouping and keyboard order identical;
do not let visual source groups reorder rows independently of navigation.

Show these distinct states:

| State | User-facing behavior |
| --- | --- |
| Loading | Small progress row; composer remains editable |
| Ready empty | Explain that this session has no provider commands |
| Unsupported | Explain that this integration does not expose provider commands; show available application actions separately |
| Stale | Keep previous rows visible with refresh status; validate selection on send |
| Unavailable | Bounded explanation and retry/refresh action |
| No filter match | Keep query visible and offer an explicit ordinary-text path where valid |

Show argument hints next to the selection and, when useful, under the input
after selection. Keep disabled reasons readable through keyboard focus as well
as pointer hover. Do not expose protocol version, raw RPC names, paths, or
internal descriptor IDs in routine user flows.

## Selection and editing

1. Selecting a row inserts its `insertText`, preserving canonical spelling, and
   records ID/binding revision in the draft. It does not submit or execute.
2. Retain identity while only arguments change. Clear it if the command token
   changes, the user opts for literal text, or session/provider authority changes.
3. Codex skill selection may insert `$name`; the retained descriptor makes that
   executable without requiring the picker to stay open after insertion.
4. On catalogue refresh, retain highlighted selection by ID. Clamp/reset only
   when that ID disappears. A reordered list must not change the meaning of
   Enter under the user's cursor.
5. Preserve a selected-but-removed command in the draft as stale/unavailable.
   Ask for a new selection at send time instead of silently converting to text.
6. Keep argument text byte-for-byte through selection validation. Do not lose
   pasted multiline content, quotes, tabs, or trailing spaces in normalization.
7. Store selection per draft/session. Restored drafts may display old identity,
   but must revalidate it before execution after a backend generation change.

## Submission and state feedback

Classify intent before mention serialization, handoff history, annotation
augmentation, and attachment-reference generation. Send command metadata through
the existing backend submission API. Treat client validation as convenience;
the backend remains authoritative.

Reject incompatible attachments/annotations with a command-specific explanation
before clearing the draft. Preserve the existing handoff restriction until a
command explicitly supports carrying transferred history. Show when a command
requires idle state or will be queued. Runtime `/steer` must retain its current
send-to-active-turn behavior rather than joining the prompt queue.

Reuse the current recoverable-dispatch card for ambiguous acceptance. Do not
add an independent spinner or retry control with a new request ID. Results from
local commands and non-model extension handlers should render from durable
backend outcome/transcript state, not a temporary toast alone. Configuration
commands, if later qualified, must update controls from provider snapshots.

## Literal messages

Unknown `/path` text should not become an error just because it resembles a
command. When the menu or a known unavailable spelling creates ambiguity,
offer an explicit “Send as text” action. That choice must reach the backend as
literal intent. If a provider cannot honor literal suppression for that exact
input, explain the limitation before sending; do not offer a nonfunctional
escape action or silently wrap text differently without qualification.

## Keyboard and accessibility

Use appropriate combobox/listbox semantics, stable option IDs, active-descendant
tracking, labels, and live status announcements. Preserve Arrow keys, Tab/Enter
completion, Escape close, Shift+Enter newline, Shift+Tab's existing behavior,
and IME composition handling. Selection must not accidentally trigger submit.
Restore focus/caret after insertion without reopening or executing the menu.
Test pointer, keyboard, narrow layout, and screen-reader state changes.

## Verification and acceptance

Extend hook/menu tests for alias search, no-match states, revision changes,
stable-ID highlight, disabled rows, whitespace, and insertion text different
from display name. Extend native-tab tests for draft restoration, input policy,
handoff, queued identity, recoverable dispatch, and provider switching.

Run the required isolated real-browser cycle: select and run a fixture command,
switch environments while it executes, return after completion, reload, and
verify result and catalogue. Repeat with a pending interaction and a command
removed while inactive. Check desktop and narrow viewports. No enabled row may
depend on a renderer-only execution or outcome state.
