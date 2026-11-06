# Whether the default allowlist still needs its telemetry hosts

Carried from the security report's S-0100 file (finding M12, task 3) when it was closed on 2026-11-05. The report recommended removing the telemetry-only defaults after a live check that the agent CLIs still run without them. That check needs a real agent run, which the S-0100 build could not make, so the default list is unchanged.

## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`.

### Tasks

1. **Check the agent CLIs without the telemetry hosts**: a run of each CLI in a restricted container whose list omits them. Status: open.
2. **Remove the hosts that no CLI needs**: change the one default list and regenerate the image fallback. Status: open (depends on 1).

### 1. Check the agent CLIs without the telemetry hosts

**Problem.** `DEFAULT_ALLOWED_DOMAINS` (`packages/protocol/src/network-allowlist.ts`) carries `sentry.io`, `statsig.anthropic.com` and `statsig.com`. They are an easy channel for data: Sentry accepts events for whatever DSN a request names, so an agent can send to an attacker's project. Nothing in the code says which CLI needs them.

**Context.** The three hosts match the reference firewall Anthropic publishes for Claude Code's dev container, which is where the defaults came from; `statsig.anthropic.com` is Anthropic's feature-flag proxy and Sentry is Claude Code's error reporting. The other CLIs' required hosts are added per platform by `requiredAgentNetworkDomains`, and none of those lists names these three. `tests/conformance/execution-policy/scripted-anthropic.ts` already runs a real `claude` against a scripted local Anthropic API, with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. `apps/backend/tests/claude-terminal-failed-turn-docker.test.ts` runs the image's real Claude CLI against a fake API on the container's loopback, which costs no provider turn.

**Investigation.** Not run. S-0100 could not make a real provider turn, and a CLI that only prints its version proves nothing about a session. The name checks S-0100 shipped narrow the channel already: in a gateway that checks names, an allowlist entry allows exactly that name, so `sentry.io` no longer lets a client resolve or reach `o<org>.ingest.sentry.io` or `o<org>.ingest.us.sentry.io`, the hosts current DSNs name. That refuses an attacker's DSN, and also Claude Code's own error reports, in such containers. Before name checks, those names resolved but their addresses were not on the list either, so Claude Code's Sentry reports were very likely failing in restricted containers already. That is a reason to expect the check to pass, not evidence that it does.

**Decisions.**

- **How should the check be run?**
  - **Against a fake provider, in a restricted container from a current image whose list omits the three hosts (recommended).** Reuse the fake-API harness of `claude-terminal-failed-turn-docker.test.ts` with an allowlist entry for the fake API, run a native and a terminal turn with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` unset, and check the turn completes with no stall and no error the user sees. Repeat for any other CLI whose traffic names these hosts (a gateway's refusals show which).
    - Pros: no billed turn; the real CLI's real behaviour when the hosts are refused; repeatable in CI.
    - Cons: a fake API may not trigger the code paths that report errors or fetch flags the way a real session does.
  - **One real turn per CLI on an isolated agent-test profile.**
    - Pros: the full real session.
    - Cons: billed provider turns; needs the user's approval.

### 2. Remove the hosts that no CLI needs

**Problem.** Until task 1 passes, the defaults keep the channel open for every new install.

**Context.** The list is the one canonical default: the renderer seeds from it and `scripts/generate-default-allowed-domains.ts` writes the image fallback `docker/default-allowed-domains`. A stored user list is never changed to match a new default, so existing installs keep the hosts until the user removes them.

**Investigation.** Nothing removed yet.

**Decisions.**

- **What happens to existing installs?**
  - **Change only the default and say so in the release notes (recommended).**
    - Pros: matches the rule that a stored list is never widened or narrowed behind the user.
    - Cons: existing installs keep the channel until their users edit the list.
  - **Also remove the three from stored lists on upgrade.**
    - Pros: closes the channel everywhere.
    - Cons: edits the user's own list, which nothing else does; a user who added them on purpose loses them.

## Needs verification

- Which CLIs, if any, contact these hosts during a session (task 1).

## Related

- [Security report, M12](../../reports/2-26-10-27-security.md#m12-egress-firewall-limitations-design)
- [6101](6101-egress-name-checks-platform-coverage.md), [6102](6102-egress-name-check-residual-channels.md)
