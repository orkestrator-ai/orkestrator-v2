## Task analysis

Analysed 2026-11-09 against `main` at `c6de4733c` (first analysed 2026-11-05 at `af2e566e5`, again 2026-11-06 at `c1724ab74`), from what the X1 batch (Coordinator trust boundary) could not prove or close. X1's outcome is the table ending `docs/reports/security/0090-x1-coordinator-trust-boundary.md`, in the parent of the commit that deleted it. Tasks 2 to 4 were worked on a Linux host on 2026-11-06, and task 5's code on 2026-11-09 (its live check is still open); see Assumptions and decisions.

### Tasks

2. **Prove the read boundary under bubblewrap**: the deny rule is proven on Seatbelt only. Status: done (2026-11-06, bubblewrap 0.13.1).
3. **Close the data directory on the other providers**: OpenCode, Cursor, Pi and Grok coordinators can still read it. Status: done for Pi and OpenCode (a link defect fixed on OpenCode); Cursor in to-do 7400 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#provider-qualification)), Grok in [7401](7401-grok-coordinator-data-dir-reads.md), OpenCode under a user `OPENCODE_CONFIG_DIR` in 7402 (done 2026-11-10 and retired; see `docs/architecture/coordinator.md`).
4. **Decide what a read-only review turn may read**: a worker bridge's read-only turns have no read boundary. Status: done (decided: leave as is).
5. **Say where a delegated prompt came from**: mail is marked, `send_prompt_to_tab` and `launch_job` are not. The note is on every path and tested (2026-11-09); the billed live run showing a real worker reads it moved to the manual-test checklist. Left here: reword the note if that run shows a model ignores it. Status: blocked (waits on 7568: 6080 task 5 live run).
6. **Measure the default**: how often coordinators need environments they did not create. Status: open (depends on usage).
7. **Retire the two compatibility paths**: the carrier's `selfReminder` spelling and the leaf capability. Status: open (depends on the floor).

### 2. Prove the read boundary under bubblewrap

**Problem.** `filesystem.denyRead` with an `allowRead` carve-out was run only on Seatbelt. Whether bubblewrap gives the same answer, the allowance included, has not been observed.

**Context.** `bridges/claude-bridge/src/conformance-coordinator-read-boundary-live.test.ts` runs the real sandbox with a scripted model and a fixture data directory, so it costs no provider turn. Its control case shows the fixture is readable without the rule.

**Investigation.** The file matches the slow tier's `*-live.test.ts` pattern, so `mise run test:full` runs it where the sandbox can start. The `Claude read boundary: the hook with no sandbox behind it` case needs no sandbox at all.

Run on 2026-11-06 on Arch Linux (kernel 7.1.8, bubblewrap 0.13.1, socat present, `claudeLinuxSandboxStatus()` available), with the pinned SDK's CLI: all six cases pass, the control included. Run it from the bridge package so the root `bunfig.toml` DOM preload is not loaded (its `AbortSignal` makes the SDK throw `ERR_INVALID_ARG_TYPE` in `setMaxListeners`):

```bash
mise run test:logged -- --name read-boundary-live -- \
  bun --cwd=bridges/claude-bridge test src/conformance-coordinator-read-boundary-live.test.ts \
  --preload ../../tests/setup-node.ts
```

A throwaway probe through the same fixture showed what bubblewrap does, beyond what the file asserts:

- Commands ran in their own user and mount namespace with seccomp on (`Seccomp: 2`), so the sandbox, not the hook, refused.
- A denied path reads as missing (`No such file or directory`), not as a permission error: the data directory is masked and the allowances bound back in. `ls` of the data directory shows only the allowed subtrees.
- The allowance holds: the conversation's own memory, tool results and attachments read; another conversation's runtime under the same directory does not.
- A link in the checkout to `control-mcp.json` reads as missing too, and `grep -r` over the data directory finds nothing.
- A write into the masked directory succeeded inside the sandbox but never reached the host. That was only possible because the fixture lives under `/tmp`, which the sandbox lets commands write; the real data directory is not writable from a coordinator command.

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

Found on 2026-11-06, per provider:

