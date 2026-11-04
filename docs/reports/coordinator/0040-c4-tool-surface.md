# C4: Tool surface

This file combines 4 reports into one batch to build together. All change what the model sees in the Control MCP tools.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0040](#0040-the-launch-agent-cannot-be-omitted-so-defaults-are-not-followed) | High | Making `agent` optional on `launch_environment` and `launch_job`. |
| [0130](#0130-the-coordinator-is-told-to-reuse-request-ids-but-not-to-make-new-ones) | Medium | Wording on new versus reused request ids, and making collisions obvious. |
| [0150](#0150-poll-guard-coverage-is-uneven) | Medium | The `list_agents` wording and a wider, sliding poll guard. |
| [0160](#0160-trim-the-coordinator-tool-surface-and-remove-the-legacy-node-tools) | Medium | Removing the legacy node tools and `start_multi_review`, and measuring schema size. |

## 0040: The launch `agent` cannot be omitted, so defaults are not followed

### Task analysis

#### Tasks

1. **Let `agent` default**: a coordinator's `launch_environment` and `launch_job` resolve the repository default when `agent` is left out. Status: open.

#### 1. Let `agent` default

**Problem.** The coordinator is told to omit choices so the user's defaults apply, but `agent` is a required enum. A model that writes `claude` out of habit runs workers on a platform other than the user's default, silently.

**Context.** `get_launch_options` returns `defaults.agent` (`docs/architecture/coordinator.md:2048-2050`). The doc also says that each "agent field" says omitting it uses the saved default (`:2045-2047`), which is not true of these two tools.

**Investigation.** `agent` is required at `control-mcp-tools.ts:1537` (`launch_environment`) and `:1760` (`launch_job`), with no description. `COORDINATOR_LAUNCH_DEFAULTS_RULE` (`packages/protocol/src/coordinator.ts:555-556`) lists `modelId`, `reasoningId` and build `agentType` as omittable; `agent` appears only as something to override on request, and nothing says to copy `defaults.agent`. `start_build_pipeline` already takes an optional `agentType`. `launch_node_environment` has the same required field (`control-mcp-nodes.ts:377`); see [0160](#0160-trim-the-coordinator-tool-surface-and-remove-the-legacy-node-tools).

**Decisions.**

- **Make it optional, or only document it?**
  - **Optional, resolving as `coordinatorService.preferredAgent` does (recommended).**
    - Pros: the rule becomes true as written; matches `modelId` and `agentType`; a model cannot pick wrongly by omission.
    - Cons: the node form must resolve on that node, where the default may differ; the `nodeId` path validates there.
  - **Keep it required and say "pass `defaults.agent`".**
    - Pros: no behaviour change; one description.
    - Cons: relies on the model reading it, and adds another line to a schema that is already large.

## 0130: The coordinator is told to reuse request ids but not to make new ones

### Task analysis

#### Tasks

1. **Fix the wording**: "use a new unique requestId for each new action; reuse it only to retry". Status: open.
2. **Make a collision obvious**: a refused or replayed request id says it was used before. Status: open.

#### 1. Fix the wording

**Problem.** A fresh main that picks `launch-1` again collides with an earlier conversation's request.

**Context.** The namespace is `coordinatorId + requestId`, across conversations. Operator instructions already say the right thing (`control-mcp-tools.ts:569`).

**Investigation.** The coordinator's context says only "Reuse requestId on retry" (`native-agent-service.ts:1305`), the MCP instructions "Reuse requestId when retrying mutations" (`control-mcp-tools.ts:603`) and `launch_environment` "Reuse requestId when retrying" (`:1531`).

**Decisions.** None: replace the three sentences, using the operator wording.

#### 2. Make a collision obvious

**Problem.** What a collision does depends on the path, and none of them tells the model to choose another id.

**Context.** Retention now lets ids older than 24 h be reused if their record was removed (`docs/architecture/coordinator.md:107-108`), which helps only after cleanup, and cleanup runs only at the limit.

**Investigation.** A changed payload throws "Coordinator request id was reused with a different payload" (`storage-coordinators.ts:269`, and at `:457`, `:486`, `:633`, `:912`). The same payload replays the old resource (`commands-registry-coordinator.ts:458-465`), which reads as a success. A collision with a different worker throws in `openWorkerDelegation` (`coordinator-worker-mail.ts:103-108`), and `send_message` swallows that (`:176-181`), so no delegation opens. The public-action hint at `control-mcp-results.ts:96` says "use a new requestId" but is not on these paths.

**Decisions.**

- **Change the error, or the namespace?**
  - **Reword the errors and mark replays (`replayed: true`) (recommended).**
    - Pros: small; keeps idempotency across a main being replaced, which a retry relies on when the conversation changes between attempts.
    - Cons: a model still has to act on the message.
  - **Namespace ids per conversation on the server, as the report's alternative.**
    - Pros: collisions across conversations disappear.
    - Cons: a retry after a main is replaced would start the work twice, and receipts in stored records need migrating.

## 0150: Poll-guard coverage is uneven

### Task analysis

#### Tasks

1. **Stop inviting polling**: rewrite the `list_agents` description. Status: open.
2. **Harden the guard**: key on the tool and its target, use a sliding window, and cover the other status reads. Status: open.

#### 1. Stop inviting polling

**Problem.** The `list_agents` description says "Read this instead of polling tabs one by one", which reads as permission to poll this.

**Context.** The async contract says not to poll at all.

**Investigation.** The sentence is at `control-mcp-tools.ts:1070`.

**Decisions.** None: replace the sentence with one saying it answers a one-off question and that wakes report changes.

#### 2. Harden the guard

**Problem.** A coordinator can poll without ever being told to stop.

**Context.** The guard never withholds data; it only adds `repeatedRead` and the contract (`docs/architecture/coordinator.md:1126-1134`), so wider coverage is low risk.

**Investigation.** It is called only for `list_environments` (`control-mcp-tools.ts:996`), `read_messages` (`:2263`) and `get_message_status` (`:2339`). `list_agents`, `get_tab_state`, `get_tab_transcript`, `get_environment`, `get_multi_review` and `get_build_pipeline` have none. The key includes the raw input JSON (for example `:997`), so changing `limit` starts afresh. The window is fixed from the first read (`control-mcp-server.ts:298`, 120 s, budget 3 at `:51-52`), so reads over 40 s apart never trip it.

**Decisions.**

- **What fingerprints a repeat on the new reads?**
  - **A semantic key (tool plus target) and each read's own state fingerprint, as `environmentListFingerprint` does (recommended).**
    - Pros: a real change is never flagged; transcripts and workflows have obvious state fields.
    - Cons: one small fingerprint per tool.
  - **Tool name and target alone, ignoring state.**
    - Pros: trivially simple.
    - Cons: a legitimate check after a change gets flagged, which teaches models to ignore the field.
- **Window?**
  - **Sliding: each identical read extends it (recommended).**
    - Pros: catches slow polling, the case the report names.
    - Cons: an entry lives longer; `MAX_COORDINATOR_POLL_ENTRIES` (`:53`) already bounds them.
  - **A longer fixed window.**
    - Pros: one constant changed.
    - Cons: only moves the interval at which polling goes unseen.

## 0160: Trim the coordinator tool surface and remove the legacy node tools

### Task analysis

#### Tasks

1. **Remove the legacy node tools**: drop the `*_node_*` forms that duplicate `nodeId` from the coordinator's set. Status: open.
2. **Hide `start_multi_review`**: coordinators get only `launch_multi_review`. Status: open.
3. **Measure, then trim schema prose**: find the largest schemas again and cut what repeats the context block. Status: open.

#### 1. Remove the legacy node tools

**Problem.** Seven tools duplicate the `nodeId` forms, and they do less: the model can pick the weaker one.

**Context.** Their own descriptions call them older forms that `nodeId` improves on.

**Investigation.** `NODE_TOOL_CAPABILITIES` (`control-mcp-nodes.ts:594-604`) grants `list_node_environments`, `read_node_environment`, `launch_node_environment`, `start_node_environment`, `stop_node_environment`, `send_prompt_to_node_tab` and `send_node_message`. `list_nodes` and `request_environment_deletion` have no duplicate. `launch_node_environment` (`:367`) does not validate the model, per its description, and its result has no async contract (`:411-418`). `send_prompt_to_node_tab` (`:451`) dispatches first and opens the delegation after, swallowing an error (`:488-494`). Both do open a delegation now. The report's "skips the outstanding-delegation check" still stands, since no check precedes the dispatch.

**Decisions.**

- **Remove, or reroute?**
  - **Remove from the coordinator set; keep any operator use (recommended).**
    - Pros: fewer tools; only one behaviour to reason about.
    - Cons: a saved schedule using `tool` with one of these names stops working, so check `assertToolSchedulable` on firing.
  - **Route them through the same implementation.**
    - Pros: no compatibility question.
    - Cons: keeps seven schemas in every turn for nothing.

#### 2. Hide `start_multi_review`

**Problem.** A tool kept for diagnostics is offered to every coordinator, and the prompt has to explain not to use it.

**Context.** `native-agent-service.ts:1305` and `control-mcp-tools.ts:601` both steer away from it.

**Investigation.** It is granted at `control-mcp-tools.ts:151` and registered at `control-mcp-coordinator-tools.ts:485`. The operator's own copy is separate (`control-mcp-operator-workflow-tools.ts:112`).

**Decisions.** None: remove it from the coordinator map and registration, and the two steering sentences with it. Check first that no live scenario calls it.

#### 3. Measure, then trim schema prose

**Problem.** The report's figures (56 tools, about 13.5k tokens) are out of date, and the surface has grown.

**Context.** The capability maps now hold about 86 entries (a count of map lines across `control-mcp-tools.ts:124-183` and the seven spread lists), against the report's 56. `send_message`'s description alone (`control-mcp-tools.ts:2047`) is about 2,000 characters.

**Investigation.** No size was measured for this file: nothing was run. Prompt caching changes what this costs per turn, and [0025](../../todo/coordinator-and-multi-review/0025-multi-review-panel-value.md) records doubts about cache behaviour elsewhere.

**Decisions.**

- **Is there a limit to enforce?**
  - **Add a test that prints and bounds total schema size for a main coordinator (recommended).**
    - Pros: a measurement at last, and it stops silent growth.
    - Cons: a bound that needs raising whenever a real tool arrives.
  - **Trim once by hand.**
    - Pros: no test to maintain.
    - Cons: nothing stops it growing back.

### Needs verification

The per-turn token and cost figure on the current surface, per provider.

## Related

- [Coordinator report, 4.3 (A2)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [Coordinator report, 4.3 (A3)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [C2 part 0080](0080-c2-workflow-records.md#0080-a-full-workflow-store-is-invisible-to-the-user): the same swallowed error
- [Coordinator report, 4.3 (A4)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [Coordinator report, 4.3 (A5)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0395-coordinator-worker-surfaces-follow-ups.md](../../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md): adds `nodeId` to more tools
