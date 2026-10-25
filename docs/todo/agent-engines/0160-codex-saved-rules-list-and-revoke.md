# Codex saved rules: list and revoke

Checked against `main` at `00a0cb82` (2026-10-25).

Split out of item 1 of
[0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
which decided on 2026-10-25 that Claude offers no "always allow" option. Codex
is the one provider whose approval card can save a durable rule today, and the
constraint in 0001 ("no always-allow option ships without a way to list and
revoke what it saved") is not met for it.

## Current state

- A Codex command or network approval offers the exec-policy or
  network-policy amendment Codex proposes as an optional, labelled choice
  ("Approve with command policy" and the network equivalent;
  `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` in
  `bridges/codex-bridge/src/app-server/approvals.ts`). **Approve** alone sends
  `accept` and saves nothing.
- An exec-policy amendment is written by Codex into the user's Codex home:
  `~/.codex/rules/default.rules` (seen live on 2026-10-21, see the live pause
  record in 0001). It applies to every later Codex session on that host, in
  and out of Orkestrator. Where a network-policy amendment is stored was not
  checked.
- Orkestrator has no read or revoke surface. The user can only edit the rules
  file by hand.

## Outstanding work

### Code

1. **List and revoke saved Codex rules.** Add `NativeAgentPermissionRule`
   (`id`, `label`, `scope`, `source`), `GET /session/:id/permission-rules` and
   `DELETE /session/:id/permission-rules/:ruleId` on the Codex bridge, and
   `listPermissionRules?` / `removePermissionRule?` on
   `NativeAgentRuntimeProvider`. Bridges with no saved rules answer an empty
   list, not 404. Then show the list, with a remove action, where the user
   manages the agent (Agent Info or settings).
   - Find out first whether app-server exposes the rules (a method that
     lists or removes exec-policy and network-policy entries). If it does
     not, the bridge would have to parse and rewrite Codex's rules file,
     whose format is Codex's own and may change on any release.
2. **Or stop offering the amendments.** If (1) is not worth building, drop
   the amendment options from the card, so Orkestrator never saves a rule it
   cannot show.

### Qualification

- On a disposable Codex home: save a command rule from the card, see it
  listed, remove it, and confirm the next identical command asks again.

## Constraints and rationale

- An allow-once decision must never widen durable permissions (0001).
- The rules file belongs to the user's Codex installation; never rewrite it
  without a format Codex documents or an app-server method.

## Open questions

- Which of (1) or (2)? (1) keeps a feature Codex users may rely on; (2) is
  smaller and closes the gap at once.

## Needs verification

- Where Codex 0.164.0 stores a network-policy amendment.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) item 1.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  item 4 (a profile shares the host Codex home).

## Replaces

- The Codex half of 0001 item 1 ("Always allow" and saved rules).
