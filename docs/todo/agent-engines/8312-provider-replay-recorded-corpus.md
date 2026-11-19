# Provider-replay corpus: real recordings and what the synthetic fixtures found

## Task analysis

Analysed 2026-11-19 against `main` at `0007f0e66`. Follow-up to the provider-replay suite for the Claude, Cursor, Pi and ACP bridges (`tests/conformance/provider-replay/`).

### Tasks

1. **Record real traffic for each supported scenario and add it beside the synthetic fixture.** Status: open.
2. **Decide whether an interrupted turn should settle its started tool cards on Claude and Pi.** Status: open (depends on 1).

### 1. Record real traffic for each supported scenario

**Problem.** Every fixture in the corpus is `synthetic`: hand-written in the shape each bridge's tests already assume. It pins what the bridges do with that shape, but a fixture written from our own belief cannot catch the case the suite exists for, a provider emitting something we did not expect.

**Context.** Each of the four bridges now carries an opt-in recorder (`@orkestrator/protocol/node/provider-replay-recorder`, switched on by `ORKESTRATOR_PROVIDER_RECORD_DIR` plus `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1`) that writes the fixture format directly. Local bridges inherit the backend's environment, so a local fixture environment in a `dev:test` profile records; a container's bridge does not receive the variables. The README's "Recording real traffic" section is the procedure. Agent-test profiles may use the host's provider credentials for this repository (AGENTS.md, "Safety boundaries"), and each scenario costs one or two short turns.

**Investigation.** Not started. The ACP adapter's round-trip test proves a recording of a replayed turn parses as a fixture with the version the agent reported, so the recorder's output is replayable; what a real Grok, Claude, Cursor or Pi session records has not been seen.

**Decisions.**

- **Which recordings first?**
  - **One per scenario the provider can produce, `approval-denial` and `interruption` first (recommended).**
    - Pros: those are the sequences where pending interactions and completion semantics differ most between providers; one recording each is enough to compare against the synthetic fixture.
    - Cons: billed turns on four providers.
  - **Only on the next pin bump of each provider.**
    - Pros: no extra turns now.
    - Cons: the first real recording then arrives together with a protocol change, so a difference cannot be told apart from the bump.
- **Strip prose from recordings?**
  - **Run the scrubber with `--strip-content` unless the scenario depends on the text (recommended).**
    - Pros: no prompt or file content can reach the repository.
    - Cons: excerpts in the expectations become empty, so prose assembly is pinned by length only.
  - **Keep prose and scrub identity and secrets only.**
    - Pros: expectations stay readable.
    - Cons: relies on reading every diff for content the scrubber cannot recognise.

### 2. Settle started tool cards on interrupt (Claude, Pi)

**Problem.** In the synthetic `interruption` fixtures, a tool call that had started when the user stopped the turn stays `pending` on Claude and Pi after the session is idle, so its card would keep showing as running. Cursor settles it as failed (`settleAbandonedToolParts`), and ACP marks it failed when `session/prompt` returns `cancelled`.

**Context.** Pinned in `bridges/claude-bridge/src/testing/provider-replay/interruption.expected.json` and `bridges/pi-bridge/src/testing/provider-replay/interruption.expected.json`. Claude adds an "Interrupted by user" status row but leaves the Bash part pending. The synthetic fixtures end at the interrupt; a real provider may still emit a closing frame for the call (Pi's `tool_execution_end`, a Claude `tool_result`) that these fixtures do not contain.

**Investigation.** Only the synthetic replays above. Whether real providers settle the call themselves is what task 1's recordings answer.

**Decisions.**

- **What to do if real recordings show the card left pending?**
  - **Settle open tool parts as failed with a fixed note when the turn ends interrupted, as Cursor does (recommended).**
    - Pros: one behaviour across bridges; the transcript stops claiming work is running on an idle session.
    - Cons: a background command that genuinely survives the interrupt would read as failed.
  - **Leave them pending and let the renderer mark tools on an idle session as left running.**
    - Pros: no bridge change.
    - Cons: every renderer path has to know; the transcript itself still says pending.

## Constraints and rationale

- A recording holds prompts, file contents and absolute paths until scrubbed; never commit one unread.
- A changed expectation is reviewed, not regenerated blindly (`bridges/AGENTS.md`, "Recorded provider traffic").

## Related

- [Provider-traffic replay](../../../tests/conformance/provider-replay/README.md)
- [Upgrading agent SDKs and binaries](../../development/upgrade-agents.md#replay-recorded-provider-traffic)