- **Pi** confined nothing: its `read` takes any absolute path, and its `grep` passes `--hidden` to ripgrep, so a search of the home directory reaches `~/.config/orkestrator-v2`. A read-only Pi session runs only `read`, `grep`, `find` and `ls` and has no shell, so the gate sees every built-in read.
- **OpenCode** already refuses a direct read: the coordinator's `{"*": "deny"}` base denies `external_directory`, and the data directory is never inside the checkout. Qualified on the pinned 1.19.5 binary with a loopback model: `read`, `grep` and `glob` on the data directory are refused, and allowing `external_directory` makes the fixture readable (the control). **Defect:** OpenCode judges `external_directory` from the path as written, so `read` of a link in the checkout pointing to `control-mcp.json`, `read` through a linked directory and `grep` rooted at a linked directory all returned the fixture credential. `grep` and `glob` from the checkout root do not follow links. 1.19.5 has no `list` tool.
- **Cursor** (`@cursor/sdk` 1.2.0) has no per-call hook that sees a built-in tool's path; the ways in are unpublished executor overrides or an `fs` tree that drops `readLints`, `semSearch` and skills. Its model is hosted, so neither can be qualified without a billed turn. Recorded in to-do 7400 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#provider-qualification)).
- **Grok**: the bridge's `fs/read_text_file` is already confined to the workspace, but Grok's own reading tools run in its process, and whether they ask permission is unobserved (Grok is signed out here). Recorded in [7401](7401-grok-coordinator-data-dir-reads.md).

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

Confirmed on 2026-11-06: the backend still deletes `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR` for every bridge and sets it only in its coordinator branch (`commands-servers.ts`), and the Pi and OpenCode checks added under task 3 read the same variable, so a worker's read-only review turns stay unbounded on every provider. The reasons for the recommendation still hold: a worker's ordinary turns read the directory anyway on a host environment.

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

Not started on 2026-11-06: the change edits `control-mcp-tools.ts`, which another build was splitting at the time. That split had merged by 2026-11-09: `send_prompt_to_tab` is in `control-mcp-environment-tools.ts` and `launch_job` in `control-mcp-launch-tools.ts`.

Found on 2026-11-09:

- Five producers build the frame: `launch_job` (Control MCP), `launch_environment` (`commands-registry-coordinator.ts`), a launch on another node (`commands-registry-coordinator-nodes.ts`) and the fork, local and remote (`coordinator-fork-worker.ts`). A remote fork sends `{projectId, coordinatorId, conversationId, instruction}` to the node, which builds the frame itself. An older node reads those four fields only and cuts the instruction at 4,000 characters.
- The parser needs only the opening line at offset zero, a closing line and a blank line, and does not read the lines between. `isTrustedUserPromptPresentation` checks a stored frame through the same parser. A frame with one more line inside therefore parses on an older backend or renderer. A test keeps a copy of the parser as it stood and checks marked frames against it.
- A scheduled fire calls the coordinator's tool in-process, with a scope the executor builds (`coordinatorScope` in `scheduled-jobs/executor.ts`). The schedule's owner records no origin, so the fire read the conversation's newest turn.
- The frame is shown as delegation metadata only on the first user message, through the stored presentation. A later prompt has no presentation.

**Decisions.**

- **How to mark them?**
  - **Add the note to the coordinator frame, and give `send_prompt_to_tab` the frame's note only (recommended).**
    - Pros: the same signal on every path.
    - Cons: needs a compatibility check on the frame parser.
  - **Leave prompts unmarked, since the origin check already limits them to the coordinator's own workers.**
    - Pros: no work.
    - Cons: an own worker still reads an injected request as an instruction.

**Remaining (2026-11-09).** The code and its tests are done: every delegated path carries the note and scheduled fires use the origin of the turn that set them (see Assumptions and decisions). Still open is a live check that a real worker reads the note. It needs a billed provider turn and a signed-in provider, which the node that built this (beelink, Linux) was not allowed to use, so it was not run and no evidence is claimed; it moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-10. Close the task once that run passes; if a model ignores the note, reword `COORDINATOR_MAIL_ORIGIN_NOTE`, which the mail path shares, from what the run recorded.

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

### Task 2: where the bubblewrap run happened

Ran the qualification file on this Linux host (the recommended option) rather than adding it to CI. The host's bubblewrap nests the CLI's user namespace (the probe answers available), so this is a stock-kernel result. A host under Ubuntu's AppArmor `bwrap-userns-restrict` is still unobserved for this file; adding it to the CI job that qualifies Claude under AppArmor (the other option) remains possible. No test change was needed: the file passed as written.

### Task 3: one shared path check, applied in each provider's own gate

Took the recommended option where the provider has a gate that sees the path:

