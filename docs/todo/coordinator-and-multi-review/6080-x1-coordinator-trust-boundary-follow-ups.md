## Task analysis

Analysed 2026-11-05 against `main` at `af2e566e5`, from what the X1 batch (Coordinator trust boundary) could not prove or close. X1's outcome is the table ending `docs/reports/security/0090-x1-coordinator-trust-boundary.md`, in the parent of the commit that deleted it.

### Tasks

1. **Run the live read-only step**: run the home-mail steps of the `read-only` scenario on a real provider. Status: open.
2. **Prove the read boundary under bubblewrap**: the deny rule is proven on Seatbelt only. Status: open.
3. **Close the data directory on the other providers**: OpenCode, Cursor, Pi and Grok coordinators can still read it. Status: open.
4. **Decide what a read-only review turn may read**: a worker bridge's read-only turns have no read boundary. Status: open.
5. **Say where a delegated prompt came from**: mail is marked, `send_prompt_to_tab` and `launch_job` are not. Status: open.
6. **Measure the default**: how often coordinators need environments they did not create. Status: open (depends on usage).
7. **Retire the two compatibility paths**: the carrier's `selfReminder` spelling and the leaf capability. Status: open (depends on the floor).

### 1. Run the live read-only step

**Problem.** The steps that mail the project home have never met a real model, so nothing shows a real coordinator's tool call being refused and held as the unit tests say.

**Context.** X1 added them to `readOnlyScenarioPrompt` and `homeMailGateFailures` (`apps/desktop/scripts/dev/coordinator-live.ts`) and wired them in `e2e/agent-testing/coordinator-live.spec.ts`. A run is a billed provider turn, which the batch was not allowed to make.

**Investigation.** `coordinator-live.test.ts` checks the prompt and every failure the evaluation can report. Nothing has run `coordinator-live.spec.ts` with these steps, so it is also unproven that `list_agent_mailboxes` counts a delivered home message in `unreadCount`, which the "nothing reached the home" check reads.

**Decisions.**

- **Which platforms first?**
  - **Run `read-only` on Claude and Codex, the two `enforced` platforms (recommended).**
    - Pros: covers what a user most often runs; each is a single turn.
    - Cons: leaves the others on unit evidence until they next run.
  - **Run every platform in `COORDINATOR_LIVE_PLATFORMS`.**
    - Pros: complete.
    - Cons: more billed turns, and Grok still has no login on the qualifying hosts ([0024](0024-coordinator-live-conformance.md) task 1).

### 2. Prove the read boundary under bubblewrap

**Problem.** `filesystem.denyRead` with an `allowRead` carve-out was run only on Seatbelt. Whether bubblewrap gives the same answer, the allowance included, has not been observed.

**Context.** `bridges/claude-bridge/src/conformance-coordinator-read-boundary-live.test.ts` runs the real sandbox with a scripted model and a fixture data directory, so it costs no provider turn. Its control case shows the fixture is readable without the rule.

**Investigation.** The file matches the slow tier's `*-live.test.ts` pattern, so `mise run test:full` runs it where the sandbox can start, but no such run has been observed on Linux. The `Claude read boundary: the hook with no sandbox behind it` case needs no sandbox at all.

**Decisions.**

- **Where to run it?**
  - **Run the file on a Linux host with working bubblewrap and record the result here (recommended).**
    - Pros: one command, no provider turn.
    - Cons: needs such a host; Ubuntu's stock AppArmor profile stops the sandbox itself.
  - **Add it to the CI job that qualifies Claude under AppArmor.**
    - Pros: stays proven.
    - Cons: more CI minutes, and it can only run after that job's remediation step.

### 3. Close the data directory on the other providers

**Problem.** A read-only coordinator on OpenCode, Cursor, Pi or Grok runs as the user with no rule on the data directory, so it can read `control-mcp.json` and a login. Those credentials outrank its own.

**Context.** Codex was checked by reading its configuration: `codex-config.ts` gives a coordinator a deny-by-default permission profile (`":root" = "deny"`) with only the runtime root, attachments, skills and workspace readable. No Codex turn was run to prove it.

**Investigation.** No path rule for the data directory exists in `bridges/cursor-bridge`, `bridges/pi-bridge` or `bridges/acp-bridge`, or in the OpenCode permission rules. Pi's gate and Cursor's allowlist decide by tool, not path. `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR` is set for every coordinator bridge, so each can read the directory it has to protect. Grok has no sandbox of its own, and OpenCode exposes no way to verify a rule, so neither can reach `enforced` on this alone.

**Decisions.**

