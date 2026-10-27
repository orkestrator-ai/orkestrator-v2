# Codex saved rules: list and revoke

Checked against `main` at `00a0cb82` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Choose list-and-revoke or drop the amendments**: code items 1 and 2 plus the open question, one decision with two implementations. Status: open.
2. **Network-amendment storage**: the "Needs verification" item, where Codex 0.164.0 stores a network-policy amendment. Status: open.
3. **Qualification on a disposable Codex home**: save, list, remove, and see the next identical command ask again. Status: open (depends on 1; only needed if item 1 ships).

### 1. Choose list-and-revoke or drop the amendments

**Problem.** A Codex approval card offers "Approve with command policy" and "Approve with network policy". Either one writes a durable rule into the user's Codex home, which applies to every later Codex session on that host, in and out of Orkestrator. Orkestrator cannot show or undo it. That breaks 0001's rule that no always-allow option ships without list and revoke.

**Context.** Split from 0001 item 1. The constraint is that the rules file belongs to Codex, so Orkestrator never rewrites it without a documented format or an app-server method.

**Investigation.**
- The card still offers both. The bridge builds amendment options only from what app-server proposed (`bridges/codex-bridge/src/app-server/approvals.ts:275-290`) and sends them back verbatim (`:405-423`). The backend labels them "Approve with command policy" and "Approve with network policy", with the proposed rule as the description (`apps/backend/src/core/http-bridge-interactions.ts:485-515`). Neither the label nor the description says the rule is durable or host-wide.
- No list or remove surface exists. A search for `permission-rules` or `listPermissionRules` finds nothing.
- app-server 0.164.0 (`bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`) has no method to list or remove exec-policy or network-policy rules. The nearest client methods are `config/read`, `config/value/write`, `config/batchWrite` and `permissionProfile/list`. None of them names saved exec-policy rules, so item 1 would mean parsing and rewriting Codex's rules file, which the constraint forbids.
- A network amendment can be `allow` or `deny` (`generated/typescript/v2/NetworkPolicyRuleAction.ts`), so a saved rule can also block a host durably.
- Stale reference: "Related" says a profile shares the host Codex home. 0031 now records that the isolated Codex home covers `rules/` (`docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:64-72`).

**Decisions.**

- **Which option?**
  - **(2) Stop offering the amendments until app-server exposes a rules method (recommended).** Remove the two options in the backend mapper, or in the bridge's descriptor, and leave "Approve" and "Approve for session".
    - Pros: closes the gap at once with a small, testable change; matches 0001's decision for Claude; no dependency on Codex's private file format.
    - Cons: Codex users lose a one-click way to save a rule; they can still use Codex's own CLI or edit the file.
  - **(1) List and revoke by parsing `~/.codex/rules/*.rules`.**
    - Pros: keeps the feature with an undo.
    - Cons: needs a parser and writer for an undocumented, Codex-owned format that may change on any release; breaks the file's own constraint; network rules' storage is still unknown.
  - **(1) with a read-only list, no revoke.**
    - Pros: makes saved rules visible without rewriting anything.
    - Cons: still parses a private format, and still fails 0001's "list and revoke" rule.
- **Where is the option removed?**
  - **In the backend mapper (`http-bridge-interactions.ts`), keeping the bridge's descriptor unchanged (recommended).**
    - Pros: one place; easy to re-enable when a rules method appears; the bridge still records what Codex proposed.
    - Cons: the bridge keeps code paths that are unused for now.
  - **In the bridge's descriptor.**
    - Pros: nothing reaches the backend that cannot be used.
    - Cons: re-enabling it later means a bridge release as well.

### 2. Network-amendment storage

**Problem.** It is unknown where Codex 0.164.0 stores an applied network-policy amendment.

**Context.** This only matters if option (1) is chosen.

**Investigation.** The generated protocol has no answer. The amendment is `{ host, action }`, and nothing in the client methods reads it back. It would take a live run with a disposable Codex home.

**Decisions.**

- **Is this kept?**
  - **Retire it if option (2) is chosen; otherwise run it first (recommended).**
    - Pros: no live run spent on a question the chosen option does not need.
    - Cons: the answer stays unknown for a future revisit.
  - **Run it now regardless.**
    - Pros: complete knowledge before deciding.
    - Cons: costs a live Codex run with network approval for a fact that may never be used.

### 3. Qualification on a disposable Codex home

**Problem.** Nothing has shown end to end that a saved rule can be listed, removed and then asks again.

**Context.** A `dev:test` profile now isolates `rules/` (0031 lines 64-72), so it is a safe place to run this.

**Investigation.** With option (2) the qualification becomes: the card offers no amendment option, and the profile's `rules/` directory stays empty after an approval.

**Decisions.**

- **What counts as a pass?**
  - **With option (2): a unit test that the mapped options carry no amendment, plus one live card check in a `dev:test` profile (recommended).**
    - Pros: cheap; proves the gap is closed where users see it.
    - Cons: does not exercise Codex's rule writing at all (by design).
  - **The file's full save, list, remove and re-ask run.**
    - Pros: proves option (1) if it is chosen.
    - Cons: only meaningful for option (1).

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
