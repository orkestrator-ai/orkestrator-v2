# Prove the Codex read-only fallback with a real Codex turn in a container

## Task analysis

Analysed 2026-11-12 against `main` at `dc8803a8c`; re-analysed 2026-11-13
against `main` at `17d28238c`.

### Tasks

1. **Run a real Codex read-only turn in a container and check what it may do**. Status: open. The fake Responses API, a host live test of the whole reviewer turn (passed 2026-11-13 on Codex 0.167.0) and the container spec are built; left: one run of the container spec on a Linux node with rootless Docker (see "Needs verification").

### 1. Run a real Codex read-only turn in a container and check what it may do

**Problem.** A Codex `readOnly` turn in a container now runs without Codex's
command sandbox (`danger-full-access` under `untrusted`). Before its thread
starts the bridge writes `CODEX_HOME/rules/orkestrator-read-only.rules`,
whose `allow` rules let a fixed set of reading programs run without asking,
and it declines every approval the turn asks for at once, MCP tool approvals
included (`refuseApproval`; "Codex read-only turns in a container" in
`docs/architecture/coordinator.md`). The bridge's runtime tests use a
scripted app-server; the rules are proved against the real pinned
app-server outside a container (see Investigation). Not proved in a real container
turn: that reads run without the namespace error on a clean `CODEX_HOME`,
that `apply_patch` is declined, and that the reviewer can still call its
`orkestrator` submit tool under `untrusted`.

**Context.** The Multi Review review on 2026-11-12 recorded this as a coverage
gap. Two models exist for a credential-free container check:
`e2e/agent-testing/container-multi-review-read-only.spec.ts` (Claude reviewers
on a fake Messages API in a real container environment, which also checks
that no write reached the checkout) and
`apps/backend/tests/container-live-telemetry-hosts.test.ts` (each CLI,
Codex included, runs a real turn against a fake provider on the runtime's
loopback). Neither drives a Codex `readOnly` turn through the bridge.

**Investigation.** Done for the rule mechanism, not for a full turn. The
pinned Codex 0.167.0 source has no list of safe commands: under
`UnlessTrusted` a command no exec-policy rule matches always asks
(`render_decision_for_unmatched_command_for_platform` in
`codex-rs/core/src/exec_policy.rs`), so without rules every read was declined
and a reviewer read nothing (Multi Review finding, 2026-11-12). An `allow`
match yields `ExecApprovalRequirement::Skip`. Rules are loaded from
`<config folder>/rules/*.rules` for each config layer, the user layer being
`CODEX_HOME`, whenever a session starts (`ExecPolicyManager::load` in
`Session::new`, `core/src/session/mod.rs`); a file that does not parse fails
the thread start (`failed to load rules`). `bash -lc` scripts are split into
plain commands (`parse_shell_lc_plain_commands`) and each must be allowed; a
script that cannot be split is evaluated whole and matches no rule. The
pinned `codex execpolicy check` accepted the generated file and matched
`cat a.txt`, `head -n 5 x`, `grep -rn foo .` and `git status --short`, and
matched nothing for `git diff HEAD`, `rg foo`, `sed -n 1p x`, `rm -rf build`,
`git -c core.pager=x status` and `/bin/cat x`. Against the real pinned
app-server on a loopback model (not in a container),
`bridges/codex-bridge/src/app-server/live-read-only-exec-rules.test.ts`
(`RUN_LIVE_CODEX_APP_SERVER=1`, no credits) passed 4/4 on 2026-11-12: a
chained `cat | head && grep` ran without asking with the rules and asked and
was declined without them; `echo changed > sentinel.txt` and `sed -n 1p`
asked and were declined with the rules, and the sentinel was unchanged. What
is left for this task is the container and the reviewer's submit call. The submit tool should not
be asked about: in `core/src/mcp_tool_call.rs` (0.167.0)
`maybe_request_mcp_tool_approval` returns before any elicitation when
`requires_mcp_tool_approval_for_mode` is false, which it always is for an
`approve`-mode tool, unless strict auto-review is on; read-only turns use the
`user` reviewer. The canary should still check that the submit call succeeds,
because the refusal would decline an elicitation if one arrived.

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