- The provider-neutral part of Claude's check (`canonicalPath`, `protectedDataDirBoundary`, `readBoundaryRefuses`) moved to `@orkestrator/protocol/node/coordinator-read-boundary`, so Claude and Pi share one implementation. Claude's behaviour is unchanged; its allowance list stays in the Claude bridge.
- Pi: the approval gate (`interactions.ts`) refuses `read`, `grep`, `find` and `ls` that would reach the data directory, whatever the approval policy (`bridges/pi-bridge/src/read-boundary.ts`). The checkout and the coordinator attachment root stay readable. Pi's path spellings (`@`, unicode spaces, `file://`, `~`) are normalised as its `resolveToCwd` does; a search rooted above the directory is refused, a listing of an ancestor is not (it shows names only).
- OpenCode: the defect is fixed with a server plugin, `orkestrator-coordinator-read-boundary.js` (`opencode-read-boundary-plugin.ts`), installed beside the credential plugin. It resolves `read`, `grep`, `glob` and `list` paths and throws in `tool.execute.before`. It reads the protected directory from its own process environment, so it is inert in every server but a coordinator's. A permission rule could not fix this, because OpenCode matches rules against the path as written. Qualified on the pinned binary in `opencode-coordinator-read-boundary-live.test.ts` (slow tier; set `ORKESTRATOR_POLICY_OPENCODE_PATH` to a worktree binary from `mise run download:opencode`).
- Tier notes were left unchanged: the reasons the picker shows do not mention the data directory today, so the tool-level nature of the Pi and OpenCode checks is recorded in `docs/architecture/coordinator.md` instead. Both stay `provider-configured`.
- Cursor and Grok are recorded in 7400 and 7401 with what blocks them; the OpenCode plugin's absence under a user `OPENCODE_CONFIG_DIR` is 7402. (2026-11-10: 7400 task 1 built, Cursor's reading tools now check paths, with a live Cursor run left; 7402 done and retired, the plugin now loads beside a user directory, qualified on the pinned binary.)

### Task 4: read-only review turns keep no read boundary

Recorded the recommended option, leave as is, after checking that nothing added under task 3 changes it (see the task's Investigation).

### Task 5: the note on every path, from one rule

Took the recommended option: the coordinator frame carries the note, and `send_prompt_to_tab` carries the frame's note only.

- **One rule.** `coordinatorCallTurnOrigin` (`packages/protocol/src/coordinator.ts`) decides for mail, prompts and launches alike. Only a turn the user started is unmarked, and an unknown origin counts as mail, as the mail path already did. The Control MCP tools read it through `get_project_coordinator` (`coordinatorScopeTurnOrigin`), and a failed read marks rather than clears. The registry commands read it from the coordinator store (`coordinatorCallerTurnOrigin`).
- **Where the note sits in the frame.** It is the last line, after the instruction (`coordinatorDelegationInstruction`), and it is the same sentence the mail carrier adds (`COORDINATOR_MAIL_ORIGIN_NOTE`). A frame from the user's turn is unchanged, byte for byte. Putting the note in the instruction text, rather than in a new delegation field, means a remote fork needs no protocol change: an older node copies the instruction into its frame and writes the note without knowing about it. A new `turnOrigin` field in the fork's `delegation` would have needed a capability gate, and an older node would have dropped the note silently.
- **`send_prompt_to_tab`.** From a mail turn the prompt is wrapped in a frame that holds only the note (`createCoordinatorMailOriginPrompt`). From the user's turn it is sent as written, as before. Using the same tags rather than a bare sentence gives the worker the signal in the shape its launch prompt had. The frame shows as text in the worker's transcript, because a later prompt has no stored presentation. Hiding it would need a presentation on `dispatch_native_agent_intent`, which this task did not add.
- **Scheduled fires** (the second half of the Problem). A coordinator schedule's owner now records `turnOrigin` (`user` or `mail`) at creation. Any `update_schedule` or `resume_schedule` from a turn the user did not start sets it to `mail`, and nothing clears it, because a later user turn may leave text that mail put there. Pausing does not set it. The executor copies it onto the fire's `CoordinatorControlScope` (new optional `turnOrigin`, set only by the scheduler), and every path above reads it before the newest turn. `send_coordinator_agent_mail` gained an optional `turnOrigin` argument for this (internal command, optional field, no domain version change; manifest regenerated). A schedule stored before this change has no `turnOrigin` and still reads the newest turn. Nothing can know which turn set it.
- **Not done here:** the frame is not hidden in the worker's transcript for later prompts (above); that is a presentation choice and does not keep the task open. A real model's reading of the note is unobserved because no billed provider turn was allowed, so the task stays open on that live check (the task's Remaining, and Needs verification).
- **Unrelated fix in the same branch:** `apps/backend/tests/command-fixtures.ts` listed `deleteAutoPipelineDraftsByEnvironment` twice, which failed the backend test typecheck (TS1117) on `main` at `c6de4733c`. The duplicate was removed in its own commit.

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

- to-do 7400 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#provider-qualification)), [7401](7401-grok-coordinator-data-dir-reads.md), and 7402 (retired 2026-11-10): follow-ups from task 3

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#which-environments-a-coordinator-may-act-on)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [Provider secrets at rest](../../architecture/storage.md#provider-secrets-at-rest)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the live run of task 5, and the real Pi and OpenCode coordinator turns from Needs verification) moved there on 2026-11-10.