- **What to do per provider?**
  - **Add the path check to each provider's existing gate, and say in its tier note that it is a tool-level check (recommended).**
    - Pros: closes the obvious read; Pi's gate and Cursor's hook already see each call.
    - Cons: a shell command on these providers can still read the file unless its own sandbox stops it.
  - **Move the credentials outside anything the user's processes can read.**
    - Pros: none over the above: same uid, same reach.
    - Cons: breaks the documented location.

### 4. Decide what a read-only review turn may read

**Problem.** `claudeReadOnlySandbox` also serves a `readOnly` turn in a worker bridge (a graph reviewer, a pipeline review), and that bridge gets no read boundary.

**Context.** The launcher sets the variable only in its coordinator branch, like the other coordinator authority. A worker's ordinary turns can read the directory anyway on a host environment, so this is a smaller gap than a coordinator's.

**Investigation.** Not established: which paths under the data directory a review turn needs, such as evidence files and the account's Claude home. Denying without that list could fail reviews, and only a live turn would show it.

**Decisions.**

- **Should review turns get the boundary?**
  - **Leave them until a worker's ordinary turns are confined too (recommended).**
    - Pros: no risk to reviews for a gap the same worker's other turns already have.
    - Cons: a read-only reviewer can still read credentials on a host environment.
  - **Set it on every host bridge and allow the account's home.**
    - Pros: one rule for every read-only turn.
    - Cons: needs a live review turn to find the allowances.

### 5. Say where a delegated prompt came from

**Problem.** A coordinator turn started by worker mail can pass the same request on with `send_prompt_to_tab` or `launch_job`, and those prompts carry no note that it arose from agent mail. A scheduled `send_message` also reads whichever turn came last, not the turn that set it.

**Context.** X1's framing covers mail, as the report asked. `createCoordinatorDelegatedPrompt` (`packages/protocol/src/review-evidence-frames.ts`) frames a launch's prompt, and a recipient reads that frame.

**Investigation.** The frame is parsed strictly at offset zero and saved as a presentation, so a new line changes stored content older readers parse. `send_prompt_to_tab` sends no frame at all today.

**Decisions.**

- **How to mark them?**
  - **Add the note to the coordinator frame, and give `send_prompt_to_tab` the frame's note only (recommended).**
    - Pros: the same signal on every path.
    - Cons: needs a compatibility check on the frame parser.
  - **Leave prompts unmarked, since the origin check already limits them to the coordinator's own workers.**
    - Pros: no work.
    - Cons: an own worker still reads an injected request as an instruction.

### 6. Measure the default

**Problem.** How often coordinators legitimately drive environments they did not create decides how disruptive the default is. A reply to a tab in such an environment is refused too, so an agent there that asks the coordinator something gets no answer until the user opts in.

**Context.** The refusal names the setting, and the report recorded this as something only usage shows.

**Investigation.** No count exists. The refusal is an ordinary tool error and is not recorded anywhere a person can read it in aggregate.

**Decisions.**

- **What to do with the evidence?**
  - **Count refusals in a content-free counter, and allow replies to that environment's own mail if the count shows they dominate (recommended).**
    - Pros: decides from evidence; keeps today's strict rule until then.
    - Cons: a counter nobody reads is wasted, so someone has to look at it.
  - **Allow replies now.**
    - Pros: fewer refusals.
    - Cons: an exception in a security check with no evidence it is needed, and it would carry the "authenticated delegation" framing.

### 7. Retire the two compatibility paths

**Problem.** The carrier spells a self-reminder `source: "workflow"` with `selfReminder: true`, and `turnOrigin` goes only to a leaf advertising `node-mail-turn-origin`. Both exist only for older peers.

**Context.** Both are in the [version-compatibility register](../../architecture/version-compatibility.md#register).

**Investigation.** Neither has a usage counter, because the first is renderer-side and the second loses nothing.

**Decisions.** None: remove each when the floor is at or above the first Stable release that has it.

## Assumptions and decisions

### Task 3: retained provider-secret storage decision

The related provider-secrets decision lives in the storage architecture guide
after report retirement. Link to that retained section so task 3's data-directory
work can still reach the accepted-risk decision.

## Constraints and rationale

- The data directory is denied as a whole, with an allowance, rather than file by file. A list goes stale silently when a store adds a secret. The allowance is the part to extend: see `coordinatorReadBoundary`.
- An environment with no stored origin stays refused. Nothing distinguishes it from one the user made by hand.

## Needs verification

- Whether the Claude CLI ever needs another path under the data directory in a real coordinator turn. The scripted run covers saved tool results, memory, attachments and a command run under the sandbox; it does not cover skills or a large tool result written by a real MCP call. Re-run the qualification file on each CLI bump.

## Related

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#which-environments-a-coordinator-may-act-on)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [Provider secrets at rest](../../architecture/storage.md#provider-secrets-at-rest)