- **How does a sandbox-off read-only turn read, given that the pinned
  Codex asks for every command no rule allows?** Decided and built (see
  Assumptions and decisions).
  - **A bridge-owned exec-policy rules file of reading programs, every
    approval still declined (recommended, built).**
    - Pros: Codex enforces it; the bridge still never approves anything, so
      the ticket's decline-every-approval contract holds; checked with the
      pinned Codex's own rule checker.
    - Cons: a prefix rule admits any arguments, so tools with a writing or
      program-running option (`rg`, `sed`, `find`, `git diff`/`show`/`log`)
      stay declined; other Codex sessions on the same `CODEX_HOME` also run
      the listed programs without asking.
  - **Restore the bridge-side read classifier from `7f949b384`.**
    - Pros: handles flags per argument, so `git diff` and `sed -n` could run.
    - Cons: the bridge approves commands, which the ticket forbids; a second
      reading-program allowlist beside the Claude bridge's.

## Assumptions and decisions

### Exec-policy rules instead of a bridge-side classifier (task 1, decision 2)

Chosen in the Multi Review fix round of 2026-11-12 after the review proved
from the pinned source that reads were declined. The rules file keeps every
approval declined, as the ticket requires, while Codex itself runs the
listed reads. The allowed set is deliberately narrow: only programs none of
whose options writes a file or runs another program, plus `git status`,
`git rev-parse`, `git ls-files` and `git merge-base`; the developer
instructions name them so the model reads diffs from its review package with
`cat`. Task 1 stays open: the end-to-end canary is still the only proof that
a real turn reads and submits.

### The canary is built and the file stays open until it runs (task 1, 2026-11-13)

Built as the recommended Codex variant of the Claude container spec:
`e2e/agent-testing/container-fake-codex-review-api.ts` (a Responses
WebSocket that scripts the reviewer in Codex code-mode `exec` cells and logs
only step names and error flags), the gated host test
`bridges/codex-bridge/src/app-server/live-read-only-reviewer-turn.test.ts`
(`RUN_LIVE_CODEX_APP_SERVER=1`; passed on 2026-11-13 against Codex 0.167.0:
reads ran, `git diff`, `touch` and `apply_patch` were declined, the submit
reached the MCP server with no approval, nothing reached the checkout) and
the opt-in container spec
`e2e/agent-testing/container-multi-review-codex-read-only.spec.ts`, which is
in the browser config and the second Docker fixture shard. The container
spec has not run: beelink2, where it was built, has no Docker access.
Options: (a) retire this file and move the run to 7568; (b) keep task 1
open as `backlog`. Chose (b): a run on a headless Linux node with rootless
Docker and a loopback fake is agent work by
[Human-only work](../../README.md#human-only-work), and the Multi Review of
2026-11-13 rejected (a) for retiring the to-do before a container run had
passed.

## Needs verification

- The container run of `container-multi-review-codex-read-only.spec.ts`. On a
  Linux node whose environment containers reach a `dev:test` profile's agent
  tools server (`mise run docker:disposable -- start --host-loopback` with
  its `DOCKER_HOST` exported for the profile and the spec, as on beelink on
  2026-11-10; or `--agent-tools-port` in a range one firewall rule admits,
  [agent-testing.md](../../development/agent-testing.md#containers-behind-a-host-firewall---agent-tools-port)),
  build the dev image in that daemon, start a fresh `mise run dev:test
  --profile <name> --fixture --fixture-environments local,container
  --no-agent-credentials --agent-platforms codex --no-host-seed --headless`,
  then run `ORKESTRATOR_AGENT_TEST_PROFILE=<name>
  ORKESTRATOR_AGENT_TEST_FAKE_CODEX_REVIEW=1 mise run test:logged -- --name
  container-review-codex -- mise run test:agent:docker --
  container-multi-review-codex-read-only.spec.ts`, and stop and reset the
  profile. The file filter matters: no other Codex session may run in
  `fixture-container` before the case, because its app-server reads the
  fake's `openai_base_url` and key when it starts, and the other Docker
  fixture specs start Codex there. Record here the date, the image's Codex
  version and the result; on a failure, the step log's records
  (`/tmp/orkestrator-qa-codex-review-steps.jsonl` in the container: step
  names and error flags only) and the workflow's phase and error. Then
  retire this file. A failure in the fixture rather than the product (the
  backend refusing an unsigned Codex, the container's Codex not reading
  `~/.codex/config.toml`) is a new to-do.

## Related

- `docs/architecture/coordinator.md`, "Codex read-only turns in a container".
- 7871 (retired): the reviewer that reviewed nothing showed as complete. A
  reviewer now reports `reviewScope.outcome: "blocked"` and is treated as a
  failed reviewer ([A reviewer that could not review](../../architecture/review-preparation.md#a-reviewer-that-could-not-review)).
