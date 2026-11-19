# Provider-replay corpus: real recordings and what the synthetic fixtures found

## Task analysis

Analysed 2026-11-19 against `main` at `0007f0e66`. Follow-up to the provider-replay suite for the Claude, Cursor, Pi and ACP bridges (`tests/conformance/provider-replay/`).

### Tasks

1. **Record real traffic for each supported scenario and add it beside the synthetic fixture.** Status: open.
2. **Decide whether an interrupted turn should settle its started tool cards on Claude and Pi.** Status: done.

### 1. Record real traffic for each supported scenario

**Problem.** The original corpus used hand-written fixtures. Most scenarios still need captured traffic to check the shapes providers emit in practice.

**Context.** Each of the four bridges now carries an opt-in recorder (`@orkestrator/protocol/node/provider-replay-recorder`, switched on by `ORKESTRATOR_PROVIDER_RECORD_DIR` plus `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1`) that writes the fixture format directly. Local bridges inherit the backend's environment, so a local fixture environment in a `dev:test` profile records; a container's bridge does not receive the variables. The README's "Recording real traffic" section is the procedure. Agent-test profiles may use the host's provider credentials for this repository (AGENTS.md, "Safety boundaries"), and each scenario costs one or two short turns.

**Investigation.** The review repair adds capture-to-replay tests through production recording hooks for each bridge. The default corpus now includes real basic-turn captures for Claude, Cursor and Pi, and cancellation captures for Cursor and Pi. The Grok credential available to the isolated profile had expired. Claude's live cancellation attempt ended with an execution error before a successful interruption could be observed.

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
    - Pros: removes known prompt, file and tool payload fields before manual review.
    - Cons: excerpts in the expectations become empty, so prose assembly is pinned by length only.
  - **Keep prose and scrub identity and secrets only.**
    - Pros: expectations stay readable.
    - Cons: relies on reading every diff for content the scrubber cannot recognise.

### 2. Settle started tool cards on interrupt (Claude, Pi)

**Problem.** The synthetic `interruption` fixtures showed tool cards staying `pending` after Claude and Pi returned idle. Cursor settles it as failed (`settleAbandonedToolParts`), and ACP marks it failed when `session/prompt` returns `cancelled`.

**Context.** Pinned in `bridges/claude-bridge/src/testing/provider-replay/interruption.expected.json` and `bridges/pi-bridge/src/testing/provider-replay/interruption.expected.json`. Both synthetic fixtures end at the interrupt with a tool result still outstanding.

**Investigation.** The revised expectations show the tool card pending mid-turn and failed after interruption. Claude applies the same settlement when reading a persisted interrupt marker.

**Decisions.**

- **What should the bridge do with an interrupted tool card?**
  - **Settle open tool parts as failed with a fixed note when the turn ends interrupted, as Cursor does (recommended).**
    - Pros: one behaviour across bridges; the transcript stops claiming work is running on an idle session.
    - Cons: a background command that genuinely survives the interrupt would read as failed.
  - **Leave them pending and let the renderer mark tools on an idle session as left running.**
    - Pros: no bridge change.
    - Cons: every renderer path has to know; the transcript itself still says pending.

## Assumptions and decisions

### Task 1. Keep the recorded checkpoints alongside synthetic scenarios

Use a disposable fixture project and retain the provider events relevant to each scenario, with workspace and session metadata removed. The five captured scenarios supplement the synthetic cases. The remaining live capture work stays open.

### Task 2. Settle interrupted tools at the bridge boundary

Mark pending tool invocations in the interrupted turn failed with a fixed message. The transcript keeps existing output and uses the same tool state when it is read again. Real traffic is still needed for the remaining corpus work in task 1.

## Constraints and rationale

- A recording holds prompts, file contents and absolute paths until scrubbed; never commit one unread.
- A changed expectation is reviewed, not regenerated blindly (`bridges/AGENTS.md`, "Recorded provider traffic").

## Related

- [Provider-traffic replay](../../../tests/conformance/provider-replay/README.md)
- [Upgrading agent SDKs and binaries](../../development/upgrade-agents.md#replay-recorded-provider-traffic)
