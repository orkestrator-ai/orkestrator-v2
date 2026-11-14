# Codex host sessions on an administrator-managed Codex host

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Run on a host whose requirements forbid full access**: a host session under the default policy fails every turn when `/etc/codex/requirements.toml` leaves `danger-full-access` out of `allowed_sandbox_modes`. Status: open.
2. **Say that a managed network proxy does not apply without Codex's sandbox**: under the host default Codex skips the administrator's network proxy, and nothing in the app says so. Status: open.

### 1. Run on a host whose requirements forbid full access

**Problem.** Orkestrator's host default runs Codex with no sandbox
(`sandbox: "none"`, which the bridge sends as `danger-full-access`). An
administrator can forbid that mode in `/etc/codex/requirements.toml`
(`allowed_sandbox_modes = ["read-only", "workspace-write"]`). On such a host
every turn of a default host session is refused by Codex, and the bridge
answers the prompt with 503 and Codex's raw text:
`turn/start failed (-32600): invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by /etc/codex/requirements.toml)`.
The user can recover only by finding Settings → Execution policy and choosing
the provider sandbox.

**Context.** Seen on 2026-11-14 with the pinned Codex 0.167.0 in a disposable
container, through the real codex-bridge process, while working to-do 0723
(retired) task 7 (`apps/backend/tests/codex-managed-network-card-live.test.ts`
is the harness; its `withStack` takes any execution-policy override). The
bridge picks the sandbox in `app-server-runtime-lifecycle.ts`
(`policy?.sandbox === "provider" ? "workspace-write" : "danger-full-access"`)
and the backend resolves the policy in
`apps/backend/src/core/native-agent-execution-policy.ts`, whose comment gives
the reason for no sandbox on a host: every vendor sandbox holds `.git`
read-only. app-server reports the effective requirements through
`configRequirements/read` (`ConfigRequirements.allowedSandboxModes`,
generated types under `bridges/codex-bridge/src/app-server/generated/`); the
bridge does not call it yet.

**Investigation.** Only the default host policy is affected: a session whose
override selects the provider sandbox runs (`workspace-write` is in the
allowed set), and containers are not affected unless an image ships such a
file. A 503 is also classed as transient by callers, so a pipeline step or
the public CLI may retry a turn that can never succeed.

**Decisions.**

- **What should a default host session do there?**
  - **Read `configRequirements/read` at engine start and, when
    `danger-full-access` is not allowed, run the host default as
    `workspace-write`, with a policy `note` saying the administrator's Codex
    requirements require Codex's sandbox (recommended).**
    - Pros: the session works with no user action; the tier and note shown
      next to the platform stay true; uses app-server's own answer rather than
      parsing the file.
    - Cons: `.git` is read-only under Codex's sandbox, so Git writes ask (the
      reason the default is no sandbox); one more app-server call at start.
  - **Keep the default and turn the refusal into a 4xx with a clear message
    naming Settings → Execution policy.**
    - Pros: no change of sandbox the user did not choose; small.
    - Cons: every default session still fails until the user acts.
  - **Leave it.**
    - Pros: no work.
    - Cons: a raw 503 that callers retry.

### 2. Say that a managed network proxy does not apply without Codex's sandbox

**Problem.** When `/etc/codex/requirements.toml` turns Codex's network proxy
on (`[network_proxy] enabled = true`), Codex routes and asks about network
access only inside its own sandbox. Under Orkestrator's host default (no
sandbox) a request to any host goes straight out with no card, so an
administrator's proxy has no effect on Orkestrator's default host sessions,
and the app does not say so.

**Context.** Same run as task 1. With the provider sandbox and approvals Ask
the card appears and behaves as designed ("Approve network access", no
amendment, `CODEX_HOME/rules/` stays empty;
[permission-rules.md](../../architecture/permission-rules.md#codex-on-a-managed-network-host)).
With the host default plus approvals Ask, the same `curl` reached the probe
server unasked. This is Codex's own rule (full access is outside the proxy);
an administrator who wants it enforced also restricts
`allowed_sandbox_modes`, which is task 1.

**Investigation.** `ConfigRequirements` from `configRequirements/read` says
whether requirements are configured; the bridge can tell a managed host from
an unmanaged one without reading `/etc` itself. No other provider has an
equivalent administrator proxy.

**Decisions.**

- **How to handle it?**
  - **Add a policy `note` on Codex host sessions that run without a sandbox
    while requirements enable the network proxy, and keep the sandbox choice
    to the user (recommended).**
    - Pros: honest about what the session enforces; no behaviour change; the
      administrator's real lever (task 1) still applies.
    - Cons: a note is easy to miss.
  - **Run the host default as `workspace-write` whenever requirements enable
    the network proxy.**
    - Pros: the administrator's proxy always applies.
    - Cons: Git writes ask on every such host even when the administrator
      allowed full access on purpose.

## Current state

Nothing built. The harness to prove either task exists
(`codex-managed-network-card-live.test.ts`, run by
`mise run verify:codex:network-card`); a test for task 1 needs a second
container run whose requirements file adds `allowed_sandbox_modes`, because
the test must never write `/etc/codex/requirements.toml` itself.

## Constraints and rationale

- Never write `/etc/codex/requirements.toml` on a real machine; prove
  managed-host behaviour only in a disposable container, with a made-up key
  and a loopback model, as `scripts/verify-codex-network-card.sh` does.
- A rule or answer must never save anything in the provider's own rule files
  (0160 and 0723, both retired); nothing here changes that.

## Related

- [permission-rules.md](../../architecture/permission-rules.md#codex-on-a-managed-network-host):
  the managed-network card result (0723 (retired) task 7).
- `apps/backend/src/core/native-agent-execution-policy.ts`: why the host
  default runs without a sandbox.
