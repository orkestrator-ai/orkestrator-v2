# Claude's Linux provider sandbox does not reach loopback directly under full network

## Task analysis

Analysed 2026-11-10 against `main` at `c98b20e6f`. Found by the Linux half
of [0001](0001-agent-interactions-and-permissions.md) task 9 on `beelink2`
with the pinned CLI 2.1.319.

### Tasks

1. **Tell the user about the Linux loopback limit**: decide whether Agent Info (and the policy override UI) should say that a Claude session with a provider sandbox and full network on Linux cannot reach services on the machine's loopback directly, and add the note. Status: open.

### 1. Tell the user about the Linux loopback limit

**Problem.** A Claude session whose execution policy is `sandbox: "provider"`
with `networkAccess: "full"` reaches loopback directly on macOS, but not on
Linux. On Linux, `curl http://127.0.0.1:<port>/` from a sandboxed command
fails with `Could not connect to server`, so a dev server, a local database
or a test fixture listening on the machine is out of reach unless the tool
uses the sandbox proxy. Agent Info shows "full network" for both systems.

**Context.** The bridge sets `network.allowLocalBinding: true` for a full
network (`claudeExecutionSandbox`,
`bridges/claude-bridge/src/services/claude-execution-sandbox.ts`). The SDK's
types document that option as "macOS only". On Linux the CLI runs each
command under bubblewrap in its own network namespace, and the only way out
is the proxy it starts (`HTTP_PROXY`/`HTTPS_PROXY`). The proxy's `NO_PROXY`
names loopback and the private ranges, so ordinary tools send loopback
requests direct, into the empty namespace. Through the proxy (`curl
--noproxy ''`) the same request reaches the server. This is the CLI's
network model, not a bridge defect, and it changes nothing about the
restricted case: there loopback is refused on both systems, as intended.
Host sessions default to no sandbox, so this reaches only users who choose
the provider sandbox on Linux.

**Investigation.** Observed on 2026-11-10 by
`claude-provider-sandbox.live.test.ts` (`mise run verify:claude:sandbox-live`)
on `beelink2` (Arch/Omarchy, kernel 7.2.15, bubblewrap 0.13.1): the
`control-direct-full` turn got `curl: (7) … Could not connect to server` and
the loopback server saw 0 requests, while `control-proxy-full` reached it
through the proxy. The test now asserts the refusal on Linux
(`PLATFORM_SANDBOX_EXPECTATIONS.linux.directLoopbackWithFullNetwork: false`),
so a CLI that changes this fails the check on the next bump. Agent Info's
text comes from the policy the bridge reports (`claudeReportedPolicy` in
`bridges/claude-bridge/src/services/claude-query-config.ts`, rendered by
`nativeAgentPolicyEffects` in
`packages/protocol/src/native-agent-policy-effects.ts`); the Claude bridge
currently reports the session's policy unchanged outside read-only turns,
with no note. Other bridges already use the policy's `note` for what they
cannot honour (Pi, Grok and OpenCode for the sandbox).

**Decisions.**

- **Should the user be told?**
  - **Add a note to the reported policy on Linux when the sandbox is
    `provider` and the network `full` (recommended).**
    - Pros: the user sees it where the policy is shown, in the same place
      other platforms explain what they cannot honour; small change in one
      function, testable with the platform injected.
    - Cons: one more note to keep in step with the CLI; the effects summary
      still says "full network", which is true for every host but loopback.
  - **Document it only (agent-engines.md, done 2026-11-10).**
    - Pros: no code.
    - Cons: a user who picks the provider sandbox on Linux finds out when a
      command fails.
- **Should Orkestrator work around it?**
  - **No (recommended).** Removing loopback from `NO_PROXY` is not something
    the SDK exposes, and setting `network.httpProxyPort` to a proxy of
    Orkestrator's own would take over the CLI's network filtering.
    - Pros: the CLI keeps the only network boundary there is.
    - Cons: the limit stays until the CLI changes.
  - **Report the network as restricted on Linux.**
    - Pros: never overstates.
    - Cons: wrong for every non-loopback host, which the proxy does reach.

## Constraints and rationale

- The note must not describe a boundary the bridge does not hold; it states
  a limit of the CLI's sandbox, so it belongs in the policy's `note`, not in
  a changed `networkAccess`.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  task 9 (where it was found).
- [0145-claude-linux-sandbox-apparmor-nested-userns.md](0145-claude-linux-sandbox-apparmor-nested-userns.md)
  (the Linux sandbox probe).
- [agent-engines.md](../../architecture/agent-engines.md#execution-policy).
