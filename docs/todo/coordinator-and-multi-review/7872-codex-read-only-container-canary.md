# Prove the Codex read-only fallback with a real Codex turn in a container

## Task analysis

Analysed 2026-11-12 against `main` at `dc8803a8c`.

### Tasks

1. **Run a real Codex read-only turn in a container and check what it may do**. Status: open.

### 1. Run a real Codex read-only turn in a container and check what it may do

**Problem.** A Codex `readOnly` turn in a container now runs without Codex's
command sandbox (`danger-full-access` under `untrusted`), and the bridge
answers every approval the turn asks for itself: it approves a command
`codexReadOnlyCommandVerdict` proves only reads and declines everything
else, MCP tool approvals included ("Codex read-only turns in a container" in
`docs/architecture/coordinator.md`). Every test of that path uses a scripted
app-server: it proves the parameters the bridge sends and how it answers
approvals, not what a real Codex does with them. Not proved: that reads
(`cat`, `rg`, `git diff`, `git show`) run without the namespace error on a
clean `CODEX_HOME`, that the command string Codex puts in a real approval
request has the `/bin/bash -lc '<script>'` shape the check lexes, that a
mutating command, shell redirection or `apply_patch` cannot change a
sentinel file, and that the reviewer can still call its `orkestrator` submit
tool under `untrusted`.

**Context.** The Multi Review review on 2026-11-12 recorded this as a coverage
gap. Two models exist for a credential-free container check:
`e2e/agent-testing/container-multi-review-read-only.spec.ts` (Claude reviewers
on a fake Messages API in a real container environment, which also checks
that no write reached the checkout) and
`apps/backend/tests/container-live-telemetry-hosts.test.ts` (each CLI,
Codex included, runs a real turn against a fake provider on the runtime's
loopback). Neither drives a Codex `readOnly` turn through the bridge.

**Investigation.** Not started. A review of the pinned Codex 0.167.0 source
(`codex-rs/core/src/exec_policy.rs`, and `exec_policy_tests.rs` expecting
`git status` to need approval without an allow rule) found that `untrusted`
asks before every command no exec-policy rule allows, reads included; the
bridge's gate now approves proven reads for that reason rather than relying
on Codex to exempt them. Still unknown: whether an MCP elicitation for the
submit tool can arrive under `untrusted` despite
`default_tools_approval_mode: "approve"`. If one did, the gate would now
decline it, and the reviewer could not submit; the canary should check that
the submit call succeeds.

**Decisions.**

- **Where should the canary live?**
  - **A Codex variant of `container-multi-review-read-only.spec.ts` with a
    fake Responses API (recommended).**
    - Pros: drives the real path end to end (backend, bridge, Codex, the
      reviewer's submit tool); the fake can ask for a read, a mutating
      command and a patch, and the case can check a sentinel file is
      unchanged; no credentials or billed turns.
    - Cons: needs a fake Responses provider that emits shell and patch calls,
      which the telemetry test's fake does not yet do; opt-in Docker suite,
      so it runs only on demand.
  - **A bridge-level test in `container-live-telemetry-hosts.test.ts` style.**
    - Pros: smaller; no browser or profile.
    - Cons: skips the backend's sandbox-off note and the Multi Review
      settling that the user sees.
  - **A billed live Codex turn in a `dev:test` profile.**
    - Pros: no fake to write.
    - Cons: costs turns, depends on the model choosing the probing commands,
      and cannot run in CI.

## Related

- `docs/architecture/coordinator.md`, "Codex read-only turns in a container".
- [7871](7871-reviewer-that-reviewed-nothing-shows-complete.md): the reviewer
  that reviewed nothing shows as complete.
