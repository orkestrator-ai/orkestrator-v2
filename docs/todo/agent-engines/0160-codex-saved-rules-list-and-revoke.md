# Codex saved rules: list and revoke

Checked against `main` at `00a0cb82` (2026-10-25). Worked on
`todo-0160-codex-saved-rules-94d86804329e` from `863b5782` (2026-10-27).
The open question is decided: Orkestrator stops offering the amendments
(option 2, decision 1 below). Every code item is done and the qualification
ran against the real pinned Codex 0.164.0 on a throwaway Codex home. What is
left is a look at a real Codex approval card in the app (Needs verification).
The durable rule lives in
[`bridges/codex-bridge/AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md)
and [`agent-engines.md`](../../architecture/agent-engines.md) (invariant 5).

Split out of item 1 of
[0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
which decided on 2026-10-25 that Claude offers no "always allow" option. Codex
was the one provider whose approval card could save a durable rule, and the
constraint in 0001 ("no always-allow option ships without a way to list and
revoke what it saved") was not met for it.

## Current state

- A Codex approval card offers **Approve**, **Approve for session** (Codex's
  in-memory `acceptForSession`, which ends with the session) and **Deny**.
  It no longer offers "Approve with command policy" or "Approve with network
  policy".
- The bridge drops app-server's proposals (`proposedExecpolicyAmendment`,
  `proposedNetworkPolicyAmendments`) from the approval descriptor and never
  answers with `acceptWithExecpolicyAmendment` or
  `applyNetworkPolicyAmendment` (`describeApproval`, `buildApprovalResponse`
  in `bridges/codex-bridge/src/app-server/approvals.ts`). The
  `approve-with-execpolicy-amendment` and `approve-with-network-amendment`
  decisions and the `amendmentIndex` field are gone from the router, runtime,
  engine and `POST /session/:id/approvals/:approvalId`, which now answers 400
  for either decision.
- The backend ignores `amendments` on a descriptor from an older bridge (an
  older container image, for example) and always answers a Codex approval
  with plain `approve` (`mapCodexApproval` and the approval branch of the
  resolution mapping in `apps/backend/src/core/http-bridge-interactions.ts`).
- The provider-neutral `AgentInteractionOption.amendment` contract in
  `packages/protocol/src/agent-interactions.ts` is unchanged; no provider
  fills it now.
- Proof:
  - Unit tests: `approvals.test.ts` (no descriptor amendments, no amendment
    arm for any decision, retired decisions rejected),
    `server-request-router.test.ts` (approving a request that proposes
    amendments sends `accept`), `sse-replay.test.ts` (the route's 400) and
    `apps/backend/src/core/agent-provider-interactions.test.ts` (an older
    bridge's amendments are neither offered nor sent).
  - Live, credit-free:
    `bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts`
    (gated by `RUN_LIVE_CODEX_APP_SERVER=1`, listed in
    [`upgrade-agents.md`](../../development/upgrade-agents.md)). Passed on
    2026-10-27 against the pinned 0.164.0 binary with a loopback fake model
    and a throwaway `CODEX_HOME`. An `untrusted` command approval carried
    `proposedExecpolicyAmendment`; the card descriptor had no amendment;
    **Approve** left `CODEX_HOME/rules/` empty; the identical command asked
    again in the next turn. The control answered the same request with the
    amendment, as the bridge used to: Codex wrote `rules/default.rules` and
    the next identical command ran without asking.
- Full suite (`mise run test`, 2026-10-27): codex-bridge 2,441 passed and
  every web, protocol and other-bridge suite passed; the failures were in
  files this change does not reach and are recorded, with base-commit reruns,
  in flake case
  [1170](../../tests/flaky-tests/aggregate-validation-runs/1170-codex-saved-rules-0160-validation.md).
- Rules a user saved before this change stay in their Codex home
  (`~/.codex/rules/default.rules`). Orkestrator does not read or edit them
  (decision 2).

## Outstanding work

### Code

1. ~~**List and revoke saved Codex rules.**~~ Not built (decision 1).
   app-server 0.164.0 has no method that lists or removes exec-policy or
   network-policy entries: the generated `ClientRequest` method list
   (`app-server/generated/typescript/ClientRequest.ts`) has none, and
   `codex execpolicy` offers only `check`. The bridge would have had to parse
   and rewrite Codex's Starlark rules file itself.
2. **Stop offering the amendments.** Done 2026-10-27, as described under
   Current state.

### Qualification

- ~~On a disposable Codex home: save a command rule from the card, see it
  listed, remove it, and confirm the next identical command asks again.~~
  Replaced by the option 2 check, run on 2026-10-27 through the bridge's
  engine on a throwaway Codex home (see Current state): **Approve** saves no
  rule and the next identical command asks again. The same check from a
  real card is under Needs verification.

## Constraints and rationale

- An allow-once decision must never widen durable permissions (0001).
- The rules file belongs to the user's Codex installation; never rewrite it
  without a format Codex documents or an app-server method.
- Defence in depth: the bridge refuses the amendment decisions even if a
  card (an older backend, a hand-made request) asked for one, and the
  backend drops amendments from an older bridge, so neither side alone can
  save a rule.

## Open questions

- ~~Which of (1) or (2)?~~ (2), decision 1.

## Needs verification

- A real Codex command approval card in the app shows Approve, Approve for
  session and Deny, with no "Broader approval (optional)" choice, and
  **Approve** leaves the profile's isolated `CODEX_HOME/rules/` empty. Not
  run: it needs a `dev:test` profile with a Codex login seeded from the
  host's `auth.json`, which this run was not allowed to touch. The backend
  mapping and the bridge are proved by the tests above; the card renders the
  backend's options generically.
- ~~Where Codex 0.164.0 stores a network-policy amendment.~~ No longer
  needed: Orkestrator never sends one, so nothing it does can store one.

## Assumptions and decisions

Decisions made on 2026-10-27.

1. **List and revoke, or drop the amendments.** Options: (a) build the list
   and revoke surface (`NativeAgentPermissionRule`, `permission-rules`
   routes, `listPermissionRules?` / `removePermissionRule?`, a list in Agent
   Info) by parsing and rewriting `~/.codex/rules/*.rules`; (b) stop
   offering the amendments. Chose (b). app-server 0.164.0 has no method to
   list or remove rules, so (a) means Orkestrator parsing and rewriting a
   Starlark file Codex owns, which the user may also edit by hand and whose
   format can change in any release; the constraint above forbids that, and
   where network amendments are stored was not even known. Pros: closes the
   gap at once; nothing Orkestrator does outlives a session; less code (the
   amendment plumbing through four bridge layers and the backend is gone).
   Cons: a Codex user who relied on "Approve with command policy" now
   approves each time, or uses **Approve for session**, an auto-approve
   policy, or Codex's own rules file. Revisit if app-server adds a rules
   method.
2. **Rules saved before this change.** Options: (a) remove or rewrite rules
   Orkestrator may have saved; (b) leave them. Chose (b). Nothing records
   which rules came from Orkestrator rather than the Codex CLI or the user,
   and the constraint forbids rewriting the file. Pros: never destroys a rule
   the user wanted. Cons: an old rule keeps applying until the user removes
   it from `~/.codex/rules/default.rules` by hand.
3. **A retired decision at the bridge route.** Options: (a) degrade
   `approve-with-*-amendment` to plain `accept`; (b) reject it with 400 and
   leave the approval pending. Chose (b). No current client sends it (the
   bridge never describes an amendment, and the backend never maps one), so
   it can only come from a hand-made request, and an unknown decision is
   rejected like any other. Pros: fail-closed, one decision set. Cons: none
   found; an older backend paired with a new bridge never receives an
   amendment to offer, so it never sends the decision.
4. **The shared contract.** Options: (a) remove `exec-policy` and
   `network-policy` from `AgentInteractionAmendment`; (b) leave the
   provider-neutral `amendment` field as is. Chose (b). It is part of
   `packages/protocol`, read by every client version; narrowing the
   validator would make a newer client reject a whole interaction from an
   older backend, leaving a card nobody can answer. Pros: no mixed-version
   risk. Cons: two kinds no provider fills today.
5. **Live proof without credits.** Options: (a) a real-stack run with a
   Codex login; (b) the real pinned app-server against a loopback fake model
   and a throwaway `CODEX_HOME`, as the other `live-*.test.ts` gates do.
   Chose (b) for this run, because copying the host's Codex login was not
   allowed. A second reader on the child's stdout observes the raw request
   (to prove Codex proposed an amendment), and the control writes the old
   amendment answer straight to app-server's stdin to prove the rules check
   finds a saved rule. Pros: real Codex behaviour, repeatable on every
   upgrade, no credits. Cons: does not exercise the rendered card (Needs
   verification).

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) item 1.
- [0723-orkestrator-permission-rules.md](0723-orkestrator-permission-rules.md): the
  "always allow" this file removed, rebuilt as Orkestrator's own allow-once rules;
  it also lists the rules saved by the removed options, read-only.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  item 4 (a profile shares the host Codex home).

## Replaces

- The Codex half of 0001 item 1 ("Always allow" and saved rules).
