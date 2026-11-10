# Container cells on a real Cursor SDK and a real Pi provider

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **Real Cursor turn in the container**: a Cursor tab in the fixture container, signed in, runs a shell tool that is refused off the allowlist. Status: open (needs a Cursor login in a container profile).
2. **Real Pi provider in the container**: a Pi tab in the fixture container on a real provider runs its `bash` tool under `auto-approve` and `ask`. Status: open (needs a Pi provider login in a container profile).

### 1. Real Cursor turn in the container

**Problem.** The Docker fixture's Cursor cell (`e2e/agent-testing/container-fake-engines.spec.ts`, from [0001](0001-agent-interactions-and-permissions.md) task 8) runs the real bridge over a fake SDK. The fake makes the network request from the bridge process itself. Whether the real `@cursor/sdk` local agent runs its Shell tool in the same process tree, and so behind the same firewall, has not been observed in a container.

**Context.** The bridge passes `local.sandboxOptions.enabled: false` for sandbox `container` (`bridges/cursor-bridge/src/agent-session.ts:546`), and the fake cell checks that it does. Containers reach Cursor's hosts only when Cursor is enabled (`requiredAgentNetworkDomains`).

**Investigation.** Not run: this host's agent-test profiles carry no Cursor credential for containers, and the ticket that added the fake cell forbade real logins and billed turns. The fake cell passed on beelink on 2026-11-06.

**Decisions.**

- **How to run it?**
  - **An opt-in variant of the fake cell (`ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_CURSOR=1`, profile started with `--credential-source cursor`) that asks the model to run `curl https://example.com/` and checks the tool card's output (recommended).**
    - Pros: reuses the spec's layout, policy and cleanup code; repeatable.
    - Cons: a billed turn; the model must choose the Shell tool.
  - **A manual run in a container environment.**
    - Pros: no spec work.
    - Cons: not repeatable.

### 2. Real Pi provider in the container

**Problem.** The Pi cell runs Pi's real SDK and `bash` tool, but over pi-ai's faux model. A real provider adds the provider's own request from the container (allowlist entries for that provider) and real tool-call selection.

**Context.** Pi fronts the user's own providers. A self-hosted endpoint is a host only the user knows and must be in `allowedDomains`. Credentials reach a container as the staged `~/.pi/agent/auth.json`.

**Investigation.** Not run, for the same reason as task 1. The faux cell proves the bridge, the policy, the firewall and the `ask` card. A real provider adds only its own network reach and the model's tool choice.

**Decisions.**

- **Which provider?**
  - **One the host is already signed in to with a cheap model, chosen with `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_PI_MODEL` (recommended).**
    - Pros: no new account; the same opt-in shape as the other live specs.
    - Cons: what it shows depends on that provider's hosts being allowlisted.
  - **Fix the provider in the spec.**
    - Pros: deterministic.
    - Cons: fails on hosts without that login.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) task 8 (the fake-engine cells).
- [Exhausted-pool and probe-network evidence](../../development/container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06) (what blocked the first manual profile start).
