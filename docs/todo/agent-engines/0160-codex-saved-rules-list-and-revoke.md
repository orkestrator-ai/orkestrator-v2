# Codex saved rules: list and revoke

Checked against `main` at `00a0cb82` (2026-10-25). Worked on
`todo-0160-codex-saved-rules-94d86804329e` from `863b5782` (2026-10-27), and
re-checked on `manage-saved-rules-5f31bb8de4ba-r1` from `0658de64` (2026-11-01)
against the pinned Codex 0.166.0. Orkestrator stops offering the amendments
(option 2, decision 1 below), and that still holds on 0.166.0. Tasks 1, 2 and 3
are done, including a real Codex card in the app with no credits. What is left
is one look at a managed-network card in the app (Needs verification). The
durable rule lives in
[`bridges/codex-bridge/AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md)
and [`agent-engines.md`](../../architecture/agent-engines.md) (invariant 5).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`. Each task's "Investigation"
was written then, against Codex 0.164.0, and is kept as the record of that
analysis. Each ends with what the 2026-11-01 pass found on 0.166.0.

### Tasks

1. **Choose list-and-revoke or drop the amendments**: code items 1 and 2 plus the open question, one decision with two implementations. Status: done (drop, shipped in `727f91c8`, #1325; still correct on 0.166.0).
2. **Network-amendment storage**: where the pinned Codex stores a network-policy amendment. Status: done (`CODEX_HOME/rules/default.rules`, a `network_rule(...)` line; evidence under task 2).
3. **Qualification on a disposable Codex home**: save, list, remove, and see the next identical command ask again. Status: done (real card and the list in the app, and the whole cycle on the pinned binary; evidence under task 3).

### 1. Choose list-and-revoke or drop the amendments

**Problem.** A Codex approval card offers "Approve with command policy" and "Approve with network policy". Either one writes a durable rule into the user's Codex home, which applies to every later Codex session on that host, in and out of Orkestrator. Orkestrator cannot show or undo it. That breaks 0001's rule that no always-allow option ships without list and revoke.

**Context.** Split from 0001 item 1. The constraint is that the rules file belongs to Codex, so Orkestrator never rewrites it without a documented format or an app-server method.

**Investigation.**
- The card still offers both. The bridge builds amendment options only from what app-server proposed (`bridges/codex-bridge/src/app-server/approvals.ts:275-290`) and sends them back verbatim (`:405-423`). The backend labels them "Approve with command policy" and "Approve with network policy", with the proposed rule as the description (`apps/backend/src/core/http-bridge-interactions.ts:485-515`). Neither the label nor the description says the rule is durable or host-wide.
- No list or remove surface exists. A search for `permission-rules` or `listPermissionRules` finds nothing.
- app-server 0.164.0 (`bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`) has no method to list or remove exec-policy or network-policy rules. The nearest client methods are `config/read`, `config/value/write`, `config/batchWrite` and `permissionProfile/list`. None of them names saved exec-policy rules, so item 1 would mean parsing and rewriting Codex's rules file, which the constraint forbids.
- A network amendment can be `allow` or `deny` (`generated/typescript/v2/NetworkPolicyRuleAction.ts`), so a saved rule can also block a host durably.
- Stale reference: "Related" says a profile shares the host Codex home. 0031 now records that the isolated Codex home covers `rules/` (`docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:64-72`).

**Re-checked 2026-11-01 on 0.166.0.**
- Still no rules method: the 109 methods in `clientRequestMethods` (`generated/protocol-manifest.json`) include none that lists or removes a rule, and `codex execpolicy` still offers only `check`.
- The amendments are still gone: the bridge sends neither, the backend ignores an older bridge's, and the card shows none (see task 3).
- 0723 (`3d707ddd`, #1348, with follow-ups in #1458) changed two things here. A user who wants "always allow" now has Orkestrator's own rules, and Settings → Permissions lists Codex's rule files read-only under "Rules outside Orkestrator". So no second rules surface is needed, and the problem left is only that those files are not edited from the app.
- One premise changed. Codex's docs now describe the format (`learn.chatgpt.com/docs/agent-configuration/rules`), so "undocumented" no longer holds. They also say rules are experimental and may change, and a hand-written rule can span lines and carry comments and inline tests. Removing one safely still takes a Starlark-aware editor of a file the user and Codex both write, so the recommendation stands.

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

**Answer, 2026-11-01, on the pinned 0.166.0.** An accepted network amendment is written to `CODEX_HOME/rules/default.rules`, the same file as a command rule, as one line:

```text
network_rule(host="probe-host.example.test", protocol="http", decision="allow", justification="Allow http access to probe-host.example.test")
network_rule(host="probe-host.example.test", protocol="http", decision="deny", justification="Deny http access to probe-host.example.test")
```

For comparison, a command amendment on the same binary writes
`prefix_rule(pattern=["touch", "probe-file.txt"], decision="allow")`.

Evidence and method:
- Static: the binary holds `failed to persist network policy amendment to execpolicy:` and `network_rule(`.
- Live: `codex-aarch64-unknown-linux-musl` 0.166.0, matching the manifest's archive and executable digests, in a disposable `oven/bun:1.4.4` container, with a temporary `CODEX_HOME` and a loopback model. Repeat it with `mise run verify:codex:network-approval`.
- `config.toml` gained no network entry; only Codex's own project trust table is there.
- `availableDecisions` lists only the allow amendment, but `proposedNetworkPolicyAmendments` also proposes a deny, and Codex honours an answer with it.

What the run also showed:
- **Codex only asks about a host under managed requirements.** With `features.network_proxy` alone it blocks the host with no approval ("domain is not on the allowlist"). It asks only once `/etc/codex/requirements.toml` has `[network_proxy] enabled = true`. So this card appears only on an administrator-managed host, and that file cannot be set up safely on a real machine. A try through macOS managed preferences in a disposable home was not picked up (`configRequirements/read` stayed `null`), which is why the run uses a container.
- **The approval carries no `command`.** The real params are `kind: "command"`, `reason`, `networkApprovalContext { host, protocol }` and the two proposals, with an `itemId` of `network#local#http#<host>#80#<uuid>`. The bridge and the backend both treated a command approval with no command as not actionable, so the card could only be denied. This is fixed (decision 6).

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

**Result, 2026-11-01, on the pinned 0.166.0.** No billed turn, and every run used a disposable Codex home. The loopback stand-in for the model means the real app-server asks for real.

| What | Where | Result |
| --- | --- | --- |
| A real card in the app | `e2e/agent-testing/codex-saved-rules-live.spec.ts`, `dev:test` profile, made-up key | Offers Deny, Cancel turn, Approve for session, Approve and remember… and Approve, and no amendment. Approve leaves `rules/` empty and the identical command asks again. |
| Listed in the app | the same spec | A `prefix_rule` and a `network_rule` in the profile's `rules/default.rules` appear in Settings → Permissions, with no controls. Real Codex obeys the rule in a new environment. Once the file is removed they are gone and a new environment asks again. |
| Command rule cycle, through the bridge's engine | `live-policy-amendment.test.ts` | Asks on save, then not in the same thread, then not in a new thread; removal leaves the running thread unasked, and a new thread asks. |
| Host, through the bridge's engine | `mise run verify:codex:network-approval` | The same cycle for allow and deny. Approve and Approve for session save nothing. |
| Approve for session | both of the above | No rule; it lasts for the thread, and a new thread asks again. |

**A rule removed by hand does not stop applying at once.** A Codex thread reads the rules once, when it starts, so a thread already running keeps a removed rule until it ends. This is the opposite of Orkestrator's own rules, which stop at the next request, so the guidance in Settings now says so.

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
was the one provider whose approval card could save a durable rule, and the
constraint in 0001 ("no always-allow option ships without a way to list and
revoke what it saved") was not met for it.

## Current state

- A Codex approval card offers **Approve**, **Approve for session** (Codex's
  in-memory `acceptForSession`, which ends with the thread),
  **Approve and remember…** (Orkestrator's own rule, 0723), **Cancel turn** and
  **Deny**. It no longer offers "Approve with command policy" or "Approve with
  network policy".
- A managed-network approval names only a host and has no command. It can now
  be approved, shows as "Approve network access", and an Orkestrator host rule
  can answer it (decision 6).
- Rules a Codex home already holds are listed read-only in Settings →
  Permissions, command and network alike, with how to remove them.
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
    `apps/backend/src/core/agent-provider-interactions-codex.test.ts` (an older
    bridge's amendments are neither offered nor sent).
  - Live, credit-free:
    `bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts`
    (gated by `RUN_LIVE_CODEX_APP_SERVER=1`, listed in
    [`upgrade-agents.md`](../../development/upgrade-agents.md)). Passed on
    2026-10-27 against the pinned 0.164.0 binary with a loopback fake model
    and a throwaway `CODEX_HOME`, and again on 2026-11-01 against 0.166.0. An
    `untrusted` command approval carried `proposedExecpolicyAmendment`; the
    card descriptor had no amendment; **Approve** left `CODEX_HOME/rules/`
    empty; the identical command asked again in the next turn. The control
    answered the same request with the amendment, as the bridge used to: Codex
    wrote `rules/default.rules` and the next identical command ran without
    asking.
  - The same file's managed-network half (`mise run
    verify:codex:network-approval`) and the real card
    (`e2e/agent-testing/codex-saved-rules-live.spec.ts`), both passed on
    2026-11-01; see tasks 2 and 3.
- Full suite (`mise run test`, 2026-10-27): codex-bridge 2,441 passed and
  every web, protocol and other-bridge suite passed; the failures were in
  files this change does not reach and are recorded, with base-commit reruns,
  in flake case
  [1170](../../tests/flaky-tests/aggregate-validation-runs/1170-codex-saved-rules-0160-validation.md).
- Rules a user saved before this change stay in their Codex home
  (`~/.codex/rules/default.rules`). Orkestrator lists them and does not edit
  them (decision 2).

## Outstanding work

### Code

1. ~~**List and revoke saved Codex rules.**~~ Not built (decision 1).
   app-server 0.166.0, like 0.164.0, has no method that lists or removes
   exec-policy or network-policy entries: the generated `ClientRequest` method
   list (`app-server/generated/typescript/ClientRequest.ts`) has none, and
   `codex execpolicy` offers only `check`. The bridge would have had to parse
   and rewrite Codex's Starlark rules file itself.
2. **Stop offering the amendments.** Done 2026-10-27, as described under
   Current state.
3. **Let a managed-network approval be approved.** Done 2026-11-01 (decision 6).

### Qualification

- ~~On a disposable Codex home: save a command rule from the card, see it
  listed, remove it, and confirm the next identical command asks again.~~
  Replaced by the option 2 check, run on 2026-10-27 through the bridge's
  engine on a throwaway Codex home (see Current state): **Approve** saves no
  rule and the next identical command asks again. On 2026-11-01 the same check
  ran from a real card, along with the file's full save, list, remove and
  re-ask cycle (task 3).

## Constraints and rationale

- An allow-once decision must never widen durable permissions (0001).
- The rules file belongs to the user's Codex installation; never rewrite it
  without an app-server method or a format Codex documents as stable. Its docs
  now describe the format but mark it experimental.
- Defence in depth: the bridge refuses the amendment decisions even if a
  card (an older backend, a hand-made request) asked for one, and the
  backend drops amendments from an older bridge, so neither side alone can
  save a rule.

## Open questions

- ~~Which of (1) or (2)?~~ (2), decision 1.

## Needs verification

- A managed-network card in the app: "Approve network access", enabled, with
  no amendment. Not run: Codex only raises it with
  `/etc/codex/requirements.toml` set, which a `dev:test` profile on a real
  machine must not write. The real payload is proved through the bridge's
  engine in a container, the backend mapping by a unit test, and the card
  renders these options generically.
- ~~A real Codex command approval card in the app shows Approve, Approve for
  session and Deny, and **Approve** leaves the profile's isolated
  `CODEX_HOME/rules/` empty.~~ Done 2026-11-01 (task 3).
- ~~Where Codex stores a network-policy amendment.~~ Done 2026-11-01 for
  0.166.0 (task 2). Option 2 does not need the answer, because Orkestrator
  never sends one, but the read-only list relies on it.

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
   upgrade, no credits. Cons: does not exercise the rendered card (decision 8
   closes that).

Decisions made on 2026-11-01, on Codex 0.166.0.

6. **A managed-network approval has no command.** Options: (a) leave it, since
   only managed hosts ever see it; (b) treat the host as the action to approve,
   in the bridge and the backend. Chose (b). Without it, dropping the network
   amendment left such a card with Deny as its only choice. Pros: the plain
   allow-once answer works, as the amendment's removal intended. Cons: it is a
   fix outside tasks 1 to 3 as written, found by running task 2. It also marks
   the request `ruleEligible`, so a saved Orkestrator host rule can answer it.
   That is what `permission-rules.md` already promised, and the backend's own
   checks still refuse a rule where the session's network is restricted. A
   command rebuilt from `commandActions` beside a host stays ineligible.
7. **Task 2, though option 2 needs no answer.** The file recommends retiring it
   under option 2. The ticket asks for the answer with evidence, and the
   read-only list depends on it: if Codex moved network rules, Settings would
   silently stop showing them. Options: (a) only a one-off run recorded here;
   (b) a repeatable check. Chose (b), `mise run verify:codex:network-approval`.
   Pros: an upgrade can repeat it. Cons: it needs Docker and a privileged
   throwaway container, because Codex's bubblewrap sandbox needs user
   namespaces. The repository is mounted read-only.
8. **A real card without credits.** Decision 5 ruled this out because it needed
   a copy of the host's login. Options: (a) leave it for a billed run; (b) a
   made-up key in a throwaway `CODEX_HOME`, as
   `codex-refused-login-live.spec.ts` does, with the profile's Codex pointed at
   a loopback model. Chose (b). Pros: the real backend, bridge, app-server and
   card, repeatable, no login touched. Cons: an opt-in spec to maintain. Inside
   a workspace an Ask session's sandbox runs a command unasked, so the scripted
   model requests `require_escalated` to reach the card.
9. **The guidance in Settings.** Options: (a) keep "edit or delete the line";
   (b) say what removal does. Chose (b), because a running thread keeps a
   removed rule, which the old wording hid. It also names network rules.
10. **Removing rules from the app.** Options: (a) keep the list read-only, with
    instructions (recommended by decision 2 and the constraint); (b) add a
    remove button that rewrites the file. Chose (a). The format is experimental,
    rules can span lines, the file is shared with the user and Codex, and removal
    would not reach a running thread anyway. Pros: nothing can damage a rule
    file. Cons: removing an old rule still means editing a file by hand. Revisit
    if app-server adds a rules method.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) item 1.
- [0723-orkestrator-permission-rules.md](0723-orkestrator-permission-rules.md): the
  "always allow" this file removed, rebuilt as Orkestrator's own allow-once rules;
  it also lists the rules saved by the removed options, read-only.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  a profile's isolated Codex home covers `rules/`.

## Replaces

- The Codex half of 0001 item 1 ("Always allow" and saved rules).
